// src/features/MercadoPago/mercadoPago.service.js

const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

// Helper para obter a data de expiração da preferência (3 dias a partir de agora)
function getExpirationDate() {
    const date = new Date();
    date.setDate(date.getDate() + 3); 
    return date.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

const mercadoPagoService = {
  async criarPreferenciaAssinatura(clientId, planId) {
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }
      if (!plan.isActive) {
        throw { statusCode: 400, message: 'Este plano não está mais disponível para assinatura.' };
      }
      if (!plan.price || Number(plan.price) < 1.00) {
        logger.error(`[CRÍTICO] Tentativa de checkout com preço inválido para o Plano ID ${planId}. Preço: ${plan.price}`);
        throw { statusCode: 500, message: 'O plano selecionado está com uma configuração de preço inválida.' };
      }

      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });

      const [firstName, ...lastNameParts] = (client.name || 'Cliente').split(' ');
      const lastName = lastNameParts.join(' ') || firstName;
      
      let payerPhone = {};
      if (client.phone && client.phone.length === 12) {
        payerPhone = {
          area_code: client.phone.substring(2, 4),
          number: client.phone.substring(4)
        };
      }

      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: plan.name,
          unit_price: Math.round(plan.price * 100) / 100,
          quantity: 1,
          currency_id: 'BRL',
        }],
        payer: {
          name: firstName,
          surname: lastName,
          email: client.email,
          phone: payerPhone,
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL}/assinatura/sucesso`,
          failure: `${process.env.FRONTEND_URL}/assinatura/erro`,
          pending: `${process.env.FRONTEND_URL}/assinatura/pendente`,
        },
        auto_return: "approved",
        external_reference: subscription.id.toString(),
        binary_mode: true,
        payment_methods: {
            excluded_payment_types: [ { id: "ticket" }, { id: "atm" } ],
            installments: 1
        },
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        statement_descriptor: "MAP NO CONTROLE",
        purpose: 'wallet_purchase',
        expiration_date_of: getExpirationDate(),
      };

      const response = await mpPreference.create({ body: preferencePayload });

      await subscription.update({ externalSubscriptionId: response.id });

      logger.info(`Preferência de pagamento MP criada (ID: ${response.id}) para Assinatura ID ${subscription.id}`);
      
      return { checkoutUrl: response.init_point, preferenceId: response.id };

    } catch (error) {
      logger.error("Erro ao criar preferência de pagamento no Mercado Pago:", error.cause || error);
      throw error;
    }
  },

  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') {
        return;
      }
      
      const paymentId = dados.data.id;
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) {
        logger.warn("[MP Webhook] Webhook sem 'external_reference'.");
        return;
      }
      
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });
      if (!subscription) {
        logger.error(`[MP Webhook] CRÍTICO: Assinatura com ID ${subscriptionId} não encontrada!`);
        return;
      }
      
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        
        await subscriptionService.updateSubscriptionStatusByExternalId(
          subscription.externalSubscriptionId, 
          'Ativa', 
          newEndDate.toISOString().split('T')[0],
          subscription.id
        );
      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status !== 'Cancelada') {
        await subscription.update({ status: 'Cancelada' });
      }

    } catch (error) {
      logger.error("Erro fatal ao processar webhook do Mercado Pago:", error.cause || error);
    }
  },

  async createPixPayment(clientId, planId) {
    logger.info(`[MP PIX] Criando pagamento PIX para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }

      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });
      logger.info(`[MP PIX] Assinatura pendente ID: ${subscription.id} criada.`);

      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + 30);
      const formattedExpirationDate = expirationDate.toISOString().replace(/Z$/, "-03:00");

      const pixPayload = {
        transaction_amount: Number(plan.price),
        description: `Pagamento Plano ${plan.name} - MAP no Controle`,
        payment_method_id: 'pix',
        payer: {
          email: client.email,
          first_name: client.name.split(' ')[0],
          last_name: client.name.split(' ').slice(1).join(' ') || client.name.split(' ')[0],
        },
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        date_of_expiration: formattedExpirationDate,
      };

      const pixResponse = await mpPayment.create({ body: pixPayload });
      logger.info(`[MP PIX] Pagamento PIX criado com sucesso. Payment ID: ${pixResponse.id}`);

      return {
        paymentId: pixResponse.id,
        qrCode: pixResponse.point_of_interaction.transaction_data.qr_code,
        qrCodeBase64: pixResponse.point_of_interaction.transaction_data.qr_code_base64,
        subscriptionId: subscription.id,
      };

    } catch (error) {
      const errorMessage = error.cause?.message || error.message;
      logger.error('Erro ao criar pagamento PIX:', { message: errorMessage, data: error.cause?.data });
      throw new Error(`The following parameters must be valid date and format (yyyy-MM-dd'T'HH:mm:ssz): date_of_expiration`);
    }
  },

  async processBrickPayment(clientId, planId, paymentData) {
    logger.info(`[MP Brick] Processando pagamento para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }
      
      if (!plan.price || Number(plan.price) < 1.00) {
        throw { statusCode: 500, message: 'Plano com configuração de preço inválida.' };
      }

      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });
      logger.info(`[MP Brick] Assinatura pendente ID: ${subscription.id} criada.`);
      
      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + 30);
      const formattedExpirationDate = expirationDate.toISOString().replace(/Z$/, "-03:00");
      
      // <<< CORREÇÃO DEFINITIVA AQUI >>>
      const paymentPayload = {
          ...paymentData,
          payment_method_id: 'pix', // FORÇA o método de pagamento para 'pix'.
          transaction_amount: Number(plan.price),
          description: `Pagamento Plano ${plan.name} - MAP no Controle`,
          external_reference: subscription.id.toString(),
          notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
          date_of_expiration: formattedExpirationDate,
      };

      const pixResponse = await mpPayment.create({ body: paymentPayload });
      logger.info(`[MP Brick] Pagamento PIX criado com sucesso via Brick. Payment ID: ${pixResponse.id}`);

      await subscription.update({ externalSubscriptionId: pixResponse.id.toString() });

      return {
        paymentId: pixResponse.id,
        status: pixResponse.status,
        qrCode: pixResponse.point_of_interaction.transaction_data.qr_code,
        qrCodeBase64: pixResponse.point_of_interaction.transaction_data.qr_code_base64,
      };

    } catch (error) {
      const errorMessage = error.cause?.message || error.message;
      logger.error('Erro ao processar pagamento do Brick:', { message: errorMessage, data: error.cause?.data });
      throw new Error(`Falha ao processar o pagamento: ${errorMessage}`);
    }
  },
   async createBrickPreference(clientId, planId) {
    logger.info(`[MP Brick Pref] Criando preferência para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }

      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });

      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: plan.name,
          unit_price: Number(plan.price), // Garante que é um número
          quantity: 1,
          currency_id: 'BRL',
        }],
        payer: {
          email: client.email,
          name: client.name,
        },
        // IMPORTANTE: Este campo diz ao Brick para renderizar apenas PIX.
        payment_methods: {
          excluded_payment_methods: [
            { id: "credit_card" },
            { id: "debit_card" },
            { id: "ticket" },
            { id: "bank_transfer" },
            { id: "mercado_pago_wallet" }
          ],
          installments: 1
        },
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        // O Brick não usa back_urls, mas é bom ter por segurança
        back_urls: {
          success: `${process.env.FRONTEND_URL}/assinatura/sucesso`,
          failure: `${process.env.FRONTEND_URL}/assinatura/erro`,
          pending: `${process.env.FRONTEND_URL}/assinatura/pendente`,
        },
      };

      const preference = await mpPreference.create({ body: preferencePayload });
      await subscription.update({ externalSubscriptionId: preference.id });

      logger.info(`[MP Brick Pref] Preferência ID: ${preference.id} criada para Assinatura ID ${subscription.id}`);
      
      // Retorna apenas o ID da preferência
      return { preferenceId: preference.id };

    } catch (error) {
      logger.error("Erro ao criar preferência para o Brick:", error.cause || error);
      throw new Error('Falha ao preparar o ambiente de pagamento.');
    }
  },
   async createPaymentPreference(clientId, planId) {
    logger.info(`[MP Pref] Criando preferência de pagamento para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);
      if (!client || !plan) throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };

      // Cria uma assinatura PENDENTE que servirá como referência.
      // O webhook usará o external_reference para encontrar esta assinatura.
      const subscription = await Subscription.create({
        clientId, planId, status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });

      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: plan.name,
          unit_price: Number(plan.price),
          quantity: 1,
          currency_id: 'BRL',
        }],
        payer: { email: client.email, name: client.name },
        // Não vamos mais restringir métodos de pagamento aqui. Deixamos o Brick decidir.
        // Apenas excluímos boleto e ATM, que não são instantâneos.
        payment_methods: {
          excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
          installments: 1, // Limita a 1 parcela
        },
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        purpose: 'wallet_purchase', // Essencial para o Brick
      };

      const preference = await mpPreference.create({ body: preferencePayload });
      
      // Armazena o ID da preferência na assinatura para referência
      await subscription.update({ externalSubscriptionId: preference.id });

      logger.info(`[MP Pref] Preferência ID: ${preference.id} criada para Assinatura ID ${subscription.id}`);
      return { preferenceId: preference.id };
    } catch (error) {
      logger.error("Erro ao criar preferência de pagamento:", error.cause || error);
      throw new Error('Falha ao preparar o ambiente de pagamento.');
    }
  },

  /**
   * [NOVO E DEFINITIVO] Processa os dados de pagamento enviados pelo 'onSubmit' do Payment Brick.
   */
  async processBrickPayment(clientId, planId, paymentData) {
    logger.info(`[MP Process] Processando pagamento do Brick para Cliente ID: ${clientId}`);
    const t = await sequelize.transaction();
    try {
      const plan = await Plan.findByPk(planId, { transaction: t });
      if (!plan) throw { statusCode: 404, message: 'Plano não encontrado.' };

      // O external_reference já foi definido na criação da preferência.
      // Aqui, precisamos encontrar a assinatura pendente para garantir consistência.
      const subscription = await Subscription.findOne({
          where: { clientId, planId, status: 'Pendente' },
          order: [['createdAt', 'DESC']], // Pega a mais recente
          transaction: t
      });

      if (!subscription) {
        throw { statusCode: 404, message: 'Nenhuma assinatura pendente encontrada para este pagamento.'};
      }

      const paymentPayload = {
        ...paymentData,
        transaction_amount: Number(plan.price), // Garante o preço correto (segurança)
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
      };
      
      const paymentResponse = await mpPayment.create({ body: paymentPayload });
      
      // Atualiza a assinatura com o ID do pagamento final
      await subscription.update({ externalSubscriptionId: paymentResponse.id.toString() }, { transaction: t });

      await t.commit();
      logger.info(`[MP Process] Pagamento ID ${paymentResponse.id} criado via Brick.`);

      // Retorna os dados necessários para o frontend (especialmente para PIX)
      return {
        id: paymentResponse.id,
        status: paymentResponse.status,
        payment_method_id: paymentResponse.payment_method_id,
        point_of_interaction: paymentResponse.point_of_interaction, // Contém QR code se for PIX
      };

    } catch (error) {
      await t.rollback();
      const errorMessage = error.cause?.data?.message || error.cause?.message || error.message;
      logger.error('Erro ao processar pagamento do Brick:', { message: errorMessage, data: error.cause?.data });
      throw new Error(errorMessage || 'Falha ao processar o pagamento.');
    }
  },
}

module.exports = mercadoPagoService;
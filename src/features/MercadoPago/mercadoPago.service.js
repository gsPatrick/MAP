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
      // 1. Busca os dados necessários (equivalente a buscar pedido e itens)
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }
      if (!plan.isActive) {
        throw { statusCode: 400, message: 'Este plano não está mais disponível para assinatura.' };
      }
      // Validação de segurança para o preço
      if (!plan.price || Number(plan.price) < 1.00) {
        logger.error(`[CRÍTICO] Tentativa de checkout com preço inválido para o Plano ID ${planId}. Preço: ${plan.price}`);
        throw { statusCode: 500, message: 'O plano selecionado está com uma configuração de preço inválida.' };
      }

      // 2. Cria o registro de Assinatura para usar como referência externa (equivalente ao Pedido)
      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });

      // 3. Prepara os dados do pagador (payer), exatamente como no e-commerce
      const [firstName, ...lastNameParts] = (client.name || 'Cliente').split(' ');
      const lastName = lastNameParts.join(' ') || firstName;
      
      let payerPhone = {};
      // O formato do telefone no seu banco é '55219...', então tem 12 dígitos.
      if (client.phone && client.phone.length === 12) {
        payerPhone = {
          area_code: client.phone.substring(2, 4), // Pega o DDD
          number: client.phone.substring(4)      // Pega o número
        };
      }

      // 4. <<< CRIAÇÃO DA PREFERÊNCIA - RÉPLICA EXATA DO E-COMMERCE >>>
      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: plan.name,
          unit_price: Math.round(plan.price * 100) / 100,
          quantity: 1,
          currency_id: 'BRL',
          // Nenhum outro campo aqui, exatamente como no e-commerce.
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
        external_reference: subscription.id.toString(), // Equivalente ao pedidoId
        binary_mode: true,
        payment_methods: {
            excluded_payment_types: [
                { id: "ticket" },
                { id: "atm" }
            ],
            installments: 1
        },
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        statement_descriptor: "MAP NO CONTROLE",
        purpose: 'wallet_purchase',
        expiration_date_of: getExpirationDate(),
      };
      // <<< FIM DA RÉPLICA >>>

      const response = await mpPreference.create({ body: preferencePayload });

      await subscription.update({
        externalSubscriptionId: response.id
      });

      logger.info(`Preferência de pagamento MP criada (ID: ${response.id}) para Assinatura ID ${subscription.id}`);
      
      return {
        checkoutUrl: response.init_point,
        preferenceId: response.id,
      };

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
          newEndDate.toISOString().split('T')[0]
        );
      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status !== 'Cancelada') {
        await subscription.update({ status: 'Cancelada' });
      }

    } catch (error) {
      logger.error("Erro fatal ao processar webhook do Mercado Pago:", error.cause || error);
    }
  },
  // <<< NOVA FUNÇÃO PARA GERAR O PAGAMENTO PIX >>>
  async criarPagamentoPix(clientId, planId) {
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

      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + 30); // PIX expira em 30 minutos

      const [firstName, ...lastNameParts] = (client.name || 'Cliente').split(' ');
      const lastName = lastNameParts.join(' ') || firstName;

      const paymentPayload = {
        transaction_amount: Math.round(plan.price * 100) / 100,
        description: `Assinatura Plano ${plan.name}`,
        payment_method_id: 'pix',
        payer: {
          email: client.email,
          first_name: firstName,
          last_name: lastName,
        },
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        date_of_expiration: expirationDate.toISOString().replace(/\.\d{3}Z$/, "-03:00"),
      };

      logger.info(`[MP PIX] Criando pagamento PIX para Assinatura ID: ${subscription.id}`);
      const response = await mpPayment.create({ body: paymentPayload });

      // Atualiza a assinatura com o ID do pagamento para referência
      await subscription.update({ externalSubscriptionId: response.id.toString() });

      const pixData = {
        paymentId: response.id,
        status: response.status, // Deverá ser "pending"
        qrCode: response.point_of_interaction.transaction_data.qr_code,
        qrCodeBase64: response.point_of_interaction.transaction_data.qr_code_base64,
      };

      logger.info(`[MP PIX] Pagamento PIX (ID: ${pixData.paymentId}) criado com sucesso.`);
      return pixData;

    } catch (error) {
      logger.error('Erro ao criar pagamento PIX:', error.cause || error);
      const errorMessage = error.cause?.error?.message || error.message || 'Erro desconhecido ao gerar PIX.';
      throw { statusCode: 500, message: errorMessage };
    }
  },
   // <<< FUNÇÃO NOVA E CORRIGIDA PARA PAGAMENTO PIX >>>
  async createPixPayment(clientId, planId) {
    logger.info(`[MP PIX] Criando pagamento PIX para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }

      // Cria a assinatura pendente
      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });
      logger.info(`[MP PIX] Assinatura pendente ID: ${subscription.id} criada.`);

      // --- CORREÇÃO DA DATA DE EXPIRAÇÃO ---
      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + 30); // Define a expiração para 30 minutos

      // Formata a data para o padrão exigido pela API do MP: "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
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
        date_of_expiration: formattedExpirationDate, // <<< USA A DATA FORMATADA CORRETAMENTE
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
      // Lança um erro padronizado para o controller
      throw new Error(`The following parameters must be valid date and format (yyyy-MM-dd'T'HH:mm:ssz): date_of_expiration`);
    }
  },
// <<< NOVA FUNÇÃO PARA PROCESSAR O PAGAMENTO VINDO DO BRICK >>>
  async processBrickPayment(clientId, planId, paymentData) {
    logger.info(`[MP Brick] Processando pagamento para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }
      
      // Validação de segurança: O preço é sempre definido pelo backend, não pelo frontend.
      if (!plan.price || Number(plan.price) < 1.00) {
        throw { statusCode: 500, message: 'Plano com configuração de preço inválida.' };
      }

      // Cria a assinatura com status "Pendente" para gerar a referência externa
      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });
      logger.info(`[MP Brick] Assinatura pendente ID: ${subscription.id} criada.`);
      
      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + 30); // PIX expira em 30 minutos
      const formattedExpirationDate = expirationDate.toISOString().replace(/Z$/, "-03:00");
      
      // Monta o payload do pagamento usando os dados do Brick e os dados seguros do nosso DB
      const paymentPayload = {
        transaction_amount: Number(plan.price), // Preço do nosso banco de dados
        description: `Pagamento Plano ${plan.name} - MAP no Controle`,
        payment_method_id: 'pix', // Fixo como pix
        payer: { // Payer vem do brick, já preenchido pelo usuário
          email: paymentData.payer.email,
          first_name: paymentData.payer.firstName,
          last_name: paymentData.payer.lastName,
        },
        external_reference: subscription.id.toString(), // ID da nossa assinatura pendente
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        date_of_expiration: formattedExpirationDate,
      };

      const pixResponse = await mpPayment.create({ body: paymentPayload });
      logger.info(`[MP Brick] Pagamento PIX criado com sucesso via Brick. Payment ID: ${pixResponse.id}`);

      // Atualiza nossa assinatura com o ID do pagamento gerado
      await subscription.update({ externalSubscriptionId: pixResponse.id.toString() });

      // Retorna os dados necessários para o frontend renderizar o QR Code
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
}

module.exports = mercadoPagoService;
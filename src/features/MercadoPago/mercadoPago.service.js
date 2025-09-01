// src/features/MercadoPago/mercadoPago.service.js
const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

const mercadoPagoService = {
  /**
   * [VERSÃO CORRIGIDA] Cria uma preferência de pagamento para Cartão e PIX no Payment Brick.
   */
  async createPaymentPreference(clientId, planId) {
    logger.info(`[MP Pref] Criando preferência para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);
      if (!client || !plan) throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };

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
        payer: { 
          email: client.email, 
          name: client.name 
        },
        
        // CONFIGURAÇÃO PARA CARTÃO E PIX
        payment_methods: {
          excluded_payment_types: [
            { id: "ticket" },        // Exclui Boleto
            { id: "bank_transfer" }, // Exclui Transferência Bancária
            { id: "debit_card" }     // Exclui Cartão de Débito (opcional)
          ],
          excluded_payment_methods: [],
          installments: 12, // Permite até 12x no cartão
        },
        
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        back_urls: {
          success: `${process.env.FRONTEND_URL}/success`,
          failure: `${process.env.FRONTEND_URL}/failure`,
          pending: `${process.env.FRONTEND_URL}/pending`
        },
        auto_return: "approved",
        purpose: 'wallet_purchase',
      };

      const preference = await mpPreference.create({ body: preferencePayload });
      await subscription.update({ externalSubscriptionId: preference.id });

      logger.info(`[MP Pref] Preferência ID: ${preference.id} criada para Assinatura ID ${subscription.id}`);
      return { preferenceId: preference.id };
    } catch (error) {
      logger.error("Erro ao criar preferência de pagamento:", error.cause || error);
      throw new Error('Falha ao preparar o ambiente de pagamento.');
    }
  },

  /**
   * [VERSÃO CORRIGIDA] Processa os dados de pagamento enviados pelo 'onSubmit' do Payment Brick.
   */
  async processBrickPayment(clientId, planId, paymentData) {
    logger.info(`[MP Process] Processando pagamento do Brick para Cliente ID: ${clientId}`);
    try {
      const plan = await Plan.findByPk(planId);
      if (!plan) throw { statusCode: 404, message: 'Plano não encontrado.' };

      const subscription = await Subscription.findOne({
        where: { clientId, planId, status: 'Pendente' }, 
        order: [['createdAt', 'DESC']],
      });
      if (!subscription) throw { statusCode: 404, message: 'Assinatura pendente não encontrada.'};

      // Configuração da data de expiração para PIX (30 minutos)
      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + 30);
      const formattedExpirationDate = expirationDate.toISOString();

      const paymentPayload = {
        ...paymentData,
        transaction_amount: Number(plan.price),
        description: `Assinatura ${plan.name}`,
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        
        // Adiciona data de expiração apenas para PIX
        ...(paymentData.payment_method_id === 'pix' && { 
          date_of_expiration: formattedExpirationDate 
        }),
      };
      
      const paymentResponse = await mpPayment.create({ body: paymentPayload });
      await subscription.update({ externalSubscriptionId: paymentResponse.id.toString() });

      logger.info(`[MP Process] Pagamento ID ${paymentResponse.id} criado via Brick. Status: ${paymentResponse.status}`);
      return paymentResponse;
    } catch (error) {
      const errorMessage = error.cause?.data?.message || error.cause?.message || error.message;
      logger.error('Erro ao processar pagamento do Brick:', { 
        message: errorMessage, 
        data: error.cause?.data 
      });
      throw new Error(errorMessage || 'Falha ao processar o pagamento.');
    }
  },
  
  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') {
        logger.info(`[Webhook] Tipo de notificação ignorado: ${dados.type}`);
        return;
      }
      
      const paymentId = dados.data.id;
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) {
        logger.warn(`[Webhook] External reference não encontrado para pagamento ${paymentId}`);
        return;
      }

      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });
      if (!subscription) {
        logger.warn(`[Webhook] Assinatura ${subscriptionId} não encontrada`);
        return;
      }
      
      logger.info(`[Webhook] Processando pagamento ${paymentId} - Status: ${paymentData.status}`);
      
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Ativa', newEndDate.toISOString().split('T')[0], subscription.id
        );
        logger.info(`[Webhook] Assinatura ${subscription.id} ativada com sucesso`);
      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status !== 'Cancelada') {
        await subscription.update({ status: 'Cancelada' });
        logger.info(`[Webhook] Assinatura ${subscription.id} cancelada - Status: ${paymentData.status}`);
      } else if (paymentData.status === "pending" && subscription.status !== 'Pendente') {
        await subscription.update({ status: 'Pendente' });
        logger.info(`[Webhook] Assinatura ${subscription.id} mantida como Pendente - Aguardando pagamento`);
      }
    } catch (error) {
      logger.error("Erro fatal ao processar webhook do Mercado Pago:", error.cause || error);
    }
  },

  /**
   * Busca o status de um pagamento específico
   */
  async getPaymentStatus(paymentId, clientId) {
    try {
      logger.info(`[MP Status] Buscando status do pagamento ${paymentId} para cliente ${clientId}`);
      
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);
      
      // Verifica se a assinatura pertence ao cliente
      const subscription = await Subscription.findOne({
        where: { id: subscriptionId, clientId }
      });
      
      if (!subscription) {
        throw { statusCode: 403, message: 'Pagamento não encontrado ou não autorizado.' };
      }
      
      return {
        id: paymentData.id,
        status: paymentData.status,
        status_detail: paymentData.status_detail,
        payment_method_id: paymentData.payment_method_id,
        transaction_amount: paymentData.transaction_amount,
        currency_id: paymentData.currency_id,
        date_created: paymentData.date_created,
        date_approved: paymentData.date_approved,
        ...(paymentData.payment_method_id === 'pix' && {
          point_of_interaction: paymentData.point_of_interaction
        })
      };
    } catch (error) {
      logger.error(`[MP Status] Erro ao buscar status do pagamento:`, error.cause || error);
      throw new Error('Falha ao buscar status do pagamento.');
    }
  },
};

module.exports = mercadoPagoService;
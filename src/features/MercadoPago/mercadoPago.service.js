// src/features/MercadoPago/mercadoPago.service.js
const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

const mercadoPagoService = {
  async createCheckoutProPreference(clientId, planId, affiliateCode = null) {
    if (!process.env.FRONTEND_URL || !process.env.BASE_URL) {
        logger.error('[MP Checkout Pro] Variáveis de ambiente FRONTEND_URL ou BASE_URL não estão definidas.');
        throw new Error('Erro de configuração do servidor. Não foi possível iniciar o pagamento.');
    }

    logger.info(`[MP Checkout Pro] Criando preferência para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }

      const createdSubscriptionData = await subscriptionService.createSubscription(
        clientId, planId, new Date().toISOString().split('T')[0], 'Pendente', null, affiliateCode
      );

      // CONFIGURAÇÃO MÍNIMA E CORRETA PARA CHECKOUT PRO
      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: `Plano ${plan.name} - MAP no Controle`,
          description: plan.description || `Acesso ao plano ${plan.name}`,
          unit_price: Number(plan.price),
          quantity: 1,
          currency_id: 'BRL',
        }],
        payer: {
          name: client.name,
          email: client.email,
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL}/payment-success`,
          failure: `${process.env.FRONTEND_URL}/payment-failure`,
          pending: `${process.env.FRONTEND_URL}/payment-pending`,
        },
        auto_return: 'approved',
        external_reference: createdSubscriptionData.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        // CONFIGURAÇÃO CORRETA PARA CHECKOUT PRO - SEM EXCLUSÕES
        payment_methods: {
          excluded_payment_methods: [],
          excluded_payment_types: [],
          installments: 12
        }
      };

      logger.info('[MP Checkout Pro] Payload da preferência:', JSON.stringify(preferencePayload, null, 2));

      const preference = await mpPreference.create({ body: preferencePayload });

      await Subscription.update(
        { externalSubscriptionId: preference.id },
        { where: { id: createdSubscriptionData.id } }
      );

      logger.info(`[MP Checkout Pro] Preferência criada com sucesso:`);
      logger.info(`[MP Checkout Pro] - ID: ${preference.id}`);
      logger.info(`[MP Checkout Pro] - Init Point: ${preference.init_point}`);
      logger.info(`[MP Checkout Pro] - Sandbox Init Point: ${preference.sandbox_init_point}`);
      
      return preference;

    } catch (error) {
      logger.error(`[MP Checkout Pro] Erro detalhado:`, {
        message: error.message,
        cause: error.cause,
        data: error.cause?.data,
        response: error.response?.data,
        status: error.status,
        statusCode: error.statusCode,
        stack: error.stack
      });

      const errorMessage = error.cause?.data?.message || 
                          error.response?.data?.message || 
                          error.cause?.message || 
                          error.message;
      
      throw new Error(errorMessage || 'Falha ao iniciar o processo de pagamento.');
    }
  },

  async processarWebhook(dados) {
    try {
      logger.info('[Webhook MP] Dados recebidos:', JSON.stringify(dados, null, 2));

      if (dados.type !== 'payment') {
        logger.info(`[Webhook MP] Tipo '${dados.type}' ignorado.`);
        return;
      }
      
      const paymentId = dados.data.id;
      logger.info(`[Webhook MP] Processando pagamento: ${paymentId}`);
      
      const paymentData = await mpPayment.get({ id: paymentId });
      
      logger.info(`[Webhook MP] Dados do pagamento:`, {
        id: paymentData.id,
        status: paymentData.status,
        payment_method_id: paymentData.payment_method_id,
        payment_type_id: paymentData.payment_type_id,
        external_reference: paymentData.external_reference,
        transaction_amount: paymentData.transaction_amount,
        date_created: paymentData.date_created,
        date_approved: paymentData.date_approved
      });
      
      if (!paymentData.external_reference) {
        logger.warn(`[Webhook MP] Pagamento ${paymentId} sem external_reference.`);
        return;
      }
      
      const subscriptionId = parseInt(paymentData.external_reference, 10);
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });

      if (!subscription) {
        logger.warn(`[Webhook MP] Assinatura ${subscriptionId} não encontrada.`);
        return;
      }
      
      const successStatuses = ['approved', 'accredited'];
      const failureStatuses = ['rejected', 'cancelled', 'refunded', 'charged_back'];

      if (successStatuses.includes(paymentData.status) && subscription.status !== 'Ativa') {
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Ativa', newEndDate.toISOString().split('T')[0], subscription.id
        );
        
        logger.info(`[Webhook MP] ✅ PAGAMENTO APROVADO - Assinatura ${subscription.id} ativada (${paymentData.payment_method_id})`);

      } else if (failureStatuses.includes(paymentData.status) && subscription.status === 'Pendente') {
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Pagamento Falhou', subscription.endDate, subscription.id
        );
        
        logger.info(`[Webhook MP] ❌ PAGAMENTO FALHOU - Assinatura ${subscription.id} (${paymentData.payment_method_id})`);

      } else {
        logger.info(`[Webhook MP] Status ${paymentData.status} recebido para assinatura ${subscription.id} (status atual: ${subscription.status})`);
      }

    } catch (error) {
      logger.error("[Webhook MP] Erro ao processar webhook:", {
        message: error.message,
        stack: error.stack
      });
    }
  },
};

module.exports = mercadoPagoService;
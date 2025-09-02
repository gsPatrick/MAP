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
      };

      const preference = await mpPreference.create({ body: preferencePayload });

      await Subscription.update(
        { externalSubscriptionId: preference.id },
        { where: { id: createdSubscriptionData.id } }
      );

      logger.info(`[MP Checkout Pro] Preferência ID: ${preference.id} criada e associada à Assinatura ID ${createdSubscriptionData.id}.`);
      return preference;

    } catch (error) {
      const errorMessage = error.cause?.data?.message || error.cause?.message || error.message;
      logger.error(`[MP Checkout Pro] Erro ao criar preferência de pagamento:`, { 
        message: errorMessage, 
        data: error.cause?.data 
      });
      throw new Error(errorMessage || 'Falha ao iniciar o processo de pagamento.');
    }
  },

  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') {
        logger.info(`[Webhook MP] Notificação do tipo '${dados.type}' ignorada.`);
        return;
      }
      
      const paymentId = dados.data.id;
      const paymentData = await mpPayment.get({ id: paymentId });
      
      if (!paymentData.external_reference) {
        logger.warn(`[Webhook MP] Pagamento ${paymentId} não possui 'external_reference'.`);
        return;
      }
      
      const subscriptionId = parseInt(paymentData.external_reference, 10);
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });

      if (!subscription) {
        logger.warn(`[Webhook MP] Assinatura ID ${subscriptionId} não encontrada.`);
        return;
      }
      
      // <<< INÍCIO DA CORREÇÃO E MELHORIA >>>
      const successStatuses = ['approved', 'accredited']; // Status que confirmam o pagamento
      const failureStatuses = ['rejected', 'cancelled', 'refunded', 'charged_back']; // Status de falha ou devolução

      if (successStatuses.includes(paymentData.status) && subscription.status !== 'Ativa') {
        // Se o pagamento foi aprovado/creditado e a assinatura ainda não está ativa
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Ativa', newEndDate.toISOString().split('T')[0], subscription.id
        );
        logger.info(`[Webhook MP] Assinatura ${subscription.id} ATIVADA com sucesso via status '${paymentData.status}'.`);

      } else if (failureStatuses.includes(paymentData.status) && subscription.status === 'Pendente') {
        // Se o pagamento falhou e a assinatura estava pendente
         await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Pagamento Falhou', subscription.endDate, subscription.id
        );
        logger.info(`[Webhook MP] Assinatura ${subscription.id} marcada como 'Pagamento Falhou' via status '${paymentData.status}'.`);

      } else {
        // Loga qualquer outra situação para depuração
        logger.info(`[Webhook MP] Status de pagamento '${paymentData.status}' recebido para assinatura ${subscription.id} (status atual: '${subscription.status}'). Nenhuma ação necessária.`);
      }
      // <<< FIM DA CORREÇÃO E MELHORIA >>>

    } catch (error) {
      logger.error("[Webhook MP] Erro fatal ao processar webhook:", error.cause || error.message || error);
    }
  },
};

module.exports = mercadoPagoService;
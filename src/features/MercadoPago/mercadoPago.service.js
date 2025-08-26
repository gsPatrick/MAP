// src/features/MercadoPago/mercadoPago.service.js
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

// Função para obter a data de expiração da preferência de pagamento
function getExpirationDate() {
    const date = new Date();
    date.setDate(date.getDate() + 1); // Preferência expira em 24 horas
    return date.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

// Inicializa os clientes da API do Mercado Pago
const mpConfig = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_TOKEN });
const mpPreference = new Preference(mpConfig);
const mpPayment = new Payment(mpConfig);

const mercadoPagoService = {
  /**
   * Cria uma preferência de pagamento no Mercado Pago para uma assinatura.
   */
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

      // CORREÇÃO: Define datas provisórias para a criação do registro.
      const effectiveStartDate = new Date();
      const endDate = new Date(effectiveStartDate);
      endDate.setDate(endDate.getDate() + plan.durationDays);

      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: effectiveStartDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      });

      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: `Assinatura Plano: ${plan.name}`,
          unit_price: Number.parseFloat(plan.price),
          quantity: 1,
          category_id: "services",
        }],
        payer: {
          name: client.name,
          email: client.email,
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/assinatura/sucesso`,
          failure: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/assinatura/erro`,
          pending: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/assinatura/pendente`,
        },
        auto_return: "approved",
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        statement_descriptor: "MAP NO CONTROLE",
        expires: true,
        expiration_date_to: getExpirationDate(),
      };

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

  /**
   * Processa notificações de webhook do Mercado Pago.
   */
  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') {
        logger.info(`[MP Webhook] Recebido evento do tipo '${dados.type}', ignorando.`);
        return;
      }
      
      const paymentId = dados.data.id;
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) {
        logger.warn("[MP Webhook] Webhook de pagamento recebido sem 'external_reference' (ID da assinatura).");
        return;
      }
      
      const subscription = await Subscription.findByPk(subscriptionId);
      if (!subscription) {
        logger.error(`[MP Webhook] CRÍTICO: Assinatura com ID ${subscriptionId} não encontrada!`);
        return;
      }
      
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        logger.info(`[MP Webhook] Pagamento APROVADO para Assinatura ID ${subscriptionId}. Ativando...`);
        await subscriptionService.activateSubscription(subscription.id, paymentData.id);
        logger.info(`[MP Webhook] Assinatura ID ${subscriptionId} ativada com sucesso.`);

      } else if (['rejected', 'cancelled'].includes(paymentData.status) && subscription.status === 'Pendente') {
        logger.warn(`[MP Webhook] Pagamento para Assinatura ID ${subscriptionId} foi '${paymentData.status}'. Atualizando status.`);
        await subscription.update({ status: 'Cancelada' });
      } else {
        logger.info(`[MP Webhook] Status de pagamento '${paymentData.status}' para Assinatura ID ${subscriptionId} recebido, nenhuma ação necessária.`);
      }

    } catch (error) {
      logger.error("Erro ao processar webhook do Mercado Pago:", error.cause || error);
      throw error;
    }
  },
};

module.exports = mercadoPagoService;
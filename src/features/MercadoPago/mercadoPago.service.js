// src/features/MercadoPago/mercadoPago.service.js
const mercadopago = require('../../config/mercadoPago');
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

// Função adaptada de 'formatDateToPreference' do seu e-commerce
function getExpirationDate() {
    const date = new Date();
    date.setDate(date.getDate() + 1); // Preferência expira em 24 horas
    return date.toISOString().replace(/\.\d{3}Z$/, "-03:00"); // Formato ISO 8601 com offset de -3h (Brasil)
}

const mercadoPagoService = {
  /**
   * Cria uma preferência de pagamento no Mercado Pago para uma assinatura.
   * Adaptado de 'criarCheckoutPro' do seu e-commerce.
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

      // 1. Cria uma assinatura PENDENTE para rastrear a tentativa de pagamento.
      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        // As datas serão definidas quando o pagamento for aprovado.
      });

      const preference = {
        items: [{
          id: plan.id.toString(),
          title: `Assinatura Plano: ${plan.name}`,
          unit_price: Number.parseFloat(plan.price),
          quantity: 1,
          category_id: "services", // Categoria para serviços/assinaturas
        }],
        payer: {
          name: client.name,
          email: client.email,
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL}/assinatura/sucesso`,
          failure: `${process.env.FRONTEND_URL}/assinatura/erro`,
          pending: `${process.env.FRONTEND_URL}/assinatura/pendente`,
        },
        auto_return: "approved",
        external_reference: subscription.id.toString(), // Mapeia o ID da Assinatura para a referência externa.
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        statement_descriptor: "MAP NO CONTROLE",
        expires: true,
        expiration_date_to: getExpirationDate(),
      };

      const response = await mercadopago.preferences.create(preference);

      // 2. Salva o ID da preferência do MP no nosso registro de assinatura.
      // É assim que o webhook saberá qual assinatura atualizar.
      await subscription.update({
        externalSubscriptionId: response.body.id
      });

      logger.info(`Preferência de pagamento MP criada (ID: ${response.body.id}) para Assinatura ID ${subscription.id}`);
      return {
        checkoutUrl: response.body.init_point,
        preferenceId: response.body.id,
      };

    } catch (error) {
      logger.error("Erro ao criar preferência de pagamento no Mercado Pago:", error.cause || error);
      throw error;
    }
  },

  /**
   * Processa notificações de webhook do Mercado Pago.
   * Adaptado de 'processarWebhook' do seu e-commerce.
   */
  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') {
        logger.info(`[MP Webhook] Recebido evento do tipo '${dados.type}', ignorando.`);
        return;
      }
      
      const paymentId = dados.data.id;
      const payment = await mercadopago.payment.findById(paymentId);
      const paymentData = payment.body;
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) {
        logger.warn("[MP Webhook] Webhook de pagamento recebido sem 'external_reference' (ID da assinatura).");
        return;
      }

      const subscription = await Subscription.findByPk(subscriptionId);
      if (!subscription) {
        logger.error(`[MP Webhook] CRÍTICO: Assinatura com ID ${subscriptionId} (da external_reference) não encontrada!`);
        return;
      }
      
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        logger.info(`[MP Webhook] Pagamento APROVADO para Assinatura ID ${subscriptionId}. Ativando assinatura...`);
        // 3. Reutiliza o serviço de assinatura existente para ativar o plano e o acesso do cliente.
        // Isso garante consistência com o fluxo do Asaas.
        await subscriptionService.activateSubscription(subscription.id, paymentData.id);
        logger.info(`[MP Webhook] Assinatura ID ${subscriptionId} ativada com sucesso.`);

      } else if (['rejected', 'cancelled'].includes(paymentData.status) && subscription.status === 'Pendente') {
        logger.warn(`[MP Webhook] Pagamento para Assinatura ID ${subscriptionId} foi '${paymentData.status}'. Atualizando status.`);
        await subscription.update({ status: 'Cancelada' });
      } else {
        logger.info(`[MP Webhook] Status de pagamento '${paymentData.status}' para Assinatura ID ${subscriptionId} recebido, nenhuma ação necessária no momento.`);
      }

    } catch (error) {
      logger.error("Erro ao processar webhook do Mercado Pago:", error.cause || error);
      throw error;
    }
  },
};

module.exports = mercadoPagoService;
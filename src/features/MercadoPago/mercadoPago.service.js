// src/features/MercadoPago/mercadoPago.service.js
const mercadopago = require('../../config/mercadoPago'); // Importa a SDK configurada
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

/**
 * Formata uma data para o padrão ISO 8601 com fuso horário,
 * exigido pelo Mercado Pago para definir a expiração do pagamento.
 * @param {Date} date - O objeto de data a ser formatado.
 * @returns {string} A data formatada.
 */
function formatDateToPreference(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const padMs = (n) => String(n).padStart(3, '0');
  
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const ms = padMs(date.getMilliseconds());
  
  const offset = -date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  const offsetSign = offset >= 0 ? '+' : '-';
  const offsetFormatted = `${offsetSign}${pad(offsetHours)}:${pad(offsetMinutes)}`;
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${offsetFormatted}`;
}

const mercadoPagoService = {
  /**
   * Cria uma preferência de pagamento no Mercado Pago (Checkout Pro) para uma assinatura de plano.
   * @param {string} clientId - O ID do cliente que está comprando.
   * @param {string} planId - O ID do plano a ser assinado.
   * @param {string|null} affiliateCode - O código de afiliado, se houver.
   * @returns {Promise<object>} O objeto de preferência completo retornado pela API do Mercado Pago.
   */
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

      // Cria a assinatura no banco de dados com status 'Pendente' antes de gerar o pagamento
      const createdSubscriptionData = await subscriptionService.createSubscription(
        clientId, planId, new Date().toISOString().split('T')[0], 'Pendente', null, affiliateCode
      );

      // Monta o payload da preferência para a API do Mercado Pago
      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: `Plano ${plan.name} - MAP no Controle`,
          description: plan.description || `Acesso ao plano ${plan.name}`,
          unit_price: Number(plan.price),
          quantity: 1,
          currency_id: 'BRL',
          category_id: "digital_goods", // Boa prática para produtos digitais
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
        statement_descriptor: "MAP NO CONTROLE",
        
        // A PARTE MAIS IMPORTANTE: EXPIRAÇÃO PARA O PIX FUNCIONAR
        expires: true,
        expiration_date_from: formatDateToPreference(new Date()),
        expiration_date_to: formatDateToPreference(new Date(Date.now() + 30 * 60 * 1000)), // Expira em 30 minutos
      };

      logger.info('[MP Checkout Pro] Payload da preferência:', JSON.stringify(preferencePayload, null, 2));

      // Cria a preferência usando a SDK do Mercado Pago
      const response = await mercadopago.preferences.create(preferencePayload);
      const preference = response.body;

      // Atualiza a assinatura com o ID da preferência gerada pelo Mercado Pago
      await Subscription.update(
        { externalSubscriptionId: preference.id },
        { where: { id: createdSubscriptionData.id } }
      );

      logger.info(`[MP Checkout Pro] Preferência criada com sucesso: ID ${preference.id}`);
      
      return preference;

    } catch (error) {
      console.error("Erro ao criar checkout:", error);
      // Lança o erro para ser tratado pela camada superior (controller)
      throw error;
    }
  },

  /**
   * Processa as notificações de webhook enviadas pelo Mercado Pago.
   * @param {object} dados - O corpo da notificação (req.body).
   */
  /**
   * Processa as notificações de webhook enviadas pelo Mercado Pago.
   * CÓDIGO FINAL E ROBUSTO.
   */
  async processarWebhook(dados) {
    try {
      logger.info('[Webhook MP] Dados recebidos:', JSON.stringify(dados, null, 2));

      // 1. Extrai o ID do recurso e o tipo de notificação de forma flexível.
      const topic = dados.type || dados.topic;
      const resourceId = dados.data?.id;

      if (!topic || !resourceId) {
        logger.warn('[Webhook MP] Webhook recebido sem "type" ou "data.id". Ignorando.', { dados });
        return;
      }
      
      logger.info(`[Webhook MP] Processando notificação. Tópico: "${topic}", ID do Recurso: ${resourceId}`);
      
      let paymentDetails;
      let subscriptionId;

      // 2. Decide qual API do Mercado Pago chamar.
      // A chamada a esta API é onde o erro "Payment not found" acontece se os tokens estiverem errados.
      if (topic === 'payment') {
        const paymentResponse = await mercadopago.payment.findById(resourceId);
        paymentDetails = paymentResponse.body;
        subscriptionId = paymentDetails.external_reference ? parseInt(paymentDetails.external_reference, 10) : null;
      
      } else if (topic.includes('preapproval') || topic.includes('subscription')) {
        const preapprovalResponse = await mercadopago.preapproval.findById(resourceId);
        paymentDetails = preapprovalResponse.body;
        subscriptionId = paymentDetails.external_reference ? parseInt(paymentDetails.external_reference, 10) : null;
      
      } else {
        logger.info(`[Webhook MP] Tópico '${topic}' não é relevante para o fluxo de ativação. Ignorando.`);
        return;
      }

      // 3. Valida e processa a assinatura.
      if (!subscriptionId) {
        logger.warn(`[Webhook MP] Recurso ${resourceId} (Tópico: ${topic}) não possui uma external_reference (ID da nossa assinatura).`);
        return;
      }
      
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });

      if (!subscription) {
        logger.warn(`[Webhook MP] Assinatura com ID ${subscriptionId} não foi encontrada no banco de dados.`);
        return;
      }
      
      const successStatuses = ['approved', 'accredited', 'authorized'];
      const failureStatuses = ['rejected', 'cancelled', 'refunded', 'charged_back'];

      if (successStatuses.includes(paymentDetails.status) && subscription.status !== 'Ativa') {
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Ativa', newEndDate.toISOString().split('T')[0], subscription.id
        );
        logger.info(`[Webhook MP] ✅ PAGAMENTO APROVADO - Assinatura ${subscription.id} ativada.`);

      } else if (failureStatuses.includes(paymentDetails.status) && subscription.status === 'Pendente') {
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Pagamento Falhou', subscription.endDate, subscription.id
        );
        logger.info(`[Webhook MP] ❌ PAGAMENTO FALHOU - Assinatura ${subscription.id}.`);
      } else {
        logger.info(`[Webhook MP] Status '${paymentDetails.status}' recebido para assinatura ${subscription.id}. Nenhuma ação necessária.`);
      }

    } catch (error) {
      const errorMessage = error.cause?.[0]?.description || error.message;
      logger.error(`[Webhook MP] Erro ao processar webhook: ${errorMessage}`, { error });
    }
  },
};
module.exports = mercadoPagoService;

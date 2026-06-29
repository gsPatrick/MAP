// src/features/MercadoPago/mercadoPago.service.js
const mercadopago = require('../../config/mercadoPago'); // Importa a SDK configurada
const { Subscription, Plan, Client } = require('../../database');
const { Op } = require('sequelize');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const crypto = require('crypto');
const { sendWhatsappMessage, pinWhatsappMessage } = require('../../services/whatsappService');
const affiliateService = require('../Affiliate/affiliate.service'); // Importe o serviço de afiliados
const onboardingHandler = require('../WhatsappHandler/onboarding.handler');

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
   * Valida a assinatura x-signature do Mercado Pago.
   * @param {string} dataId - O ID do recurso (data.id ou id).
   * @param {string} xSignature - O header x-signature.
   * @param {string} xRequestId - O header x-request-id.
   * @returns {boolean}
   */
  validateSignature(dataId, xSignature, xRequestId) {
    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    if (!secret) {
      logger.warn('[Webhook MP] Validação de assinatura pulada: MERCADO_PAGO_WEBHOOK_SECRET não definido.');
      return true; // Se não tiver secret, permitimos para não quebrar a integração antes da config
    }

    try {
      const parts = xSignature.split(',');
      let ts, v1;
      parts.forEach(part => {
        const [key, value] = part.split('=');
        if (key.trim() === 'ts') ts = value.trim();
        if (key.trim() === 'v1') v1 = value.trim();
      });

      if (!ts || !v1) return false;

      const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(manifest);
      const computedSignature = hmac.digest('hex');

      return crypto.timingSafeEqual(Buffer.from(computedSignature), Buffer.from(v1));
    } catch (error) {
      logger.error('[Webhook MP] Erro ao validar assinatura:', error);
      return false;
    }
  },

  /**
   * Busca os detalhes de um pagamento ou merchant_order e processa a atualização.
   */
  async processarNotificacao(tipo, id) {
    try {
      let paymentId = id;
      let externalReference = null;
      let status = null;

      if (tipo === 'merchant_order') {
        logger.info(`[Webhook MP] Buscando Merchant Order: ${id}`);
        const orderResponse = await mercadopago.merchant_order.findById(id);
        const orderData = orderResponse.body;

        // No Checkout Pro, o pagamento aprovado fecha a merchant_order
        // Pegamos o último pagamento vinculado
        if (orderData.payments && orderData.payments.length > 0) {
          const lastPayment = orderData.payments[orderData.payments.length - 1];
          paymentId = lastPayment.id;
          status = lastPayment.status;
        }
        externalReference = orderData.external_reference;
      } else if (tipo === 'payment') {
        logger.info(`[Webhook MP] Buscando Payment: ${id}`);
        const paymentResponse = await mercadopago.payment.findById(id);
        const paymentData = paymentResponse.body;
        status = paymentData.status;
        externalReference = paymentData.external_reference;
      }

      if (!externalReference) {
        logger.warn(`[Webhook MP] Notificação ${id} (${tipo}) sem external_reference. Ignorando.`);
        return;
      }

      const subscriptionId = parseInt(externalReference, 10);
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan', 'client'] });

      if (!subscription || !subscription.client) {
        logger.warn(`[Webhook MP] Assinatura ${subscriptionId} não encontrada para o pagamento ${paymentId}.`);
        return;
      }

      const successStatuses = ['approved', 'accredited'];
      const failureStatuses = ['rejected', 'cancelled', 'refunded', 'charged_back'];

      if (successStatuses.includes(status)) {
        // IDEMPOTÊNCIA: o Mercado Pago dispara 'payment' E 'merchant_order' para a
        // mesma aprovação (mais retentativas). Garantimos via UPDATE condicional
        // ATÔMICO que apenas UM processamento efetive a ativação. Se 0 linhas forem
        // afetadas, outra notificação já ativou -> não duplicamos comissão de
        // afiliado nem mensagens. (Renovação que cria nova Subscription 'Pendente'
        // continua funcionando, pois a transição Pendente->Ativa ocorre 1x.)
        const [claimed] = await Subscription.update(
          { status: 'Ativa' },
          { where: { id: subscription.id, status: { [Op.ne]: 'Ativa' } } }
        );
        if (claimed === 0) {
          logger.info(`[Webhook MP] Assinatura ${subscription.id} já estava ativa. Duplicata ignorada (idempotência).`);
          return;
        }

        const client = subscription.client;
        const plan = subscription.plan;

        // Verifica se já era ativo para definir se é renovação ou nova assinatura
        const wasActiveBefore = client.status === 'Ativo' && client.accessExpiresAt && new Date(client.accessExpiresAt) >= new Date();

        await subscriptionService.updateSubscriptionStatusById(subscription.id, 'Ativa', { skipMessages: true });
        logger.info(`[Webhook MP] ✅ SUCESSO - Assinatura ${subscription.id} ativada.`);

        // --- Lógica de Negócio Pós-Ativação (Copiada do original corrigida) ---
        if (client.phone) {
          const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
          const dashboardUrl = "https://www.map-nocontrole.com.br/login";
          let mainMessage, loginMessage;

          if (wasActiveBefore) {
            mainMessage = `Olá, ${clientName}! ✨\n\nSua assinatura do plano *${plan.name}* foi renovada com sucesso! Agradecemos por continuar conosco.\n\nContinue no controle! 😉`;
          } else {
            mainMessage = `🎉 Pagamento confirmado, ${clientName}! Sua assinatura do plano *${plan.name}* está ativa. Seja muito bem-vindo(a) ao MAP no Controle!`;
          }

          loginMessage = `Para acessar o painel web com todos os relatórios e gráficos, utilize:\n` +
            `🔗 *Link:* ${dashboardUrl}\n` +
            `📧 *E-mail:* ${client.email}\n` +
            `🔑 *Senha:* (a que você cadastrou)`;

          // Envio de mensagens
          await sendWhatsappMessage(client.phone, mainMessage);
          const loginMessageResponse = await sendWhatsappMessage(client.phone, loginMessage);
          if (loginMessageResponse && loginMessageResponse.messageId) {
            await pinWhatsappMessage(client.phone, loginMessageResponse.messageId, '30_days');
          }

          // Afiliados e Onboarding
          await affiliateService.processNewSubscriptionForAffiliate(subscription);
          await affiliateService.sendAffiliateLinkNotification(client);

          const isAdvancedPlan = plan.tier && (plan.tier.includes('avancado') || plan.tier.includes('vitalicio'));
          if (isAdvancedPlan && !wasActiveBefore) {
            await onboardingHandler.triggerOnboarding(client.phone, "Agora, vamos configurar sua conta empresarial rapidamente!");
          }
        }

      } else if (failureStatuses.includes(status) && subscription.status === 'Pendente') {
        await subscriptionService.updateSubscriptionStatusById(subscription.id, 'Pagamento Falhou', { skipMessages: true });
        logger.info(`[Webhook MP] ❌ FALHA - Assinatura ${subscription.id} marcada como falha.`);
      } else {
        logger.info(`[Webhook MP] Status '${status}' para assinatura ${subscription.id}. Nenhuma ação.`);
      }
    } catch (error) {
      logger.error(`[Webhook MP] Erro ao buscar dados da notificação ${id}:`, error);
    }
  },

  /**
   * Processa as notificações de webhook enviadas pelo Mercado Pago.
   * @param {object} dados - O corpo da notificação (req.body).
   */
  // Dentro do objeto 'mercadoPagoService'
  /**
   * <<< VERSÃO FINAL E COMPLETA >>>
   * Processa as notificações de webhook enviadas pelo Mercado Pago,
   * lidando com ativação, renovação, onboarding, afiliados e notificações.
   * @param {object} dados - O corpo da notificação (req.body).
   */
  processarWebhook: async (dados, headers = {}) => {
    try {
      logger.info('[Webhook MP] Notificação recebida:', JSON.stringify(dados, null, 2));

      // 1. Identificação do Tipo e ID (Suporte a V2 e IPN)
      const notificationType = dados.type || dados.topic;
      const resourceId = dados.data?.id || dados.id;

      if (!['payment', 'merchant_order'].includes(notificationType)) {
        logger.info(`[Webhook MP] Tipo '${notificationType}' ignorado.`);
        return;
      }

      if (!resourceId) {
        logger.warn('[Webhook MP] ID do recurso não encontrado.');
        return;
      }

      // 2. Validação de Assinatura (Opcional se secret não configurado)
      const xSignature = headers['x-signature'];
      const xRequestId = headers['x-request-id'];
      if (xSignature && xRequestId) {
        const isValid = mercadoPagoService.validateSignature(resourceId, xSignature, xRequestId);
        if (!isValid) {
          logger.error(`[Webhook MP] Assinatura INVÁLIDA para recurso ${resourceId}.`);
          return;
        }
        logger.info(`[Webhook MP] Assinatura validada com sucesso para ${resourceId}.`);
      }

      // 3. Processamento
      await mercadoPagoService.processarNotificacao(notificationType, resourceId);

    } catch (error) {
      logger.error("[Webhook MP] Erro crítico no processarWebhook:", error);
    }
  },
};

module.exports = mercadoPagoService;

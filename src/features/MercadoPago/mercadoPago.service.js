// src/features/MercadoPago/mercadoPago.service.js
const mercadopago = require('../../config/mercadoPago'); // Importa a SDK configurada
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { sendWhatsappMessage, pinWhatsappMessage } = require('../../services/whatsappService');
const affiliateService = require('../Affiliate/affiliate.service'); // Importe o serviço de afiliados

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
// Dentro do objeto 'mercadoPagoService'
  /**
   * <<< VERSÃO FINAL E COMPLETA >>>
   * Processa as notificações de webhook enviadas pelo Mercado Pago,
   * lidando com ativação, renovação, onboarding, afiliados e notificações.
   * @param {object} dados - O corpo da notificação (req.body).
   */
  processarWebhook: async (dados) => {
    try {
      logger.info('[Webhook MP] Dados recebidos:', JSON.stringify(dados, null, 2));

      // 1. Validação inicial do Webhook
      if (dados.type !== 'payment') {
        logger.info(`[Webhook MP] Tipo '${dados.type}' ignorado.`);
        return;
      }
      
      const paymentId = dados.data.id;
      logger.info(`[Webhook MP] Processando pagamento: ${paymentId}`);
      
      const paymentResponse = await mercadopago.payment.findById(paymentId);
      const paymentData = paymentResponse.body;
      
      logger.info(`[Webhook MP] Dados do pagamento: status ${paymentData.status}, ref ${paymentData.external_reference}`);
      
      if (!paymentData.external_reference) {
        logger.warn(`[Webhook MP] Pagamento ${paymentId} sem external_reference. Ignorando.`);
        return;
      }
      
      const subscriptionId = parseInt(paymentData.external_reference, 10);
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan', 'client'] });

      if (!subscription || !subscription.client) {
        logger.warn(`[Webhook MP] Assinatura ${subscriptionId} ou cliente associado não encontrado. Ignorando.`);
        return;
      }
      
      // 2. Extração de Variáveis para Clareza
      const client = subscription.client;
      const plan = subscription.plan;
      const successStatuses = ['approved', 'accredited'];
      const failureStatuses = ['rejected', 'cancelled', 'refunded', 'charged_back'];

      // 3. Lógica Principal: Pagamento Aprovado
      if (successStatuses.includes(paymentData.status) && subscription.status !== 'Ativa') {
        const wasActiveBefore = client.status === 'Ativo' && client.accessExpiresAt && new Date(client.accessExpiresAt) >= new Date();

        await subscriptionService.updateSubscriptionStatusByExternalId(null, 'Ativa', null, subscription.id);
        logger.info(`[Webhook MP] ✅ PAGAMENTO APROVADO - Assinatura ${subscription.id} ativada para o cliente ${client.id}.`);
        
        // Se o cliente tem WhatsApp, inicia o fluxo de comunicação
        if (client.phone) {
            const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
            const dashboardUrl = "https://www.map-nocontrole.com.br/login";
            let mainMessage, loginMessage;

            // Define se é uma mensagem de boas-vindas ou de renovação
            if (wasActiveBefore) {
                mainMessage = `Olá, ${clientName}! ✨\n\nSua assinatura do plano *${plan.name}* foi renovada com sucesso! Agradecemos por continuar conosco.\n\nContinue no controle! 😉`;
            } else {
                mainMessage = `🎉 Pagamento confirmado, ${clientName}! Sua assinatura do plano *${plan.name}* está ativa. Seja muito bem-vindo(a) ao MAP no Controle!`;
            }

            // Define a mensagem de login que será fixada
            loginMessage = `Para acessar o painel web com todos os relatórios e gráficos, utilize:\n`+
                           `🔗 *Link:* ${dashboardUrl}\n` +
                           `📧 *E-mail:* ${client.email}\n` +
                           `🔑 *Senha:* (a que você cadastrou)`;

            // --- Orquestração do Envio de Mensagens ---
            
            // Passo A: Envia a mensagem principal (Boas-vindas ou Renovação)
            await sendWhatsappMessage(client.phone, mainMessage);

            // Passo B: Envia a mensagem de login e tenta fixá-la
            const loginMessageResponse = await sendWhatsappMessage(client.phone, loginMessage);
            if (loginMessageResponse && loginMessageResponse.messageId) {
                await pinWhatsappMessage(client.phone, loginMessageResponse.messageId, '30_days');
            }

            // Passo C: Processa a comissão para quem o indicou
            await affiliateService.processNewSubscriptionForAffiliate(client.id);

            // Passo D: Envia para o NOVO cliente o SEU PRÓPRIO link de afiliado
            await affiliateService.sendAffiliateLinkNotification(client);

            // Passo E: Inicia o onboarding, se for a primeira ativação de um plano avançado
            const isAdvancedPlan = plan.tier.includes('avancado') || plan.tier.includes('vitalicio');
            if (isAdvancedPlan && !wasActiveBefore) {
                await onboardingHandler.triggerOnboarding(client.phone, "Agora, vamos configurar sua conta empresarial rapidamente!");
            }
        }

      // 4. Lógica de Falha no Pagamento
      } else if (failureStatuses.includes(paymentData.status) && subscription.status === 'Pendente') {
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Pagamento Falhou', subscription.endDate, subscription.id
        );
        logger.info(`[Webhook MP] ❌ PAGAMENTO FALHOU - Assinatura ${subscription.id}.`);
      } else {
        logger.info(`[Webhook MP] Status '${paymentData.status}' recebido para assinatura ${subscription.id}. Nenhuma ação necessária.`);
      }

    } catch (error) {
      console.error("[Webhook MP] Erro ao processar webhook:", error);
    }
  },
};

module.exports = mercadoPagoService;

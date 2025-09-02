// src/features/MercadoPago/mercadoPago.service.js
// <<< ALTERAÇÃO: Importamos os clientes 'preference' e 'payment' já configurados >>>
const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

// <<< NOVO: Função para formatar a data para o padrão do Mercado Pago >>>
function formatDateToPreference(date) {
  // Esta função é idêntica à do Código 02 e está correta
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
        statement_descriptor: "MAP NO CONTROLE", // <<< NOVO: Texto na fatura do cliente

        // <<< CORREÇÃO CRÍTICA: Configuração de expiração ESSENCIAL para o PIX >>>
        expires: true,
        expiration_date_from: formatDateToPreference(new Date()),
        expiration_date_to: formatDateToPreference(new Date(Date.now() + 30 * 60 * 1000)), // Expira em 30 minutos

        payment_methods: {
          excluded_payment_methods: [],
          excluded_payment_types: [],
          installments: 12
        }
      };

      logger.info('[MP Checkout Pro] Payload da preferência:', JSON.stringify(preferencePayload, null, 2));

      // <<< ALTERAÇÃO: A chamada usa a sintaxe da NOVA SDK, passando o payload dentro de um objeto 'body' >>>
      const preference = await mpPreference.create({ body: preferencePayload });

      await Subscription.update(
        { externalSubscriptionId: preference.id },
        { where: { id: createdSubscriptionData.id } }
      );

      logger.info(`[MP Checkout Pro] Preferência criada com sucesso:`, {
        id: preference.id,
        init_point: preference.init_point,
      });
      
      return preference;

    } catch (error) {
      const apiError = error.cause?.data || error.message;
      logger.error(`[MP Checkout Pro] Erro detalhado:`, {
        message: error.message,
        apiResponse: apiError,
        stack: error.stack
      });
      const errorMessage = apiError?.message || error.message || 'Falha ao iniciar o processo de pagamento.';
      throw new Error(errorMessage);
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
      
      // <<< ALTERAÇÃO: A chamada usa a sintaxe da NOVA SDK para buscar o pagamento >>>
      const paymentData = await mpPayment.get({ id: paymentId });
      
      logger.info(`[Webhook MP] Dados do pagamento:`, {
        id: paymentData.id,
        status: paymentData.status,
        external_reference: paymentData.external_reference,
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
      
      // A lógica de atualização de status permanece a mesma, pois é interna do seu sistema
      const successStatuses = ['approved', 'accredited'];
      const failureStatuses = ['rejected', 'cancelled', 'refunded', 'charged_back'];

      if (successStatuses.includes(paymentData.status) && subscription.status !== 'Ativa') {
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Ativa', newEndDate.toISOString().split('T')[0], subscription.id
        );
        logger.info(`[Webhook MP] ✅ PAGAMENTO APROVADO - Assinatura ${subscription.id} ativada.`);

      } else if (failureStatuses.includes(paymentData.status) && subscription.status === 'Pendente') {
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Pagamento Falhou', subscription.endDate, subscription.id
        );
        logger.info(`[Webhook MP] ❌ PAGAMENTO FALHOU - Assinatura ${subscription.id}.`);

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
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
        // CORREÇÃO PRINCIPAL: Configurar métodos de pagamento para incluir PIX
        payment_methods: {
          excluded_payment_methods: [], // Não excluir nenhum método
          excluded_payment_types: [],   // Não excluir nenhum tipo
          installments: 12,             // Permitir até 12 parcelas no cartão
          default_installments: 1,      // Padrão em 1x
        },
        // ADIÇÃO: Configurar explicitamente o PIX
        payment_methods_configuration: {
          pix: {
            expiration_date: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // PIX expira em 30 minutos
          }
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL}/payment-success`,
          failure: `${process.env.FRONTEND_URL}/payment-failure`,
          pending: `${process.env.FRONTEND_URL}/payment-pending`,
        },
        auto_return: 'approved',
        external_reference: createdSubscriptionData.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        // ADIÇÃO: Configurações extras para melhor experiência
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Preferência expira em 24h
        // CORREÇÃO: Definir métodos permitidos explicitamente
        payment_methods: {
          excluded_payment_methods: [],
          excluded_payment_types: [],
          installments: 12,
          default_payment_method_id: null,
          // Forçar a inclusão do PIX
          included_payment_methods: ['pix'],
        }
      };

      // Log para debug da configuração
      logger.info('[MP Checkout Pro] Payload da preferência:', JSON.stringify(preferencePayload, null, 2));

      const preference = await mpPreference.create({ body: preferencePayload });

      await Subscription.update(
        { externalSubscriptionId: preference.id },
        { where: { id: createdSubscriptionData.id } }
      );

      logger.info(`[MP Checkout Pro] Preferência ID: ${preference.id} criada e associada à Assinatura ID ${createdSubscriptionData.id}.`);
      
      // Log da resposta da preferência para debug
      logger.info(`[MP Checkout Pro] Resposta da preferência:`, {
        id: preference.id,
        init_point: preference.init_point,
        sandbox_init_point: preference.sandbox_init_point
      });

      return preference;

    } catch (error) {
      const errorMessage = error.cause?.data?.message || error.cause?.message || error.message;
      logger.error(`[MP Checkout Pro] Erro ao criar preferência de pagamento:`, { 
        message: errorMessage, 
        data: error.cause?.data,
        fullError: error
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
      
      // Log adicional para debug do status do pagamento PIX
      logger.info(`[Webhook MP] Dados do pagamento recebidos:`, {
        id: paymentData.id,
        status: paymentData.status,
        payment_method_id: paymentData.payment_method_id,
        payment_type_id: paymentData.payment_type_id,
        external_reference: paymentData.external_reference
      });
      
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
      
      // Status de sucesso mais abrangentes para PIX
      const successStatuses = ['approved', 'accredited'];
      // Status específicos do PIX que podem precisar de tratamento especial
      const pixPendingStatuses = ['pending', 'in_process'];
      const failureStatuses = ['rejected', 'cancelled', 'refunded', 'charged_back'];

      if (successStatuses.includes(paymentData.status) && subscription.status !== 'Ativa') {
        // Pagamento aprovado - ativar assinatura
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Ativa', newEndDate.toISOString().split('T')[0], subscription.id
        );
        logger.info(`[Webhook MP] Assinatura ${subscription.id} ATIVADA com sucesso via ${paymentData.payment_method_id} status '${paymentData.status}'.`);

      } else if (pixPendingStatuses.includes(paymentData.status) && paymentData.payment_method_id === 'pix') {
        // PIX pendente - manter como pendente mas logar
        logger.info(`[Webhook MP] PIX em processamento para assinatura ${subscription.id} - status '${paymentData.status}'.`);
        
      } else if (failureStatuses.includes(paymentData.status) && subscription.status === 'Pendente') {
        // Pagamento falhou
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Pagamento Falhou', subscription.endDate, subscription.id
        );
        logger.info(`[Webhook MP] Assinatura ${subscription.id} marcada como 'Pagamento Falhou' via ${paymentData.payment_method_id} status '${paymentData.status}'.`);

      } else {
        // Log detalhado para outros casos
        logger.info(`[Webhook MP] Status '${paymentData.status}' via ${paymentData.payment_method_id} para assinatura ${subscription.id} (status atual: '${subscription.status}'). Nenhuma ação necessária.`);
      }

    } catch (error) {
      logger.error("[Webhook MP] Erro fatal ao processar webhook:", {
        message: error.message,
        cause: error.cause,
        stack: error.stack
      });
    }
  },
};

module.exports = mercadoPagoService;
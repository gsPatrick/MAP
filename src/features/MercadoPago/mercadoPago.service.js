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

      // PAYLOAD OTIMIZADO ESPECIFICAMENTE PARA PIX FUNCIONAR
      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: `Plano ${plan.name} - MAP no Controle`,
          description: plan.description || `Acesso ao plano ${plan.name}`,
          unit_price: parseFloat(plan.price),
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
        // CONFIGURAÇÕES ESSENCIAIS PARA PIX
        payment_methods: {
          excluded_payment_methods: [],
          excluded_payment_types: [],
          installments: 12,
          default_installments: 1
        },
        // OBRIGATÓRIO PARA PIX EM PRODUÇÃO
        statement_descriptor: "MAP no Controle",
        // CONFIGURAR EXPIRAÇÃO (PIX precisa disso)
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        // CONFIGURAÇÕES ADICIONAIS PARA PIX
        additional_info: {
          items: [{
            id: plan.id.toString(),
            title: `Plano ${plan.name}`,
            description: plan.description || `Acesso ao plano ${plan.name}`,
            picture_url: null,
            category_id: "services",
            quantity: 1,
            unit_price: parseFloat(plan.price)
          }],
          payer: {
            first_name: client.name.split(' ')[0] || client.name,
            last_name: client.name.split(' ').slice(1).join(' ') || '',
            phone: {
              area_code: "11",
              number: "999999999"
            },
            address: {
              street_name: "Rua Exemplo",
              street_number: 123,
              zip_code: "01234567"
            }
          },
          shipments: {
            receiver_address: {
              zip_code: "01234567",
              street_name: "Rua Exemplo",
              street_number: 123,
              floor: "",
              apartment: ""
            }
          }
        }
      };

      logger.info('[MP Checkout Pro] Payload PIX enviado:', JSON.stringify(preferencePayload, null, 2));

      const preference = await mpPreference.create({ body: preferencePayload });

      await Subscription.update(
        { externalSubscriptionId: preference.id },
        { where: { id: createdSubscriptionData.id } }
      );

      logger.info(`[MP Checkout Pro] Preferência ID: ${preference.id} criada com PIX habilitado`);
      logger.info(`[MP Checkout Pro] Init Point: ${preference.init_point}`);
      
      return preference;

    } catch (error) {
      // Log completo do erro para debug do PIX
      logger.error(`[MP Checkout Pro] ERRO COMPLETO PIX:`, {
        message: error.message,
        cause: error.cause,
        data: error.cause?.data,
        response: error.response?.data,
        status: error.status || error.statusCode,
        config: error.config
      });

      const errorMessage = error.cause?.data?.message || 
                          error.response?.data?.message || 
                          error.cause?.message || 
                          error.message;
      
      throw new Error(errorMessage || 'Falha ao criar preferência PIX.');
    }
  },

  async processarWebhook(dados) {
    try {
      logger.info('[Webhook MP] Webhook PIX recebido:', JSON.stringify(dados, null, 2));

      if (dados.type !== 'payment') {
        logger.info(`[Webhook MP] Notificação do tipo '${dados.type}' ignorada.`);
        return;
      }
      
      const paymentId = dados.data.id;
      const paymentData = await mpPayment.get({ id: paymentId });
      
      logger.info(`[Webhook MP] Pagamento PIX processado:`, {
        id: paymentData.id,
        status: paymentData.status,
        payment_method_id: paymentData.payment_method_id,
        payment_type_id: paymentData.payment_type_id,
        transaction_amount: paymentData.transaction_amount,
        external_reference: paymentData.external_reference,
        date_created: paymentData.date_created,
        date_approved: paymentData.date_approved
      });
      
      if (!paymentData.external_reference) {
        logger.warn(`[Webhook MP] PIX ${paymentId} sem external_reference.`);
        return;
      }
      
      const subscriptionId = parseInt(paymentData.external_reference, 10);
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });

      if (!subscription) {
        logger.warn(`[Webhook MP] Assinatura PIX ${subscriptionId} não encontrada.`);
        return;
      }
      
      // Status específicos do PIX
      const successStatuses = ['approved', 'accredited'];
      const pendingStatuses = ['pending', 'in_process'];
      const failureStatuses = ['rejected', 'cancelled', 'refunded', 'charged_back'];

      if (successStatuses.includes(paymentData.status)) {
        if (subscription.status !== 'Ativa') {
          const newEndDate = new Date();
          newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
          
          await subscriptionService.updateSubscriptionStatusByExternalId(
            null, 'Ativa', newEndDate.toISOString().split('T')[0], subscription.id
          );
          
          logger.info(`[Webhook MP] ✅ PIX APROVADO - Assinatura ${subscription.id} ATIVADA`);
        }
      } else if (pendingStatuses.includes(paymentData.status)) {
        logger.info(`[Webhook MP] ⏳ PIX PENDENTE - Assinatura ${subscription.id} aguardando`);
      } else if (failureStatuses.includes(paymentData.status)) {
        if (subscription.status === 'Pendente') {
          await subscriptionService.updateSubscriptionStatusByExternalId(
            null, 'Pagamento Falhou', subscription.endDate, subscription.id
          );
          logger.info(`[Webhook MP] ❌ PIX FALHOU - Assinatura ${subscription.id}`);
        }
      }

    } catch (error) {
      logger.error("[Webhook MP] Erro PIX webhook:", {
        message: error.message,
        stack: error.stack
      });
    }
  },
};

module.exports = mercadoPagoService;
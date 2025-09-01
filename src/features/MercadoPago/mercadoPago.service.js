// src/features/MercadoPago/mercadoPago.service.js
const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

const mercadoPagoService = {
  /**
   * [VERSÃO FINAL E CORRIGIDA] Cria uma preferência de pagamento flexível para o Payment Brick.
   */
  async createPaymentPreference(clientId, planId) {
    logger.info(`[MP Pref Final] Criando preferência para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);
      if (!client || !plan) throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };

      const subscription = await Subscription.create({
        clientId, planId, status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });

      const preferencePayload = {
        items: [{
          id: plan.id.toString(), title: plan.name,
          unit_price: Number(plan.price), quantity: 1, currency_id: 'BRL',
        }],
        payer: { email: client.email, name: client.name },
        // <<< CORREÇÃO 1: Habilitando PIX e Cartões Corretamente >>>
        // Apenas excluímos boleto, que não é instantâneo. O Brick mostrará as opções restantes.
        payment_methods: {
          excluded_payment_types: [{ id: "ticket" }],
          installments: 1,
        },
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        purpose: 'wallet_purchase',
      };

      const preference = await mpPreference.create({ body: preferencePayload });
      await subscription.update({ externalSubscriptionId: preference.id });

      logger.info(`[MP Pref Final] Preferência ID: ${preference.id} criada para Assinatura ID ${subscription.id}`);
      return { preferenceId: preference.id };
    } catch (error) {
      logger.error("Erro ao criar preferência de pagamento final:", error.cause || error);
      throw new Error('Falha ao preparar o ambiente de pagamento.');
    }
  },

  /**
   * [VERSÃO FINAL E CORRIGIDA] Processa os dados de pagamento enviados pelo 'onSubmit' do Payment Brick.
   */
  async processBrickPayment(clientId, planId, paymentData) {
    logger.info(`[MP Process Final] Processando pagamento do Brick para Cliente ID: ${clientId}`);
    try {
      const plan = await Plan.findByPk(planId);
      if (!plan) throw { statusCode: 404, message: 'Plano não encontrado.' };

      const subscription = await Subscription.findOne({
          where: { clientId, planId, status: 'Pendente' }, order: [['createdAt', 'DESC']],
      });
      if (!subscription) throw { statusCode: 404, message: 'Assinatura pendente não encontrada.'};

      // <<< CORREÇÃO 2: Formato da Data de Expiração do PIX >>>
      const expirationDate = new Date();
      expirationDate.setMinutes(expirationDate.getMinutes() + 30);
      const formattedExpirationDate = expirationDate.toISOString().slice(0, 23) + "-03:00";

      const paymentPayload = {
        ...paymentData,
        transaction_amount: Number(plan.price),
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        ...(paymentData.payment_method_id === 'pix' && { date_of_expiration: formattedExpirationDate }),
      };
      
      const paymentResponse = await mpPayment.create({ body: paymentPayload });
      await subscription.update({ externalSubscriptionId: paymentResponse.id.toString() });

      logger.info(`[MP Process Final] Pagamento ID ${paymentResponse.id} criado via Brick.`);
      return paymentResponse;
    } catch (error) {
      const errorMessage = error.cause?.data?.message || error.cause?.message || error.message;
      logger.error('Erro ao processar pagamento do Brick final:', { message: errorMessage, data: error.cause?.data });
      throw new Error(errorMessage || 'Falha ao processar o pagamento.');
    }
  },
  
  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') return;
      
      const paymentId = dados.data.id;
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) return;
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });
      if (!subscription) return;
      
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, 'Ativa', newEndDate.toISOString().split('T')[0], subscription.id
        );
      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status !== 'Cancelada') {
        await subscription.update({ status: 'Cancelada' });
      } 
      // <<< CORREÇÃO 3: Tratamento do Status PENDENTE (para PIX) >>>
      else if (paymentData.status === "pending" && subscription.status !== 'Pendente') {
        // Apenas para garantir que o status no nosso DB reflita o status do MP
        await subscription.update({ status: 'Pendente' });
        logger.info(`[Webhook] Assinatura ID ${subscription.id} marcada como Pendente, aguardando pagamento PIX.`);
      }
    } catch (error) {
      logger.error("Erro fatal ao processar webhook do Mercado Pago:", error.cause || error);
    }
  },
};

module.exports = mercadoPagoService;
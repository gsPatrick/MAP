// src/features/MercadoPago/mercadoPago.service.js
const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

const mercadoPagoService = {
  /**
   * Cria uma preferência de pagamento no Mercado Pago (Checkout Pro).
   * O cliente será redirecionado para o site do MP para concluir o pagamento.
   * @param {number} clientId - ID do cliente que está comprando.
   * @param {number} planId - ID do plano que está sendo comprado.
   * @param {string | null} affiliateCode - Código de afiliado da transação, se houver.
   * @returns {Promise<object>} Objeto da preferência criada, incluindo a URL de pagamento (init_point).
   */
  async createCheckoutProPreference(clientId, planId, affiliateCode = null) {
    logger.info(`[MP Checkout Pro] Criando preferência para Cliente ID: ${clientId}, Plano ID: ${planId}`);
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }

      // Cria uma assinatura com status 'Pendente' que será confirmada pelo webhook
      // Passamos o affiliateCode para o serviço de assinatura para que ele possa registrar o indicador
      const subscription = await subscriptionService.createSubscription(
        clientId,
        planId,
        new Date().toISOString().split('T')[0], // Inicia hoje
        'Pendente', // Status inicial
        null, // ID externo será preenchido depois
        affiliateCode // Código de afiliado
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
          phone: {
            // Garante que o número de telefone esteja em um formato aceitável
            number: client.phone.length > 8 ? client.phone : `999999999`, // Fallback
            area_code: client.phone.substring(0,2) || `99` // Fallback
          }
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL}/payment-success`,
          failure: `${process.env.FRONTEND_URL}/payment-failure`,
          pending: `${process.env.FRONTEND_URL}/payment-pending`,
        },
        auto_return: 'approved',
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
      };

      const preference = await mpPreference.create({ body: preferencePayload });

      // Atualiza a assinatura com o ID da preferência para rastreamento
      await subscription.update({ externalSubscriptionId: preference.id });

      logger.info(`[MP Checkout Pro] Preferência ID: ${preference.id} criada para Assinatura ID ${subscription.id}. URL: ${preference.init_point}`);
      
      return preference; // Retorna o objeto completo, o controller enviará o init_point

    } catch (error) {
      logger.error("[MP Checkout Pro] Erro ao criar preferência de pagamento:", error.cause || error.message || error);
      throw new Error('Falha ao iniciar o processo de pagamento.');
    }
  },

  /**
   * Processa notificações de webhook recebidas do Mercado Pago.
   * @param {object} dados - O corpo da notificação de webhook.
   */
  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') {
        logger.info(`[Webhook MP] Notificação do tipo '${dados.type}' ignorada.`);
        return;
      }
      
      const paymentId = dados.data.id;
      logger.info(`[Webhook MP] Processando notificação para o pagamento ID: ${paymentId}`);
      
      const paymentData = await mpPayment.get({ id: paymentId });
      
      if (!paymentData.external_reference) {
        logger.warn(`[Webhook MP] Pagamento ${paymentId} não possui 'external_reference'. Impossível processar.`);
        return;
      }
      
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });
      if (!subscription) {
        logger.warn(`[Webhook MP] Assinatura com ID ${subscriptionId} (ref. externa) não foi encontrada no banco.`);
        return;
      }
      
      logger.info(`[Webhook MP] Assinatura ID ${subscription.id} encontrada. Status do pagamento no MP: '${paymentData.status}'. Status atual da assinatura: '${subscription.status}'.`);
      
      // Ativa a assinatura se o pagamento foi aprovado E a assinatura ainda não está ativa
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);

        // A função do service já lida com a ativação do cliente e comissão do afiliado
        await subscriptionService.updateSubscriptionStatusByExternalId(
          null, // Não precisamos do ID externo aqui
          'Ativa', 
          newEndDate.toISOString().split('T')[0], 
          subscription.id // Usamos o ID direto da assinatura
        );
        logger.info(`[Webhook MP] Assinatura ${subscription.id} ATIVADA com sucesso.`);

      // Atualiza para 'Pagamento Falhou' ou 'Cancelada'
      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status === 'Pendente') {
         await subscriptionService.updateSubscriptionStatusByExternalId(
          null,
          'Pagamento Falhou',
          subscription.endDate, // Mantém a data de fim original
          subscription.id
        );
        logger.info(`[Webhook MP] Assinatura ${subscription.id} marcada como 'Pagamento Falhou' devido ao status '${paymentData.status}'.`);
      } else {
        logger.info(`[Webhook MP] Nenhuma ação necessária para o status '${paymentData.status}' ou a assinatura já está no estado correto.`);
      }

    } catch (error) {
      logger.error("[Webhook MP] Erro fatal ao processar webhook do Mercado Pago:", error.cause || error.message || error);
    }
  },
};

module.exports = mercadoPagoService;
// src/features/MercadoPago/mercadoPago.service.js

const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

// Helper para obter a data de expiração da preferência (3 dias a partir de agora)
function getExpirationDate() {
    const date = new Date();
    date.setDate(date.getDate() + 3); 
    return date.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

const mercadoPagoService = {
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

      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });

      const [firstName, ...lastNameParts] = (client.name || 'Cliente').split(' ');
      const lastName = lastNameParts.join(' ') || firstName;

      const preferencePayload = {
        purpose: 'wallet_purchase',

        items: [{
          id: plan.id.toString(),
          // <<< CORREÇÃO 1: Título padronizado e seguro >>>
          // Usamos o nome do plano, que é mais descritivo do que um título genérico.
          // Isso ajuda o usuário a identificar a compra.
          title: plan.name, 
          description: `Assinatura do plano ${plan.name} para o MAP no Controle.`, // Descrição opcional, mas útil
          // <<< CORREÇÃO 2: Garantia de formato numérico correto para o preço >>>
          // Evita problemas de arredondamento com valores como 39.90
          unit_price: Math.round(plan.price * 100) / 100,
          quantity: 1,
          currency_id: 'BRL',
        }],
        
        payer: {
          name: firstName,
          surname: lastName,
          email: client.email,
        },
        
        payment_methods: {
            excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
            installments: 1
        },

        back_urls: {
          success: `${process.env.FRONTEND_URL}/assinatura/sucesso`,
          failure: `${process.env.FRONTEND_URL}/assinatura/erro`,
          pending: `${process.env.FRONTEND_URL}/assinatura/pendente`,
        },
        auto_return: "approved",
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        statement_descriptor: "MAP NO CONTROLE",
        binary_mode: true,
        expiration_date_of: getExpirationDate(),
      };

      const response = await mpPreference.create({ body: preferencePayload });

      // Atualiza a assinatura com o ID da preferência para rastreamento no webhook
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

  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') {
        logger.debug("[MP Webhook] Webhook recebido não é do tipo 'payment'. Ignorando.");
        return;
      }
      
      const paymentId = dados.data.id;
      logger.info(`[MP Webhook] Processando pagamento ID: ${paymentId}`);
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) {
        logger.warn(`[MP Webhook] Webhook para pagamento ${paymentId} não continha 'external_reference'. Ignorando.`);
        return;
      }
      
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });
      if (!subscription) {
        logger.error(`[MP Webhook] CRÍTICO: Assinatura com ID ${subscriptionId} (da external_reference) não encontrada no banco de dados!`);
        return;
      }
      
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        logger.info(`[MP Webhook] Pagamento ${paymentId} APROVADO para assinatura ${subscriptionId}. Atualizando status para 'Ativa'.`);
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        
        await subscriptionService.updateSubscriptionStatusByExternalId(
          subscription.externalSubscriptionId, 
          'Ativa', 
          newEndDate.toISOString().split('T')[0]
        );
      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status !== 'Cancelada') {
        logger.info(`[MP Webhook] Pagamento ${paymentId} com status '${paymentData.status}' para assinatura ${subscriptionId}. Atualizando status para 'Cancelada'.`);
        await subscription.update({ status: 'Cancelada' });
      } else {
        logger.info(`[MP Webhook] Status do pagamento ${paymentId} é '${paymentData.status}'. Nenhuma ação necessária para a assinatura ${subscriptionId} (status atual: ${subscription.status}).`);
      }

    } catch (error) {
      logger.error("Erro fatal ao processar webhook do Mercado Pago:", error.cause || error);
    }
  },
};

module.exports = mercadoPagoService;
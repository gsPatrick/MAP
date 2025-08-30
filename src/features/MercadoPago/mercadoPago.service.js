// src/features/MercadoPago/mercadoPago.service.js

// 1. IMPORTAÇÃO DAS INSTÂNCIAS JÁ CONFIGURADAS E MODELOS
const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

// Função auxiliar para definir a data de expiração da preferência de pagamento
function getExpirationDate() {
    const date = new Date();
    // Define a expiração para 24 horas a partir de agora
    date.setDate(date.getDate() + 1); 
    // Formata a data para o padrão ISO 8601 com fuso horário -03:00 (padrão de Brasília)
    return date.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

const mercadoPagoService = {
  /**
   * Cria uma preferência de pagamento no Mercado Pago para uma assinatura.
   * @param {number} clientId - ID do cliente que está assinando.
   * @param {number} planId - ID do plano que está sendo assinado.
   * @returns {Promise<{checkoutUrl: string, preferenceId: string}>}
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

      // Calcula as datas de início e fim da assinatura
      const effectiveStartDate = new Date();
      const endDate = new Date(effectiveStartDate);
      endDate.setDate(endDate.getDate() + plan.durationDays);

      // Cria um registro de assinatura com status "Pendente" no banco de dados
      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: effectiveStartDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      });

      // Monta o payload completo para a API do Mercado Pago
      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: `Assinatura Plano: ${plan.name}`,
          unit_price: Number.parseFloat(plan.price),
          quantity: 1,
          category_id: "services", // Categoria para produtos digitais/serviços
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
        external_reference: subscription.id.toString(), // Vincula a preferência à nossa assinatura
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`, // URL para receber webhooks
        statement_descriptor: "MAP NO CONTROLE", // O que aparece na fatura do cartão
        expires: true,
        expiration_date_to: getExpirationDate(),
        // A LINHA CRÍTICA QUE CORRIGE O ERRO NO APLICATIVO MÓVEL
        purpose: 'wallet_purchase',
      };

      // Cria a preferência de pagamento usando a instância da SDK
      const response = await mpPreference.create({ body: preferencePayload });

      // Atualiza nossa assinatura com o ID da preferência do MP para referência futura
      await subscription.update({
        externalSubscriptionId: response.id
      });

      logger.info(`Preferência de pagamento MP criada (ID: ${response.id}) para Assinatura ID ${subscription.id}`);
      
      return {
        checkoutUrl: response.init_point, // URL de checkout para redirecionar o cliente
        preferenceId: response.id,
      };

    } catch (error) {
      // O `.cause` geralmente contém o erro detalhado da SDK do Mercado Pago
      logger.error("Erro ao criar preferência de pagamento no Mercado Pago:", error.cause || error);
      throw error;
    }
  },

  /**
   * Processa notificações de webhook recebidas do Mercado Pago.
   * @param {object} dados - O corpo do webhook recebido.
   */
  async processarWebhook(dados) {
    try {
      // Processa apenas eventos do tipo "pagamento"
      if (dados.type !== 'payment') {
        logger.info(`[MP Webhook] Recebido evento do tipo '${dados.type}', ignorando.`);
        return;
      }
      
      const paymentId = dados.data.id;
      // Busca os dados completos do pagamento
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) {
        logger.warn("[MP Webhook] Webhook de pagamento recebido sem 'external_reference', não é possível processar.");
        return;
      }
      
      const subscription = await Subscription.findByPk(subscriptionId);
      if (!subscription) {
        logger.error(`[MP Webhook] CRÍTICO: Assinatura com ID ${subscriptionId} (da external_reference) não foi encontrada no banco de dados!`);
        return;
      }
      
      // Lógica de atualização de status baseada na resposta do webhook
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        logger.info(`[MP Webhook] Pagamento APROVADO para Assinatura ID ${subscriptionId}. Ativando...`);
        // A data de expiração da assinatura será calculada pelo serviço de assinatura
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        
        await subscriptionService.updateSubscriptionStatusByExternalId(subscription.externalSubscriptionId, 'Ativa', newEndDate.toISOString().split('T')[0]);
        logger.info(`[MP Webhook] Assinatura ID ${subscriptionId} ativada com sucesso.`);

      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status !== 'Cancelada') {
        logger.warn(`[MP Webhook] Pagamento para Assinatura ID ${subscriptionId} foi '${paymentData.status}'. Atualizando para Cancelada.`);
        await subscription.update({ status: 'Cancelada' });
        // Aqui você pode adicionar lógica para rebaixar o plano do usuário se necessário

      } else {
        logger.info(`[MP Webhook] Status de pagamento '${paymentData.status}' para Assinatura ID ${subscriptionId} recebido, nenhuma ação necessária no momento.`);
      }

    } catch (error) {
      logger.error("Erro fatal ao processar webhook do Mercado Pago:", error.cause || error);
      // Não re-lança o erro para evitar que o webhook tente reenviar indefinidamente por um erro de lógica interna
    }
  },
};

module.exports = mercadoPagoService;
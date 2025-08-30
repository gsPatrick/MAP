// src/features/MercadoPago/mercadoPago.service.js

const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

function getExpirationDate() {
    const date = new Date();
    date.setDate(date.getDate() + 1); 
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

      const effectiveStartDate = new Date();
      const endDate = new Date(effectiveStartDate);
      endDate.setDate(endDate.getDate() + plan.durationDays);

      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: effectiveStartDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      });

      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: `Assinatura Plano: ${plan.name}`,
          description: `Acesso ao plano ${plan.name} do MAP no Controle`,
          unit_price: Number.parseFloat(plan.price),
          quantity: 1,
          currency_id: 'BRL',
        }],
        payer: {
          name: client.name,
          email: client.email,
        },
        
        // <<< INÍCIO DAS CORREÇÕES BASEADAS NO SEU CÓDIGO FUNCIONAL >>>
        
        // CORREÇÃO 1: Adicionar binary_mode para forçar um resultado imediato (aprovado/recusado)
        binary_mode: true,

        // CORREÇÃO 2: Especificar que não há frete
        shipments: {
            cost: 0,
            mode: 'not_specified',
        },

        // CORREÇÃO 3: Estrutura de payment_methods mais completa
        payment_methods: {
            excluded_payment_types: [
                { id: "ticket" }, // Exclui Boleto
                { id: "atm" }     // Exclui Pagamento em Lotérica
            ],
            installments: 1 // Força o pagamento à vista, removendo a tela de seleção de parcelas
        },
        
        // <<< FIM DAS CORREÇÕES >>>

        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        statement_descriptor: "MAP NO CONTROLE",
        // As back_urls são mantidas para o fluxo web, elas não afetam negativamente
        back_urls: {
            success: `${process.env.FRONTEND_URL}/assinatura/sucesso`,
            failure: `${process.env.FRONTEND_URL}/assinatura/erro`,
            pending: `${process.env.FRONTEND_URL}/assinatura/pendente`,
        },
        auto_return: "approved",
      };

      const response = await mpPreference.create({ body: preferencePayload });

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
        logger.info(`[MP Webhook] Recebido evento do tipo '${dados.type}', ignorando.`);
        return;
      }
      
      const paymentId = dados.data.id;
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) {
        logger.warn("[MP Webhook] Webhook sem 'external_reference', não é possível processar.");
        return;
      }
      
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });
      if (!subscription) {
        logger.error(`[MP Webhook] CRÍTICO: Assinatura com ID ${subscriptionId} não foi encontrada!`);
        return;
      }
      
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        logger.info(`[MP Webhook] Pagamento APROVADO para Assinatura ID ${subscriptionId}. Ativando...`);
        
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        
        await subscriptionService.updateSubscriptionStatusByExternalId(
          subscription.externalSubscriptionId, 
          'Ativa', 
          newEndDate.toISOString().split('T')[0]
        );
        logger.info(`[MP Webhook] Assinatura ID ${subscriptionId} ativada com sucesso.`);

      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status !== 'Cancelada') {
        logger.warn(`[MP Webhook] Pagamento para Assinatura ID ${subscriptionId} foi '${paymentData.status}'. Atualizando para Cancelada.`);
        await subscription.update({ status: 'Cancelada' });
      } else {
        logger.info(`[MP Webhook] Status de pagamento '${paymentData.status}' para Assinatura ID ${subscriptionId} recebido, nenhuma ação necessária no momento.`);
      }

    } catch (error) {
      logger.error("Erro fatal ao processar webhook do Mercado Pago:", error.cause || error);
    }
  },
};

module.exports = mercadoPagoService;
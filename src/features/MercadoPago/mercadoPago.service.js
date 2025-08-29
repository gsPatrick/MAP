// src/features/MercadoPago/mercadoPago.service.js

// 1. IMPORTAÇÃO CORRIGIDA: Importa as instâncias já configuradas
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

      // Cria um registro de assinatura com status "Pendente"
      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: effectiveStartDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      });

      // CORREÇÃO 1: Ajustar o payload para melhor compatibilidade mobile
      const preferencePayload = {
        items: [{
          id: plan.id.toString(),
          title: `Assinatura - ${plan.name}`, // Titulo mais limpo
          description: `Plano ${plan.name} - ${plan.durationDays} dias`, // Adicionada descrição
          unit_price: Number(plan.price), // Usando Number() ao invés de parseFloat()
          quantity: 1,
          category_id: "services",
        }],
        payer: {
          name: client.name,
          email: client.email,
          // CORREÇÃO 2: Adicionar informações do pagador se disponível
          ...(client.phone && { phone: { number: client.phone } }),
          ...(client.document && { identification: { type: "CPF", number: client.document } }),
        },
        // CORREÇÃO 3: Melhorar as URLs de retorno para mobile
        back_urls: {
          success: `${process.env.FRONTEND_URL}/assinatura/sucesso?subscription_id=${subscription.id}`,
          failure: `${process.env.FRONTEND_URL}/assinatura/erro?subscription_id=${subscription.id}`,
          pending: `${process.env.FRONTEND_URL}/assinatura/pendente?subscription_id=${subscription.id}`,
        },
        auto_return: "approved",
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        statement_descriptor: "MAP NO CONTROLE",
        
        // CORREÇÃO 4: Configurações adicionais para melhor experiência mobile
        payment_methods: {
          excluded_payment_methods: [], // Permite todos os métodos por padrão
          excluded_payment_types: [], // Permite todos os tipos por padrão
          installments: 12, // Máximo de 12x
        },
        
        // CORREÇÃO 5: Configurar expiração corretamente
        expires: true,
        expiration_date_to: getExpirationDate(),
        
        // CORREÇÃO 6: Adicionar configurações de experiência do usuário
        purpose: "subscription", // Indica que é para assinatura
        marketplace: process.env.NODE_ENV === 'production' ? "PROD" : "TEST",
      };

      logger.info(`Criando preferência MP para cliente ${client.email}, plano ${plan.name}`);
      
      // Cria a preferência de pagamento usando a instância importada
      const response = await mpPreference.create({ body: preferencePayload });

      if (!response || !response.id) {
        throw new Error('Resposta inválida do Mercado Pago - ID da preferência não encontrado');
      }

      // Atualiza nossa assinatura com o ID da preferência do MP para referência futura
      await subscription.update({
        externalSubscriptionId: response.id
      });

      logger.info(`Preferência MP criada com sucesso (ID: ${response.id}) para Assinatura ${subscription.id}`);
      
      // CORREÇÃO 7: Retornar URLs apropriadas para web e mobile
      return {
        // Para web - abre no navegador
        checkoutUrl: response.init_point,
        // Para mobile - deep link que pode abrir o app
        checkoutUrlMobile: response.init_point,
        preferenceId: response.id,
        subscriptionId: subscription.id,
        // Informações adicionais úteis
        amount: plan.price,
        planName: plan.name,
      };

    } catch (error) {
      logger.error("Erro ao criar preferência MP:", {
        error: error.cause || error.message || error,
        clientId,
        planId,
        stack: error.stack
      });
      
      // CORREÇÃO 8: Melhor tratamento de erros
      if (error.status || error.statusCode) {
        throw error;
      }
      
      // Se o erro veio do MP, extrair informações úteis
      if (error.cause && error.cause.details) {
        logger.error("Detalhes do erro MP:", error.cause.details);
        throw {
          statusCode: 400,
          message: 'Erro ao processar pagamento. Tente novamente.',
          details: error.cause.details
        };
      }
      
      throw {
        statusCode: 500,
        message: 'Erro interno do servidor ao criar preferência de pagamento.'
      };
    }
  },

  async processarWebhook(dados) {
    try {
      logger.info(`[MP Webhook] Recebido: ${dados.type} - ID: ${dados.data?.id}`);
      
      // CORREÇÃO 9: Processar mais tipos de eventos relevantes
      if (!['payment', 'merchant_order'].includes(dados.type)) {
        logger.info(`[MP Webhook] Evento '${dados.type}' ignorado.`);
        return { processed: false, reason: 'event_type_ignored' };
      }
      
      const paymentId = dados.data.id;
      if (!paymentId) {
        logger.warn("[MP Webhook] Webhook recebido sem ID de pagamento");
        return { processed: false, reason: 'no_payment_id' };
      }

      // CORREÇÃO 10: Melhor tratamento de erro na busca do pagamento
      let paymentData;
      try {
        paymentData = await mpPayment.get({ id: paymentId });
      } catch (mpError) {
        logger.error(`[MP Webhook] Erro ao buscar pagamento ${paymentId}:`, mpError);
        throw new Error(`Não foi possível recuperar dados do pagamento: ${mpError.message}`);
      }

      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId || isNaN(subscriptionId)) {
        logger.warn(`[MP Webhook] External reference inválida: ${paymentData.external_reference}`);
        return { processed: false, reason: 'invalid_external_reference' };
      }
      
      const subscription = await Subscription.findByPk(subscriptionId);
      if (!subscription) {
        logger.error(`[MP Webhook] Assinatura ${subscriptionId} não encontrada!`);
        return { processed: false, reason: 'subscription_not_found' };
      }
      
      logger.info(`[MP Webhook] Processando pagamento ${paymentId} - Status: ${paymentData.status} - Assinatura: ${subscriptionId}`);

      // CORREÇÃO 11: Lógica de status mais robusta
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        logger.info(`[MP Webhook] Ativando assinatura ${subscriptionId}...`);
        await subscriptionService.activateSubscription(subscription.id, paymentData.id);
        logger.info(`[MP Webhook] Assinatura ${subscriptionId} ativada com sucesso`);
        return { processed: true, action: 'activated' };

      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status)) {
        if (subscription.status === 'Pendente') {
          logger.warn(`[MP Webhook] Cancelando assinatura ${subscriptionId} - Status pagamento: ${paymentData.status}`);
          await subscription.update({ status: 'Cancelada' });
          return { processed: true, action: 'cancelled' };
        } else if (paymentData.status === 'refunded' && subscription.status === 'Ativa') {
          logger.warn(`[MP Webhook] Reembolso processado - Desativando assinatura ${subscriptionId}`);
          await subscription.update({ status: 'Cancelada' });
          return { processed: true, action: 'refunded' };
        }

      } else if (paymentData.status === "pending") {
        logger.info(`[MP Webhook] Pagamento ${paymentId} ainda pendente`);
        return { processed: true, action: 'pending' };
      }

      logger.info(`[MP Webhook] Nenhuma ação necessária - Status: ${paymentData.status}, Assinatura status: ${subscription.status}`);
      return { processed: true, action: 'no_action_needed' };

    } catch (error) {
      logger.error("Erro ao processar webhook MP:", {
        error: error.message,
        dados,
        stack: error.stack
      });
      
      // CORREÇÃO 12: Retornar informação sobre o erro sem lançar exceção
      return { processed: false, reason: 'processing_error', error: error.message };
    }
  },

  // CORREÇÃO 13: Método auxiliar para verificar status de pagamento
  async verificarStatusPagamento(preferenceId) {
    try {
      // Este método pode ser usado pelo frontend para verificar status
      const subscription = await Subscription.findOne({
        where: { externalSubscriptionId: preferenceId }
      });
      
      if (!subscription) {
        return { found: false };
      }
      
      return {
        found: true,
        status: subscription.status,
        subscriptionId: subscription.id,
        startDate: subscription.startDate,
        endDate: subscription.endDate
      };
    } catch (error) {
      logger.error("Erro ao verificar status:", error);
      throw error;
    }
  }
};

module.exports = mercadoPagoService;

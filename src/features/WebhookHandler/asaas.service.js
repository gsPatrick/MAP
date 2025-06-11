// src/features/WebhookHandler/asaas.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const asaasApiService = require('../../services/asaasApiService');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');

async function processWebhookEvent(eventData) {
  // Ignora eventos que não são de confirmação de pagamento
  const { event, payment } = eventData;
  if (event !== 'PAYMENT_RECEIVED' && event !== 'PAYMENT_CONFIRMED') {
    return;
  }

  // Valida se o payload do pagamento está completo
  if (!payment || !payment.customer || !payment.subscription) {
    logger.error('[ASAAS SVC] Payload de pagamento incompleto (sem customer ou subscription ID).', eventData);
    return; // Retorna OK para o ASAAS não reenviar um webhook malformado.
  }

  const asaasCustomerId = payment.customer;
  const externalSubscriptionId = payment.subscription;

  const t = await sequelize.transaction();
  try {
    // ==========================================================
    // 1. VERIFICAÇÃO DE IDEMPOTÊNCIA
    // ==========================================================
    // Se a assinatura já foi marcada como "Ativa", ignora o webhook.
    const existingActiveSubscription = await Subscription.findOne({
      where: {
        externalSubscriptionId: externalSubscriptionId,
        status: 'Ativa'
      },
      transaction: t
    });

    if (existingActiveSubscription) {
      logger.info(`[ASAAS SVC] A assinatura para o ID externo ${externalSubscriptionId} já está ATIVA. Webhook ignorado para evitar reprocessamento.`);
      await t.commit();
      return;
    }

    // ==========================================================
    // 2. BUSCAR DADOS COMPLETOS DO CLIENTE
    // ==========================================================
    const customerData = await asaasApiService.getCustomerById(asaasCustomerId);
    const clientRawPhone = customerData.mobilePhone || customerData.phone;

    if (!clientRawPhone) {
      logger.error(`[ASAAS SVC] CRÍTICO: Telefone não encontrado para o cliente ASAAS ID ${asaasCustomerId}, mesmo após busca na API.`);
      await t.rollback();
      return;
    }

    const clientPhone = normalizePhoneNumberToCanonical(clientRawPhone);
    const clientName = customerData.name || `Cliente ${clientPhone}`;
    const clientEmail = customerData.email || null;

    // ==========================================================
    // 3. ENCONTRAR OU CRIAR O CLIENTE NO SEU BANCO
    // ==========================================================
    let localClient = await Client.findOne({
      where: { [Op.or]: [{ phone: clientPhone }, { email: clientEmail, [Op.not]: null }] },
      transaction: t
    });

    if (localClient) {
      logger.info(`[ASAAS SVC] Cliente local encontrado (ID: ${localClient.id}). Verificando e vinculando ID do ASAAS...`);
      if (!localClient.asaasCustomerId) {
        await localClient.update({ asaasCustomerId: asaasCustomerId, name: clientName }, { transaction: t });
        logger.info(`[ASAAS SVC] ID do cliente ASAAS (${asaasCustomerId}) vinculado com sucesso.`);
      }
    } else {
      logger.info(`[ASAAS SVC] Nenhum cliente existente encontrado. Criando novo cliente...`);
      const newClientData = {
        name: clientName,
        email: clientEmail,
        phone: clientPhone,
        asaasCustomerId: asaasCustomerId,
        status: 'Ativo'
      };
      localClient = await clientService.createClientContact(newClientData, { transaction: t });
      logger.info(`[ASAAS SVC] Novo cliente criado (ID: ${localClient.id}).`);
    }

    // ==========================================================
    // 4. IDENTIFICAR O PLANO PELO VALOR
    // ==========================================================
    const planValue = parseFloat(payment.value);
    const localPlan = await Plan.findOne({
      where: { price: { [Op.eq]: planValue } },
      transaction: t
    });

    if (!localPlan) {
      await t.rollback();
      logger.error(`[ASAAS SVC] Nenhum plano encontrado no sistema com o valor R$${planValue}. Verifique se os planos foram semeados corretamente no banco.`);
      throw new Error(`Plano com valor ${planValue} não configurado.`);
    }
    logger.info(`[ASAAS SVC] Plano "${localPlan.name}" corresponde ao valor pago.`);

    // ==========================================================
    // 5. CRIAR OU ATUALIZAR A ASSINATURA LOCAL
    // ==========================================================
    // Neste ponto, a assinatura só pode ser nova ou estar pendente, pois já filtramos as "Ativas".
    const [subscription, created] = await Subscription.findOrCreate({
      where: { externalSubscriptionId: externalSubscriptionId },
      defaults: {
        clientId: localClient.id,
        planId: localPlan.id,
        startDate: payment.paymentDate ? new Date(payment.paymentDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        endDate: payment.nextDueDate || new Date(new Date().setDate(new Date().getDate() + localPlan.durationDays)).toISOString().split('T')[0],
        status: 'Ativa',
        externalSubscriptionId: externalSubscriptionId,
      },
      transaction: t
    });

    if (created) {
      logger.info(`[ASAAS SVC] Nova assinatura local (ID: ${subscription.id}) criada para o cliente ${localClient.id}.`);
      // A lógica de atualizar o accessLevel do cliente já está dentro do subscriptionService.createSubscription (ou deveria estar)
      // Mas podemos chamar aqui explicitamente para garantir.
      await subscriptionService.updateSubscriptionStatusByExternalId(externalSubscriptionId, 'Ativa', subscription.endDate);
    } else {
      logger.info(`[ASAAS SVC] Assinatura local ${subscription.id} encontrada. Atualizando status para 'Ativa'.`);
      await subscriptionService.updateSubscriptionStatusByExternalId(externalSubscriptionId, 'Ativa', subscription.endDate);
    }

    await t.commit();
    logger.info(`[ASAAS SVC] Processo concluído com sucesso para o pagamento ${payment.id}.`);

  } catch (error) {
    if (t.finished !== 'commit' && t.finished !== 'rollback') {
      await t.rollback();
    }
    logger.error(`[ASAAS SVC] Erro CRÍTICO ao processar webhook de pagamento: ${error.message}`, { stack: error.stack, eventData });
    // Lança o erro para que o controller responda com 500 e o ASAAS tente reenviar.
    throw error;
  }
}

module.exports = {
  processWebhookEvent,
};
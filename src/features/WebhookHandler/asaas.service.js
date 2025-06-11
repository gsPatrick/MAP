// src/features/WebhookHandler/asaas.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const asaasApiService = require('../../services/asaasApiService');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');

async function processWebhookEvent(eventData) {
  const { event, payment } = eventData;
  if (event !== 'PAYMENT_RECEIVED' && event !== 'PAYMENT_CONFIRMED') {
    return;
  }
  if (!payment || !payment.customer) {
    logger.error('[ASAAS SVC] Payload de pagamento incompleto.', eventData);
    return;
  }

  const asaasCustomerId = payment.customer;

  // Passo 1: Buscar os dados completos do cliente na API do ASAAS.
  const customerData = await asaasApiService.getCustomerById(asaasCustomerId);

  const clientRawPhone = customerData.mobilePhone || customerData.phone;
  
  if (!clientRawPhone) {
    logger.error(`[ASAAS SVC] CRÍTICO: Telefone não encontrado para o cliente ASAAS ID ${asaasCustomerId}, mesmo após busca na API.`);
    return;
  }

  const clientPhone = normalizePhoneNumberToCanonical(clientRawPhone);
  const clientName = customerData.name || `Cliente ${clientPhone}`;
  const clientEmail = customerData.email || null;
  const externalSubscriptionId = payment.subscription;

  if (!externalSubscriptionId) {
    logger.warn(`[ASAAS SVC] Pagamento (ID: ${payment.id}) sem ID de assinatura. Ignorando.`);
    return;
  }

  const t = await sequelize.transaction();
  try {
    let localClient = await Client.findOne({ where: { phone: clientPhone }, transaction: t });

    if (localClient) {
      logger.info(`[ASAAS SVC] Cliente local encontrado pelo telefone ${clientPhone} (ID: ${localClient.id}).`);
      if (!localClient.asaasCustomerId) {
        await localClient.update({ asaasCustomerId: asaasCustomerId }, { transaction: t });
        logger.info(`[ASAAS SVC] ID do cliente ASAAS (${asaasCustomerId}) vinculado ao cliente local existente.`);
      }
    } else {
      logger.info(`[ASAAS SVC] Nenhum cliente encontrado com o telefone ${clientPhone}. Criando novo cliente...`);
      const newClientData = {
        name: clientName,
        email: clientEmail,
        phone: clientPhone,
        asaasCustomerId: asaasCustomerId,
        status: 'Ativo'
      };
      localClient = await clientService.createClientContact(newClientData, { transaction: t });
      logger.info(`[ASAAS SVC] Novo cliente criado no sistema local. ID: ${localClient.id}`);
    }

    const planValue = parseFloat(payment.value);

    // ==========================================================
    // LOG DE DIAGNÓSTICO ADICIONADO AQUI
    // ==========================================================
    // Este log vai nos mostrar exatamente o que está na tabela 'plans' ANTES da busca.
    const allPlansInDB = await Plan.findAll({ raw: true, transaction: t });
    logger.info(`[DIAGNÓSTICO] Planos existentes no banco: ${JSON.stringify(allPlansInDB, null, 2)}`);
    // ==========================================================
    
    const localPlan = await Plan.findOne({
      where: { price: { [Op.eq]: planValue } },
      transaction: t
    });

    if (!localPlan) {
      await t.rollback(); // Importante fazer o rollback ANTES de lançar o erro
      logger.error(`[ASAAS SVC] Nenhum plano encontrado com o valor R$${planValue}.`);
      throw new Error(`Plano com valor ${planValue} não configurado.`);
    }

    logger.info(`[ASAAS SVC] Plano "${localPlan.name}" corresponde ao valor pago.`);

    let localSubscription = await Subscription.findOne({ where: { externalSubscriptionId: externalSubscriptionId }, transaction: t });

    if (localSubscription) {
      logger.info(`[ASAAS SVC] Assinatura local ${localSubscription.id} encontrada. Atualizando status para 'Ativa'.`);
      const nextDueDate = payment.nextDueDate || new Date(new Date().setDate(new Date().getDate() + 30)).toISOString().split('T')[0];
      await subscriptionService.updateSubscriptionStatusByExternalId(externalSubscriptionId, 'Ativa', nextDueDate);
    } else {
      logger.info(`[ASAAS SVC] Criando nova assinatura local para o cliente ${localClient.id}.`);
      const startDate = payment.paymentDate ? new Date(payment.paymentDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      await subscriptionService.createSubscription(
        localClient.id,
        localPlan.id,
        startDate,
        'Ativa',
        externalSubscriptionId
      );
    }
    
    await t.commit();
    logger.info(`[ASAAS SVC] Processo concluído com sucesso para o pagamento ${payment.id}.`);

  } catch (error) {
    if (t.finished !== 'commit' && t.finished !== 'rollback') {
        await t.rollback();
    }
    logger.error(`[ASAAS SVC] Erro CRÍTICO ao processar webhook de pagamento: ${error.message}`, { stack: error.stack, eventData });
    throw error;
  }
}

module.exports = {
  processWebhookEvent,
};
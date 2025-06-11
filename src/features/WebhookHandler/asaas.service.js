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

  if (!payment || !payment.customer || !payment.subscription) {
    logger.error('[ASAAS SVC] Payload de pagamento incompleto (sem customer ou subscription ID).', eventData);
    return;
  }

  const asaasCustomerId = payment.customer;
  const externalSubscriptionId = payment.subscription;

  const t = await sequelize.transaction();
  try {
    const existingActiveSubscription = await Subscription.findOne({
      where: { externalSubscriptionId, status: 'Ativa' },
      transaction: t
    });

    if (existingActiveSubscription) {
      logger.info(`[ASAAS SVC] A assinatura para o ID externo ${externalSubscriptionId} já está ATIVA. Webhook ignorado.`);
      await t.commit();
      return;
    }

    const customerData = await asaasApiService.getCustomerById(asaasCustomerId);
    const clientRawPhone = customerData.mobilePhone || customerData.phone;

    if (!clientRawPhone) {
      logger.error(`[ASAAS SVC] CRÍTICO: Telefone não encontrado para o cliente ASAAS ID ${asaasCustomerId}.`);
      await t.rollback();
      return;
    }

    const clientPhone = normalizePhoneNumberToCanonical(clientRawPhone);
    const clientName = customerData.name || `Cliente ${clientPhone}`;
    const clientEmail = customerData.email || null;

    let localClient;

    if (clientPhone) {
      localClient = await Client.findOne({ where: { phone: clientPhone }, transaction: t });
    }
    if (!localClient && clientEmail) {
      localClient = await Client.findOne({ where: { email: clientEmail }, transaction: t });
    }

    if (localClient) {
      logger.info(`[ASAAS SVC] Cliente local encontrado (ID: ${localClient.id}). Verificando e vinculando dados...`);
      const updates = {};
      if (!localClient.asaasCustomerId) updates.asaasCustomerId = asaasCustomerId;
      if (!localClient.name && clientName) updates.name = clientName;
      if (!localClient.email && clientEmail) updates.email = clientEmail;
      
      if (Object.keys(updates).length > 0) {
        await localClient.update(updates, { transaction: t });
        logger.info(`[ASAAS SVC] Dados do cliente local atualizados.`);
      }
    } else {
      logger.info(`[ASAAS SVC] Nenhum cliente existente encontrado. Criando novo cliente...`);
      const newClientData = {
        name: clientName, // <<<<<<< AQUI ESTÁ A CORREÇÃO
        email: clientEmail,
        phone: clientPhone,
        asaasCustomerId: asaasCustomerId,
        status: 'Ativo'
      };
      localClient = await clientService.createClientContact(newClientData, { transaction: t });
      logger.info(`[ASAAS SVC] Novo cliente criado (ID: ${localClient.id}).`);
    }

    const planValue = parseFloat(payment.value);
    const localPlan = await Plan.findOne({
      where: { price: { [Op.eq]: planValue } },
      transaction: t
    });

    if (!localPlan) {
      await t.rollback();
      logger.error(`[ASAAS SVC] Nenhum plano encontrado no sistema com o valor R$${planValue}.`);
      throw new Error(`Plano com valor ${planValue} não configurado.`);
    }
    logger.info(`[ASAAS SVC] Plano "${localPlan.name}" corresponde ao valor pago.`);

    const endDate = payment.nextDueDate || new Date(new Date().setDate(new Date().getDate() + localPlan.durationDays)).toISOString().split('T')[0];
    
    await Subscription.findOrCreate({
      where: { externalSubscriptionId: externalSubscriptionId },
      defaults: {
        clientId: localClient.id,
        planId: localPlan.id,
        startDate: payment.paymentDate ? new Date(payment.paymentDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        endDate: endDate,
        status: 'Pendente',
      },
      transaction: t
    });

    await t.commit();

    logger.info(`[ASAAS SVC] Delegando ativação da assinatura ${externalSubscriptionId} para o Subscription Service.`);
    await subscriptionService.updateSubscriptionStatusByExternalId(externalSubscriptionId, 'Ativa', endDate);

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
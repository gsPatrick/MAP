// src/features/WebhookHandler/asaas.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');


/**
 * Processa um evento de webhook do ASAAS vindo de um Link de Pagamento genérico.
 */
async function processWebhookEvent(eventData) {
  /*
  // ATENÇÃO: QUANDO FOR PARA PRODUÇÃO, DESCOMENTE ESTE BLOCO!
  // Esta é a validação de segurança do webhook.
  const configuredToken = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!configuredToken || configuredToken !== apiTokenFromHeader) {
    logger.warn(`[ASAAS SVC] Token de webhook do ASAAS inválido ou não configurado.`);
    throw new Error('Token inválido.');
  }
  logger.info('[ASAAS SVC] Token de webhook validado com sucesso.');
  */

  const { event, payment } = eventData;
  if (event !== 'PAYMENT_RECEIVED' && event !== 'PAYMENT_CONFIRMED') {
    logger.info(`[ASAAS SVC] Evento '${event}' não é de confirmação de pagamento. Ignorando para este fluxo.`);
    return;
  }
  if (!payment || !payment.customer) {
    logger.error('[ASAAS SVC] Payload de pagamento incompleto ou sem ID de cliente.', eventData);
    throw new Error('Payload de pagamento inválido.');
  }

  const asaasCustomerId = payment.customer;
  const clientName = payment.customer.name;
  const clientEmail = payment.customer.email;
  const clientRawPhone = payment.customer.mobilePhone || payment.customer.phone;
  const clientPhone = normalizePhoneNumberToCanonical(clientRawPhone);
  const externalSubscriptionId = payment.subscription;

  if (!externalSubscriptionId) {
    logger.warn(`[ASAAS SVC] Pagamento recebido (ID: ${payment.id}) sem um ID de assinatura associado. Ignorando.`);
    return;
  }

  const t = await sequelize.transaction();
  try {
    let localClient = await Client.findOne({ where: { asaasCustomerId: asaasCustomerId }, transaction: t });

    if (!localClient) {
      logger.info(`[ASAAS SVC] Cliente com asaasCustomerId ${asaasCustomerId} não encontrado. Verificando por e-mail/telefone...`);
      const existingClient = await Client.findOne({
        where: { [Op.or]: [{ email: clientEmail }, { phone: clientPhone }] },
        transaction: t
      });

      if (existingClient) {
        logger.warn(`[ASAAS SVC] Cliente com email ${clientEmail} ou telefone ${clientPhone} já existe (ID: ${existingClient.id}). Apenas vinculando asaasCustomerId ${asaasCustomerId}.`);
        await existingClient.update({ asaasCustomerId: asaasCustomerId }, { transaction: t });
        localClient = existingClient;
      } else {
        logger.info(`[ASAAS SVC] Criando novo cliente no sistema local...`);
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
    } else {
      logger.info(`[ASAAS SVC] Cliente local encontrado (ID: ${localClient.id}) para o asaasCustomerId ${asaasCustomerId}.`);
    }

    const planValue = parseFloat(payment.value);
    const localPlan = await Plan.findOne({
      where: {
        price: { [Op.eq]: planValue }
      },
      transaction: t
    });

    if (!localPlan) {
      await t.rollback();
      logger.error(`[ASAAS SVC] Nenhum plano encontrado no sistema com o valor R$${planValue}. Não é possível criar a assinatura.`);
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
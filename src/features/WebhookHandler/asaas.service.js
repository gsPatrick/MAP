// src/features/WebhookHandler/asaas.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');

async function processWebhookEvent(eventData) {
  const { event, payment } = eventData;
  if (event !== 'PAYMENT_RECEIVED' && event !== 'PAYMENT_CONFIRMED') {
    return; // Ignora eventos que não são de confirmação
  }

  if (!payment || !payment.customer) {
    logger.error('[ASAAS SVC] Payload de pagamento incompleto ou sem ID de cliente.', eventData);
    return; // Retorna OK para o ASAAS não reenviar
  }

  // Extração dos dados com foco no telefone
  const asaasCustomerId = payment.customer;
  const clientRawPhone = payment.customer.mobilePhone || payment.customer.phone;

  // Validação CRÍTICA: Se nem com o campo obrigatório o telefone veio, algo está muito errado.
  if (!clientRawPhone) {
    logger.error(`[ASAAS SVC] CRÍTICO: Webhook recebido SEM TELEFONE, mesmo sendo um campo obrigatório no checkout. Cliente ASAAS ID: ${asaasCustomerId}. Payload:`, payment.customer);
    return; // Não podemos prosseguir.
  }

  const clientPhone = normalizePhoneNumberToCanonical(clientRawPhone);
  const clientName = payment.customer.name || `Cliente ${clientPhone}`; // Usa o telefone para criar um nome padrão
  const clientEmail = payment.customer.email || null; // E-mail continua opcional
  const externalSubscriptionId = payment.subscription;

  if (!externalSubscriptionId) {
    logger.warn(`[ASAAS SVC] Pagamento (ID: ${payment.id}) sem ID de assinatura. Ignorando.`);
    return;
  }

  const t = await sequelize.transaction();
  try {
    // Busca o cliente prioritariamente pelo telefone, que é nosso identificador único
    let localClient = await Client.findOne({ where: { phone: clientPhone }, transaction: t });

    if (localClient) {
      logger.info(`[ASAAS SVC] Cliente local encontrado pelo telefone ${clientPhone} (ID: ${localClient.id}).`);
      // Se o cliente já existia mas não tinha o ID do ASAAS, atualiza.
      if (!localClient.asaasCustomerId) {
        await localClient.update({ asaasCustomerId: asaasCustomerId }, { transaction: t });
        logger.info(`[ASAAS SVC] ID do cliente ASAAS (${asaasCustomerId}) vinculado ao cliente local existente.`);
      }
    } else {
      // Se não encontrou pelo telefone, significa que é um cliente 100% novo.
      logger.info(`[ASAAS SVC] Nenhum cliente encontrado com o telefone ${clientPhone}. Criando novo cliente...`);
      
      const newClientData = {
        name: clientName,
        email: clientEmail,       // null se não fornecido
        phone: clientPhone,       // O identificador principal
        asaasCustomerId: asaasCustomerId,
        status: 'Ativo'
      };
      
      localClient = await clientService.createClientContact(newClientData, { transaction: t });
      logger.info(`[ASAAS SVC] Novo cliente criado no sistema local. ID: ${localClient.id}`);
    }

    // Identificação do plano pelo valor (continua igual)
    const planValue = parseFloat(payment.value);
    const localPlan = await Plan.findOne({
      where: { price: { [Op.eq]: planValue } },
      transaction: t
    });

    if (!localPlan) {
      await t.rollback();
      logger.error(`[ASAAS SVC] Nenhum plano encontrado com o valor R$${planValue}.`);
      throw new Error(`Plano com valor ${planValue} não configurado.`);
    }
    logger.info(`[ASAAS SVC] Plano "${localPlan.name}" corresponde ao valor pago.`);

    // Criação/Atualização da assinatura (continua igual)
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
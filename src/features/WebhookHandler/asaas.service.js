// src/features/WebhookHandler/asaas.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const asaasApiService = require('../../services/asaasApiService');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

// <<< [CORREÇÃO PRINCIPAL] Importa a função de normalização de telefone >>>
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');

/**
 * Processa um evento de webhook recebido do ASAAS.
 * @param {object} eventData - O payload do evento do webhook.
 */
async function processWebhookEvent(eventData) {
  const { event, payment } = eventData;

  // Filtra apenas os eventos que nos interessam (pagamento recebido ou confirmado)
  if (event !== 'PAYMENT_RECEIVED' && event !== 'PAYMENT_CONFIRMED') {
    logger.info(`[ASAAS SVC] Evento '${event}' recebido e ignorado por não ser relevante para ativação.`);
    return;
  }

  // Validação essencial do payload
  if (!payment || !payment.customer || !payment.subscription) {
    logger.error('[ASAAS SVC] Payload de pagamento recebido incompleto (faltando customer ou subscription ID).', eventData);
    return;
  }

  const asaasCustomerId = payment.customer;
  const externalSubscriptionId = payment.subscription;

  const t = await sequelize.transaction();
  try {
    // Otimização: Se já existe uma assinatura ATIVA para este ID externo, não faz nada.
    const existingActiveSubscription = await Subscription.findOne({
      where: { externalSubscriptionId, status: 'Ativa' },
      transaction: t
    });

    if (existingActiveSubscription) {
      logger.info(`[ASAAS SVC] A assinatura para o ID externo ${externalSubscriptionId} já está ATIVA. Webhook ignorado para evitar duplicidade.`);
      await t.commit();
      return;
    }

    // Busca os dados completos do cliente na API do Asaas para obter telefone, nome, etc.
    const customerData = await asaasApiService.getCustomerById(asaasCustomerId);
    const clientRawPhone = customerData.mobilePhone || customerData.phone;

    if (!clientRawPhone) {
      logger.error(`[ASAAS SVC] CRÍTICO: Telefone não encontrado para o cliente ASAAS ID ${asaasCustomerId}. Não é possível prosseguir com a ativação.`);
      await t.rollback();
      return;
    }

    // <<< [CORREÇÃO APLICADA] Normaliza o número de telefone vindo do Asaas >>>
    const clientPhone = normalizePhoneNumberToCanonical(clientRawPhone);
    const clientName = customerData.name || `Cliente ${clientPhone}`;
    const clientEmail = customerData.email || null;

    let localClient;

    // Tenta encontrar o cliente local pelo telefone normalizado (principal) ou pelo email (secundário)
    if (clientPhone) {
      localClient = await Client.findOne({ where: { phone: clientPhone }, transaction: t });
    }
    if (!localClient && clientEmail) {
      localClient = await Client.findOne({ where: { email: clientEmail }, transaction: t });
    }

    // Se o cliente já existe, atualiza os dados se necessário
    if (localClient) {
      logger.info(`[ASAAS SVC] Cliente local encontrado (ID: ${localClient.id}). Verificando e vinculando dados...`);
      const updates = {};
      if (!localClient.asaasCustomerId) updates.asaasCustomerId = asaasCustomerId;
      if ((!localClient.name || localClient.name === 'Convidado') && clientName) updates.name = clientName;
      if (!localClient.email && clientEmail) updates.email = clientEmail;
      
      if (Object.keys(updates).length > 0) {
        await localClient.update(updates, { transaction: t });
        logger.info(`[ASAAS SVC] Dados do cliente local (ID: ${localClient.id}) foram atualizados.`);
      }
    } else {
      // Se não encontrou, cria um novo cliente no nosso banco de dados
      logger.info(`[ASAAS SVC] Nenhum cliente existente encontrado para tel:${clientPhone} ou email:${clientEmail}. Criando novo cliente...`);
      const newClientData = {
        name: clientName, // Garante que o nome do Asaas seja usado na criação
        email: clientEmail,
        phone: clientPhone,
        asaasCustomerId: asaasCustomerId,
        status: 'Ativo'
      };
      localClient = await clientService.createClientContact(newClientData, { transaction: t });
      logger.info(`[ASAAS SVC] Novo cliente criado (ID: ${localClient.id}).`);
    }

    // Encontra o plano local correspondente ao valor pago
    const planValue = parseFloat(payment.value);
    const localPlan = await Plan.findOne({
      where: { price: { [Op.eq]: planValue } },
      transaction: t
    });

    if (!localPlan) {
      await t.rollback();
      logger.error(`[ASAAS SVC] CRÍTICO: Nenhum plano encontrado no sistema com o valor R$${planValue}. O pagamento não pode ser associado.`);
      throw new Error(`Plano com valor ${planValue} não configurado.`);
    }
    logger.info(`[ASAAS SVC] Plano "${localPlan.name}" corresponde ao valor pago.`);

    // Calcula a data de expiração da assinatura
    const endDate = payment.nextDueDate || new Date(new Date().setDate(new Date().getDate() + localPlan.durationDays)).toISOString().split('T')[0];
    
    // Garante que um registro de assinatura exista para ser atualizado
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

    await t.commit(); // Confirma todas as operações no banco

    // Delega a lógica de ativação para o serviço especializado
    logger.info(`[ASAAS SVC] Delegando ativação da assinatura ${externalSubscriptionId} para o Subscription Service.`);
    await subscriptionService.updateSubscriptionStatusByExternalId(externalSubscriptionId, 'Ativa', endDate);

    logger.info(`[ASAAS SVC] Processo de webhook concluído com sucesso para o pagamento ${payment.id}.`);

  } catch (error) {
    if (t.finished !== 'commit' && t.finished !== 'rollback') {
      await t.rollback();
    }
    logger.error(`[ASAAS SVC] Erro CRÍTICO ao processar webhook de pagamento: ${error.message}`, { stack: error.stack, eventData });
    throw error; // Propaga o erro para o controller responder 500 ao Asaas
  }
}

module.exports = {
  processWebhookEvent,
};
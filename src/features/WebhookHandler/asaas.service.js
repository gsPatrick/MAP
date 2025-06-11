// src/features/WebhookHandler/asaas.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');

async function processWebhookEvent(eventData) {
  /*
  // Bloco de segurança para produção (mantido comentado por enquanto)
  const configuredToken = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!configuredToken || configuredToken !== apiTokenFromHeader) {
    throw new Error('Token inválido.');
  }
  */

  const { event, payment } = eventData;
  if (event !== 'PAYMENT_RECEIVED' && event !== 'PAYMENT_CONFIRMED') {
    logger.info(`[ASAAS SVC] Evento '${event}' não é de confirmação de pagamento. Ignorando.`);
    return;
  }
  if (!payment || !payment.customer) {
    logger.error('[ASAAS SVC] Payload de pagamento incompleto ou sem ID de cliente.', eventData);
    throw new Error('Payload de pagamento inválido.');
  }

  // Extração segura dos dados do cliente
  const asaasCustomerId = payment.customer;
  const clientName = payment.customer.name || 'Cliente Sem Nome'; // Garante um valor padrão
  const clientEmail = payment.customer.email || null; // Converte undefined para null
  const clientRawPhone = payment.customer.mobilePhone || payment.customer.phone || null; // Converte undefined para null
  
  // Normaliza o telefone apenas se ele existir
  const clientPhone = clientRawPhone ? normalizePhoneNumberToCanonical(clientRawPhone) : null;
  
  const externalSubscriptionId = payment.subscription;

  // Validação essencial: precisamos de pelo menos um telefone para criar a conta
  if (!clientPhone) {
      logger.error(`[ASAAS SVC] Webhook recebido sem número de telefone para o cliente ${clientName} (${asaasCustomerId}). Não é possível criar a conta.`);
      // Retornamos sucesso para o ASAAS não ficar reenviando, pois este é um erro de dados, não de processo.
      return; 
  }

  if (!externalSubscriptionId) {
    logger.warn(`[ASAAS SVC] Pagamento recebido (ID: ${payment.id}) sem um ID de assinatura associado. Ignorando.`);
    return;
  }

  const t = await sequelize.transaction();
  try {
    let localClient = await Client.findOne({ where: { asaasCustomerId: asaasCustomerId }, transaction: t });

    if (!localClient) {
      logger.info(`[ASAAS SVC] Cliente com asaasCustomerId ${asaasCustomerId} não encontrado. Verificando por e-mail/telefone...`);
      
      // >>>>>>>> MUDANÇA PRINCIPAL AQUI <<<<<<<<<<
      // Construir a cláusula 'where' dinamicamente para evitar valores undefined
      const whereConditions = [];
      if (clientEmail) {
        whereConditions.push({ email: clientEmail });
      }
      if (clientPhone) {
        whereConditions.push({ phone: clientPhone });
      }
      // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

      let existingClient = null;
      if (whereConditions.length > 0) {
        existingClient = await Client.findOne({
          where: { [Op.or]: whereConditions },
          transaction: t
        });
      }

      if (existingClient) {
        logger.warn(`[ASAAS SVC] Cliente com email ${clientEmail} ou telefone ${clientPhone} já existe (ID: ${existingClient.id}). Apenas vinculando asaasCustomerId ${asaasCustomerId}.`);
        await existingClient.update({ asaasCustomerId: asaasCustomerId }, { transaction: t });
        localClient = existingClient;
      } else {
        logger.info(`[ASAAS SVC] Criando novo cliente no sistema local...`);
        const newClientData = {
          name: clientName,
          email: clientEmail, // Pode ser null, seu modelo permite
          phone: clientPhone, // Sabemos que existe por causa da validação acima
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
      // Passa a transação para a função de update
      await subscriptionService.updateSubscriptionStatusByExternalId(externalSubscriptionId, 'Ativa', nextDueDate);
    } else {
      logger.info(`[ASAAS SVC] Criando nova assinatura local para o cliente ${localClient.id}.`);
      const startDate = payment.paymentDate ? new Date(payment.paymentDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      // Passa a transação para a função de create
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
// src/features/WebhookHandler/hotmart.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service'); // Usaremos para encontrar/criar clientes
const subscriptionService = require('../Subscription/subscription.service'); // Usaremos para gerenciar assinaturas locais
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

/**
 * Processa um evento de webhook recebido da Hotmart.
 * @param {object} eventData - O payload JSON do webhook da Hotmart.
 * @param {string} hottokFromHeader - O valor do Hottok recebido no header da requisição.
 */
async function processWebhookEvent(eventData, hottokFromHeader) {
  const configuredHottok = process.env.HOTMART_HOTTOK;

  if (!configuredHottok) {
    logger.error('[HOTMART SVC] HOTMART_HOTTOK não está configurado no ambiente. Não é possível validar o webhook.');
    throw new Error('Configuração interna do servidor impede a validação do webhook.');
  }

  if (configuredHottok !== hottokFromHeader) {
    logger.warn(`[HOTMART SVC] Hottok inválido recebido. Esperado: ${configuredHottok ? ' configurado ' : 'NÃO configurado'}, Recebido: ${hottokFromHeader}`);
    throw new Error('Hottok inválido.'); // Isso resultará em um 500 para a Hotmart, que tentará reenviar.
  }

  logger.info('[HOTMART SVC] Hottok validado com sucesso.');

  const {
    prod, // ID do produto na Hotmart
    // price, // Valor do produto (pode ser útil para logs ou verificação)
    email: buyer_email, // Email do comprador (Hotmart envia como 'email')
    name: buyer_name, // Nome do comprador
    phone_local_code: buyer_phone_local_code, // DDD
    phone_number: buyer_phone_number, // Número do telefone
    status, // Status da transação (approved, canceled, completed, expired, refunded, chargeback, billet_printed, etc.)
    // payment_type,
    transaction: transactionId, // ID da transação na Hotmart (importante para idempotência)
    approved_date, // Data de aprovação (timestamp ms)
    // billet_expiration_date,
    // Para assinaturas:
    subscriber_code, // ID do assinante (para assinaturas)
    subscription_status, // Status da assinatura (active, inactive, canceled, overdue, expired)
    date_next_charge, // Próxima data de cobrança da assinatura (YYYY-MM-DD HH:MM:SS)
    // recurrency_period, // Período da recorrência (em dias, ex: 30, 365) - pode ser útil
  } = eventData;

  logger.info(`[HOTMART SVC] Processando evento: Prod=${prod}, Status=${status}, Email=${buyer_email}, Transação=${transactionId}, Assinatura Status=${subscription_status || 'N/A'}`);

  // 1. Encontrar o Plano no nosso sistema usando o ID do produto da Hotmart
  const plan = await Plan.findOne({ where: { hotmartProductId: prod.toString() } });
  if (!plan) {
    logger.warn(`[HOTMART SVC] Plano não encontrado no sistema para Hotmart Product ID: ${prod}. Evento para ${buyer_email} ignorado.`);
    return; // Não prosseguir se o plano não existe no nosso DB
  }
  logger.info(`[HOTMART SVC] Plano local encontrado: "${plan.name}" (ID: ${plan.id})`);

  // 2. Encontrar ou criar o Cliente no nosso sistema
  let clientInstance;
  if (buyer_email) {
    clientInstance = await Client.findOne({ where: { email: buyer_email.toLowerCase() } });
  }

  if (!clientInstance && buyer_phone_number) {
    const fullPhone = (buyer_phone_local_code || '') + buyer_phone_number;
    // Tenta encontrar por telefone normalizado
    clientInstance = await Client.findOne({ where: { phone: fullPhone.replace(/\D/g, '') }});
  }

  if (!clientInstance) {
    logger.info(`[HOTMART SVC] Cliente não encontrado para ${buyer_email}. Criando novo cliente...`);
    const clientDataForCreation = {
      email: buyer_email ? buyer_email.toLowerCase() : null,
      name: buyer_name,
      phone: (buyer_phone_local_code || '') + (buyer_phone_number || ''), // O service de cliente irá normalizar
      status: 'Aguardando Pagamento', // Status inicial ao criar via Hotmart
    };
    clientInstance = await clientService.createClientContact(clientDataForCreation); // Assume que createClientContact pode lidar com isso
    logger.info(`[HOTMART SVC] Novo cliente criado: ID ${clientInstance.id}, Email: ${clientInstance.email}`);
  } else {
    logger.info(`[HOTMART SVC] Cliente existente encontrado: ID ${clientInstance.id}, Email: ${clientInstance.email}`);
    // Opcional: Atualizar nome/telefone se estiverem vazios no DB e vierem da Hotmart
    let clientNeedsUpdate = false;
    const updatePayload = {};
    if (buyer_name && (!clientInstance.name || clientInstance.name.length < buyer_name.length)) {
        updatePayload.name = buyer_name;
        clientNeedsUpdate = true;
    }
    const fullPhoneFromHotmart = ((buyer_phone_local_code || '') + (buyer_phone_number || '')).replace(/\D/g, '');
    if (fullPhoneFromHotmart && (!clientInstance.phone || clientInstance.phone !== fullPhoneFromHotmart)) {
        updatePayload.phone = fullPhoneFromHotmart;
        clientNeedsUpdate = true;
    }
    if (clientNeedsUpdate) {
        await Client.update(updatePayload, { where: { id: clientInstance.id } });
        logger.info(`[HOTMART SVC] Dados do cliente ID ${clientInstance.id} atualizados (nome/telefone).`);
        clientInstance = await Client.findByPk(clientInstance.id); // Recarrega para ter os dados atualizados
    }
  }

  // 3. Processar o status do evento da Hotmart
  // Usaremos transactionId para compras únicas e subscriber_code para assinaturas como ID externo.
  const externalIdForSubscription = subscriber_code || transactionId;

  const t = await sequelize.transaction();
  try {
    // Tenta encontrar uma assinatura existente por este externalId
    let localSubscription = await Subscription.findOne({
        where: {
            clientId: clientInstance.id,
            externalSubscriptionId: externalIdForSubscription
        },
        include: [{model: Plan, as: 'plan'}], // Inclui o plano para ter durationDays
        transaction: t
    });

    const effectiveStatus = subscription_status ? subscription_status.toLowerCase() : (status ? status.toLowerCase() : 'unknown');
    let subscriptionStartDate = approved_date ? new Date(parseInt(approved_date,10)).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    switch (effectiveStatus) {
      case 'approved': // Compra aprovada (produto único ou primeira parcela de assinatura)
      case 'active':   // Assinatura ativa
      case 'completed': // Compra concluída (pode ser tratada como ativa)
        logger.info(`[HOTMART SVC] Status APROVADO/ATIVO para Cliente ID ${clientInstance.id}, Plano ${plan.name}.`);

        let endDateApproved;
        if (date_next_charge && plan.durationDays) { // É uma assinatura com próxima cobrança
            // A data de fim da vigência atual é um pouco antes da próxima cobrança
            // Ou baseada no recurrency_period, se disponível e mais preciso
            const nextChargeDate = new Date(date_next_charge.replace(' ', 'T') + 'Z'); // Garante que seja UTC
            endDateApproved = new Date(nextChargeDate);
            endDateApproved.setDate(endDateApproved.getDate() -1); // Um dia antes da próxima cobrança
        } else if (plan.durationDays) { // Produto único ou assinatura sem próxima cobrança definida explicitamente (ex: vitalício Hotmart)
            endDateApproved = new Date(subscriptionStartDate);
            endDateApproved.setDate(endDateApproved.getDate() + plan.durationDays);
        } else {
             logger.warn(`[HOTMART SVC] Não foi possível determinar a data de término para o plano ${plan.name}. Usando padrão de 30 dias.`);
             endDateApproved = new Date(subscriptionStartDate);
             endDateApproved.setDate(endDateApproved.getDate() + 30); // Fallback
        }


        if (localSubscription) {
          await localSubscription.update({
            planId: plan.id, // Garante que o plano está correto
            startDate: subscriptionStartDate,
            endDate: endDateApproved.toISOString().split('T')[0],
            status: 'Ativa',
            autoRenew: !!date_next_charge
          }, { transaction: t });
          logger.info(`[HOTMART SVC] Assinatura existente ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) atualizada para ATIVA.`);
        } else {
          localSubscription = await subscriptionService.createSubscription(
            clientInstance.id,
            plan.id,
            subscriptionStartDate,
            'Ativa',
            externalIdForSubscription // Passa o externalId
          ); // createSubscription já usa transação internamente se não passada
          logger.info(`[HOTMART SVC] Nova assinatura ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) criada como ATIVA.`);
        }
        // A função subscriptionService.createSubscription já deve ter atualizado o Client.accessLevel e accessExpiresAt
        // Se não, ou se for um update, precisaríamos fazer aqui:
        // Ex: await clientInstance.update({ accessLevel: ..., accessExpiresAt: ...}, {transaction: t});
        // A lógica no subscriptionService é:
        // const clientAccessLevel = plan.tier === 'avancado' ?
        //     (plan.durationDays > 7000 ? 'vitalicio_avancado' : (plan.durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')) :
        //     (plan.durationDays > 7000 ? 'vitalicio_basico' : (plan.durationDays > 60 ? 'basico_anual' : 'basico_mensal'));
        // await clientInstance.update({ accessLevel: clientAccessLevel, accessExpiresAt: endDateApproved.toISOString().split('T')[0], status: 'Ativo'}, {transaction: t});
        break;

      case 'billet_printed':
        logger.info(`[HOTMART SVC] Status BOLETO GERADO para Cliente ID ${clientInstance.id}, Plano ${plan.name}.`);
        if (!localSubscription) {
          localSubscription = await subscriptionService.createSubscription(
            clientInstance.id,
            plan.id,
            new Date().toISOString().split('T')[0], // Data da geração do boleto
            'Pendente',
            externalIdForSubscription
          );
          logger.info(`[HOTMART SVC] Nova assinatura ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) criada como PENDENTE (Boleto).`);
        } else {
          await localSubscription.update({ status: 'Pendente', planId: plan.id }, { transaction: t });
          logger.info(`[HOTMART SVC] Assinatura existente ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) atualizada para PENDENTE (Boleto).`);
        }
        // Se o cliente estava como gratuito, muda para Aguardando Pagamento
        if (clientInstance.accessLevel === 'gratuito') {
            await Client.update({ status: 'Aguardando Pagamento' }, { where: { id: clientInstance.id }, transaction: t });
        }
        break;

      case 'canceled':
      case 'expired':
      case 'refunded':
      case 'chargeback':
      case 'overdue':
      case 'inactive': // Status de assinatura inativa da Hotmart
        const actionType = effectiveStatus.charAt(0).toUpperCase() + effectiveStatus.slice(1);
        logger.info(`[HOTMART SVC] Status ${actionType} para Cliente ID ${clientInstance.id}, Plano ${plan.name} (Externo: ${externalIdForSubscription}). Revogando acesso se necessário.`);

        let newSubscriptionStatusLocal = 'Expirada'; // Default
        if (effectiveStatus === 'canceled') newSubscriptionStatusLocal = 'Cancelada';
        else if (effectiveStatus === 'refunded' || effectiveStatus === 'chargeback') newSubscriptionStatusLocal = 'Cancelada'; // Pode ter um status específico
        else if (effectiveStatus === 'overdue' || effectiveStatus === 'inactive') newSubscriptionStatusLocal = 'Pagamento Falhou';

        if (localSubscription) {
          await localSubscription.update({ status: newSubscriptionStatusLocal, endDate: new Date().toISOString().split('T')[0] }, { transaction: t });
          logger.info(`[HOTMART SVC] Assinatura ${localSubscription.id} (Externo: ${externalIdForSubscription}) marcada como ${newSubscriptionStatusLocal}.`);
        } else {
           logger.warn(`[HOTMART SVC] Nenhuma assinatura local encontrada com ID externo ${externalIdForSubscription} para marcar como ${newSubscriptionStatusLocal}.`);
        }

        // Verificar se há QUALQUER outra assinatura ATIVA antes de revogar o acesso do cliente
        const anyOtherActiveSubscription = await Subscription.findOne({
          where: {
            clientId: clientInstance.id,
            status: 'Ativa',
            endDate: { [Op.gte]: new Date().toISOString().split('T')[0] },
            // Se localSubscription existe, excluí-la da verificação. Se não, não precisa.
            ...(localSubscription && { id: { [Op.ne]: localSubscription.id } })
          },
          include: [{model: Plan, as: 'plan'}], // Para pegar o tier e duration da outra ativa
          transaction: t
        });

        if (!anyOtherActiveSubscription) {
          await Client.update({
            accessLevel: 'gratuito',
            accessExpiresAt: null,
            status: (effectiveStatus === 'overdue' || effectiveStatus === 'inactive') ? 'Pagamento Falhou' : 'Ativo'
          }, { where: { id: clientInstance.id }, transaction: t });
          logger.info(`[HOTMART SVC] Acesso do cliente ID ${clientInstance.id} revertido para gratuito.`);
        } else {
          // Se há outra assinatura ativa, redefinir o accessLevel e accessExpiresAt do cliente para o dessa outra assinatura
           const otherPlan = anyOtherActiveSubscription.plan;
           const otherEndDate = new Date(anyOtherActiveSubscription.endDate);
           const otherAccessDurationDays = otherPlan.durationDays;

           const otherClientAccessLevel = otherPlan.tier === 'avancado' ?
            (otherAccessDurationDays > 7000 ? 'vitalicio_avancado' : (otherAccessDurationDays > 60 ? 'avancado_anual' : 'avancado_mensal')) :
            (otherAccessDurationDays > 7000 ? 'vitalicio_basico' : (otherAccessDurationDays > 60 ? 'basico_anual' : 'basico_mensal'));

          await Client.update({
            accessLevel: otherClientAccessLevel,
            accessExpiresAt: otherAccessDurationDays > 7000 ? null : otherEndDate.toISOString().split('T')[0],
            status: 'Ativo'
          }, { where: { id: clientInstance.id }, transaction: t });
          logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} ainda possui outra assinatura ativa ("${otherPlan.name}"). Acesso atualizado para ${otherClientAccessLevel}.`);
        }
        break;

      default:
        logger.warn(`[HOTMART SVC] Status não tratado ou desconhecido: '${effectiveStatus}'. Evento para Prod=${prod}, Email=${buyer_email} ignorado.`);
    }

    await t.commit();
  } catch (error) {
    await t.rollback();
    logger.error(`[HOTMART SVC] Erro na transação ao processar evento Hotmart para Cliente ${clientInstance ? clientInstance.id : 'N/A'}: ${error.message}`, { stack: error.stack, eventData });
    throw error; // Relança para o controller saber que houve falha e retornar 500
  }
}

module.exports = {
  processWebhookEvent,
};
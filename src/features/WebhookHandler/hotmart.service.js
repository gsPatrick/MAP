// src/features/WebhookHandler/hotmart.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
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
    throw new Error('Hottok inválido.');
  }

  logger.info('[HOTMART SVC] Hottok validado com sucesso.');

  const data = eventData.data;

  if (!data) {
    logger.error('[HOTMART SVC] Payload do webhook da Hotmart não contém o objeto "data" esperado. Payload recebido:', eventData);
    throw new Error('Formato de payload inesperado da Hotmart: objeto "data" ausente.');
  }

  const prod = data.product ? data.product.id : undefined;
  const buyer_email = data.buyer ? data.buyer.email : undefined; // Email do comprador
  // const buyer_name = data.buyer ? data.buyer.name : undefined; // Nome do comprador (não usaremos para criar/atualizar nome)
  const buyer_phone_local_code = data.buyer ? data.buyer.checkout_phone_code : undefined;
  const buyer_phone_number = data.buyer ? data.buyer.checkout_phone : undefined;
  const status = data.purchase ? data.purchase.status : undefined;
  const transactionId = data.purchase ? data.purchase.transaction : undefined;
  const approved_date = data.purchase ? data.purchase.approved_date : undefined;

  const subscriber_code = data.subscription && data.subscription.subscriber ? data.subscription.subscriber.code : undefined;
  const subscription_status = data.subscription ? data.subscription.status : undefined;
  const date_next_charge = data.subscription ? data.subscription.date_next_charge : undefined;

  logger.info(`[HOTMART SVC] Processando evento: Prod=${prod}, Status=${status}, Email=${buyer_email}, Telefone(completo payload)=${buyer_phone_local_code}${buyer_phone_number}, Transação=${transactionId}, Assinatura Status=${subscription_status || 'N/A'}`);

  if (prod === undefined || prod === null) {
    logger.warn(`[HOTMART SVC] ID do produto (prod) não encontrado no payload da Hotmart. Evento ignorado.`);
    return;
  }
  const plan = await Plan.findOne({ where: { hotmartProductId: prod.toString() } });
  if (!plan) {
    logger.warn(`[HOTMART SVC] Plano não encontrado no sistema para Hotmart Product ID: ${prod}. Evento para ${buyer_email} ignorado.`);
    return;
  }
  logger.info(`[HOTMART SVC] Plano local encontrado: "${plan.name}" (ID: ${plan.id})`);

  let clientInstance;
  const fullPhoneNumberFromHotmart = buyer_phone_local_code && buyer_phone_number
    ? (buyer_phone_local_code.replace(/\D/g, '') + buyer_phone_number.replace(/\D/g, ''))
    : null;

  // Tenta encontrar por telefone primeiro, se existir
  if (fullPhoneNumberFromHotmart) {
    clientInstance = await Client.findOne({ where: { phone: fullPhoneNumberFromHotmart }});
  }
  // Se não encontrou por telefone mas tem email, tenta por email
  if (!clientInstance && buyer_email) {
    clientInstance = await Client.findOne({ where: { email: buyer_email.toLowerCase() } });
  }


  if (!clientInstance) {
    if (!fullPhoneNumberFromHotmart) {
        logger.error('[HOTMART SVC] Tentativa de criar novo cliente via Hotmart, mas o número de telefone não foi fornecido no payload. O email é: ' + buyer_email +'. Abortando criação de cliente.');
        // Se o telefone é absolutamente obrigatório, você pode lançar um erro ou retornar.
        // Se o email for aceitável como ÚNICO identificador e você não tiver telefone,
        // você precisaria de uma lógica para criar o cliente só com email aqui.
        // Por ora, estamos priorizando telefone. Se não tem telefone, não cria (baseado na sua última instrução).
        throw new Error('Número de telefone não fornecido pela Hotmart para criação de novo cliente.');
    }
    logger.info(`[HOTMART SVC] Cliente não encontrado por telefone '${fullPhoneNumberFromHotmart}' ou email '${buyer_email}'. Criando novo cliente SOMENTE COM TELEFONE...`);
    const clientDataForCreation = {
      email: null, // Forçar email como nulo na criação
      name: null,  // Forçar nome como nulo na criação
      phone: fullPhoneNumberFromHotmart, // Telefone é obrigatório para novo cliente via Hotmart
      status: 'Aguardando Pagamento', // Começa como aguardando, será 'Ativo' se o plano for ativado
    };
    clientInstance = await clientService.createClientContact(clientDataForCreation);
    logger.info(`[HOTMART SVC] Novo cliente criado (SOMENTE COM TELEFONE): ID ${clientInstance.id}, Telefone: ${clientInstance.phone}`);
  } else {
    logger.info(`[HOTMART SVC] Cliente existente encontrado: ID ${clientInstance.id}, Email: ${clientInstance.email}, Telefone: ${clientInstance.phone}`);
    // Não vamos mais atualizar nome ou email com dados da Hotmart para clientes existentes.
    // Apenas o telefone, se vier diferente e o do banco estiver vazio ou diferente.
    let clientNeedsUpdate = false;
    const updatePayloadClient = {};

    if (fullPhoneNumberFromHotmart && (!clientInstance.phone || clientInstance.phone !== fullPhoneNumberFromHotmart)) {
        logger.info(`[HOTMART SVC] Telefone do cliente ID ${clientInstance.id} será atualizado de "${clientInstance.phone}" para "${fullPhoneNumberFromHotmart}".`);
        updatePayloadClient.phone = fullPhoneNumberFromHotmart;
        clientNeedsUpdate = true;
    }
    // Se o cliente foi encontrado pelo email, mas não tem telefone no banco e a Hotmart enviou um, atualiza.
    if (fullPhoneNumberFromHotmart && !clientInstance.phone && buyer_email && clientInstance.email === buyer_email.toLowerCase()) {
        logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} (encontrado por email) não tinha telefone, atualizando para "${fullPhoneNumberFromHotmart}".`);
        updatePayloadClient.phone = fullPhoneNumberFromHotmart;
        clientNeedsUpdate = true;
    }

    if (clientNeedsUpdate) {
        await Client.update(updatePayloadClient, { where: { id: clientInstance.id } });
        logger.info(`[HOTMART SVC] Telefone do cliente ID ${clientInstance.id} atualizado.`);
        clientInstance = await Client.findByPk(clientInstance.id); // Recarrega para ter os dados atualizados
    }
  }

  const externalIdForSubscription = subscriber_code || transactionId;
  if (!externalIdForSubscription) {
    logger.error(`[HOTMART SVC] ID externo da assinatura/transação (subscriber_code ou transactionId) não encontrado no payload. Não é possível prosseguir. Payload:`, eventData.data.subscription, eventData.data.purchase);
    throw new Error('ID externo da assinatura/transação ausente no payload da Hotmart.');
  }

  const t = await sequelize.transaction();
  try {
    let localSubscription = await Subscription.findOne({
        where: {
            clientId: clientInstance.id,
            externalSubscriptionId: externalIdForSubscription // Usar o ID externo para encontrar
        },
        include: [{model: Plan, as: 'plan'}],
        transaction: t
    });

    const effectiveStatus = subscription_status ? subscription_status.toLowerCase() : (status ? status.toLowerCase() : 'unknown');
    let subscriptionStartDate = approved_date ? new Date(parseInt(approved_date,10)).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    switch (effectiveStatus) {
      case 'approved':
      case 'active':
      case 'completed':
        logger.info(`[HOTMART SVC] Status ${effectiveStatus.toUpperCase()} para Cliente ID ${clientInstance.id}, Plano ${plan.name}.`);

        let endDateApproved;
        if (date_next_charge && plan.durationDays) { // Assinatura renovando
            const nextChargeDate = new Date(date_next_charge.replace(' ', 'T') + 'Z'); // Garante UTC
            endDateApproved = new Date(nextChargeDate);
            endDateApproved.setUTCDate(endDateApproved.getUTCDate() -1); // Um dia antes da próxima cobrança
             logger.info(`[HOTMART SVC] Renovação de assinatura. Próxima cobrança: ${date_next_charge}. Nova data de fim da vigência: ${endDateApproved.toISOString().split('T')[0]}`);
        } else if (plan.durationDays) { // Primeira ativação ou produto único
            endDateApproved = new Date(subscriptionStartDate);
            endDateApproved.setDate(endDateApproved.getDate() + plan.durationDays);
            logger.info(`[HOTMART SVC] Primeira ativação/produto único. Data de início: ${subscriptionStartDate}. Nova data de fim da vigência: ${endDateApproved.toISOString().split('T')[0]}`);
        } else {
             logger.warn(`[HOTMART SVC] Duração do plano ${plan.name} (ID: ${plan.id}) não definida (durationDays). Usando fallback de 30 dias.`);
             endDateApproved = new Date(subscriptionStartDate);
             endDateApproved.setDate(endDateApproved.getDate() + 30);
        }

        if (localSubscription) {
          // Assinatura já existe, vamos atualizá-la (renovação ou mudança de status)
          await localSubscription.update({
            planId: plan.id, // Garante que o planId está correto (pode ter mudado de plano)
            startDate: subscriptionStartDate, // Pode ser a mesma ou uma nova data de aprovação
            endDate: endDateApproved.toISOString().split('T')[0],
            status: 'Ativa',
            autoRenew: !!date_next_charge // Se tem próxima cobrança, é auto-renovável
          }, { transaction: t });
          logger.info(`[HOTMART SVC] Assinatura existente ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) atualizada para ATIVA. Válida até ${localSubscription.endDate}.`);

          // Atualizar o cliente APÓS atualizar a assinatura existente
          const clientAccessLevel = plan.tier === 'avancado' ?
            (plan.durationDays > 7000 ? 'vitalicio_avancado' : (plan.durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')) :
            (plan.durationDays > 7000 ? 'vitalicio_basico' : (plan.durationDays > 60 ? 'basico_anual' : 'basico_mensal'));

          await Client.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: plan.durationDays > 7000 ? null : endDateApproved.toISOString().split('T')[0], // Se for vitalício, não expira
            status: 'Ativo' // Garante que o cliente está ativo
           }, { where: {id: clientInstance.id }, transaction: t });
           logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} teve acesso atualizado para ${clientAccessLevel}, expira em: ${endDateApproved.toISOString().split('T')[0]}.`);

        } else {
          // Assinatura não existe, criar uma nova.
          // O serviço subscriptionService.createSubscription já lida com a atualização do Client.accessLevel e accessExpiresAt.
          localSubscription = await subscriptionService.createSubscription(
            clientInstance.id,
            plan.id,
            subscriptionStartDate,
            'Ativa',
            externalIdForSubscription // Passa o ID externo aqui
          );
          logger.info(`[HOTMART SVC] Nova assinatura ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) criada como ATIVA.`);
        }
        break;

      case 'billet_printed':
        logger.info(`[HOTMART SVC] Status BOLETO GERADO para Cliente ID ${clientInstance.id}, Plano ${plan.name}.`);
        if (!localSubscription) {
          localSubscription = await subscriptionService.createSubscription(
            clientInstance.id,
            plan.id,
            new Date().toISOString().split('T')[0],
            'Pendente',
            externalIdForSubscription
          );
          logger.info(`[HOTMART SVC] Nova assinatura ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) criada como PENDENTE (Boleto).`);
        } else {
          await localSubscription.update({ status: 'Pendente', planId: plan.id }, { transaction: t });
          logger.info(`[HOTMART SVC] Assinatura existente ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) atualizada para PENDENTE (Boleto).`);
        }
        // Se o cliente estava ativo com plano gratuito ou outro status que não seja 'Aguardando Pagamento' ou 'Pagamento Falhou'
        if (clientInstance.status === 'Ativo' && clientInstance.accessLevel === 'gratuito') {
            await Client.update({ status: 'Aguardando Pagamento' }, { where: { id: clientInstance.id }, transaction: t });
            logger.info(`[HOTMART SVC] Status do Cliente ID ${clientInstance.id} atualizado para 'Aguardando Pagamento'.`);
        }
        break;

      case 'canceled':
      case 'expired':
      case 'refunded':
      case 'chargeback':
      case 'overdue': // Cliente com pagamento atrasado
      case 'inactive': // Assinatura se tornou inativa na Hotmart
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
            ...(localSubscription && { id: { [Op.ne]: localSubscription.id } })
          },
          include: [{model: Plan, as: 'plan'}],
          transaction: t
        });

        if (!anyOtherActiveSubscription) {
          let clientNewStatus = 'Ativo'; // Por padrão, se não for pagamento falho, mantém ativo mas com acesso gratuito
          if (effectiveStatus === 'overdue' || effectiveStatus === 'inactive' || effectiveStatus === 'Pagamento Falhou'){
            clientNewStatus = 'Pagamento Falhou';
          }

          await Client.update({
            accessLevel: 'gratuito',
            accessExpiresAt: null,
            status: clientNewStatus
          }, { where: { id: clientInstance.id }, transaction: t });
          logger.info(`[HOTMART SVC] Acesso do cliente ID ${clientInstance.id} revertido para gratuito. Status do cliente: ${clientNewStatus}.`);
        } else {
           const otherPlan = anyOtherActiveSubscription.plan;
           const otherEndDate = new Date(anyOtherActiveSubscription.endDate);
           const otherAccessDurationDays = otherPlan.durationDays;
           const otherClientAccessLevel = otherPlan.tier === 'avancado' ?
            (otherAccessDurationDays > 7000 ? 'vitalicio_avancado' : (otherAccessDurationDays > 60 ? 'avancado_anual' : 'avancado_mensal')) :
            (otherAccessDurationDays > 7000 ? 'vitalicio_basico' : (otherAccessDurationDays > 60 ? 'basico_anual' : 'basico_mensal'));

          await Client.update({
            accessLevel: otherClientAccessLevel,
            accessExpiresAt: otherAccessDurationDays > 7000 ? null : otherEndDate.toISOString().split('T')[0],
            status: 'Ativo' // Garante que está ativo se tem outra assinatura válida
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
    throw error;
  }
}

module.exports = {
  processWebhookEvent,
};
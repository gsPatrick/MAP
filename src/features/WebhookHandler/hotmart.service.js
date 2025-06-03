// src/features/WebhookHandler/hotmart.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

// <<< NOVO: Telefone fixo para o teste do Prod=0 >>>
const TEST_PROD_ZERO_PHONE = '5571982862912'; // Incluindo o DDI 55

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
  const buyer_email_from_payload = data.buyer ? data.buyer.email : undefined;
  // const buyer_name_from_payload = data.buyer ? data.buyer.name : undefined; // Não usaremos
  const buyer_phone_local_code_from_payload = data.buyer ? data.buyer.checkout_phone_code : undefined;
  const buyer_phone_number_from_payload = data.buyer ? data.buyer.checkout_phone : undefined;
  const status = data.purchase ? data.purchase.status : undefined;
  const transactionId = data.purchase ? data.purchase.transaction : undefined;
  const approved_date = data.purchase ? data.purchase.approved_date : undefined;

  const subscriber_code = data.subscription && data.subscription.subscriber ? data.subscription.subscriber.code : undefined;
  const subscription_status = data.subscription ? data.subscription.status : undefined;
  const date_next_charge = data.subscription ? data.subscription.date_next_charge : undefined;

  // <<< INÍCIO DA LÓGICA ESPECIAL PARA Prod=0 >>>
  let targetClientPhone;
  let targetClientEmail = null; // Para Prod=0, não usaremos o email do payload para buscar/criar
  let targetClientName = null;  // Nem o nome

  if (prod !== undefined && prod !== null && prod.toString() === '0') {
    logger.info(`[HOTMART SVC] Evento para Prod=0 (TESTE). Usando telefone fixo: ${TEST_PROD_ZERO_PHONE}`);
    targetClientPhone = TEST_PROD_ZERO_PHONE.replace(/\D/g, '');
    // Opcional: Definir um nome fixo para este cliente de teste
    targetClientName = "Cliente Teste Hotmart ID Zero";
  } else {
    // Lógica normal para outros produtos
    targetClientEmail = buyer_email_from_payload ? buyer_email_from_payload.toLowerCase() : null;
    // targetClientName = buyer_name_from_payload; // Se fosse usar o nome do payload
    if (buyer_phone_local_code_from_payload && buyer_phone_number_from_payload) {
      targetClientPhone = (buyer_phone_local_code_from_payload.replace(/\D/g, '') + buyer_phone_number_from_payload.replace(/\D/g, ''));
    } else {
      targetClientPhone = null;
    }
  }
  // <<< FIM DA LÓGICA ESPECIAL PARA Prod=0 >>>

  logger.info(`[HOTMART SVC] Processando evento: Prod=${prod}, Status=${status}, Email (do payload)=${buyer_email_from_payload}, Telefone (a ser usado)=${targetClientPhone}, Transação=${transactionId}, Assinatura Status=${subscription_status || 'N/A'}`);

  if (prod === undefined || prod === null) {
    logger.warn(`[HOTMART SVC] ID do produto (prod) não encontrado no payload da Hotmart. Evento ignorado.`);
    return;
  }
  const plan = await Plan.findOne({ where: { hotmartProductId: prod.toString() } });
  if (!plan) {
    logger.warn(`[HOTMART SVC] Plano não encontrado no sistema para Hotmart Product ID: ${prod}. Evento para ${targetClientPhone || targetClientEmail} ignorado.`);
    return;
  }
  logger.info(`[HOTMART SVC] Plano local encontrado: "${plan.name}" (ID: ${plan.id})`);

  let clientInstance;

  // Busca ou Criação do Cliente
  if (targetClientPhone) {
    clientInstance = await Client.findOne({ where: { phone: targetClientPhone }});
  }
  // Se for Prod=0 e não achou por telefone, e não tem email alvo, cria só com telefone.
  // Se NÃO for Prod=0 e não achou por telefone mas tem email alvo, tenta por email.
  if (!clientInstance && targetClientEmail && (prod.toString() !== '0')) {
    clientInstance = await Client.findOne({ where: { email: targetClientEmail } });
  }

  if (!clientInstance) {
    if (!targetClientPhone) {
        const idInfo = prod.toString() === '0' ? `Prod=0 (telefone fixo ${TEST_PROD_ZERO_PHONE} deveria ter sido usado)` : `email ${targetClientEmail}`;
        logger.error(`[HOTMART SVC] Tentativa de criar novo cliente, mas o número de telefone não foi determinado para ${idInfo}. Abortando.`);
        throw new Error('Número de telefone não determinado para criação de novo cliente via Hotmart.');
    }
    logger.info(`[HOTMART SVC] Cliente não encontrado por telefone '${targetClientPhone}' ou email (se aplicável). Criando novo cliente...`);
    const clientDataForCreation = {
      email: (prod.toString() === '0') ? null : targetClientEmail, // Só usa email se não for o teste de Prod=0
      name: (prod.toString() === '0') ? targetClientName : null, // Nome específico para o teste de Prod=0, nulo para outros
      phone: targetClientPhone,
      status: 'Aguardando Pagamento',
    };
    clientInstance = await clientService.createClientContact(clientDataForCreation);
    logger.info(`[HOTMART SVC] Novo cliente criado: ID ${clientInstance.id}, Telefone: ${clientInstance.phone}, Email: ${clientInstance.email}, Nome: ${clientInstance.name}`);
  } else {
    logger.info(`[HOTMART SVC] Cliente existente encontrado: ID ${clientInstance.id}, Email: ${clientInstance.email}, Telefone: ${clientInstance.phone}`);
    // Lógica de atualização do cliente existente (opcional e controlada)
    // Para Prod=0, não vamos atualizar nada no cliente existente.
    // Para outros produtos, podemos atualizar o telefone se vier diferente.
    if (prod.toString() !== '0') {
        let clientNeedsUpdate = false;
        const updatePayloadClient = {};
        if (targetClientPhone && (!clientInstance.phone || clientInstance.phone !== targetClientPhone)) {
            logger.info(`[HOTMART SVC] Telefone do cliente ID ${clientInstance.id} (NÃO Prod=0) será atualizado de "${clientInstance.phone}" para "${targetClientPhone}".`);
            updatePayloadClient.phone = targetClientPhone;
            clientNeedsUpdate = true;
        }
        // Se o cliente foi encontrado pelo email, mas não tem telefone no banco e a Hotmart enviou um, atualiza.
        if (targetClientPhone && !clientInstance.phone && targetClientEmail && clientInstance.email === targetClientEmail) {
            logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} (NÃO Prod=0, encontrado por email) não tinha telefone, atualizando para "${targetClientPhone}".`);
            updatePayloadClient.phone = targetClientPhone;
            clientNeedsUpdate = true;
        }

        if (clientNeedsUpdate) {
            await Client.update(updatePayloadClient, { where: { id: clientInstance.id } });
            logger.info(`[HOTMART SVC] Telefone do cliente ID ${clientInstance.id} (NÃO Prod=0) atualizado.`);
            clientInstance = await Client.findByPk(clientInstance.id);
        }
    }
  }

  const externalIdForSubscription = subscriber_code || transactionId;
  if (!externalIdForSubscription) {
    logger.error(`[HOTMART SVC] ID externo da assinatura/transação (subscriber_code ou transactionId) não encontrado no payload. Não é possível prosseguir. Payload:`, data.subscription, data.purchase);
    throw new Error('ID externo da assinatura/transação ausente no payload da Hotmart.');
  }

  const t = await sequelize.transaction();
  try {
    // A lógica para encontrar ou criar/atualizar a 'localSubscription' e
    // o switch para 'effectiveStatus' permanecem os mesmos do código anterior.
    // O 'clientInstance' já estará definido como o "Cliente de Teste Fixo" se Prod=0.

    let localSubscription = await Subscription.findOne({
        where: {
            // Para Prod=0, a busca é sempre pelo clientInstance.id (que será o do TEST_PROD_ZERO_PHONE)
            // E pelo externalIdForSubscription (que virá da Hotmart)
            clientId: clientInstance.id,
            externalSubscriptionId: externalIdForSubscription
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
        if (date_next_charge && plan.durationDays) {
            const nextChargeDate = new Date(date_next_charge.replace(' ', 'T') + 'Z');
            endDateApproved = new Date(nextChargeDate);
            endDateApproved.setUTCDate(endDateApproved.getUTCDate() -1);
            logger.info(`[HOTMART SVC] Renovação de assinatura. Próxima cobrança: ${date_next_charge}. Nova data de fim da vigência: ${endDateApproved.toISOString().split('T')[0]}`);
        } else if (plan.durationDays) {
            endDateApproved = new Date(subscriptionStartDate);
            endDateApproved.setDate(endDateApproved.getDate() + plan.durationDays);
            logger.info(`[HOTMART SVC] Primeira ativação/produto único. Data de início: ${subscriptionStartDate}. Nova data de fim da vigência: ${endDateApproved.toISOString().split('T')[0]}`);
        } else {
             logger.warn(`[HOTMART SVC] Duração do plano ${plan.name} (ID: ${plan.id}) não definida (durationDays). Usando fallback de 30 dias.`);
             endDateApproved = new Date(subscriptionStartDate);
             endDateApproved.setDate(endDateApproved.getDate() + 30);
        }

        if (localSubscription) {
          await localSubscription.update({
            planId: plan.id,
            startDate: subscriptionStartDate,
            endDate: endDateApproved.toISOString().split('T')[0],
            status: 'Ativa',
            autoRenew: !!date_next_charge
          }, { transaction: t });
          logger.info(`[HOTMART SVC] Assinatura existente ID ${localSubscription.id} (Cliente: ${clientInstance.id}, Externo: ${externalIdForSubscription}) atualizada para ATIVA. Válida até ${localSubscription.endDate}.`);

          const clientAccessLevel = plan.tier === 'avancado' ?
            (plan.durationDays > 7000 ? 'vitalicio_avancado' : (plan.durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')) :
            (plan.durationDays > 7000 ? 'vitalicio_basico' : (plan.durationDays > 60 ? 'basico_anual' : 'basico_mensal'));

          await Client.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: plan.durationDays > 7000 ? null : endDateApproved.toISOString().split('T')[0],
            status: 'Ativo'
           }, { where: {id: clientInstance.id }, transaction: t });
           logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} teve acesso atualizado para ${clientAccessLevel}, expira em: ${endDateApproved.toISOString().split('T')[0]}.`);

        } else {
          localSubscription = await subscriptionService.createSubscription(
            clientInstance.id,
            plan.id,
            subscriptionStartDate,
            'Ativa',
            externalIdForSubscription
          );
          logger.info(`[HOTMART SVC] Nova assinatura ID ${localSubscription.id} (Cliente: ${clientInstance.id}, Externo: ${externalIdForSubscription}) criada como ATIVA.`);
        }
        break;

      // Casos de billet_printed, canceled, expired, etc. permanecem os mesmos
      // ... (copie os cases de 'billet_printed' até 'default' do código anterior aqui) ...
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
        if (clientInstance.status === 'Ativo' && clientInstance.accessLevel === 'gratuito') {
            await Client.update({ status: 'Aguardando Pagamento' }, { where: { id: clientInstance.id }, transaction: t });
            logger.info(`[HOTMART SVC] Status do Cliente ID ${clientInstance.id} atualizado para 'Aguardando Pagamento'.`);
        }
        break;

      case 'canceled':
      case 'expired':
      case 'refunded':
      case 'chargeback':
      case 'overdue':
      case 'inactive':
        const actionType = effectiveStatus.charAt(0).toUpperCase() + effectiveStatus.slice(1);
        logger.info(`[HOTMART SVC] Status ${actionType} para Cliente ID ${clientInstance.id}, Plano ${plan.name} (Externo: ${externalIdForSubscription}). Revogando acesso se necessário.`);

        let newSubscriptionStatusLocal = 'Expirada';
        if (effectiveStatus === 'canceled') newSubscriptionStatusLocal = 'Cancelada';
        else if (effectiveStatus === 'refunded' || effectiveStatus === 'chargeback') newSubscriptionStatusLocal = 'Cancelada';
        else if (effectiveStatus === 'overdue' || effectiveStatus === 'inactive') newSubscriptionStatusLocal = 'Pagamento Falhou';

        if (localSubscription) {
          await localSubscription.update({ status: newSubscriptionStatusLocal, endDate: new Date().toISOString().split('T')[0] }, { transaction: t });
          logger.info(`[HOTMART SVC] Assinatura ${localSubscription.id} (Externo: ${externalIdForSubscription}) marcada como ${newSubscriptionStatusLocal}.`);
        } else {
           logger.warn(`[HOTMART SVC] Nenhuma assinatura local encontrada com ID externo ${externalIdForSubscription} para marcar como ${newSubscriptionStatusLocal}.`);
        }

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
          let clientNewStatus = 'Ativo';
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
            status: 'Ativo'
          }, { where: { id: clientInstance.id }, transaction: t });
          logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} ainda possui outra assinatura ativa ("${otherPlan.name}"). Acesso atualizado para ${otherClientAccessLevel}.`);
        }
        break;

      default:
        logger.warn(`[HOTMART SVC] Status não tratado ou desconhecido: '${effectiveStatus}'. Evento para Prod=${prod}, Email (payload)=${buyer_email_from_payload} ignorado.`);

    } // Fim do switch

    await t.commit();
  } catch (error) {
    await t.rollback();
    logger.error(`[HOTMART SVC] Erro na transação ao processar evento Hotmart para Cliente ${clientInstance ? clientInstance.id : 'N/A'} (Telefone Alvo: ${targetClientPhone}): ${error.message}`, { stack: error.stack, eventData });
    throw error;
  }
}

module.exports = {
  processWebhookEvent,
};
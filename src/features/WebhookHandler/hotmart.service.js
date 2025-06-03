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
    throw new Error('Hottok inválido.');
  }

  logger.info('[HOTMART SVC] Hottok validado com sucesso.');

  // ---------------------------------------------------------------------------
  // INÍCIO DA CORREÇÃO: Extração de dados aninhados
  // ---------------------------------------------------------------------------
  const data = eventData.data; // Objeto principal que contém os dados úteis

  if (!data) {
    logger.error('[HOTMART SVC] Payload do webhook da Hotmart não contém o objeto "data" esperado. Payload recebido:', eventData);
    throw new Error('Formato de payload inesperado da Hotmart: objeto "data" ausente.');
  }

  // Extração cuidadosa, verificando a existência de cada objeto pai
  const prod = data.product ? data.product.id : undefined;
  const buyer_email = data.buyer ? data.buyer.email : undefined;
  const buyer_name = data.buyer ? data.buyer.name : undefined;
  // Ajustado para os nomes corretos dos campos no payload da Hotmart
  const buyer_phone_local_code = data.buyer ? data.buyer.checkout_phone_code : undefined;
  const buyer_phone_number = data.buyer ? data.buyer.checkout_phone : undefined;
  const status = data.purchase ? data.purchase.status : undefined;
  const transactionId = data.purchase ? data.purchase.transaction : undefined;
  const approved_date = data.purchase ? data.purchase.approved_date : undefined;

  const subscriber_code = data.subscription && data.subscription.subscriber ? data.subscription.subscriber.code : undefined;
  const subscription_status = data.subscription ? data.subscription.status : undefined;
  // date_next_charge não está no exemplo de payload, assumindo undefined se não vier.
  // Se vier em outro local, ajuste aqui. Ex: data.subscription.plan.date_next_charge
  const date_next_charge = data.subscription ? data.subscription.date_next_charge : undefined;
  // ---------------------------------------------------------------------------
  // FIM DA CORREÇÃO
  // ---------------------------------------------------------------------------

  logger.info(`[HOTMART SVC] Processando evento: Prod=${prod}, Status=${status}, Email=${buyer_email}, Transação=${transactionId}, Assinatura Status=${subscription_status || 'N/A'}`);

  // 1. Encontrar o Plano no nosso sistema usando o ID do produto da Hotmart
  if (prod === undefined || prod === null) {
    logger.warn(`[HOTMART SVC] ID do produto (prod) não encontrado no payload da Hotmart. Evento para ${buyer_email} ignorado.`);
    return;
  }
  const plan = await Plan.findOne({ where: { hotmartProductId: prod.toString() } });
  if (!plan) {
    logger.warn(`[HOTMART SVC] Plano não encontrado no sistema para Hotmart Product ID: ${prod}. Evento para ${buyer_email} ignorado.`);
    return;
  }
  logger.info(`[HOTMART SVC] Plano local encontrado: "${plan.name}" (ID: ${plan.id})`);

  // 2. Encontrar ou criar o Cliente no nosso sistema
  let clientInstance;
  if (buyer_email) {
    clientInstance = await Client.findOne({ where: { email: buyer_email.toLowerCase() } });
  }

  // Constrói o número de telefone completo a partir do DDD e número
  const fullPhoneNumberFromHotmart = buyer_phone_local_code && buyer_phone_number
    ? (buyer_phone_local_code.replace(/\D/g, '') + buyer_phone_number.replace(/\D/g, ''))
    : null;


  if (!clientInstance && fullPhoneNumberFromHotmart) {
    clientInstance = await Client.findOne({ where: { phone: fullPhoneNumberFromHotmart }});
  }

  if (!clientInstance) {
    logger.info(`[HOTMART SVC] Cliente não encontrado para ${buyer_email || fullPhoneNumberFromHotmart}. Criando novo cliente...`);
    const clientDataForCreation = {
      email: buyer_email ? buyer_email.toLowerCase() : null,
      name: buyer_name,
      phone: fullPhoneNumberFromHotmart,
      status: 'Aguardando Pagamento',
    };
    clientInstance = await clientService.createClientContact(clientDataForCreation);
    logger.info(`[HOTMART SVC] Novo cliente criado: ID ${clientInstance.id}, Email: ${clientInstance.email}`);
  } else {
    logger.info(`[HOTMART SVC] Cliente existente encontrado: ID ${clientInstance.id}, Email: ${clientInstance.email}`);
    let clientNeedsUpdate = false;
    const updatePayloadClient = {};
    if (buyer_name && (!clientInstance.name || clientInstance.name.length < buyer_name.length)) {
        updatePayloadClient.name = buyer_name;
        clientNeedsUpdate = true;
    }
    if (fullPhoneNumberFromHotmart && (!clientInstance.phone || clientInstance.phone !== fullPhoneNumberFromHotmart)) {
        updatePayloadClient.phone = fullPhoneNumberFromHotmart;
        clientNeedsUpdate = true;
    }
    // Adicionar atualização de email se o email da Hotmart for diferente e o campo no DB estiver vazio ou for diferente
    if (buyer_email && buyer_email.toLowerCase() !== clientInstance.email) {
        const existingEmailUser = await Client.findOne({where: {email: buyer_email.toLowerCase(), id: {[Op.ne]: clientInstance.id}}});
        if(!existingEmailUser){
            updatePayloadClient.email = buyer_email.toLowerCase();
            clientNeedsUpdate = true;
        } else {
            logger.warn(`[HOTMART SVC] Email ${buyer_email} do webhook já existe para outro cliente (ID: ${existingEmailUser.id}). Não atualizando email para cliente ${clientInstance.id}.`);
        }
    }

    if (clientNeedsUpdate) {
        await Client.update(updatePayloadClient, { where: { id: clientInstance.id } });
        logger.info(`[HOTMART SVC] Dados do cliente ID ${clientInstance.id} atualizados.`);
        clientInstance = await Client.findByPk(clientInstance.id);
    }
  }

  const externalIdForSubscription = subscriber_code || transactionId;

  const t = await sequelize.transaction();
  try {
    let localSubscription = await Subscription.findOne({
        where: {
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
        logger.info(`[HOTMART SVC] Status APROVADO/ATIVO para Cliente ID ${clientInstance.id}, Plano ${plan.name}.`);

        let endDateApproved;
        if (date_next_charge && plan.durationDays) {
            const nextChargeDate = new Date(date_next_charge.replace(' ', 'T') + 'Z');
            endDateApproved = new Date(nextChargeDate);
            endDateApproved.setDate(endDateApproved.getDate() -1);
        } else if (plan.durationDays) {
            endDateApproved = new Date(subscriptionStartDate);
            endDateApproved.setDate(endDateApproved.getDate() + plan.durationDays);
        } else {
             logger.warn(`[HOTMART SVC] Não foi possível determinar a data de término para o plano ${plan.name}. Usando padrão de 30 dias.`);
             endDateApproved = new Date(subscriptionStartDate);
             endDateApproved.setDate(endDateApproved.getDate() + 30);
        }

        if (localSubscription) {
          // Importante: O subscriptionService.createSubscription lida com a atualização do Client.
          // Se atualizarmos aqui, precisamos replicar essa lógica ou chamar um service de update.
          // Por ora, o createSubscription será chamado se não houver localSubscription.
          // Se houver, atualizamos a assinatura local e DEPOIS o cliente.
          await localSubscription.update({
            planId: plan.id,
            startDate: subscriptionStartDate,
            endDate: endDateApproved.toISOString().split('T')[0],
            status: 'Ativa',
            autoRenew: !!date_next_charge
          }, { transaction: t });
          logger.info(`[HOTMART SVC] Assinatura existente ID ${localSubscription.id} (Externo: ${externalIdForSubscription}) atualizada para ATIVA.`);

          // Atualizar o cliente após atualizar a assinatura existente
          const clientAccessLevel = plan.tier === 'avancado' ?
            (plan.durationDays > 7000 ? 'vitalicio_avancado' : (plan.durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')) :
            (plan.durationDays > 7000 ? 'vitalicio_basico' : (plan.durationDays > 60 ? 'basico_anual' : 'basico_mensal'));
          await Client.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: plan.durationDays > 7000 ? null : endDateApproved.toISOString().split('T')[0],
            status: 'Ativo'
           }, { where: {id: clientInstance.id }, transaction: t });
           logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} teve acesso atualizado para ${clientAccessLevel} devido à atualização da assinatura.`);

        } else {
          // subscriptionService.createSubscription já deve tratar a atualização do Client.accessLevel e accessExpiresAt
          localSubscription = await subscriptionService.createSubscription(
            clientInstance.id,
            plan.id,
            subscriptionStartDate,
            'Ativa',
            externalIdForSubscription,
            // true // autoRenew (se criarSubscription aceitar) - o default no service é baseado em durationDays
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
        if (clientInstance.accessLevel === 'gratuito' || clientInstance.status === 'Ativo') { // Se estava ativo gratuito ou apenas ativo (ex. pós-trial)
            await Client.update({ status: 'Aguardando Pagamento' }, { where: { id: clientInstance.id }, transaction: t });
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
          await Client.update({
            accessLevel: 'gratuito',
            accessExpiresAt: null,
            status: (effectiveStatus === 'overdue' || effectiveStatus === 'inactive') ? 'Pagamento Falhou' : 'Ativo'
          }, { where: { id: clientInstance.id }, transaction: t });
          logger.info(`[HOTMART SVC] Acesso do cliente ID ${clientInstance.id} revertido para gratuito.`);
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
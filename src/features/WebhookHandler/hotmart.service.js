// src/features/WebhookHandler/hotmart.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

const TEST_PROD_ZERO_PHONE = '5571982862912'; // Seu número de teste

/**
 * Processa um evento de webhook recebido da Hotmart.
 */
async function processWebhookEvent(eventData, hottokFromHeader) {
  // ... (validação do hottok e extração inicial do payload data, prod, status, etc. como antes)
  const configuredHottok = process.env.HOTMART_HOTTOK;

  if (!configuredHottok) {
    logger.error('[HOTMART SVC] HOTMART_HOTTOK não está configurado no ambiente.');
    throw new Error('Configuração interna do servidor impede a validação do webhook.');
  }
  if (configuredHottok !== hottokFromHeader) {
    logger.warn(`[HOTMART SVC] Hottok inválido recebido.`);
    throw new Error('Hottok inválido.');
  }
  logger.info('[HOTMART SVC] Hottok validado com sucesso.');

  const data = eventData.data;
  if (!data) {
    logger.error('[HOTMART SVC] Payload do webhook da Hotmart não contém o objeto "data".', eventData);
    throw new Error('Formato de payload inesperado da Hotmart: objeto "data" ausente.');
  }

  const prod = data.product ? data.product.id : undefined;
  const buyer_email_from_payload = data.buyer ? data.buyer.email : undefined;
  const buyer_phone_local_code_from_payload = data.buyer ? data.buyer.checkout_phone_code : undefined;
  const buyer_phone_number_from_payload = data.buyer ? data.buyer.checkout_phone : undefined;
  const status = data.purchase ? data.purchase.status : undefined;
  const transactionId = data.purchase ? data.purchase.transaction : undefined;
  const approved_date = data.purchase ? data.purchase.approved_date : undefined;
  const subscriber_code = data.subscription && data.subscription.subscriber ? data.subscription.subscriber.code : undefined;
  const subscription_status = data.subscription ? data.subscription.status : undefined;
  const date_next_charge = data.subscription ? data.subscription.date_next_charge : undefined;

  let clientPhoneNumberForLookup;
  let clientNameToSetOnCreate = null; // Nome será null por padrão, exceto para Prod=0
  const isProdZeroTest = (prod !== undefined && prod !== null && prod.toString() === '0');

  if (isProdZeroTest) {
    logger.info(`[HOTMART SVC] Evento para Prod=0 (TESTE). Usando telefone fixo: ${TEST_PROD_ZERO_PHONE}`);
    clientPhoneNumberForLookup = TEST_PROD_ZERO_PHONE.replace(/\D/g, '');
    clientNameToSetOnCreate = "Cliente Teste Hotmart ID Zero"; // Nome específico para o cliente de teste
  } else {
    if (buyer_phone_local_code_from_payload && buyer_phone_number_from_payload) {
      clientPhoneNumberForLookup = (buyer_phone_local_code_from_payload.replace(/\D/g, '') + buyer_phone_number_from_payload.replace(/\D/g, ''));
    } else {
      clientPhoneNumberForLookup = null;
      // Se o telefone não vier no payload para um produto real, o que fazer?
      // A lógica atual abaixo lançará um erro se não conseguir determinar um telefone para criar um novo cliente.
      // Se você quiser usar o email como fallback para BUSCAR, mas não para CRIAR, a lógica precisa ser mais granular.
      // Por ora, a prioridade é o telefone.
      logger.warn(`[HOTMART SVC] Telefone do comprador não fornecido no payload para Prod=${prod}. Email do payload: ${buyer_email_from_payload}`);
    }
    // clientNameToSetOnCreate permanece null para produtos reais, conforme sua regra.
  }

  logger.info(`[HOTMART SVC] Processando evento: Prod=${prod}, Status=${status}, Email(payload)=${buyer_email_from_payload}, Telefone(para lookup/criação)=${clientPhoneNumberForLookup}, Transação=${transactionId}, Assinatura Status=${subscription_status || 'N/A'}`);

  if (prod === undefined || prod === null) {
    logger.warn(`[HOTMART SVC] ID do produto (prod) não encontrado no payload. Evento ignorado.`);
    return;
  }
  const plan = await Plan.findOne({ where: { hotmartProductId: prod.toString() } });
  if (!plan) {
    logger.warn(`[HOTMART SVC] Plano não encontrado no sistema para Hotmart Product ID: ${prod}. Evento para Telefone ${clientPhoneNumberForLookup} ignorado.`);
    return;
  }
  logger.info(`[HOTMART SVC] Plano local encontrado: "${plan.name}" (ID: ${plan.id})`);

  let clientInstance;

  if (clientPhoneNumberForLookup) {
    logger.info(`[HOTMART SVC - DEBUG] Tentando encontrar cliente com phone: '${clientPhoneNumberForLookup}'`);
    clientInstance = await Client.findOne({ where: { phone: clientPhoneNumberForLookup }});
  }
  // Adicional: Se não encontrou por telefone E NÃO É o teste Prod=0 E tem email no payload, tenta buscar por email.
  // Isso ajuda se um cliente se cadastrou no seu sistema com email, mas a compra na Hotmart veio com um telefone diferente
  // ou sem telefone, mas com o mesmo email.
  if (!clientInstance && !isProdZeroTest && buyer_email_from_payload) {
    logger.info(`[HOTMART SVC - DEBUG] Cliente não encontrado por telefone. Tentando por email (payload): '${buyer_email_from_payload.toLowerCase()}'`);
    clientInstance = await Client.findOne({ where: { email: buyer_email_from_payload.toLowerCase() } });
    if (clientInstance && clientPhoneNumberForLookup && !clientInstance.phone) {
        // Encontrou por email, não tem telefone no DB, mas Hotmart enviou telefone: atualiza telefone.
        logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} (encontrado por email) não tinha telefone. Atualizando para ${clientPhoneNumberForLookup}.`);
        await clientInstance.update({ phone: clientPhoneNumberForLookup });
        clientInstance = await Client.findByPk(clientInstance.id); // Recarrega
    }
  }


  if (!clientInstance) {
    // Se chegamos aqui, o cliente não foi encontrado nem por telefone nem por email (ou é Prod=0 e não foi achado pelo telefone fixo).
    // Precisamos de um telefone para criar o cliente.
    if (!clientPhoneNumberForLookup) {
        logger.error(`[HOTMART SVC] Não foi possível determinar um número de telefone para criar o novo cliente (Prod=${prod}, Email Payload=${buyer_email_from_payload}). Abortando.`);
        throw new Error('Número de telefone ausente ou não determinado para criação de cliente via webhook.');
    }

    logger.info(`[HOTMART SVC] Nenhum cliente existente encontrado. Criando novo cliente com Telefone: ${clientPhoneNumberForLookup}...`);
    const clientDataForCreation = {
      email: null, // Email sempre nulo na criação via Hotmart, conforme sua regra
      name: clientNameToSetOnCreate, // Nome específico para Prod=0, ou null para outros
      phone: clientPhoneNumberForLookup,
      status: 'Aguardando Pagamento', // Será 'Ativo' após ativação do plano
    };
    clientInstance = await clientService.createClientContact(clientDataForCreation);
    logger.info(`[HOTMART SVC] Novo cliente criado: ID ${clientInstance.id}, Telefone: ${clientInstance.phone}, Email: ${clientInstance.email}, Nome: ${clientInstance.name}`);
  } else {
    // Cliente existente encontrado
    logger.info(`[HOTMART SVC] Cliente existente encontrado: ID ${clientInstance.id}, Telefone: ${clientInstance.phone}, Email: ${clientInstance.email}, Nome: ${clientInstance.name}`);
    // Se for o teste Prod=0 e o nome do cliente encontrado não for o nome de teste, atualiza o nome.
    if (isProdZeroTest && clientInstance.name !== clientNameToSetOnCreate && clientNameToSetOnCreate) {
        await clientInstance.update({ name: clientNameToSetOnCreate });
        logger.info(`[HOTMART SVC] Nome do cliente de teste ID ${clientInstance.id} (Prod=0) verificado/atualizado para "${clientNameToSetOnCreate}".`);
        clientInstance = await Client.findByPk(clientInstance.id); // Recarrega para consistência
    }
    // Para produtos reais, não atualizamos nome/email de clientes existentes.
    // A atualização do telefone (se o cliente foi encontrado por email mas não tinha telefone) já foi feita acima.
  }

  const externalIdForSubscription = subscriber_code || transactionId;
  if (!externalIdForSubscription) {
    logger.error(`[HOTMART SVC] ID externo da assinatura/transação (subscriber_code ou transactionId) não encontrado. Abortando. Payload:`, data.subscription, data.purchase);
    throw new Error('ID externo da assinatura/transação ausente no payload da Hotmart.');
  }

  const t = await sequelize.transaction();
  try {
    // A lógica para encontrar ou criar/atualizar a 'localSubscription' e
    // o switch para 'effectiveStatus' permanecem os mesmos.
    // O 'clientInstance' já estará definido corretamente (seja o de teste ou o do payload).

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
          logger.info(`[HOTMART SVC] Assinatura existente ID ${localSubscription.id} (Cliente: ${clientInstance.id}, Externo: ${externalIdForSubscription}) atualizada para ATIVA. Válida até ${endDateApproved.toISOString().split('T')[0]}.`);

          const clientAccessLevel = plan.tier === 'avancado' ?
            (plan.durationDays > 7000 ? 'vitalicio_avancado' : (plan.durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')) :
            (plan.durationDays > 7000 ? 'vitalicio_basico' : (plan.durationDays > 60 ? 'basico_anual' : 'basico_mensal'));

          await Client.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: plan.durationDays > 7000 ? null : endDateApproved.toISOString().split('T')[0],
            status: 'Ativo'
           }, { where: {id: clientInstance.id }, transaction: t });
           logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} teve acesso ATUALIZADO para ${clientAccessLevel}, expira em: ${endDateApproved.toISOString().split('T')[0]}.`);

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
        logger.warn(`[HOTMART SVC] Status não tratado ou desconhecido: '${effectiveStatus}'. Evento para Prod=${prod}, Email(payload)=${buyer_email_from_payload} ignorado.`);
    }

    await t.commit();
  } catch (error) {
    await t.rollback();
    logger.error(`[HOTMART SVC] Erro na transação ao processar evento Hotmart para Cliente ${clientInstance ? clientInstance.id : 'N/A'} (Telefone Alvo: ${clientPhoneNumberForLookup}): ${error.message}`, { stack: error.stack, eventData });
    throw error;
  }
}

module.exports = {
  processWebhookEvent,
};
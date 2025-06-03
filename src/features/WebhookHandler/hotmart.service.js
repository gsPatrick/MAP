// src/features/WebhookHandler/hotmart.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

const TEST_PROD_ZERO_PHONE = '5571982862912'; // DDI + DDD + Número

/**
 * Processa um evento de webhook recebido da Hotmart.
 */
async function processWebhookEvent(eventData, hottokFromHeader) {
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

  // Extração dos dados do payload
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

  let clientPhoneNumberToUse;
  let clientEmailForLookup = null; // Email do payload para BUSCA, não necessariamente para criação/update
  let clientNameToSetOnCreate = null; // Nome a ser usado APENAS na criação
  const isProdZeroTest = (prod !== undefined && prod !== null && prod.toString() === '0');

  if (isProdZeroTest) {
    logger.info(`[HOTMART SVC] Evento para Prod=0 (TESTE). Usando telefone fixo: ${TEST_PROD_ZERO_PHONE}`);
    clientPhoneNumberToUse = TEST_PROD_ZERO_PHONE.replace(/\D/g, '');
    clientNameToSetOnCreate = "Cliente Teste Hotmart ID Zero";
    // Não usaremos o email do payload para buscar ou criar o cliente de teste Prod=0
  } else {
    // Para produtos reais, usa os dados do payload
    if (buyer_phone_local_code_from_payload && buyer_phone_number_from_payload) {
      clientPhoneNumberToUse = (buyer_phone_local_code_from_payload.replace(/\D/g, '') + buyer_phone_number_from_payload.replace(/\D/g, ''));
    } else {
      clientPhoneNumberToUse = null;
    }
    if (buyer_email_from_payload) {
      clientEmailForLookup = buyer_email_from_payload.toLowerCase();
    }
    // Não vamos usar buyer_name_from_payload para clientNameToSetOnCreate para produtos reais
    // O nome será definido pelo onboarding do WhatsApp ou outra interação.
  }

  logger.info(`[HOTMART SVC] Processando evento: Prod=${prod}, Status=${status}, Email(payload)=${buyer_email_from_payload}, Telefone(a ser usado)=${clientPhoneNumberToUse}, Transação=${transactionId}, Assinatura Status=${subscription_status || 'N/A'}`);

  if (prod === undefined || prod === null) {
    logger.warn(`[HOTMART SVC] ID do produto (prod) não encontrado no payload. Evento ignorado.`);
    return;
  }
  const plan = await Plan.findOne({ where: { hotmartProductId: prod.toString() } });
  if (!plan) {
    logger.warn(`[HOTMART SVC] Plano não encontrado no sistema para Hotmart Product ID: ${prod}. Evento para ${clientPhoneNumberToUse || clientEmailForLookup} ignorado.`);
    return;
  }
  logger.info(`[HOTMART SVC] Plano local encontrado: "${plan.name}" (ID: ${plan.id})`);

  let clientInstance;

  // Lógica Unificada de Busca/Criação do Cliente:
  // 1. Tenta encontrar por telefone (clientPhoneNumberToUse). Este é o identificador primário.
  // 2. Se não encontrar por telefone E não for o teste Prod=0 E tiver um email no payload, tenta encontrar por email.
  // 3. Se ainda não encontrar, cria um novo cliente.

  if (clientPhoneNumberToUse) {
    clientInstance = await Client.findOne({ where: { phone: clientPhoneNumberToUse }});
    if (clientInstance) {
        logger.info(`[HOTMART SVC] Cliente encontrado por telefone ${clientPhoneNumberToUse}: ID ${clientInstance.id}`);
    }
  }

  if (!clientInstance && clientEmailForLookup && !isProdZeroTest) {
    clientInstance = await Client.findOne({ where: { email: clientEmailForLookup } });
    if (clientInstance) {
        logger.info(`[HOTMART SVC] Cliente encontrado por email ${clientEmailForLookup}: ID ${clientInstance.id}`);
        // Se encontrou por email mas não tinha telefone no banco, e o payload da Hotmart tem telefone,
        // podemos considerar atualizar o telefone do cliente.
        if (clientPhoneNumberToUse && !clientInstance.phone) {
            logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} (encontrado por email) não tinha telefone. Atualizando para ${clientPhoneNumberToUse}.`);
            await clientInstance.update({ phone: clientPhoneNumberToUse });
            clientInstance = await Client.findByPk(clientInstance.id); // Recarrega
        }
    }
  }

  if (!clientInstance) {
    // Condições para criar:
    // - Se for Prod=0, clientPhoneNumberToUse (TEST_PROD_ZERO_PHONE) deve estar definido.
    // - Se não for Prod=0, clientPhoneNumberToUse (do payload) deve estar definido.
    if (!clientPhoneNumberToUse) {
        const idInfo = isProdZeroTest ? `Prod=0 (telefone fixo ${TEST_PROD_ZERO_PHONE} não foi definido corretamente no código)` : `email ${clientEmailForLookup}`;
        logger.error(`[HOTMART SVC] Tentativa de criar novo cliente, mas o número de telefone não foi determinado/fornecido para ${idInfo}. Payload do comprador:`, data.buyer);
        throw new Error('Número de telefone não fornecido/determinado para criação de novo cliente via Hotmart.');
    }

    logger.info(`[HOTMART SVC] Nenhum cliente existente encontrado. Criando novo cliente com Telefone: ${clientPhoneNumberToUse}...`);
    const clientDataForCreation = {
      email: null, // Email não será usado na criação inicial, conforme sua regra
      name: clientNameToSetOnCreate, // Será "Cliente Teste Hotmart ID Zero" para Prod=0, ou null para outros
      phone: clientPhoneNumberToUse,
      status: 'Aguardando Pagamento', // Ou 'Ativo' se preferir que já comece ativo antes da confirmação do plano
    };
    clientInstance = await clientService.createClientContact(clientDataForCreation);
    logger.info(`[HOTMART SVC] Novo cliente criado: ID ${clientInstance.id}, Telefone: ${clientInstance.phone}, Email: ${clientInstance.email}, Nome: ${clientInstance.name}`);
  } else {
    // Cliente existente encontrado.
    // Para Prod=0, forçamos o nome para o de teste se estiver diferente. Não atualizamos telefone/email.
    if (isProdZeroTest) {
        if (clientInstance.name !== clientNameToSetOnCreate && clientNameToSetOnCreate) {
            await clientInstance.update({ name: clientNameToSetOnCreate });
            logger.info(`[HOTMART SVC] Nome do cliente de teste ID ${clientInstance.id} (Prod=0) atualizado para "${clientNameToSetOnCreate}".`);
            clientInstance = await Client.findByPk(clientInstance.id);
        } else {
             logger.info(`[HOTMART SVC] Cliente de teste ID ${clientInstance.id} (Prod=0) encontrado. Nome e telefone não serão alterados pelo payload.`);
        }
    }
    // Para produtos reais, não atualizamos nome/email. O telefone já foi tratado acima se encontrou por email.
  }

  const externalIdForSubscription = subscriber_code || transactionId;
  if (!externalIdForSubscription) {
    logger.error(`[HOTMART SVC] ID externo da assinatura/transação (subscriber_code ou transactionId) não encontrado. Abortando. Payload:`, data.subscription, data.purchase);
    throw new Error('ID externo da assinatura/transação ausente no payload da Hotmart.');
  }

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
          // createSubscription já loga a atualização do cliente.
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
    logger.error(`[HOTMART SVC] Erro na transação ao processar evento Hotmart para Cliente ${clientInstance ? clientInstance.id : 'N/A'} (Telefone Alvo: ${clientPhoneNumberToUse}): ${error.message}`, { stack: error.stack, eventData });
    throw error;
  }
}

module.exports = {
  processWebhookEvent,
};
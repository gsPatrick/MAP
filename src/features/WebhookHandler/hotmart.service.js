// src/features/WebhookHandler/hotmart.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

/**
 * Normaliza um número de telefone brasileiro para o formato usado pelo WhatsApp (sem o nono dígito).
 * @param {string} phoneNumber - O número de telefone a ser normalizado.
 * @returns {string|null} - O número normalizado ou null se a entrada for inválida.
 */
function normalizePhoneNumberForWhatsapp(phoneNumber) {
    if (!phoneNumber) return null;

    // 1. Limpa tudo que não for número.
    let cleanNumber = phoneNumber.replace(/\D/g, '');

    // 2. Garante que o número tenha o DDI 55 (padrão Brasil).
    if (cleanNumber.length === 11) { // Formato comum: DDD (2) + Número (9) = 11 dígitos
        cleanNumber = '55' + cleanNumber;
    }

    // 3. Verifica se o número está no formato brasileiro completo (DDI + DDD + 9º dígito).
    // DDI (55) + DDD (XX) + 9º dígito (9) + Resto (XXXXXXXX) = 13 dígitos
    if (cleanNumber.length === 13 && cleanNumber.startsWith('55')) {
        const ddd = cleanNumber.substring(2, 4);
        const nonoDigito = cleanNumber.charAt(4);

        // A regra do nono dígito se aplica a celulares. DDDs de celular começam de 11 a 99.
        // O nono dígito é sempre '9'.
        if (nonoDigito === '9') {
            const numeroSemNonoDigito = cleanNumber.substring(5);
            const numeroNormalizado = '55' + ddd + numeroSemNonoDigito;
            logger.info(`[NORMALIZE_PHONE] Removendo nono dígito de '${cleanNumber}' para '${numeroNormalizado}'.`);
            return numeroNormalizado;
        }
    }
    
    // Se não se encaixar na regra de remoção, retorna o número limpo como está.
    logger.info(`[NORMALIZE_PHONE] Número '${cleanNumber}' não se encaixa na regra de remoção do nono dígito. Usando como está.`);
    return cleanNumber;
}


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

  // Extração de dados do payload da Hotmart
  const prod = data.product ? data.product.id : undefined;
  const buyer_email_from_payload = data.buyer ? data.buyer.email : undefined;
  const buyer_phone_number_from_payload = data.buyer ? data.buyer.checkout_phone : undefined;
  const buyer_name_from_payload = data.buyer ? data.buyer.name : null;
  const status = data.purchase ? data.purchase.status : undefined;
  const transactionId = data.purchase ? data.purchase.transaction : undefined;
  const approved_date = data.purchase ? data.purchase.approved_date : undefined;
  const subscriber_code = data.subscription && data.subscription.subscriber ? data.subscription.subscriber.code : undefined;
  const subscription_status = data.subscription ? data.subscription.status : undefined;
  const date_next_charge = data.subscription ? data.subscription.date_next_charge : undefined;

  // --- LÓGICA DE NORMALIZAÇÃO DE TELEFONE (VERSÃO DEFINITIVA COM REMOÇÃO DO 9) ---
  const clientPhoneNumberForLookup = normalizePhoneNumberForWhatsapp(buyer_phone_number_from_payload);

  if (!clientPhoneNumberForLookup) {
      logger.warn(`[HOTMART SVC] Telefone do comprador não pôde ser determinado ou não foi fornecido no payload para Prod=${prod}. Email: ${buyer_email_from_payload}`);
      // A lógica abaixo continuará e tentará encontrar pelo email.
  }

  logger.info(`[HOTMART SVC] Processando evento: Prod=${prod}, Status Compra=${status}, Status Assinatura=${subscription_status || 'N/A'}, Email(payload)=${buyer_email_from_payload}, Telefone(lookup/criação)=${clientPhoneNumberForLookup}, Transação=${transactionId}, ID Assinante=${subscriber_code || 'N/A'}`);

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

  // Busca ou cria o cliente
  let clientInstance;
  if (clientPhoneNumberForLookup) {
    logger.info(`[HOTMART SVC - DEBUG] Tentando encontrar cliente com phone: '${clientPhoneNumberForLookup}'`);
    clientInstance = await Client.findOne({ where: { phone: clientPhoneNumberForLookup }});
  }
  if (!clientInstance && buyer_email_from_payload) {
    logger.info(`[HOTMART SVC - DEBUG] Cliente não encontrado por telefone. Tentando por email (payload): '${buyer_email_from_payload.toLowerCase()}'`);
    clientInstance = await Client.findOne({ where: { email: buyer_email_from_payload.toLowerCase() } });
    if (clientInstance && clientPhoneNumberForLookup && !clientInstance.phone) {
        logger.info(`[HOTMART SVC] Cliente ID ${clientInstance.id} (encontrado por email) não tinha telefone. Atualizando para ${clientPhoneNumberForLookup}.`);
        await clientInstance.update({ phone: clientPhoneNumberForLookup });
    }
  }

  if (!clientInstance) {
    if (!clientPhoneNumberForLookup) {
        logger.error(`[HOTMART SVC] Não foi possível determinar um número de telefone para criar o novo cliente (Prod=${prod}, Email Payload=${buyer_email_from_payload}). Abortando.`);
        throw new Error('Número de telefone ausente ou não determinado para criação de cliente via webhook.');
    }
    logger.info(`[HOTMART SVC] Nenhum cliente existente encontrado. Criando novo cliente com Telefone: ${clientPhoneNumberForLookup}...`);
    const clientDataForCreation = {
      email: buyer_email_from_payload ? buyer_email_from_payload.toLowerCase() : null,
      name: buyer_name_from_payload,
      phone: clientPhoneNumberForLookup,
      status: 'Aguardando Pagamento',
    };
    clientInstance = await clientService.createClientContact(clientDataForCreation);
    logger.info(`[HOTMART SVC] Novo cliente criado: ID ${clientInstance.id}, Telefone: ${clientInstance.phone}, Email: ${clientInstance.email}, Nome: ${clientInstance.name}`);
  } else {
    logger.info(`[HOTMART SVC] Cliente existente encontrado: ID ${clientInstance.id}, Telefone: ${clientInstance.phone}, Email: ${clientInstance.email}, Nome: ${clientInstance.name}`);
    const updates = {};
    if (!clientInstance.name && buyer_name_from_payload) {
        updates.name = buyer_name_from_payload;
    }
    if (!clientInstance.email && buyer_email_from_payload) {
        updates.email = buyer_email_from_payload.toLowerCase();
    }
    if (Object.keys(updates).length > 0) {
        logger.info(`[HOTMART SVC] Atualizando dados do cliente existente ID ${clientInstance.id} com informações da Hotmart.`, updates);
        await clientInstance.update(updates);
    }
  }

  // O resto do arquivo permanece exatamente o mesmo
  // ... (código de processamento de status: approved, billet_printed, etc.) ...
  
  // ID externo: subscriber_code para assinaturas, transactionId para compras únicas
  const externalIdForSubscription = subscriber_code || transactionId;
  if (!externalIdForSubscription) {
    logger.error(`[HOTMART SVC] ID externo da assinatura/transação (subscriber_code ou transactionId) não encontrado. Abortando.`, { sub_payload: data.subscription, purchase_payload: data.purchase });
    throw new Error('ID externo da assinatura/transação ausente no payload da Hotmart.');
  }

  try {
    const effectiveStatus = (subscription_status || status || 'unknown').toLowerCase();
    let accessStartDate = approved_date ? new Date(parseInt(approved_date,10)).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    switch (effectiveStatus) {
      case 'approved':
      case 'active':
      case 'completed':
        logger.info(`[HOTMART SVC] Status EFETIVO ${effectiveStatus.toUpperCase()} para Cliente ID ${clientInstance.id}, Plano ${plan.name}.`);

        let accessEndDate;
        if (subscription_status && date_next_charge && plan.durationDays) {
            const nextChargeDate = new Date(date_next_charge.replace(' ', 'T') + 'Z');
            accessEndDate = new Date(nextChargeDate);
            accessEndDate.setUTCDate(accessEndDate.getUTCDate() - 1);
            logger.info(`[HOTMART SVC] Processando como assinatura recorrente. Próxima cobrança: ${date_next_charge}. Vigência atual do acesso até: ${accessEndDate.toISOString().split('T')[0]}`);
        } else if (plan.durationDays) {
            accessEndDate = new Date(accessStartDate);
            accessEndDate.setDate(accessEndDate.getDate() + plan.durationDays);
            logger.info(`[HOTMART SVC] Processando como produto único ou primeira ativação. Data de início: ${accessStartDate}. Vigência do acesso até: ${accessEndDate.toISOString().split('T')[0]}`);
        } else {
             logger.warn(`[HOTMART SVC] Duração do plano ${plan.name} (ID: ${plan.id}) não definida (durationDays). Usando fallback de 30 dias para cálculo de data de fim.`);
             accessEndDate = new Date(accessStartDate);
             accessEndDate.setDate(accessEndDate.getDate() + 30);
        }
        
        const existingLocalSubscription = await Subscription.findOne({
            where: { externalSubscriptionId: externalIdForSubscription }
        });

        if (existingLocalSubscription) {
            logger.info(`[HOTMART SVC] Assinatura local existente encontrada (ID: ${existingLocalSubscription.id}, Externo: ${externalIdForSubscription}). Chamando updateSubscriptionStatusByExternalId.`);
            await subscriptionService.updateSubscriptionStatusByExternalId(
                externalIdForSubscription,
                'Ativa',
                accessEndDate.toISOString().split('T')[0]
            );
        } else {
            logger.info(`[HOTMART SVC] Nenhuma assinatura local encontrada para external ID ${externalIdForSubscription}. Criando nova assinatura via subscriptionService.`);
            await subscriptionService.createSubscription(
                clientInstance.id,
                plan.id,
                accessStartDate,
                'Ativa',
                externalIdForSubscription
            );
        }
        break;

      case 'billet_printed':
        logger.info(`[HOTMART SVC] Status BOLETO GERADO para Cliente ID ${clientInstance.id}, Plano ${plan.name}.`);
        let localSubscriptionBillet = await Subscription.findOne({
            where: { externalSubscriptionId: externalIdForSubscription }
        });

        if (!localSubscriptionBillet) {
          await subscriptionService.createSubscription(
            clientInstance.id,
            plan.id,
            new Date().toISOString().split('T')[0],
            'Pendente',
            externalIdForSubscription
          );
          logger.info(`[HOTMART SVC] Nova assinatura (Externo: ${externalIdForSubscription}) criada como PENDENTE (Boleto).`);
        } else {
          if(localSubscriptionBillet.status !== 'Ativa'){
            await localSubscriptionBillet.update({ status: 'Pendente', planId: plan.id });
            logger.info(`[HOTMART SVC] Assinatura existente (Externo: ${externalIdForSubscription}) atualizada para PENDENTE (Boleto).`);
          } else {
             logger.info(`[HOTMART SVC] Assinatura existente (Externo: ${externalIdForSubscription}) já está ATIVA. Mantendo status para evento de boleto gerado.`);
          }
        }
        if (clientInstance.status === 'Ativo' && clientInstance.accessLevel === 'gratuito') {
            await clientInstance.update({ status: 'Aguardando Pagamento' });
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
        logger.info(`[HOTMART SVC] Status ${actionType} para Cliente ID ${clientInstance.id}, Plano ${plan.name} (Externo: ${externalIdForSubscription}).`);

        let newSubscriptionStatusLocal = 'Expirada';
        if (effectiveStatus === 'canceled' || effectiveStatus === 'refunded' || effectiveStatus === 'chargeback') {
            newSubscriptionStatusLocal = 'Cancelada';
        } else if (effectiveStatus === 'overdue' || effectiveStatus === 'inactive') {
            newSubscriptionStatusLocal = 'Pagamento Falhou';
        }

        logger.info(`[HOTMART SVC] Chamando updateSubscriptionStatusByExternalId para marcar assinatura ${externalIdForSubscription} como ${newSubscriptionStatusLocal}.`);
        await subscriptionService.updateSubscriptionStatusByExternalId(
            externalIdForSubscription,
            newSubscriptionStatusLocal,
            null
        );
        break;

      default:
        logger.warn(`[HOTMART SVC] Status efetivo não tratado ou desconhecido: '${effectiveStatus}'. Evento para Prod=${prod}, Email(payload)=${buyer_email_from_payload} ignorado.`);
    }

  } catch (error) {
    logger.error(`[HOTMART SVC] Erro ao processar evento Hotmart para Cliente ${clientInstance ? clientInstance.id : 'N/A'} (Telefone Alvo: ${clientPhoneNumberForLookup}): ${error.message}`, { stack: error.stack, eventData });
    throw error;
  }
}

module.exports = {
  processWebhookEvent,
};
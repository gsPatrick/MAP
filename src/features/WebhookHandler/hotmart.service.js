// src/features/WebhookHandler/hotmart.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database'); // sequelize aqui pode não ser necessário diretamente
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

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
  const buyer_phone_local_code_from_payload = data.buyer ? data.buyer.checkout_phone_code : undefined;
  const buyer_phone_number_from_payload = data.buyer ? data.buyer.checkout_phone : undefined;
  const buyer_name_from_payload = data.buyer ? data.buyer.name : null; // Captura o nome do comprador
  const status = data.purchase ? data.purchase.status : undefined; // Status da compra
  const transactionId = data.purchase ? data.purchase.transaction : undefined;
  const approved_date = data.purchase ? data.purchase.approved_date : undefined; // Timestamp da aprovação
  const subscriber_code = data.subscription && data.subscription.subscriber ? data.subscription.subscriber.code : undefined; // ID do assinante (para assinaturas)
  const subscription_status = data.subscription ? data.subscription.status : undefined; // Status da assinatura (ACTIVE, CANCELED, etc.)
  const date_next_charge = data.subscription ? data.subscription.date_next_charge : undefined; // Próxima data de cobrança para assinaturas

  let clientPhoneNumberForLookup;

  // --- LÓGICA DE NORMALIZAÇÃO DE TELEFONE (VERSÃO DEFINITIVA) ---
  if (buyer_phone_number_from_payload) {
    // 1. Limpa tudo que não for número do campo principal do telefone.
    let cleanNumber = buyer_phone_number_from_payload.replace(/\D/g, '');

    // 2. Analisa o tamanho do número para normalizar para o padrão brasileiro (55+DDD+Numero).
    if (cleanNumber.length === 11) { // Formato mais comum: DDD + Número (ex: 71912345678)
      logger.info(`[HOTMART SVC] Normalizando telefone: Número com 11 dígitos ('${cleanNumber}'). Adicionando '55'.`);
      clientPhoneNumberForLookup = '55' + cleanNumber;
    } else if (cleanNumber.length === 13 && cleanNumber.startsWith('55')) { // Cliente já digitou o número completo com +55
      logger.info(`[HOTMART SVC] Normalizando telefone: Número com 13 dígitos ('${cleanNumber}') já está no formato correto.`);
      clientPhoneNumberForLookup = cleanNumber;
    } else if (cleanNumber.length === 12 && cleanNumber.startsWith('55')) { // Formato DDI + DDD + 8 dígitos (raro, mas possível)
      logger.info(`[HOTMART SVC] Normalizando telefone: Número com 12 dígitos ('${cleanNumber}') já está no formato correto.`);
      clientPhoneNumberForLookup = cleanNumber;
    } else {
      // Se o formato for inesperado, usamos a concatenação como fallback, mas logamos um aviso.
      logger.warn(`[HOTMART SVC] Formato de telefone inesperado ('${cleanNumber}'). Usando fallback de concatenação com código de área.`);
      const areaCode = buyer_phone_local_code_from_payload ? buyer_phone_local_code_from_payload.replace(/\D/g, '') : '';
      clientPhoneNumberForLookup = (areaCode + cleanNumber).replace(/\D/g, ''); // Garante limpeza final
    }
  } else {
    clientPhoneNumberForLookup = null;
    logger.warn(`[HOTMART SVC] Telefone do comprador não fornecido no payload para Prod=${prod}. Email do payload: ${buyer_email_from_payload}`);
  }
  // --- FIM DA LÓGICA DE NORMALIZAÇÃO ---


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
        clientInstance = await Client.findByPk(clientInstance.id);
    }
  }

  if (!clientInstance) {
    if (!clientPhoneNumberForLookup) {
        logger.error(`[HOTMART SVC] Não foi possível determinar um número de telefone para criar o novo cliente (Prod=${prod}, Email Payload=${buyer_email_from_payload}). Abortando.`);
        throw new Error('Número de telefone ausente ou não determinado para criação de cliente via webhook.');
    }
    logger.info(`[HOTMART SVC] Nenhum cliente existente encontrado. Criando novo cliente com Telefone: ${clientPhoneNumberForLookup}...`);
    const clientDataForCreation = {
      email: buyer_email_from_payload ? buyer_email_from_payload.toLowerCase() : null, // Salva o email na criação
      name: buyer_name_from_payload, // Salva o nome na criação
      phone: clientPhoneNumberForLookup,
      status: 'Aguardando Pagamento', // O status do cliente será gerenciado pelo subscriptionService
    };
    clientInstance = await clientService.createClientContact(clientDataForCreation);
    logger.info(`[HOTMART SVC] Novo cliente criado: ID ${clientInstance.id}, Telefone: ${clientInstance.phone}, Email: ${clientInstance.email}, Nome: ${clientInstance.name}`);
  } else {
    logger.info(`[HOTMART SVC] Cliente existente encontrado: ID ${clientInstance.id}, Telefone: ${clientInstance.phone}, Email: ${clientInstance.email}, Nome: ${clientInstance.name}`);
    // Se encontrou o cliente, verifica se o nome ou email precisam ser atualizados com dados da Hotmart
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
        clientInstance = await Client.findByPk(clientInstance.id);
    }
  }

  // ID externo: subscriber_code para assinaturas, transactionId para compras únicas
  const externalIdForSubscription = subscriber_code || transactionId;
  if (!externalIdForSubscription) {
    logger.error(`[HOTMART SVC] ID externo da assinatura/transação (subscriber_code ou transactionId) não encontrado. Abortando.`, { sub_payload: data.subscription, purchase_payload: data.purchase });
    throw new Error('ID externo da assinatura/transação ausente no payload da Hotmart.');
  }

  try {
    // Determina o status efetivo a ser usado para a lógica
    // Prioriza o status da assinatura, se houver, senão o status da compra.
    const effectiveStatus = (subscription_status || status || 'unknown').toLowerCase();
    
    // Data de início da assinatura/acesso. Usa a data de aprovação se disponível.
    let accessStartDate = approved_date ? new Date(parseInt(approved_date,10)).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    switch (effectiveStatus) {
      case 'approved':    // Status da Compra
      case 'active':      // Status da Assinatura
      case 'completed':   // Status da Compra (para produtos de pagamento único)
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
             accessEndDate.setDate(accessEndDate.getDate() + 30); // Fallback
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
    throw error; // Relança para o controller tratar a resposta HTTP
  }
}

module.exports = {
  processWebhookEvent,
};
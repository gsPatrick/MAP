// src/services/asaasApiService.js
const axios = require('axios');
const { Client, Plan, Subscription } = require('../database');
const logger = require('../utils/logger');
const subscriptionService = require('../features/Subscription/subscription.service');

const asaasAPI = axios.create({
  baseURL: 'https://api.asaas.com/v3', // Aponta para o ambiente de sandbox
  headers: {
    'access_token': process.env.ASAAS_API_KEY,
    'Content-Type': 'application/json'
  }
});



/**
 * Simula o recebimento de um pagamento em dinheiro para uma cobrança específica.
 * Isso força a cobrança a ser marcada como 'RECEIVED' e dispara o webhook.
 * @param {string} paymentId - O ID da cobrança (ex: 'payment_1234567890').
 * @param {number} value - O valor exato da cobrança.
 * @returns {Promise<object>} A resposta da API do ASAAS.
 */
async function simulatePayment(paymentId, value) {
  try {
    if (process.env.NODE_ENV !== 'development') {
      logger.error('[ASAAS API SVC] A simulação de pagamento só é permitida em ambiente de desenvolvimento.');
      throw new Error('Operação não permitida em produção.');
    }

    logger.info(`[ASAAS API SVC] Simulando pagamento para a cobrança ID: ${paymentId}`);
    
    const endpoint = `/payments/${paymentId}/receiveInCash`;
    const payload = {
      paymentDate: new Date().toISOString().split('T')[0], // Data de hoje
      value: value,
      notifyCustomer: false
    };

    const { data } = await asaasAPI.post(endpoint, payload);
    
    logger.info(`[ASAAS API SVC] Pagamento para a cobrança ${paymentId} simulado com sucesso. Status agora é: ${data.status}`);
    return data;

  } catch (error) {
    logger.error(`[ASAAS API SVC] Falha ao simular pagamento para ${paymentId}:`, error.response ? error.response.data : error.message);
    throw new Error('Falha ao simular pagamento no ASAAS.');
  }
}


/**
 * Cria ou obtém um cliente no ASAAS e armazena o ID.
 * @param {number} clientId - O ID do seu cliente local.
 * @returns {Promise<string>} O ID do cliente no ASAAS (asaasCustomerId).
 */
async function findOrCreateAsaasCustomer(clientId) {
    const client = await Client.findByPk(clientId);
    if (!client) throw new Error('Cliente local não encontrado.');

    if (client.asaasCustomerId) {
        logger.info(`[ASAAS API] Cliente ASAAS já existe para o cliente local ID ${clientId}. ID: ${client.asaasCustomerId}`);
        return client.asaasCustomerId;
    }

    logger.info(`[ASAAS API] Criando novo cliente no ASAAS para o cliente local ID ${clientId}.`);
    const { data: newAsaasCustomer } = await asaasAPI.post('/customers', {
        name: client.name,
        email: client.email,
        mobilePhone: client.phone,
        // cpfCnpj: client.cpf // Se você tiver essa informação
    });

    await client.update({ asaasCustomerId: newAsaasCustomer.id });
    logger.info(`[ASAAS API] Cliente ASAAS criado com ID ${newAsaasCustomer.id} e vinculado ao cliente local ID ${clientId}.`);
    
    return newAsaasCustomer.id;
}

/**
 * Cria uma nova assinatura no ASAAS para um cliente e plano.
 * @param {number} clientId - ID do seu cliente local.
 * @param {number} planId - ID do seu plano local.
 * @returns {Promise<object>} O objeto da assinatura criada no ASAAS (inclui link de pagamento, etc.).
 */
async function createAsaasSubscription(clientId, planId) {
    const plan = await Plan.findByPk(planId);
    if (!plan || !plan.asaasProductId) {
        throw new Error('Plano não encontrado ou não configurado para o ASAAS.');
    }

    const asaasCustomerId = await findOrCreateAsaasCustomer(clientId);

    const subscriptionPayload = {
        customer: asaasCustomerId,
        billingType: 'UNDEFINED', // Deixa o cliente escolher (Boleto, Cartão)
        nextDueDate: new Date(new Date().setDate(new Date().getDate() + 3)).toISOString().split('T')[0], // Próximo vencimento (ex: 3 dias)
        value: plan.price,
        cycle: plan.durationDays === 30 ? 'MONTHLY' : 'YEARLY', // Adapte conforme seus planos
        description: `Assinatura do plano ${plan.name}`,
        // externalReference: `client-${clientId}-plan-${planId}` // Referência interna
    };

    const { data: newAsaasSubscription } = await asaasAPI.post('/subscriptions', subscriptionPayload);
    
    logger.info(`[ASAAS API] Assinatura ${newAsaasSubscription.id} criada no ASAAS para o cliente ${asaasCustomerId}.`);

    // Pré-cria a assinatura local como "Pendente" para vincular ao webhook
    await subscriptionService.createSubscription(
        clientId,
        planId,
        new Date().toISOString().split('T')[0],
        'Pendente', // Status inicial
        newAsaasSubscription.id // ID externo do ASAAS
    );

    return newAsaasSubscription; // Retorne isso para o seu controller/frontend
}

/**
 * Busca os dados completos de um cliente no ASAAS usando seu ID.
 * @param {string} customerId - O ID do cliente no ASAAS (ex: 'cus_123').
 * @returns {Promise<object>} Os dados do cliente.
 */
async function getCustomerById(customerId) {
  try {
    logger.info(`[ASAAS API SVC] Buscando dados do cliente ASAAS ID: ${customerId}`);
    const { data } = await asaasAPI.get(`/customers/${customerId}`);
    return data;
  } catch (error) {
    logger.error(`[ASAAS API SVC] Falha ao buscar cliente ${customerId}:`, error.response ? error.response.data : error.message);
    throw new Error(`Falha ao buscar dados do cliente ${customerId} no ASAAS.`);
  }
}

/**
 * Simula o recebimento de um pagamento em dinheiro para uma cobrança específica.
 * (Esta função continua a mesma)
 */
async function simulatePayment(paymentId, value) {
  // ... (código da função simulatePayment continua aqui, sem alterações)
  try {
    if (process.env.NODE_ENV !== 'development') {
      logger.error('[ASAAS API SVC] A simulação de pagamento só é permitida em ambiente de desenvolvimento.');
      throw new Error('Operação não permitida em produção.');
    }
    logger.info(`[ASAAS API SVC] Simulando pagamento para a cobrança ID: ${paymentId}`);
    const endpoint = `/payments/${paymentId}/receiveInCash`;
    const payload = {
      paymentDate: new Date().toISOString().split('T')[0],
      value: value,
      notifyCustomer: false
    };
    const { data } = await asaasAPI.post(endpoint, payload);
    logger.info(`[ASAAS API SVC] Pagamento para a cobrança ${paymentId} simulado com sucesso. Status agora é: ${data.status}`);
    return data;
  } catch (error) {
    logger.error(`[ASAAS API SVC] Falha ao simular pagamento para ${paymentId}:`, error.response ? error.response.data : error.message);
    throw new Error('Falha ao simular pagamento no ASAAS.');
  }
}

module.exports = {
    simulatePayment,
    getCustomerById,
  findOrCreateAsaasCustomer,
  createAsaasSubscription
};
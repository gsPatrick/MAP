// src/services/whatsappService.js
const logger = require('../utils/logger');
const axios = require('axios'); // Certifique-se de que está instalado: npm install axios

// Seus dados da Z-API (idealmente do .env)
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || "3E036BB2BDD5306BF3C102121E6AE94B";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "5102B339BF1EAE5DAA24125D";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "Fb1aa6d984ce847a2a0cf414ce7cf9c5cS"; // Seu Client-Token

const BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

/**
 * Envia uma mensagem de texto simples via Z-API.
 * @param {string} phone - Número do destinatário (formato 5511999999999).
 * @param {string} message - Mensagem a ser enviada.
 * @returns {Promise<object|null>} Resposta da API ou null em caso de erro.
 */
async function sendWhatsappMessage(phone, message) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) {
    logger.error('[WhatsAppService] Variáveis de ambiente da Z-API não configuradas.');
    return null;
  }
  if (!phone || !message) {
    logger.error('[WhatsAppService] Telefone e mensagem são obrigatórios para envio de texto.');
    return null;
  }

  const endpoint = `${BASE_URL}/send-text`;
  const payload = {
    phone: phone.replace(/\D/g, ''),
    message: message,
  };
  const headers = {
    'Content-Type': 'application/json',
    'client-token': ZAPI_CLIENT_TOKEN,
  };

  try {
    logger.info(`[WhatsAppService] Enviando mensagem de TEXTO para ${payload.phone}: "${payload.message.substring(0, 70)}..."`);
    const response = await axios.post(endpoint, payload, { headers });
    logger.info(`[WhatsAppService] Mensagem de TEXTO enviada com sucesso para ${phone}. Z-API Response:`, response.data);
    return response.data; // Geralmente contém um ID da mensagem
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    const errorStatus = error.response?.status;
    logger.error(`[WhatsAppService] Erro ao enviar mensagem de TEXTO para ${phone}: Status ${errorStatus}`, { errorMessage });
    return null;
  }
}

/**
 * Envia uma mensagem com uma lista de botões (Button List) via Z-API.
 * @param {string} phone - Número do destinatário (formato 5511999999999).
 * @param {string} messageText - Mensagem principal acima dos botões.
 * @param {Array<{id: string, label: string}>} buttons - Array de objetos de botão.
 * @param {string} [listTitle="Opções"] - Título opcional para a seção da lista de botões.
 * @param {string} [buttonListText="Clique para ver"] - Texto opcional do botão que abre a lista.
 * @returns {Promise<object|null>} Resposta da API ou null em caso de erro.
 */
async function sendButtonListMessage(phone, messageText, buttons, listTitle = "Opções Disponíveis", buttonListText = "Ver Opções") {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) {
    logger.error('[WhatsAppService] Variáveis de ambiente da Z-API não configuradas.');
    return null;
  }
  if (!phone || !messageText || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
    logger.error('[WhatsAppService] Telefone, mensagem principal e array de botões são obrigatórios para sendButtonListMessage.');
    return null;
  }
  if (buttons.some(btn => !btn.id || !btn.label)) {
    logger.error('[WhatsAppService] Cada botão deve ter um "id" e um "label".');
    return null;
  }

  // O endpoint fornecido na documentação é /send-button-list
  // Mas a estrutura do body que você passou é para uma "Lista de Botões" que é um tipo específico,
  // não botões de resposta rápida (quick reply buttons) que são diferentes.
  // Vou seguir a estrutura do body que você mandou, que parece ser para "Lista de Botões".
  // Se for "Botões de Resposta Rápida", a estrutura do payload e o endpoint podem ser outros.
  // A documentação da Z-API pode ter um endpoint específico como `/send-list-message` ou `/send-buttons`
  // Vou usar o endpoint `/send-button-list` conforme você indicou.
  const endpoint = `${BASE_URL}/send-button-list`;

  const payload = {
    phone: phone.replace(/\D/g, ''),
    message: messageText, // Mensagem principal que acompanha a lista
    buttonList: {
      // title: listTitle, // Título da seção da lista (a Z-API pode ou não usar isso)
      // buttonText: buttonListText, // Texto do botão que revela a lista
      buttons: buttons.map(btn => ({ id: btn.id.toString(), label: btn.label })), // Garante que ID seja string
      // description: "Selecione uma das opções abaixo" // Descrição opcional
    }
  };

  // Algumas APIs de lista de botões podem ter uma estrutura um pouco diferente, como:
  // "buttonList": { "title": "Título Principal", "buttonText": "Ver Opções", "sections": [{ "title": "Seção 1", "rows": buttons }] }
  // É CRUCIAL verificar a documentação exata da Z-API para o formato de "send-button-list".
  // Estou usando o formato que você forneceu no exemplo de body.

  const headers = {
    'Content-Type': 'application/json',
    'client-token': ZAPI_CLIENT_TOKEN,
  };

  try {
    logger.info(`[WhatsAppService] Enviando MENSAGEM COM LISTA DE BOTÕES para ${payload.phone}: "${payload.message.substring(0, 50)}..." com ${buttons.length} botões.`);
    logger.debug('[WhatsAppService] Payload da Lista de Botões:', payload);
    const response = await axios.post(endpoint, payload, { headers });
    logger.info(`[WhatsAppService] Mensagem com LISTA DE BOTÕES enviada com sucesso para ${phone}. Z-API Response:`, response.data);
    return response.data;
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    const errorStatus = error.response?.status;
    logger.error(`[WhatsAppService] Erro ao enviar mensagem com LISTA DE BOTÕES para ${phone}: Status ${errorStatus}`, { errorMessage, payloadAttempted: payload });
    return null;
  }
}


module.exports = {
  sendWhatsappMessage,
  sendButtonListMessage,
};
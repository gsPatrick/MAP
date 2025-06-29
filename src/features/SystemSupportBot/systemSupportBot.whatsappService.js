// src/features/SystemSupportBot/systemSupportBot.whatsappService.js
// Serviço de comunicação Z-API ESPECÍFICO para o Bot de Suporte, com credenciais hardcoded.

const axios = require('axios');
const logger = require('../../utils/logger');
const path = require('path');
const fs = require('fs');

// !!! CREDENCIAIS HARDCODED PARA O BOT DE SUPORTE !!!
const ZAPI_INSTANCE_ID = '3E2D4E22815160FAFA032A9B2850D0B6';
const ZAPI_TOKEN = '248FE768CA46F0496AF85BB5';
const ZAPI_CLIENT_TOKEN = 'F4e3f7e11155e4743835dcf2f5d2c820fS'; // Assumindo que este é o 'client-token'

// Base URL para chamadas da API da Z-API
const BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

// --- Funções de Envio ---

/**
 * Envia uma mensagem de texto simples.
 */
async function sendWhatsappMessage(phone, message) {
  if (!phone || !message) {
    logger.error('[SUPPORT ZAPI SVC] Telefone e mensagem são obrigatórios para envio de texto.');
    return null;
  }

  const endpoint = `${BASE_URL}/send-text`;
  const payload = {
    phone: phone.replace(/\D/g, ''), // Garante apenas números
    message: message,
  };
  const headers = {
    'Content-Type': 'application/json',
    'client-token': ZAPI_CLIENT_TOKEN,
  };

  try {
    logger.info(`[SUPPORT ZAPI SVC] Enviando mensagem de TEXTO para ${payload.phone}: "${payload.message.substring(0, 70)}..."`);
    const response = await axios.post(endpoint, payload, { headers });
    logger.info(`[SUPPORT ZAPI SVC] Mensagem de TEXTO enviada com sucesso para ${phone}. Z-API Response:`, response.data);
    return response.data;
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    const errorStatus = error.response?.status;
    logger.error(`[SUPPORT ZAPI SVC] Erro ao enviar mensagem de TEXTO para ${phone}: Status ${errorStatus}`, { errorMessage });
    // Retorna null ou lança o erro dependendo de como quer tratar falhas de envio
    return null;
  }
}

/**
 * Envia uma mensagem com lista de botões.
 */
async function sendButtonListMessage(phone, messageText, buttons) {
    if (!phone || !messageText || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
        logger.error('[SUPPORT ZAPI SVC] Telefone, mensagem principal e array de botões são obrigatórios para sendButtonListMessage.');
        return null;
    }
    if (buttons.some(btn => !btn.id || !btn.label)) {
        logger.error('[SUPPORT ZAPI SVC] Cada botão deve ter um "id" e um "label".');
        return null;
    }

    const endpoint = `${BASE_URL}/send-button-list`;

    const payload = {
        phone: phone.replace(/\D/g, ''), // Garante apenas números
        message: messageText,
        buttonList: {
            buttons: buttons.map(btn => ({ id: btn.id.toString(), label: btn.label })),
        }
    };

    const headers = {
        'Content-Type': 'application/json',
        'client-token': ZAPI_CLIENT_TOKEN,
    };

    try {
        logger.info(`[SUPPORT ZAPI SVC] Enviando MENSAGEM COM LISTA DE BOTÕES para ${payload.phone}: "${payload.message.substring(0, 50)}..." com ${buttons.length} botões.`);
        // logger.debug('[SUPPORT ZAPI SVC] Payload da Lista de Botões:', payload); // Descomente para depurar payload
        const response = await axios.post(endpoint, payload, { headers });
        logger.info(`[SUPPORT ZAPI SVC] Mensagem com LISTA DE BOTÕES enviada com sucesso para ${phone}. Z-API Response:`, response.data);
        return response.data;
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        const errorStatus = error.response?.status;
        logger.error(`[SUPPORT ZAPI SVC] Erro ao enviar mensagem com LISTA DE BOTÕES para ${phone}: Status ${errorStatus}`, { errorMessage, payloadAttempted: payload });
         // Retorna null ou lança o erro
        return null;
    }
}

// --- Funções de Download (se o bot de suporte precisar baixar mídia) ---
// Se o bot de suporte for *apenas* texto/botão/transcrição, ele não precisa baixar mídia.
// Se precisar, copie a função downloadZapiMedia para cá, usando o ZAPI_CLIENT_TOKEN hardcoded.
/*
async function downloadZapiMedia(mediaUrl) {
  if (!ZAPI_CLIENT_TOKEN) { ... }
  if (!mediaUrl) { ... }
  try {
    logger.info(`[SUPPORT ZAPI SVC - Download] Baixando mídia de: ${mediaUrl}`);
    const response = await axios({
      method: 'get',
      url: mediaUrl,
      headers: { 'client-token': ZAPI_CLIENT_TOKEN },
      responseType: 'stream',
    });
    // ... lógica de nome de arquivo ...
    return { stream: response.data, filename };
  } catch (error) { ... }
}
*/


module.exports = {
    sendWhatsappMessage,
    sendButtonListMessage,
    // downloadZapiMedia, // Exporte se adicionar a função
};
// src/services/whatsappService.js

// SUAS DEPENDÊNCIAS EXISTENTES
const logger = require('../utils/logger');
const axios = require('axios');
const path = require('path');

// <<< NOVAS DEPENDÊNCIAS NECESSÁRIAS PARA A LÓGICA DE RECEBIMENTO >>>
// ESTAS DEPENDÊNCIAS SÃO REMOVIDAS DAQUI, POIS PERTENCEM AO SERVICE DE FEATURES
// const { Client } = require('../database');
// const { normalizePhoneNumberToCanonical } = require('../utils/phoneUtils');

// <<< ESTA É A LINHA QUE CAUSA A DEPENDÊNCIA CIRCULAR E SERÁ REMOVIDA >>>
// const { handleIncomingMessageLogic } = require('../features/WhatsappHandler/whatsapp.service');


// SUAS CONFIGURAÇÕES EXISTENTES
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || "3E036BB2BDD5306BF3C102121E6AE94B";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "5102B339BF1EAE5DAA24125D";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "Fb1aa6d984ce847a2a0cf414ce7cf9c5cS";
const ZAPI_API_URL ="https://api.z-api.io/"
const BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;


// ========================================================================
// SUAS FUNÇÕES DE ENVIO E DOWNLOAD (100% MANTIDAS, SEM ALTERAÇÕES)
// ========================================================================

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
    return response.data;
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    const errorStatus = error.response?.status;
    logger.error(`[WhatsAppService] Erro ao enviar mensagem de TEXTO para ${phone}: Status ${errorStatus}`, { errorMessage });
    return null;
  }
}

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

  const endpoint = `${BASE_URL}/send-button-list`;

  const payload = {
    phone: phone.replace(/\D/g, ''),
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

async function downloadZapiMedia(mediaUrl) {
  if (!ZAPI_CLIENT_TOKEN) {
    logger.error('[WhatsAppService - Download] ZAPI_CLIENT_TOKEN não configurado.');
    return null;
  }
  if (!mediaUrl) {
    logger.error('[WhatsAppService - Download] mediaUrl não fornecida.');
    return null;
  }

  try {
    logger.info(`[WhatsAppService - Download] Baixando mídia de: ${mediaUrl}`);
    const response = await axios({
      method: 'get',
      url: mediaUrl,
      headers: {
        'client-token': ZAPI_CLIENT_TOKEN,
      },
      responseType: 'stream',
    });
    
    let filename = 'audio.ogg';
    try {
        const urlPath = new URL(mediaUrl).pathname;
        const baseName = path.basename(urlPath);
        if (baseName && baseName.includes('.')) {
            filename = baseName;
        }
    } catch (e) {
        logger.warn(`[WhatsAppService - Download] Não foi possível parsear a URL para extrair nome do arquivo: ${mediaUrl}. Usando default: ${filename}`);
    }
    
    logger.info(`[WhatsAppService - Download] Mídia baixada com sucesso. Nome de arquivo sugerido: ${filename}`);
    return { stream: response.data, filename };

  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    const errorStatus = error.response?.status;
    logger.error(`[WhatsAppService - Download] Erro ao baixar mídia de ${mediaUrl}. Status ${errorStatus}`, { errorMessage });
    return null;
  }
}

// ========================================================================
// IMPORTANTE: AS FUNÇÕES DE RECEBIMENTO DE MENSAGEM NÃO FICAM AQUI.
// Elas pertencem ao seu `features/WhatsappHandler/whatsapp.service.js`,
// que é o "cérebro" que USA este arquivo para ENVIAR mensagens.
// ========================================================================


// ========================================================================
// EXPORTS
// ========================================================================

// ========================================================================
// <<< INÍCIO: NOVAS FUNÇÕES DE GERENCIAMENTO DA INSTÂNCIA Z-API >>>
// ========================================================================

/**
 * Verifica o status da conexão da instância principal da Z-API.
 * @returns {Promise<object|null>} Objeto com o status da conexão ou null em caso de erro.
 */
async function getZapiInstanceStatus() {
  const endpoint = `${ZAPI_API_URL}/instances/${ZAPI_INSTANCE_ID}/status`;
  const headers = { 'client-token': ZAPI_CLIENT_TOKEN };
  
  try {
    logger.info(`[WhatsAppService] Verificando status da instância Z-API: ${ZAPI_INSTANCE_ID}`);
    const response = await axios.get(endpoint, { headers });
    logger.info(`[WhatsAppService] Status da instância obtido com sucesso. Conectado: ${response.data.connected}`);
    return response.data;
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error(`[WhatsAppService] Erro ao verificar status da instância Z-API: ${errorMessage}`);
    return null;
  }
}

/**
 * Gera a URL da imagem do QR Code para conexão.
 * @returns {string} A URL completa para ser usada em uma tag <img>.
 */
function getZapiQrCodeImageUrl() {
    // Este endpoint é acessado diretamente pelo frontend, então apenas montamos a URL.
    const qrCodeUrl = `${BASE_URL}/qr-code/image`;
    logger.info(`[WhatsAppService] Gerando URL do QR Code: ${qrCodeUrl}`);
    return qrCodeUrl;
}


/**
 * Fixa uma mensagem específica no topo de uma conversa do WhatsApp.
 * @param {string} phone - O número de telefone do chat.
 * @param {string} messageId - O ID da mensagem a ser fixada.
 * @param {'24_hours' | '7_days' | '30_days'} duration - A duração que a mensagem ficará fixada.
 * @returns {Promise<object|null>} A resposta da API da Z-API ou null em caso de erro.
 */
async function pinWhatsappMessage(phone, messageId, duration = '30_days') {
  if (!messageId || !phone) {
    logger.error('[WhatsAppService Pin] Telefone e ID da mensagem são obrigatórios para fixar.');
    return null;
  }

  const endpoint = `${BASE_URL}/pin-message`;
  const payload = {
    phone: phone.replace(/\D/g, ''),
    messageId: messageId,
    pinMessageDuration: duration,
  };
  const headers = {
    'Content-Type': 'application/json',
    'client-token': ZAPI_CLIENT_TOKEN,
  };

  try {
    logger.info(`[WhatsAppService Pin] Tentando fixar a mensagem ID ${messageId} para ${payload.phone} por ${duration}.`);
    // A Z-API usa o método PATCH para esta ação
    const response = await axios.patch(endpoint, payload, { headers });
    logger.info(`[WhatsAppService Pin] Mensagem fixada com sucesso. Z-API Response:`, response.data);
    return response.data;
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    const errorStatus = error.response?.status;
    logger.error(`[WhatsAppService Pin] Erro ao fixar mensagem ID ${messageId} para ${phone}: Status ${errorStatus}`, { errorMessage });
    return null;
  }
}

// ========================================================================
// <<< FIM: NOVAS FUNÇÕES DE GERENCIAMENTO DA INSTÂNCIA Z-API >>>
// ========================================================================


module.exports = {
  sendWhatsappMessage,
  sendButtonListMessage,
  downloadZapiMedia,
  pinWhatsappMessage,
  getZapiInstanceStatus, // <<< EXPORTAR NOVA FUNÇÃO
  getZapiQrCodeImageUrl, // <<< EXPORTAR NOVA FUNÇÃO
};
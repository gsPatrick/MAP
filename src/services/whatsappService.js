// src/services/whatsappService.js
const logger = require('../utils/logger');
const axios = require('axios'); // Certifique-se de que está instalado: npm install axios
const path = require('path'); // Para extrair extensão do arquivo

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


/**
 * Baixa um arquivo de mídia da Z-API.
 * @param {string} mediaUrl - URL do arquivo de mídia fornecida pela Z-API.
 * @returns {Promise<{stream: ReadableStream, filename: string}|null>} Objeto com o stream do áudio e um nome de arquivo sugerido, ou null em caso de erro.
 */
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
        'client-token': ZAPI_CLIENT_TOKEN, // Adiciona o client-token para autenticar o download
      },
      responseType: 'stream', // Importante para obter um stream
    });

    // Tentar extrair um nome de arquivo e extensão da URL ou dos headers
    let filename = 'audio.ogg'; // Default filename
    try {
        const urlPath = new URL(mediaUrl).pathname;
        const baseName = path.basename(urlPath);
        if (baseName && baseName.includes('.')) { // Verifica se há uma extensão
            filename = baseName;
        }
    } catch (e) {
        logger.warn(`[WhatsAppService - Download] Não foi possível parsear a URL para extrair nome do arquivo: ${mediaUrl}. Usando default: ${filename}`);
    }
    // Poderia também verificar response.headers['content-type'] para inferir a extensão se necessário
    // Ex: const contentType = response.headers['content-type'];
    // if (contentType === 'audio/ogg') filename = 'audio.ogg';

    logger.info(`[WhatsAppService - Download] Mídia baixada com sucesso. Nome de arquivo sugerido: ${filename}`);
    return { stream: response.data, filename };

  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    const errorStatus = error.response?.status;
    logger.error(`[WhatsAppService - Download] Erro ao baixar mídia de ${mediaUrl}. Status ${errorStatus}`, { errorMessage });
    return null;
  }
}

module.exports = {
  sendWhatsappMessage,
  sendButtonListMessage,
  downloadZapiMedia, // <<< ADICIONADO
};
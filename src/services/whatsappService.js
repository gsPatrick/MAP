// src/services/whatsappService.js

// SUAS DEPENDÊNCIAS EXISTENTES
const logger = require('../utils/logger');
const axios = require('axios');
const path = require('path');

// <<< NOVAS DEPENDÊNCIAS NECESSÁRIAS PARA A LÓGICA DE RECEBIMENTO >>>
const { Client } = require('../database');
const { normalizePhoneNumberToCanonical } = require('../utils/phoneUtils');
const { handleIncomingMessageLogic } = require('../features/WhatsappHandler/whatsapp.service'); // Você precisará criar ou ajustar este handler

// SUAS CONFIGURAÇÕES EXISTENTES
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || "3E036BB2BDD5306BF3C102121E6AE94B";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "5102B339BF1EAE5DAA24125D";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "Fb1aa6d984ce847a2a0cf414ce7cf9c5cS";

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
// <<< NOVA LÓGICA DE RECEBIMENTO DE WEBHOOK >>>
// ========================================================================

/**
 * Ponto de entrada principal para processar um webhook de mensagem recebida da Z-API.
 * Esta função deve ser chamada pelo seu controller de webhook.
 * @param {object} payload - O objeto de payload completo do webhook da Z-API.
 */
async function handleIncomingMessage(payload) {
  // Pega o número "bruto" que a Z-API enviou
  const rawPhoneFromZapi = payload.phone; 

  // >>> APLICA A NORMALIZAÇÃO UNIVERSAL <<<
  const canonicalPhone = normalizePhoneNumberToCanonical(rawPhoneFromZapi);

  if (!canonicalPhone) {
    logger.error(`[WHATSAPP SVC] Não foi possível normalizar o telefone do remetente: ${rawPhoneFromZapi}. Mensagem ignorada.`);
    return;
  }

  try {
    // Usa o número canônico para encontrar ou criar o cliente
    const [client, created] = await Client.findOrCreate({
      where: { phone: canonicalPhone },
      defaults: {
        phone: canonicalPhone,
        name: payload.senderName || 'Novo Contato',
        status: 'Ativo',
        accessLevel: 'gratuito',
      }
    });

    if (created) {
      logger.info(`[WHATSAPP SVC] Telefone ${canonicalPhone} não reconhecido. Novo cliente (ID: ${client.id}) criado.`);
    }

    // A partir daqui, você pode chamar uma função centralizadora que lida com o que fazer com a mensagem.
    // Isso mantém este arquivo focado na comunicação e normalização.
    // Exemplo:
    // await handleIncomingMessageLogic(client, payload, created);
    
    logger.info(`[WHATSAPP SVC] Mensagem de ${canonicalPhone} (Cliente ID: ${client.id}) recebida.`, { type: payload.type });
    // Aqui você adicionaria a lógica para tratar o conteúdo da mensagem (texto, áudio, etc.)
    // e chamar os respectivos handlers (onboarding, IA, etc.), passando a instância 'client'.

  } catch (error) {
    logger.error(`[WHATSAPP SVC] Erro ao processar mensagem de ${canonicalPhone}:`, error);
  }
}

// ========================================================================
// EXPORTS (Adicionando a nova função)
// ========================================================================

module.exports = {
  // Funções que você já tinha
  sendWhatsappMessage,
  sendButtonListMessage,
  downloadZapiMedia,

  // <<< NOVA FUNÇÃO ADICIONADA PARA SER USADA PELO SEU CONTROLLER >>>
  handleIncomingMessage,
};
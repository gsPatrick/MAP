// src/features/WhatsappHandler/whatsapp.controller.js
const whatsappService = require('./whatsapp.service'); // Este é o seu whatsapp.service.js de features/WhatsappHandler
const logger = require('../../utils/logger');

async function handleIncomingMessage(req, res, next) {
  try {
    const payload = req.body;
    logger.info('[WHATSAPP CONTROLLER] Webhook da Z-API recebido:', { payload });

    let senderPhone = null;
    let messageText = null; // Para mensagens de texto ou label de botão
    let isFromMe = false;
    let pushName = null;
    let selectedButtonId = null; 
    let detectedMessageType = null; // Tipo de mensagem detectado: 'text', 'button_response', 'audio', etc.
    let mediaUrl = null;
    let mimeType = null;

    // --- Início da Extração de Dados Comuns ---
    // Tenta obter o telefone do remetente de vários locais possíveis no payload
    if (payload.phone) {
        senderPhone = payload.phone;
    } else if (payload.sender) { // Comum em callbacks de mensagens enviadas/recebidas
        senderPhone = payload.sender;
    } else if (payload.chatId) { // Se for um evento de chat
        senderPhone = payload.chatId.split('@')[0];
    } else if (payload.message && payload.message.sender) { // Para algumas estruturas de 'MessageReceived'
        senderPhone = payload.message.sender.replace('@c.us', '');
    } else if (payload.author) { // Para alguns tipos de eventos de status ou grupo
        senderPhone = payload.author.replace('@c.us', '');
    }
    // Normaliza o número de telefone se obtido (remove DDI repetido se vier assim da Z-API)
    if (senderPhone && senderPhone.startsWith('5555')) {
        senderPhone = senderPhone.substring(2);
    }


    // Tenta obter 'fromMe'
    if (payload.fromMe !== undefined) {
        isFromMe = payload.fromMe;
    } else if (payload.message && payload.message.fromMe !== undefined) {
        isFromMe = payload.message.fromMe;
    }

    // Tenta obter o nome do remetente (pushName)
    if (payload.chatName) { // Mais comum em ReceivedCallback
        pushName = payload.chatName;
    } else if (payload.senderName && !pushName) { // Fallback
        pushName = payload.senderName;
    } else if (payload.message && payload.message.notifyName && !pushName) { // Para MessageReceived
        pushName = payload.message.notifyName;
    } else if (payload.message && payload.message.senderName && !pushName) { // Outro fallback
        pushName = payload.message.senderName;
    }
    // Remove o caractere invisível que a Z-API às vezes envia
    if (pushName === "⠀") {
        pushName = null;
    }
    // --- Fim da Extração de Dados Comuns ---


    // --- Início da Lógica de Detecção do Tipo de Mensagem ---
    const mainWebhookType = payload.type; // Ex: "ReceivedCallback", "MessageReceived", "ChatPresence"

    if (mainWebhookType === 'ReceivedCallback') {
        if (payload.text && typeof payload.text.message === 'string') {
            messageText = payload.text.message;
            detectedMessageType = 'text';
        } else if (payload.buttonsResponseMessage && payload.buttonsResponseMessage.buttonId) {
            messageText = payload.buttonsResponseMessage.message; // Label do botão
            selectedButtonId = payload.buttonsResponseMessage.buttonId;
            payload.selectedButtonId = selectedButtonId; // Passa para o service
            detectedMessageType = 'button_response';
        } else if (payload.audio && payload.audio.audioUrl) {
            mediaUrl = payload.audio.audioUrl;
            mimeType = payload.audio.mimeType;
            detectedMessageType = 'audio';
            logger.info(`[WHATSAPP CONTROLLER] Mensagem de áudio (ReceivedCallback) detectada. URL: ${mediaUrl}, MimeType: ${mimeType}`);
        } else if (payload.image && payload.image.imageUrl) {
            // Lógica para imagem (se for implementar futuramente)
            // mediaUrl = payload.image.imageUrl;
            // mimeType = payload.image.mimeType;
            // detectedMessageType = 'image';
            logger.info(`[WHATSAPP CONTROLLER] Mensagem de imagem (ReceivedCallback) detectada. Ignorando por enquanto.`);
        } else if (payload.video && payload.video.videoUrl) {
            // Lógica para vídeo
            logger.info(`[WHATSAPP CONTROLLER] Mensagem de vídeo (ReceivedCallback) detectada. Ignorando por enquanto.`);
        } else if (payload.document && payload.document.documentUrl) {
            // Lógica para documento
            logger.info(`[WHATSAPP CONTROLLER] Mensagem de documento (ReceivedCallback) detectada. Ignorando por enquanto.`);
        } else if (payload.sticker && payload.sticker.stickerUrl) {
             logger.info(`[WHATSAPP CONTROLLER] Mensagem de sticker (ReceivedCallback) detectada. Ignorando.`);
        } else if (payload.location) {
             logger.info(`[WHATSAPP CONTROLLER] Mensagem de localização (ReceivedCallback) detectada. Ignorando.`);
        }
        // Adicionar mais 'else if' para outros tipos de mídia em 'ReceivedCallback'
    } 
    // Estrutura alternativa, comum para mensagens enviadas/recebidas via outras integrações ou cenários
    else if (mainWebhookType === 'MessageReceived' && payload.message) {
        const msgObj = payload.message;
        if (msgObj.body && typeof msgObj.body === 'string') {
            messageText = msgObj.body;
            detectedMessageType = 'text';
        } else if ((msgObj.type === 'ptt' || msgObj.type === 'audio') && msgObj.mediaUrl) {
            mediaUrl = msgObj.mediaUrl;
            mimeType = msgObj.mimetype || msgObj.mimeType; // Algumas APIs usam 'mimetype', outras 'mimeType'
            detectedMessageType = 'audio';
            logger.info(`[WHATSAPP CONTROLLER] Mensagem de áudio (MessageReceived) detectada. URL: ${mediaUrl}, MimeType: ${mimeType}`);
        }
        // Adicionar mais 'else if' para outros tipos de mídia em 'MessageReceived'
    }
    // Você pode adicionar mais 'else if (mainWebhookType === ...)' para outros tipos de eventos principais da Z-API
    else {
        logger.info(`[WHATSAPP CONTROLLER] Webhook de tipo '${mainWebhookType}' não tratado para extração de conteúdo principal.`);
    }
    // --- Fim da Lógica de Detecção do Tipo de Mensagem ---


    if (isFromMe) {
      logger.info('[WHATSAPP CONTROLLER] Mensagem de mim mesmo (fromMe=true), ignorando.');
      return res.status(200).json({ status: 'success', message: 'Echo message ignored.' });
    }

    if (!senderPhone) {
        logger.warn('[WHATSAPP CONTROLLER] Não foi possível determinar o remetente da mensagem.', { payload });
        return res.status(200).json({ status: 'fail_no_sender', message: 'Sender phone not found in payload.' });
    }

    // Roteia para o serviço apropriado com base no tipo de mensagem detectado
    if (detectedMessageType === 'audio' && mediaUrl) {
        await whatsappService.processIncomingAudioMessage(senderPhone, mediaUrl, mimeType, pushName, payload);
        res.status(200).json({ status: 'success', message: 'Audio message received and processing initiated.' });
    } else if ((detectedMessageType === 'text' && messageText) || (detectedMessageType === 'button_response' && selectedButtonId)) { 
      await whatsappService.processIncomingMessage(senderPhone, messageText, pushName, payload);
      res.status(200).json({ status: 'success', message: 'Message received and processing initiated.' });
    } else {
      // Se chegou aqui, significa que o payload tinha um remetente, mas o conteúdo não foi reconhecido como acionável
      logger.warn('[WHATSAPP CONTROLLER] Payload de webhook reconhecido (tem remetente), mas sem conteúdo acionável (texto, botão ou áudio válido).', { mainType: mainWebhookType, detectedType: detectedMessageType, senderPhone });
      res.status(200).json({ status: 'fail_no_actionable_content', message: 'Payload recognized but no actionable content found.' });
    }

  } catch (error) {
    logger.error('[WHATSAPP CONTROLLER] Erro ao processar webhook da Z-API:', { error: error.message, stack: error.stack });
    // É importante responder 200 para a Z-API mesmo em caso de erro interno,
    // para evitar que ela continue reenviando o mesmo webhook.
    res.status(200).json({ status: 'error_processing_internally', message: 'Error processing webhook.' });
  }
}

module.exports = {
  handleIncomingMessage,
};
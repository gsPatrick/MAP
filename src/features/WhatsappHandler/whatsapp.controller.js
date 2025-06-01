// src/features/WhatsappHandler/whatsapp.controller.js
const whatsappService = require('./whatsapp.service'); // Este é o seu whatsapp.service.js de features/WhatsappHandler
const logger = require('../../utils/logger');

async function handleIncomingMessage(req, res, next) {
  try {
    const payload = req.body;
    logger.info('[WHATSAPP CONTROLLER] Webhook da Z-API recebido:', { payload });

    let senderPhone = null;
    let messageText = null;
    let isFromMe = false;
    let pushName = null;
    let selectedButtonId = null; 
    let messageType = null;
    let mediaUrl = null;
    let mimeType = null;

    // Tenta extrair dados de diferentes estruturas de payload da Z-API
    if (payload.phone) senderPhone = payload.phone;
    if (payload.chatId) senderPhone = senderPhone || payload.chatId.split('@')[0];
    if (payload.message?.sender) senderPhone = senderPhone || payload.message.sender.replace('@c.us', '');

    if (payload.fromMe !== undefined) isFromMe = payload.fromMe;
    else if (payload.message?.fromMe !== undefined) isFromMe = payload.message.fromMe;

    if (payload.chatName) pushName = payload.chatName;
    else if (payload.senderName) pushName = payload.senderName;
    else if (payload.message?.notifyName) pushName = payload.message.notifyName;
    else if (payload.message?.senderName) pushName = payload.message.senderName;
    if (pushName === "⠀") pushName = null;

    messageType = payload.type || payload.message?.type; // 'ReceivedCallback', 'MessageReceived', ou o tipo dentro de payload.message

    // Estrutura para mensagens de TEXTO normais da Z-API
    if (payload.text && typeof payload.text.message === 'string') {
      messageText = payload.text.message;
    }
    // Estrutura para cliques em BOTÕES (Button List Response) da Z-API
    else if (payload.buttonsResponseMessage) {
        messageText = payload.buttonsResponseMessage.message; // O texto do botão clicado
        selectedButtonId = payload.buttonsResponseMessage.buttonId; // O ID do botão
        payload.selectedButtonId = selectedButtonId; // Adiciona para o service usar
    }
    // Estrutura alternativa para mensagens de texto (ex: MessageReceived)
    else if (payload.message?.body && typeof payload.message.body === 'string') {
        messageText = payload.message.body;
    }
    // Estrutura para ÁUDIO (PTT ou áudio encaminhado)
    // A Z-API pode usar 'ptt' ou 'audio' como tipo, e 'mediaUrl' para a URL.
    else if ((payload.type === 'ptt' || payload.type === 'audio' || payload.message?.type === 'ptt' || payload.message?.type === 'audio') && (payload.mediaUrl || payload.message?.mediaUrl)) {
        mediaUrl = payload.mediaUrl || payload.message.mediaUrl;
        mimeType = payload.mimetype || payload.message?.mimetype; // Ex: "audio/ogg; codecs=opus"
        messageType = 'audio'; // Normaliza para 'audio' para o service
        logger.info(`[WHATSAPP CONTROLLER] Mensagem de áudio detectada. URL: ${mediaUrl}, MimeType: ${mimeType}`);
    }


    if (isFromMe) {
      logger.info('[WHATSAPP CONTROLLER] Mensagem de mim mesmo (fromMe=true), ignorando.');
      return res.status(200).json({ status: 'success', message: 'Echo message ignored.' });
    }

    if (!senderPhone) {
        logger.warn('[WHATSAPP CONTROLLER] Não foi possível determinar o remetente da mensagem.', { payload });
        return res.status(200).json({ status: 'fail_no_sender', message: 'Sender phone not found in payload.' });
    }

    if (messageType === 'audio' && mediaUrl) {
        // Chama o serviço para lidar com a mensagem de áudio
        await whatsappService.processIncomingAudioMessage(senderPhone, mediaUrl, mimeType, pushName, payload);
        res.status(200).json({ status: 'success', message: 'Audio message received and processing initiated.' });
    } else if (senderPhone && (messageText || selectedButtonId) ) { 
      // Se foi um clique de botão, messageText será o label do botão.
      await whatsappService.processIncomingMessage(senderPhone, messageText, pushName, payload);
      res.status(200).json({ status: 'success', message: 'Message received and processing initiated.' });
    } else {
      logger.warn('[WHATSAPP CONTROLLER] Payload de webhook não continha telefone E (texto/botão OU mídia de áudio) esperado na estrutura conhecida.', { type: payload.type, senderPhone });
      res.status(200).json({ status: 'fail_payload_structure', message: 'Payload structure not recognized for actionable message.' });
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
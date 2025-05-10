// src/features/WhatsappHandler/whatsapp.controller.js
const whatsappService = require('./whatsapp.service');
const logger = require('../../utils/logger');

async function handleIncomingMessage(req, res, next) {
  try {
    const payload = req.body;
    logger.info('[WHATSAPP CONTROLLER] Webhook da Z-API recebido:', { payload });

    let senderPhone = null;
    let messageText = null;
    let isFromMe = false;
    let pushName = null;
    let selectedButtonId = null; // Para capturar o ID do botão clicado

    // Estrutura para mensagens de TEXTO normais
    if (payload.type === 'ReceivedCallback' && payload.text && typeof payload.text.message === 'string' && payload.phone) {
      senderPhone = payload.phone;
      messageText = payload.text.message;
      isFromMe = payload.fromMe || false;
      pushName = payload.chatName || payload.senderName || null;
      if (pushName === "⠀") pushName = null;
    }
    // Estrutura para cliques em BOTÕES (Button List Response)
    else if (payload.type === 'ReceivedCallback' && payload.buttonsResponseMessage && payload.phone) {
        senderPhone = payload.phone;
        messageText = payload.buttonsResponseMessage.message; // O texto do botão clicado
        selectedButtonId = payload.buttonsResponseMessage.buttonId; // O ID do botão
        isFromMe = payload.fromMe || false;
        pushName = payload.chatName || payload.senderName || null;
        if (pushName === "⠀") pushName = null;
        // Adiciona o selectedButtonId ao rawPayload para o service.js poder usar
        payload.selectedButtonId = selectedButtonId;
    }
    // Adicione mais 'else if' aqui se a Z-API tiver outras estruturas de payload importantes
    else if (payload.type === 'MessageReceived' && payload.message?.body && payload.message?.sender) {
        senderPhone = payload.message.sender.replace('@c.us', '');
        messageText = payload.message.body;
        isFromMe = payload.message.fromMe;
        pushName = payload.message.notifyName || payload.message.senderName;
    }


    if (isFromMe) {
      logger.info('[WHATSAPP CONTROLLER] Mensagem de mim mesmo (fromMe=true), ignorando.');
      return res.status(200).json({ status: 'success', message: 'Echo message ignored.' });
    }

    if (senderPhone && (messageText || selectedButtonId) ) { // Precisa de telefone E (texto OU um botão clicado)
      // Se foi um clique de botão, messageText será o label do botão.
      // O selectedButtonId já está em payload.selectedButtonId
      await whatsappService.processIncomingMessage(senderPhone, messageText, pushName, payload);
      res.status(200).json({ status: 'success', message: 'Message received and processing initiated.' });
    } else {
      logger.warn('[WHATSAPP CONTROLLER] Payload de webhook não continha telefone ou texto/botão esperado na estrutura conhecida.', { type: payload.type });
      res.status(200).json({ status: 'fail_payload_structure', message: 'Payload structure not recognized for actionable message.' });
    }

  } catch (error) {
    logger.error('[WHATSAPP CONTROLLER] Erro ao processar webhook da Z-API:', { error: error.message, stack: error.stack });
    res.status(200).json({ status: 'error_processing_internally', message: 'Error processing webhook.' });
  }
}

module.exports = {
  handleIncomingMessage,
};
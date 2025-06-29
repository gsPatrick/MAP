// src/features/SystemSupportBot/systemSupportBot.controller.js
// Controller para receber webhooks da Z-API para o Bot de Suporte

const systemSupportBotService = require('./systemSupportBot.service');
const logger = require('../../utils/logger');
// !!! NÃO IMPORTAMOS whatsappService.js NEM aiModelService.js aqui,
// pois este controller apenas roteia mensagens para o service, que por sua vez
// usa o systemSupportBot.whatsappService.js e o aiModelService.js.
// A transcrição de áudio DEVE acontecer no bot principal e o texto transcrito
// DEVE ser enviado para o processIncomingMessage DESTE serviço de suporte.

async function handleIncomingMessage(req, res, next) {
  try {
    const payload = req.body;
    // Certifique-se de que este log está configurado para o webhook correto
    logger.info('[SUPPORT BOT CTRL] Webhook da Z-API recebido (Suporte Bot):', { eventType: payload.type, sender: payload.phone || payload.sender || payload.chatId });

    let senderPhone = null;
    let messageText = null;
    let isFromMe = false;
    let pushName = null;
    let selectedButtonId = null;
    let detectedMessageType = null;
    // let mediaUrl = null; // Não precisamos de mediaUrl neste controller
    // let mimeType = null; // Não precisamos de mimeType neste controller

    // --- Extração de Dados (Mesma lógica do controller principal) ---
    if (payload.phone) { senderPhone = payload.phone; } else if (payload.sender) { senderPhone = payload.sender; } else if (payload.chatId) { senderPhone = payload.chatId.split('@')[0]; } else if (payload.message && payload.message.sender) { senderPhone = payload.message.sender.replace('@c.us', ''); } else if (payload.author) { senderPhone = payload.author.replace('@c.us', ''); }
    if (senderPhone && senderPhone.startsWith('5555')) { senderPhone = senderPhone.substring(2); }

    if (payload.fromMe !== undefined) { isFromMe = payload.fromMe; } else if (payload.message && payload.message.fromMe !== undefined) { isFromMe = payload.message.fromMe; }

    if (payload.chatName) { pushName = payload.chatName; } else if (payload.senderName && !pushName) { pushName = payload.senderName; } else if (payload.message && payload.message.notifyName && !pushName) { pushName = payload.message.notifyName; } else if (payload.message && payload.message.senderName && !pushName) { pushName = payload.message.senderName; }
    if (pushName === "⠀") { pushName = null; }
    // --- Fim Extração de Dados ---

    const mainWebhookType = payload.type;

    if (mainWebhookType === 'ReceivedCallback') {
        if (payload.text && typeof payload.text.message === 'string') {
            messageText = payload.text.message;
            detectedMessageType = 'text';
        } else if (payload.buttonsResponseMessage && payload.buttonsResponseMessage.buttonId) {
            messageText = payload.buttonsResponseMessage.message; // Label do botão clicado
            selectedButtonId = payload.buttonsResponseMessage.buttonId;
            payload.selectedButtonId = selectedButtonId; // Passa para o service
            detectedMessageType = 'button_response';
        } else if (payload.audio && payload.audio.audioUrl) {
            // ÁUDIO RECEBIDO: Este bot de suporte NÃO PROCESSA ÁUDIOS DIRETAMENTE.
            // A transcrição deve ser feita pelo bot principal.
             logger.info(`[SUPPORT BOT CTRL] Áudio recebido no bot de suporte. Ignorando (processamento de áudio no bot principal).`);
             // Podemos enviar uma mensagem pedindo ao usuário para usar texto ou que o bot principal trate o áudio.
             // systemSupportBotService.sendWhatsappMessage(senderPhone, "Obrigado pelo áudio! Por enquanto, sou um bot de suporte e ainda não consigo processar mensagens de voz. Poderia digitar sua dúvida, por favor?");
             res.status(200).json({ status: 'success', message: 'Audio message received by support bot, processing skipped.' });
             return; // Interrompe o fluxo aqui
        }
        // Adicione tratamento para outros tipos de mídia aqui, se necessário (e decida se este bot suporta)
    } else if (mainWebhookType === 'MessageReceived' && payload.message) {
        const msgObj = payload.message;
         if (msgObj.body && typeof msgObj.body === 'string') {
            messageText = msgObj.body;
            detectedMessageType = 'text';
        } else if ((msgObj.type === 'ptt' || msgObj.type === 'audio') && msgObj.mediaUrl) {
             // ÁUDIO RECEBIDO VIA MessageReceived: Ignorar
             logger.info(`[SUPPORT BOT CTRL] Áudio (MessageReceived) recebido no bot de suporte. Ignorando.`);
             res.status(200).json({ status: 'success', message: 'Audio message received by support bot, processing skipped.' });
             return; // Interrompe o fluxo aqui
         }
        // Adicione tratamento para outros tipos de mídia aqui, se necessário
    }

    if (isFromMe) {
      logger.info('[SUPPORT BOT CTRL] Mensagem de mim mesmo (fromMe=true), ignorando.');
      return res.status(200).json({ status: 'success', message: 'Echo message ignored.' });
    }

    if (!senderPhone) {
        logger.warn('[SUPPORT BOT CTRL] Não foi possível determinar o remetente da mensagem.', { payload });
        return res.status(200).json({ status: 'fail_no_sender', message: 'Sender phone not found in payload.' });
    }

    // Roteia para o serviço do bot de suporte com base no tipo de mensagem detectado
    if (detectedMessageType === 'button_response' && selectedButtonId) {
        // Processa respostas de botão (este bot pode usar botões de menu)
         await systemSupportBotService.processButtonResponse(senderPhone, messageText, pushName, payload);
         res.status(200).json({ status: 'success', message: 'Button response received and processing initiated.' });

    } else if (detectedMessageType === 'text' && messageText) {
      // Processa mensagens de texto
      await systemSupportBotService.processIncomingMessage(senderPhone, messageText, pushName, payload);
      res.status(200).json({ status: 'success', message: 'Text message received and processing initiated.' });

    } else {
      // Se chegou aqui, significa que o payload tinha um remetente, mas o conteúdo não foi reconhecido como acionável
      logger.warn('[SUPPORT BOT CTRL] Payload de webhook reconhecido (tem remetente), mas sem conteúdo acionável (texto ou botão) para o bot de suporte.', { mainType: mainWebhookType, detectedType: detectedMessageType, senderPhone });
      // Opcional: Enviar uma mensagem padrão de "não entendi" se for um tipo de payload inesperado mas com remetente.
      // Exemplo: se for um evento de "ChatPresence" ou "ReadReceipt" que você não processa.
      // systemSupportBotService.sendWhatsappMessage(senderPhone, "Recebi uma notificação sua, mas não entendi o que significa. Se tiver alguma dúvida, pode digitar aqui!");
      res.status(200).json({ status: 'fail_no_actionable_content', message: 'Payload recognized but no actionable content for support bot.' });
    }

  } catch (error) {
    logger.error('[SUPPORT BOT CTRL] Erro ao processar webhook da Z-API (Suporte Bot):', { error: error.message, stack: error.stack });
    // Responde 200 para a Z-API mesmo em caso de erro interno para evitar reenviar
    res.status(200).json({ status: 'error_processing_internally', message: 'Error processing webhook.' });
  }
}

module.exports = {
  handleIncomingMessage,
};
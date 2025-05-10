// src/features/WhatsappHandler/whatsapp.controller.js
const whatsappService = require('./whatsapp.service'); // O serviço que processa a lógica
const logger = require('../../utils/logger');

/**
 * Recebe notificações de webhook da Z-API (novas mensagens, status, etc.).
 */
async function handleIncomingMessage(req, res, next) {
  try {
    const payload = req.body;
    logger.info('[WHATSAPP CONTROLLER] Webhook da Z-API recebido:', { payload: JSON.stringify(payload).substring(0, 500) + '...' }); // Loga o payload (cuidado com dados sensíveis em prod)

    // A Z-API pode enviar diferentes tipos de eventos.
    // Precisamos identificar se é uma mensagem de texto de um cliente.
    // A estrutura exata do payload da Z-API para 'message' precisa ser verificada na documentação deles.
    // Exemplo comum:
    // if (payload.type === 'message' && payload.message && payload.message.type === 'chat' && !payload.message.fromMe) {

    // ASSUMINDO que o payload principal para uma nova mensagem seja algo como:
    // { "messageId": "...", "timestamp": 123, "phone": "5511999999999", "message": "Texto da mensagem", "isGroup": false, ... }
    // Ou pode estar aninhado: payload.data.message, payload.events[0].message etc.
    // **VOCÊ PRECISARÁ AJUSTAR A EXTRAÇÃO DO NÚMERO E MENSAGEM CONFORME A DOCUMENTAÇÃO REAL DA Z-API**

    let senderPhone = null;
    let messageText = null;
    let isFromMe = false; // Para ignorar mensagens enviadas pelo próprio bot/número

    // Adapte esta lógica baseada no payload real da Z-API
    // Exemplo 1: Payload direto
    if (payload.phone && payload.message && typeof payload.message === 'string') {
        senderPhone = payload.phone;
        messageText = payload.message;
        isFromMe = payload.fromMe || payload.isFromMe || false;
    }
    // Exemplo 2: Payload aninhado comum em algumas APIs de WhatsApp
    else if (payload.messages && payload.messages.length > 0 && payload.messages[0].type === 'text') {
        const msgObj = payload.messages[0];
        senderPhone = msgObj.from; // ou msgObj.author
        messageText = msgObj.text.body;
        isFromMe = msgObj.id.fromMe || false;
    }
    // Exemplo 3: Se a Z-API usar uma estrutura específica para eventos de mensagem
    // else if (payload.event === 'onmessage' && payload.data?.message?.body) {
    //     senderPhone = payload.data.sender.id; // ou similar
    //     messageText = payload.data.message.body;
    //     isFromMe = payload.data.message.fromMe;
    // }
    // Adicione mais 'else if' conforme a estrutura do payload da Z-API para diferentes tipos de mensagens (texto, imagem, etc.)

    if (isFromMe) {
        logger.info('[WHATSAPP CONTROLLER] Mensagem de mim mesmo, ignorando.');
        return res.status(200).json({ status: 'success', message: 'Echo message ignored.' });
    }

    if (senderPhone && messageText) {
      // Remove caracteres não numéricos do telefone, se necessário, e garante DDI
      senderPhone = senderPhone.replace(/\D/g, '');
      if (!senderPhone.startsWith('55') && senderPhone.length > 9) { // Heurística para adicionar 55 se não tiver
          // senderPhone = '55' + senderPhone; // Cuidado com essa lógica, pode ser falha.
      }

      await whatsappService.processIncomingMessage(senderPhone, messageText, payload);
      res.status(200).json({ status: 'success', message: 'Message received and processing initiated.' });
    } else {
      logger.warn('[WHATSAPP CONTROLLER] Payload de webhook não continha telefone ou texto de mensagem esperado.', { payload });
      res.status(400).json({ status: 'fail', message: 'Payload not recognized as a processable message.' });
    }

  } catch (error) {
    // Não envie o erro detalhado para a Z-API, apenas logue e retorne um status de erro genérico
    // A Z-API geralmente espera um 200 OK para confirmar o recebimento do webhook.
    // Se você retornar 500, ela pode tentar reenviar.
    logger.error('[WHATSAPP CONTROLLER] Erro ao processar webhook da Z-API:', { error: error.message, stack: error.stack });
    // É importante retornar 200 para a Z-API para evitar retries, mesmo que haja um erro interno.
    // O erro já foi logado.
    res.status(200).json({ status: 'error_processing', message: 'Error processing webhook internally.' });
    // Ou, se você quer que a Z-API saiba que houve um problema e talvez tente reenviar (verifique a doc da Z-API):
    // next(error); // Isso usaria o errorHandler global e poderia retornar 500.
  }
}

module.exports = {
  handleIncomingMessage,
};
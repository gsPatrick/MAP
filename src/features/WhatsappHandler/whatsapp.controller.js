// src/features/WhatsappHandler/whatsapp.controller.js
const whatsappService = require('./whatsapp.service');
const logger = require('../../utils/logger');

async function handleIncomingMessage(req, res, next) {
  try {
    const payload = req.body;
    // Log completo do payload (para depuração inicial, pode reduzir em produção ou mascarar dados)
    logger.info('[WHATSAPP CONTROLLER] Webhook da Z-API recebido:', { payload }); // Logar o objeto inteiro

    let senderPhone = null;
    let messageText = null;
    let isFromMe = false;
    let pushName = null; // Para o nome do contato

    // Verificar se é um evento de mensagem recebida e extrair os dados
    // Com base no seu payload:
    if (payload.type === 'ReceivedCallback' && payload.text && typeof payload.text.message === 'string' && payload.phone) {
      senderPhone = payload.phone;
      messageText = payload.text.message;
      isFromMe = payload.fromMe || false; // Z-API já fornece `fromMe` diretamente
      pushName = payload.chatName || payload.senderName || null; // Tenta pegar o nome
      if (pushName === "⠀") pushName = null; // Limpa se for só o caractere invisível
    } else if (payload.type === 'MessageReceived' && payload.message?.body && payload.message?.sender) { // Outra estrutura possível que algumas APIs usam
        senderPhone = payload.message.sender.replace('@c.us', ''); // Exemplo se vier com sufixo
        messageText = payload.message.body;
        isFromMe = payload.message.fromMe;
        pushName = payload.message.notifyName || payload.message.senderName;
    }
    // Adicione mais 'else if' aqui se a Z-API tiver outras estruturas de payload para mensagens de texto
    // ou para diferentes tipos de eventos que você queira tratar (ex: status de mensagem, cliques em botões).


    if (isFromMe) {
      logger.info('[WHATSAPP CONTROLLER] Mensagem de mim mesmo (fromMe=true), ignorando.');
      return res.status(200).json({ status: 'success', message: 'Echo message ignored.' });
    }

    if (senderPhone && messageText) {
      // Normalizar telefone (remover não dígitos já é feito no service findOrCreateClientByPhone)
      // senderPhone = senderPhone.replace(/\D/g, '');

      // Passar o rawPayload também pode ser útil para o service ter acesso a outros campos se necessário
      await whatsappService.processIncomingMessage(senderPhone, messageText, pushName, payload);
      res.status(200).json({ status: 'success', message: 'Message received and processing initiated.' });
    } else {
      logger.warn('[WHATSAPP CONTROLLER] Payload de webhook não continha telefone ou texto de mensagem esperado na estrutura conhecida.', { type: payload.type });
      // É importante retornar 200 OK para a Z-API para que ela não tente reenviar indefinidamente.
      res.status(200).json({ status: 'fail_payload_structure', message: 'Payload structure not recognized for text message.' });
    }

  } catch (error) {
    logger.error('[WHATSAPP CONTROLLER] Erro ao processar webhook da Z-API:', { error: error.message, stack: error.stack });
    // Retornar 200 para a Z-API mesmo em erro interno para evitar retries excessivos.
    res.status(200).json({ status: 'error_processing_internally', message: 'Error processing webhook.' });
  }
}

module.exports = {
  handleIncomingMessage,
};
// src/features/GoogleWebhook/googleWebhook.controller.js
const googleWebhookService = require('./googleWebhook.service');
const logger = require('../../utils/logger');

async function handleNotification(req, res, next) {
  // Os cabeçalhos são cruciais para identificar a origem e o recurso
  const channelId = req.headers['x-goog-channel-id'];
  const resourceId = req.headers['x-goog-resource-id']; // ID do calendário
  const resourceState = req.headers['x-goog-resource-state']; // 'exists', 'sync', 'not_exists'
  const messageNumber = req.headers['x-goog-message-number'];
  const channelToken = req.headers['x-goog-channel-token']; // Se você setou um token ao criar o watch

  logger.info(`[GoogleWebhookCtrl] Notificação recebida: ChannelID=${channelId}, ResourceID=${resourceId}, State=${resourceState}, MsgNum=${messageNumber}, Token=${channelToken || 'N/A'}`);

  // Validação básica
  if (!channelId || !resourceId || !resourceState) {
    logger.warn('[GoogleWebhookCtrl] Cabeçalhos do Google ausentes ou incompletos. Ignorando notificação.');
    return res.status(400).send('Cabeçalhos do Google ausentes.');
  }

  // O Google espera uma resposta rápida (2xx) para confirmar o recebimento do webhook.
  // O processamento real deve ser feito de forma assíncrona para não bloquear.
  res.status(200).send('Notificação recebida.'); // Envia 200 OK imediatamente

  // Processa a notificação de forma assíncrona
  googleWebhookService.processNotification(channelId, resourceId, resourceState, req.body)
    .catch(error => {
      // Logar o erro, mas não podemos mais enviar resposta HTTP aqui
      logger.error(`[GoogleWebhookCtrl] Erro assíncrono ao processar notificação do Google: ${error.message}`, { error, channelId });
    });
}

module.exports = {
  handleNotification,
};  
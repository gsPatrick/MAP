// src/features/WebhookHandler/asaas.controller.js
const asaasService = require('./asaas.service');
const logger = require('../../utils/logger');

async function handleWebhookEvent(req, res, next) {
  try {
    const eventData = req.body;
    // Opcional: o token viria no header, mas como você não configurou, vamos ignorá-lo por enquanto.
    // const apiTokenFromHeader = req.headers['asaas-access-token']; 

    logger.info(`[ASAAS CTRL] Webhook do ASAAS recebido. Evento: ${eventData.event}`);

    // Delega todo o processamento para o serviço
    await asaasService.processWebhookEvent(eventData);

    // Responde 200 OK para o ASAAS confirmar o recebimento
    res.status(200).send('OK');
  } catch (error) {
    logger.error('[ASAAS CTRL] Erro ao processar webhook do ASAAS:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body
    });
    // ASAAS tentará reenviar se não receber 200 OK
    res.status(500).send('Internal Server Error');
  }
}

module.exports = {
  handleWebhookEvent,
};
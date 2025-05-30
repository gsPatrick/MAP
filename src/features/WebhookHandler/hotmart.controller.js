// src/features/WebhookHandler/hotmart.controller.js
const hotmartService = require('./hotmart.service');
const logger = require('../../utils/logger');

async function handleWebhookEvent(req, res, next) {
  try {
    const eventData = req.body;
    const hottokFromHeader = req.headers['x-hotmart-hottok']; // Hotmart envia o Hottok neste header

    // Log básico do evento recebido (cuidado com dados sensíveis em produção)
    logger.info(`[HOTMART CTRL] Webhook da Hotmart recebido. Transação: ${eventData.transaction}, Status: ${eventData.status}, Produto: ${eventData.prod}`);
    // logger.debug('[HOTMART CTRL] Payload completo do webhook:', eventData);

    if (!hottokFromHeader) {
        logger.warn('[HOTMART CTRL] Requisição de webhook sem x-hotmart-hottok no header.');
        return res.status(401).send('Unauthorized: Missing Hottok.');
    }

    // Delega o processamento completo, incluindo validação do Hottok, para o serviço
    await hotmartService.processWebhookEvent(eventData, hottokFromHeader);

    // A Hotmart espera uma resposta 200 OK para confirmar o recebimento bem-sucedido.
    // Não envie o corpo da resposta, apenas o status.
    res.status(200).send('OK');
  } catch (error) {
    // Loga o erro internamente
    logger.error('[HOTMART CTRL] Erro ao processar webhook da Hotmart:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body // Cuidado ao logar o corpo inteiro em produção
    });
    // Responde com um erro genérico para a Hotmart.
    // A Hotmart tentará reenviar o webhook se não receber 200 OK.
    res.status(500).send('Internal Server Error');
  }
}

module.exports = {
  handleWebhookEvent,
};
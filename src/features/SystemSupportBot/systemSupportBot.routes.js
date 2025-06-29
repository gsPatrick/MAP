// src/features/SystemSupportBot/systemSupportBot.routes.js

const { Router } = require('express');
const systemSupportBotController = require('./systemSupportBot.controller');
const logger = require('../../utils/logger');

const router = Router();

// Obtém o caminho do webhook das variáveis de ambiente ou usa um padrão
const SUPPORT_BOT_WEBHOOK_PATH = process.env.SUPPORT_BOT_WEBHOOK_PATH || '/webhook-support';

logger.info(`[SUPPORT BOT ROUTES] Configurando rota POST para o webhook do bot de suporte: ${SUPPORT_BOT_WEBHOOK_PATH}`);

router.post(SUPPORT_BOT_WEBHOOK_PATH, systemSupportBotController.handleIncomingMessage);

// Rota GET opcional para verificação do webhook pela Z-API (se eles usarem esse método)
router.get(SUPPORT_BOT_WEBHOOK_PATH, (req, res) => {
  const VERIFY_TOKEN = process.env.ZAPI_WEBHOOK_VERIFY_TOKEN; // Reutiliza o mesmo token de verificação, se aplicável
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      logger.info(`[SUPPORT BOT ROUTES] Verificação do Webhook GET para ${SUPPORT_BOT_WEBHOOK_PATH} bem-sucedida.`);
      res.status(200).send(challenge);
    } else {
      logger.warn(`[SUPPORT BOT ROUTES] Falha na verificação do Webhook GET para ${SUPPORT_BOT_WEBHOOK_PATH} (token inválido).`);
      res.sendStatus(403);
    }
  } else {
     logger.info(`[SUPPORT BOT ROUTES] Requisição GET genérica recebida em ${SUPPORT_BOT_WEBHOOK_PATH}.`);
    res.status(200).send(`Endpoint de Webhook para Bot de Suporte (Z-API) está ativo em ${SUPPORT_BOT_WEBHOOK_PATH}. Use POST para enviar mensagens.`);
  }
});


module.exports = router;
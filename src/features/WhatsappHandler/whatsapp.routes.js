// src/features/WhatsappHandler/whatsapp.routes.js
const { Router } = require('express');
const whatsappController = require('./whatsapp.controller'); // Certifique-se que whatsapp.controller.js existe
const logger = require('../../utils/logger');

const router = Router();

// Endpoint para receber webhooks da Z-API (onde as mensagens dos usuários chegam)
router.post('/webhook', whatsappController.handleIncomingMessage);

// Opcional: Rota GET para verificação do webhook pela Z-API (se eles usarem esse método)
router.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.ZAPI_WEBHOOK_VERIFY_TOKEN; 
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      logger.info('[WHATSAPP WEBHOOK] Verificação do Webhook GET bem-sucedida.');
      res.status(200).send(challenge);
    } else {
      logger.warn('[WHATSAPP WEBHOOK] Falha na verificação do Webhook GET (token inválido).');
      res.sendStatus(403); 
    }
  } else {
    logger.info('[WHATSAPP WEBHOOK] Requisição GET recebida (sem parâmetros de verificação).');
    res.status(200).send('Endpoint de Webhook para WhatsApp (Z-API) está ativo. Use POST para enviar mensagens.');
  }
});

module.exports = router;
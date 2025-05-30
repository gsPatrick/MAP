// src/features/WebhookHandler/hotmart.routes.js
const { Router } = require('express');
const hotmartController = require('./hotmart.controller');
// Middleware de verificação (opcional, mas recomendado para produção)
// const { verifyHotmartWebhook } = require('../../middlewares/paymentMiddlewares');

const router = Router();

// A Hotmart recomenda que o endpoint seja simples e direto.
// A verificação do Hottok será feita no serviço ou em um middleware específico.
router.post('/hotmart', hotmartController.handleWebhookEvent);

module.exports = router;
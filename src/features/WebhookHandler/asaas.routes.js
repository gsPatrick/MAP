// src/features/WebhookHandler/asaas.routes.js
const { Router } = require('express');
const asaasController = require('./asaas.controller');

const router = Router();

// Endpoint para receber notificações (webhooks) do ASAAS
router.post('/asaas', asaasController.handleWebhookEvent);

module.exports = router;
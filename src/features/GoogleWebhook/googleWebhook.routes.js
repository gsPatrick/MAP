// src/features/GoogleWebhook/googleWebhook.routes.js
const { Router } = require('express');
const googleWebhookController = require('./googleWebhook.controller');

const router = Router();

// Esta rota é chamada pelo Google Calendar quando há notificações push
router.post('/', googleWebhookController.handleNotification);

module.exports = router;
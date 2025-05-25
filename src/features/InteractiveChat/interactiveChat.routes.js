// src/features/InteractiveChat/interactiveChat.routes.js
const { Router } = require('express');
const interactiveChatController = require('./interactiveChat.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware'); // Protege a rota de chat

const router = Router();

// Rota para o cliente logado enviar mensagens para o chat do site e receber respostas
// O authenticateClientToken garante que temos req.client com os dados do cliente autenticado.
router.post('/send-message', authenticateClientToken, interactiveChatController.handleSiteChatMessage);

module.exports = router;
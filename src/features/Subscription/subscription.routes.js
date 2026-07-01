// src/features/Subscription/subscription.routes.js
const { Router } = require('express');
const subscriptionController = require('./subscription.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware');

const router = Router();

// Aplica o middleware de autenticação para todas as rotas de assinatura
router.use(authenticateClientToken);

// Rota para obter a assinatura ATIVA do cliente logado
router.get('/me/active', subscriptionController.getMyActiveSubscription);

// Rota para obter TODAS as assinaturas (histórico) do cliente logado
router.get('/me', subscriptionController.getMySubscriptions);

// Cancelar (agendado p/ vencimento) e reativar
router.post('/cancel', subscriptionController.cancelMySubscription);
router.post('/reactivate', subscriptionController.reactivateMySubscription);

module.exports = router;
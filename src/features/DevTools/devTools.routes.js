// src/features/DevTools/devTools.routes.js
const { Router } = require('express');
const devToolsController = require('./devTools.controller');
// const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware'); // Se aplicável

const router = Router();

// Rota antiga renomeada para mais clareza
router.post('/activate-access-level/:clientId', devToolsController.activateTestAccessLevelController);
// Exemplo de uso: POST /api/dev-tools/activate-access-level/123?level=avancado_mensal

// NOVA ROTA para simular a criação de uma assinatura (e consequentemente ativar o plano no cliente)
// Use POST pois cria um recurso (Subscription)
router.post('/simulate-subscription/:clientId', devToolsController.simulateSubscriptionController);
// Exemplo de uso: POST /api/dev-tools/simulate-subscription/123
// Corpo (Body) JSON: { "planId": 1 }  (ou ?planId=1 na query)
// Opcional no corpo/query: "status": "Pendente" (se quiser simular uma não ativa)


  router.post('/simulate-asaas-payment', devToolsController.simulateAsaasPayment);

module.exports = router;
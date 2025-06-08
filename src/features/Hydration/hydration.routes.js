// src/features/Hydration/hydration.routes.js
const { Router } = require('express');
const hydrationController = require('./hydration.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware'); // Supondo que você tenha um middleware para autenticar clientes

const router = Router();

// Todas as rotas de hidratação exigem que um cliente esteja logado
router.use(authenticateClientToken);

// Rota para buscar os logs do dia (cria se não existirem)
router.get('/logs/today', authenticateClientToken, hydrationController.getTodaysLogs);

// Rota para atualizar o status de um log específico (marcar como bebido/pendente)
router.patch('/log/:logId', hydrationController.updateLog);



module.exports = router;
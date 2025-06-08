const express = require('express');
const router = express.Router();
const hydrationController = require('./hydration.controller');
// Certifique-se de que o caminho para seu middleware de autenticação está correto
const { authenticateClient } = require('../../middleware/authMiddleware'); 

// ROTA QUE ESTÁ FALTANDO:
// Define que um GET para a raiz do router de hidratação + /logs/today
// deve chamar o controller getTodaysLogs.
router.get('/logs/today', authenticateClient, hydrationController.getTodaysLogs);

// Aqui podem existir outras rotas que você já tinha, como:
 router.put('/preferences', authenticateClient, hydrationController.updatePreferences);
 router.patch('/log/:id', authenticateClient, hydrationController.updateLogStatus);

module.exports = router;
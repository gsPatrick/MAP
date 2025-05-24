// src/features/System/system.routes.js
const { Router } = require('express');
const systemController = require('./system.controller');
// const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware');

const router = Router();

// Proteger todas as rotas de sistema para administradores
// router.use(authenticateToken);
// router.use(authorizeRole(['admin'])); // Supondo que 'admin' seja o role necessário

// Preferências do Sistema (UserPreference)
router.get('/preferences', systemController.getSystemPreferences);
router.put('/preferences', systemController.updateSystemPreferences);

// Categorias Financeiras - REMOVIDAS DESTE ARQUIVO
// Elas agora estão em financialCategory.routes.js e aninhadas sob /financial-accounts/:financialAccountId

// Frases Motivacionais
router.post('/motivational-phrases', systemController.createMotivationalPhrase);
router.get('/motivational-phrases', systemController.getAllMotivationalPhrases);
router.put('/motivational-phrases/:id', systemController.updateMotivationalPhrase);
router.delete('/motivational-phrases/:id', systemController.deleteMotivationalPhrase);

module.exports = router;
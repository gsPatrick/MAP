// src/features/System/system.routes.js
const { Router } = require('express');
const systemController = require('./system.controller');
// const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware');

const router = Router();

// Proteger todas as rotas de sistema para administradores
// router.use(authenticateToken);
// router.use(authorizeRole(['admin']));

// Preferências do Sistema (UserPreference)
router.get('/preferences', systemController.getSystemPreferences);
router.put('/preferences', systemController.updateSystemPreferences);

// Categorias Financeiras
router.post('/financial-categories', systemController.createFinancialCategory);
router.get('/financial-categories', systemController.getAllFinancialCategories); // Aceita query params: hierarchical, onlyTopLevel, isActive
router.get('/financial-categories/:id', systemController.getFinancialCategoryById);
router.put('/financial-categories/:id', systemController.updateFinancialCategory);
router.delete('/financial-categories/:id', systemController.deleteFinancialCategory); // Aceita query params para opções de deleção

// Frases Motivacionais
router.post('/motivational-phrases', systemController.createMotivationalPhrase);
router.get('/motivational-phrases', systemController.getAllMotivationalPhrases); // Aceita query param: isActive
router.put('/motivational-phrases/:id', systemController.updateMotivationalPhrase);
router.delete('/motivational-phrases/:id', systemController.deleteMotivationalPhrase);

module.exports = router;
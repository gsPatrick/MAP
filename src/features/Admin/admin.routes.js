// src/features/Admin/admin.routes.js
const { Router } = require('express');
const adminController = require('./admin.controller');
const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware');

const router = Router();

// Aplica autenticação de admin para todas as rotas deste arquivo
// A linha abaixo protege TODAS as rotas que começam com '/admin'
router.use('/admin', authenticateToken, authorizeRole(['admin']));

// --- Rotas de Métricas e Dashboards ---
router.get('/admin/dashboard/metrics', adminController.getDashboardMetrics);
router.get('/admin/dashboard/affiliates', adminController.getAffiliatesDashboard);

// --- Rotas de Gerenciamento de Clientes ---
router.get('/admin/clients', adminController.getAllClients);
router.post('/admin/clients', adminController.createClient);
router.put('/admin/clients/:clientId', adminController.updateClient);
router.put('/admin/clients/:clientId/change-phone', adminController.changeClientPhone);
router.post('/admin/clients/change-plan', adminController.changeUserPlan);
router.put('/admin/clients/:clientId/clear-balance', adminController.clearClientBalance);

// <<< [ROTA DE EXCLUSÃO CORRIGIDA E ÚNICA] >>>
// Esta é a única rota DELETE para clientes neste arquivo.
// Ela chama o controller correto que por sua vez chama o admin.service.
router.delete('/admin/clients/:clientId', adminController.deleteClientAsAdmin);

// --- Rotas de Gerenciamento de Planos ---
router.post('/admin/plans/custom', adminController.createCustomPlan);
router.get('/admin/plans', adminController.getAllPlans);
router.put('/admin/plans/:planId', adminController.updatePlan);

// --- Rotas de Comunicação ---
router.post('/admin/broadcast', adminController.sendBroadcastMessage);

module.exports = router;
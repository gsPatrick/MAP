// src/features/Admin/admin.routes.js
const { Router } = require('express');
const adminController = require('./admin.controller');
const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware');

const router = Router();

// Aplica autenticação de admin para todas as rotas deste arquivo
router.use('/admin', authenticateToken, authorizeRole(['admin']));

// --- Rotas de Métricas e Dashboards ---
router.get('/admin/dashboard/metrics', adminController.getDashboardMetrics);
router.get('/admin/dashboard/affiliates', adminController.getAffiliatesDashboard);

// --- Rotas de Gerenciamento de Clientes ---
router.get('/admin/clients', adminController.getAllClients);
router.post('/admin/clients', adminController.createClient);
router.put('/admin/clients/:clientId', adminController.updateClient);
router.delete('/admin/clients/:clientId', adminController.deleteClient);
router.post('/admin/clients/change-plan', adminController.changeUserPlan);

// --- Rotas de Gerenciamento de Planos ---
router.post('/admin/plans/custom', adminController.createCustomPlan);

// --- Rotas de Comunicação ---
router.post('/admin/broadcast', adminController.sendBroadcastMessage);
router.get('/admin/plans', adminController.getAllPlans);
router.put('/admin/plans/:planId', adminController.updatePlan);

module.exports = router;
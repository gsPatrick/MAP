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
router.get('/admin/dashboard/stats', adminController.getAdminStats); // <<< NOVA ROTA

// --- Rotas de Gerenciamento de Clientes ---
// <<< NOVA ROTA PARA O PAINEL DE ADMIN >>>
router.get('/admin/clients/list', adminController.getAdminClientList);

// Manter a rota antiga se ainda for usada em outro lugar, ou remover
router.get('/admin/clients', adminController.getAllClients);

router.post('/admin/clients', adminController.createClient);
router.put('/admin/clients/:clientId', adminController.updateClient);
router.put('/admin/clients/:clientId/change-phone', adminController.changeClientPhone);
router.post('/admin/clients/change-plan', adminController.changeUserPlan);
router.post('/admin/clients/:clientId/confirm-payment', adminController.confirmClientPayment);
router.put('/admin/clients/:clientId/clear-balance', adminController.clearClientBalance);
router.delete('/admin/clients/:clientId', adminController.deleteClientAsAdmin);

// --- Rotas de Gerenciamento de Planos ---
router.post('/admin/plans/custom', adminController.createCustomPlan);
router.get('/admin/plans', adminController.getAllPlans);
router.put('/admin/plans/:planId', adminController.updatePlan);

// --- Rotas de Comunicação ---
router.post('/admin/broadcast', adminController.sendBroadcastMessage)

// --- <<< NOVAS ROTAS Z-API >>> ---
router.get('/admin/zapi/status', adminController.getZapiStatus);
router.get('/admin/zapi/qrcode-url', adminController.getZapiQrCode);
router.post('/admin/clients/create-as-admin', adminController.createClientAsAdmin); // <<< NOVA ROTA

router.put('/admin/clients/:clientId/clear-balance', adminController.clearClientBalance);

// --- Saques de afiliado (admin) ---
router.get('/admin/affiliates/pending-payouts', adminController.getPendingAffiliatePayouts);
router.get('/admin/affiliates/:clientId/payouts', adminController.getAffiliatePayoutsByClient);
router.post('/admin/affiliates/payouts/:payoutId/pay', adminController.payAffiliatePayout);


module.exports = router;
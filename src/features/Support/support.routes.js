// d:/daniatualagrvai/MAP/src/features/Support/support.routes.js
const express = require('express');
const router = express.Router();
const supportController = require('./support.controller');
const { authenticateClientToken, authenticateToken } = require('../../middlewares/authMiddleware');

// Rotas do Cliente (Autenticado)
router.post('/tickets', authenticateClientToken, supportController.createTicket);
router.get('/my-tickets', authenticateClientToken, supportController.listMyTickets);
router.get('/tickets/:id', authenticateClientToken, supportController.getMyTicket);
router.post('/tickets/:id/messages', authenticateClientToken, supportController.postMyMessage);

// Rotas do Administrador
router.get('/admin/tickets', authenticateToken, supportController.adminListTickets);
router.get('/admin/metrics', authenticateToken, supportController.adminGetMetrics);
router.get('/admin/tickets/:id', authenticateToken, supportController.adminGetTicket);
router.post('/admin/tickets/:id/messages', authenticateToken, supportController.adminPostMessage);
router.put('/admin/tickets/:id', authenticateToken, supportController.adminUpdateTicket);

module.exports = router;

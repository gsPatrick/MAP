// src/features/Service/service.routes.js
const { Router } = require('express');
const serviceController = require('./service.controller');
const { authenticateClientToken, checkFinancialAccountOwnership } = require('../../middlewares/authMiddleware');

const router = Router();

// Middleware de autenticação e verificação de propriedade para todas as rotas
// Isso garante que apenas o dono da conta financeira pode gerenciar seus serviços.
router.use('/:financialAccountId', authenticateClientToken, checkFinancialAccountOwnership);

// --- Rotas para o CRUD de Serviços ---

// Rota para listar todos os serviços de uma conta e criar um novo serviço
router.route('/:financialAccountId/services')
  .get(serviceController.getAllServices)
  .post(serviceController.createService);

// Rota para obter, atualizar e deletar um serviço específico
router.route('/:financialAccountId/services/:serviceId')
  .get(serviceController.getServiceById)
  .patch(serviceController.updateService)
  .put(serviceController.updateService) // Suporte para PUT e PATCH
  .delete(serviceController.deleteService);

module.exports = router;
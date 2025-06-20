// src/features/Availability/availability.routes.js
const { Router } = require('express');
const availabilityController = require('./availability.controller');
const { authenticateClientToken, checkFinancialAccountOwnership } = require('../../middlewares/authMiddleware');

const router = Router({ mergeParams: true });

// Aplica middleware de autenticação e propriedade para todas as rotas.
router.use('/:financialAccountId', authenticateClientToken, checkFinancialAccountOwnership);

// Rota para criar uma nova regra de disponibilidade e listar todas as regras de uma conta
// Caminho final: GET ou POST /api/availability/:financialAccountId
router.route('/:financialAccountId')
  .post(availabilityController.createAvailabilityRule)
  .get(availabilityController.getAllAvailabilityRules);

// Rota para obter, atualizar e deletar uma regra de disponibilidade específica
// Caminho final: GET, PATCH, DELETE /api/availability/:financialAccountId/:ruleId
router.route('/:financialAccountId/:ruleId')
  .get(availabilityController.getAvailabilityRuleById)
  .patch(availabilityController.updateAvailabilityRule)
  .put(availabilityController.updateAvailabilityRule) // Suporte para PUT e PATCH
  .delete(availabilityController.deleteAvailabilityRule);

module.exports = router;
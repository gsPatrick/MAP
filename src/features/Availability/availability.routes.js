// src/features/Availability/availability.routes.js
const { Router } = require('express');
const availabilityController = require('./availability.controller');
const { authenticateClientToken, checkFinancialAccountOwnership } = require('../../middlewares/authMiddleware');

const router = Router();

// Aplica middleware de autenticação e propriedade para todas as rotas de disponibilidade.
// Apenas o dono da conta pode definir seus próprios horários.
router.use('/:financialAccountId', authenticateClientToken, checkFinancialAccountOwnership);

// Rota para criar uma nova regra de disponibilidade e listar todas as regras de uma conta
router.route('/:financialAccountId/availability-rules')
  .post(availabilityController.createAvailabilityRule)
  .get(availabilityController.getAllAvailabilityRules);

// Rota para obter, atualizar e deletar uma regra de disponibilidade específica
router.route('/:financialAccountId/availability-rules/:ruleId')
  .get(availabilityController.getAvailabilityRuleById)
  .patch(availabilityController.updateAvailabilityRule)
  .put(availabilityController.updateAvailabilityRule) // Suporte para PUT e PATCH
  .delete(availabilityController.deleteAvailabilityRule);

module.exports = router;
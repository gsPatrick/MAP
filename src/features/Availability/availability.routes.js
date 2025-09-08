// src/features/Availability/availability.routes.js
const { Router } = require('express');
const availabilityController = require('./availability.controller');

const router = Router({ mergeParams: true });

// Rota para criar uma nova regra de disponibilidade (PROTEGIDA) e listar todas as regras de uma conta (PÚBLICA)
// Caminho final: GET (público) ou POST (protegido) /api/availability/:financialAccountId
router.route('/:financialAccountId')
  .post( // Apenas o POST é protegido
    
    checkFinancialAccountOwnership,
    availabilityController.createAvailabilityRule
  )
  .get( // O GET para listar todas as regras é público, sem middlewares de autenticação
    availabilityController.getAllAvailabilityRules
  );

// Rota para obter, atualizar e deletar uma regra de disponibilidade específica (TODAS PROTEGIDAS)
// Caminho final: GET, PATCH, PUT, DELETE /api/availability/:financialAccountId/:ruleId
router.route('/:financialAccountId/:ruleId')
  .get( // Obter uma regra específica continua protegido
    
    checkFinancialAccountOwnership,
    availabilityController.getAvailabilityRuleById
  )
  .patch(
    
    checkFinancialAccountOwnership,
    availabilityController.updateAvailabilityRule
  )
  .put( // Suporte para PUT e PATCH
    
    checkFinancialAccountOwnership,
    availabilityController.updateAvailabilityRule
  )
  .delete(
    
    checkFinancialAccountOwnership,
    availabilityController.deleteAvailabilityRule
  );

module.exports = router;
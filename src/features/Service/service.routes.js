// src/features/Service/service.routes.js
const { Router } = require('express');
const serviceController = require('./service.controller');
const { authenticateClientToken, checkFinancialAccountOwnership } = require('../../middlewares/authMiddleware');

// Usamos { mergeParams: true } para que este router possa acessar os parâmetros da rota pai,
// se aplicável em alguma montagem mais complexa.
const router = Router({ mergeParams: true });

// <<< MUDANÇA: APLICAR MIDDLEWARE DE AUTORIZAÇÃO DIRETAMENTE AQUI >>>
// Como esta rota não está mais aninhada, ela precisa do seu próprio middleware de autorização.
router.use('/:financialAccountId', authenticateClientToken, checkFinancialAccountOwnership);

// Rota para listar todos os serviços de uma conta e criar um novo serviço.
// O caminho completo será: GET /api/services/:financialAccountId
router.route('/:financialAccountId')
  .get(serviceController.getAllServices)
  .post(serviceController.createService);

// Rota para obter, atualizar e deletar um serviço específico.
// O caminho completo será: GET /api/services/:financialAccountId/:serviceId
router.route('/:financialAccountId/:serviceId')
  .get(serviceController.getServiceById)
  .patch(serviceController.updateService)
  .put(serviceController.updateService) // Suporte para PUT e PATCH
  .delete(serviceController.deleteService);

module.exports = router;
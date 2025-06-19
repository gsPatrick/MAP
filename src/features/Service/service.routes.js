// src/features/Service/service.routes.js
const { Router } = require('express');
const serviceController = require('./service.controller');
// Os middlewares de autenticação e propriedade já são aplicados na rota pai (em src/routes/index.js)

// Usamos { mergeParams: true } para que este router possa acessar os parâmetros da rota pai,
// especificamente o :financialAccountId.
const router = Router({ mergeParams: true });

// --- Rotas para o CRUD de Serviços ---

// Rota para listar todos os serviços de uma conta e criar um novo serviço.
// O caminho completo será: GET /api/financial-accounts/:financialAccountId/services
router.route('/')
  .get(serviceController.getAllServices)
  .post(serviceController.createService);

// Rota para obter, atualizar e deletar um serviço específico.
// O caminho completo será: GET /api/financial-accounts/:financialAccountId/services/:serviceId
router.route('/:serviceId')
  .get(serviceController.getServiceById)
  .patch(serviceController.updateService)
  .put(serviceController.updateService) // Suporte para PUT e PATCH
  .delete(serviceController.deleteService);

module.exports = router;
// src/features/Service/service.routes.js
const { Router } = require('express');
const serviceController = require('./service.controller');
const { authenticateClientToken, checkFinancialAccountOwnership } = require('../../middlewares/authMiddleware');

// Este router espera ser montado em um caminho como '/api/services'
// e espera que o :financialAccountId seja passado na URL.
// Usamos { mergeParams: true } para acessar parâmetros de rotas pai, se houver.
const router = Router({ mergeParams: true });

// O middleware será aplicado a todas as rotas abaixo.
// Ele garante que o usuário está autenticado e tem acesso à financialAccountId.
router.use('/:financialAccountId', authenticateClientToken, checkFinancialAccountOwnership);

// Rota para listar todos os serviços e criar um novo.
// O caminho completo será, por exemplo: GET /api/services/2
router.route('/:financialAccountId')
  .get(serviceController.getAllServices)
  .post(serviceController.createService);

// Rota para operar em um serviço específico.
// O caminho completo será, por exemplo: GET /api/services/2/15
router.route('/:financialAccountId/:serviceId')
  .get(serviceController.getServiceById)
  .patch(serviceController.updateService)
  .put(serviceController.updateService) // Suporte para PUT e PATCH
  .delete(serviceController.deleteService);

module.exports = router;
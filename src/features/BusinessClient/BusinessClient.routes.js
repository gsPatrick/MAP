// src/features/BusinessClient/businessClient.routes.js
const { Router } = require('express');
const businessClientController = require('./BusinessClient.controller');
// Middlewares de autenticação e autorização serão aplicados no router pai (clientFinancialAccountRouter)
// const { authenticateClientToken, authorizeFinancialAccountOwnership } = require('../../middlewares/authMiddleware');

// Este router espera que :financialAccountId seja fornecido pela rota pai
const router = Router({ mergeParams: true });

// Todas as rotas abaixo esperam o :financialAccountId na URL,
// e dependem da autenticação e autorização já aplicadas no router pai.
// Adicionar middleware específico para verificar se a conta é PJ/MEI, se necessário,
// mas a validação também está no serviço e no controller helper.

router.post('/', businessClientController.createBusinessClient);
router.get('/', businessClientController.getAllBusinessClients);
router.get('/:businessClientId', businessClientController.getBusinessClientById);
router.put('/:businessClientId', businessClientController.updateBusinessClient);
router.delete('/:businessClientId', businessClientController.deleteBusinessClient);

module.exports = router;
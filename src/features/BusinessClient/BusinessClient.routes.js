// src/features/BusinessClient/businessClient.routes.js
const { Router } = require('express');
const businessClientController = require('./BusinessClient.controller');

// Este router espera que :financialAccountId seja fornecido pela rota pai
const router = Router({ mergeParams: true });

// As rotas abaixo já estão sob o prefixo /financial-accounts/:financialAccountId/business-clients
router.post('/public/verify', businessClientController.verifyPublicClient);

// Rota para criar e listar clientes
// Caminho final: POST ou GET /financial-accounts/:financialAccountId/business-clients/
router.route('/')
    .post(businessClientController.createBusinessClient)
    .get(businessClientController.getAllBusinessClients);

// <<< MUDANÇA: Rota simplificada para detalhes do cliente >>>
// Caminho final: GET /financial-accounts/:financialAccountId/business-clients/:businessClientId/details
router.get('/:businessClientId/details', businessClientController.getDetails);

// <<< MUDANÇA: Rota simplificada para o histórico de agendamentos do cliente >>>
// Caminho final: GET /financial-accounts/:financialAccountId/business-clients/:businessClientId/appointments
router.get('/:businessClientId/appointments', businessClientController.getAppointmentHistory);

// Rotas para um cliente específico
// Caminho final: GET, PUT, DELETE /financial-accounts/:financialAccountId/business-clients/:businessClientId
router.route('/:businessClientId')
    .get(businessClientController.getBusinessClientById)
    .put(businessClientController.updateBusinessClient)
    .delete(businessClientController.deleteBusinessClient);

module.exports = router;
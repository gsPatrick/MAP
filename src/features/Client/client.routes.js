// src/features/Client/client.routes.js
const { Router } = require('express');
const clientController = require('./client.controller');
// const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware');

const router = Router();


router.get('/debug/all-clients', clientController.getClientsForDebug);
router.post('/debug/backfill-affiliate-codes', clientController.backfillAffiliateCodes);


// === Rotas para Client (Contatos do WhatsApp) ===
// router.use(authenticateToken); // Proteger todas as rotas de cliente

router.post('/', /*authorizeRole(['admin']),*/ clientController.createClientContact);
router.get('/', /*authorizeRole(['admin']),*/ clientController.getAllClientContacts);
router.get('/:clientId', /*authorizeRole(['admin']),*/ clientController.getClientContactById);
router.put('/:clientId', /*authorizeRole(['admin']),*/ clientController.updateClientContact);
router.delete('/:clientId', /*authorizeRole(['admin']),*/ clientController.deleteClientContact);


// === Rotas para FinancialAccounts (aninhadas sob um Client) ===
// Ex: /api/clients/:clientId/financial-accounts

// Criar uma nova conta financeira para um cliente
router.post('/:clientId/financial-accounts', /*authorizeRole(['admin']),*/ clientController.createFinancialAccount);

// Listar todas as contas financeiras de um cliente
router.get('/:clientId/financial-accounts', /*authorizeRole(['admin', 'owner_client']),*/ clientController.getClientFinancialAccounts);

// Obter uma conta financeira específica de um cliente
router.get('/:clientId/financial-accounts/:accountId', /*authorizeRole(['admin', 'owner_client']),*/ clientController.getFinancialAccountById);

// Atualizar uma conta financeira específica de um cliente
router.put('/:clientId/financial-accounts/:accountId', /*authorizeRole(['admin', 'owner_client']),*/ clientController.updateFinancialAccount);

// Deletar uma conta financeira específica de um cliente
router.delete('/:clientId/financial-accounts/:accountId', /*authorizeRole(['admin', 'owner_client']),*/ clientController.deleteFinancialAccount);


module.exports = router;
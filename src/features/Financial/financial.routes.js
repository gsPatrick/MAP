// src/features/Financial/financial.routes.js
const { Router } = require('express');
const financialController = require('./financial.controller');
// const { authenticateToken, authorizeFinancialAccountAccess } = require('../../middlewares/authMiddleware'); // Novo middleware

const router = Router({ mergeParams: true }); // mergeParams é importante para acessar :financialAccountId de um router pai

// Middleware para verificar se o usuário logado tem acesso à :financialAccountId (a ser criado)
// router.use(authenticateToken);
// router.use(authorizeFinancialAccountAccess); // Verifica se o user logado pode acessar esta financialAccountId

// Rotas de Transações aninhadas
router.post('/transactions', financialController.createTransaction);
router.post('/transactions/parcelled', financialController.createParcelledAccount);
router.get('/transactions', financialController.getAllTransactions);
router.get('/transactions/summary', financialController.getFinancialSummary);
// router.get('/transactions/export', financialController.exportTransactions);
router.get('/transactions/:transactionId', financialController.getTransactionById);
router.put('/transactions/:transactionId', financialController.updateTransaction);
router.patch('/transactions/:transactionId/settle', financialController.markAsPaidOrReceived);
router.delete('/transactions/:transactionId', financialController.deleteTransaction);

// TODO: Adicionar rotas para RecurringTransactionRule (ex: /recurring-rules)
// TODO: Adicionar rotas para CreditCard (ex: /credit-cards)
// Estas também seriam aninhadas sob /financial-accounts/:financialAccountId/

module.exports = router;
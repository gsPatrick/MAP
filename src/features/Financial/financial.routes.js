// src/features/Financial/financial.routes.js
const { Router } = require('express');
const financialController = require('./financial.controller');
// const { authenticateToken, authorizeFinancialAccountAccess } = require('../../middlewares/authMiddleware'); // Descomente se for usar

const router = Router({ mergeParams: true }); // mergeParams é importante para acessar :financialAccountId de um router pai

// Se você for aplicar middlewares específicos para todas as rotas financeiras aqui:
// router.use(authenticateToken); // Exemplo
// router.use(authorizeFinancialAccountAccess); // Exemplo

// Rotas para Transações (CRUD e outras)
// Estas rotas serão prefixadas com /financial-accounts/:financialAccountId/transactions/ devido à montagem no routes/index.js
router.post('/', financialController.createTransaction); // Rota final: .../transactions
router.post('/parcelled', financialController.createParcelledAccount); // Rota final: .../transactions/parcelled
router.get('/', financialController.getAllTransactions); // Rota final: .../transactions

// Rotas para Resumos e Dashboards
router.get('/summary', financialController.getFinancialSummary); // Rota final: .../transactions/summary
router.get('/dashboard/monthly-trend', financialController.getMonthlyTrend); // Rota final: .../transactions/dashboard/monthly-trend
router.get('/dashboard/expense-categories', financialController.getExpenseCategorySummary); // Rota final: .../transactions/dashboard/expense-categories

// Rotas para uma transação específica
router.get('/:transactionId', financialController.getTransactionById); // Rota final: .../transactions/:transactionId
router.put('/:transactionId', financialController.updateTransaction); // Rota final: .../transactions/:transactionId
router.patch('/:transactionId/settle', financialController.markAsPaidOrReceived); // Rota final: .../transactions/:transactionId/settle
router.delete('/:transactionId', financialController.deleteTransaction); // Rota final: .../transactions/:transactionId

module.exports = router;
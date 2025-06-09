// src/features/Financial/financial.routes.js
const { Router } = require('express');
const financialController = require('./financial.controller');

const router = Router(); // Não precisa mais de mergeParams aqui

// --- ROTAS PARA TRANSAÇÕES ESPECÍFICAS ---
// O prefixo /financial-accounts/:financialAccountId/ é adicionado no routes/index.js
// Estas rotas serão montadas sob /transactions

router.post('/', financialController.createTransaction);
router.get('/', financialController.getAllTransactions); // Este vai lidar com a listagem geral, incluindo 'dueAfter'
router.post('/parcelled', financialController.createParcelledAccount);

// Rotas para uma transação específica
router.get('/:transactionId', financialController.getTransactionById);
router.patch('/:transactionId', financialController.updateTransaction);
router.delete('/:transactionId', financialController.deleteTransaction);
router.post('/:transactionId/settle', financialController.markAsPaidOrReceived); 

module.exports = router;
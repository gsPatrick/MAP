// src/features/Financial/financial.routes.js
const { Router } = require('express');
const financialController = require('./financial.controller');

const router = Router(); // Não precisa mais de mergeParams aqui

// --- ROTAS PARA TRANSAÇÕES ESPECÍFICAS ---
// O prefixo /financial-accounts/:financialAccountId/ é adicionado no routes/index.js
// Estas rotas serão montadas sob /transactions

router.post('/', financialController.createTransaction);
router.get('/', financialController.getAllTransactions);
router.post('/parcelled', financialController.createParcelledAccount);

// Rotas para uma transação específica
router.get('/:transactionId', financialController.getTransactionById);
router.patch('/:transactionId', financialController.updateTransaction); // Usando PATCH para atualizações parciais
router.delete('/:transactionId', financialController.deleteTransaction);
router.post('/:transactionId/settle', financialController.markAsPaidOrReceived); // Rota para marcar como paga/recebida

module.exports = router;
// src/features/Financial/financial.routes.js
const { Router } = require('express');
const financialController = require('./financial.controller');

// A opção mergeParams: true é ESSENCIAL para que este router receba os parâmetros
// da rota pai onde ele é montado (neste caso, :financialAccountId de /financial-accounts/:financialAccountId)
const router = Router({ mergeParams: true });

// --- ROTAS PARA TRANSAÇÕES ESPECÍFICAS ---
// O prefixo /financial-accounts/:financialAccountId/ é adicionado no routes/index.js
// Estas rotas serão montadas sob /transactions

router.post('/', financialController.createTransaction);
router.get('/', financialController.getAllTransactions);
router.post('/parcelled', financialController.createParcelledAccount);

// Rotas para uma transação específica
router.get('/:transactionId', financialController.getTransactionById);
router.patch('/:transactionId', financialController.updateTransaction);
router.delete('/:transactionId', financialController.deleteTransaction);
router.post('/:transactionId/settle', financialController.markAsPaidOrReceived);
// ... outros imports e rotas ...

// Nova rota para buscar transações com filtros avançados
router.get('/transactions/filtered', financialController.getFilteredTransactions);

// ... o resto do arquivo ...

module.exports = router;
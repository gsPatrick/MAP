// src/features/RecurringTransaction/recurringTransaction.routes.js
const { Router } = require('express');
const recurringTransactionController = require('./recurringTransaction.controller');
// const { authenticateToken, authorizeFinancialAccountAccess } = require('../../middlewares/authMiddleware');

const router = Router({ mergeParams: true }); // mergeParams para acessar :financialAccountId da rota pai

// router.use(authenticateToken);
// router.use(authorizeFinancialAccountAccess); // Middleware para checar acesso à financialAccountId

router.post('/', recurringTransactionController.createRecurringRule);
router.get('/', recurringTransactionController.getAllRecurringRules);
router.get('/:ruleId', recurringTransactionController.getRecurringRuleById);
router.put('/:ruleId', recurringTransactionController.updateRecurringRule);
router.delete('/:ruleId', recurringTransactionController.deleteRecurringRule);

// NOVA ROTA
router.get('/:ruleId/history', recurringTransactionController.getRecurringRuleHistory);


module.exports = router;
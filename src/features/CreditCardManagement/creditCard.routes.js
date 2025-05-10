// src/features/CreditCardManagement/creditCard.routes.js
const { Router } = require('express');
const creditCardController = require('./creditCard.controller');
// const { authenticateToken, authorizeFinancialAccountAccess } = require('../../middlewares/authMiddleware');

const router = Router({ mergeParams: true }); // mergeParams para acessar :financialAccountId da rota pai

// router.use(authenticateToken);
// router.use(authorizeFinancialAccountAccess); // Middleware para checar acesso à financialAccountId

router.post('/', creditCardController.createCreditCard);
router.get('/', creditCardController.getAllCreditCards);
router.get('/:cardId', creditCardController.getCreditCardById);
router.put('/:cardId', creditCardController.updateCreditCard);
router.delete('/:cardId', creditCardController.deleteCreditCard);

module.exports = router;
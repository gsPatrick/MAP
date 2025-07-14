// src/features/CreditCardManagement/creditCard.routes.js
const { Router } = require('express');
const creditCardController = require('./creditCard.controller');
// const { authenticateToken, authorizeFinancialAccountAccess } = require('../../middlewares/authMiddleware');

const router = Router({ mergeParams: true }); // mergeParams para acessar :financialAccountId da rota pai

// router.use(authenticateToken);
// router.use(authorizeFinancialAccountAccess); // Middleware para checar acesso à financialAccountId

router.post('/', creditCardController.createCreditCard);
router.get('/', creditCardController.getAllCreditCards);

// Rotas específicas para um cartão
router.get('/:cardId', creditCardController.getCreditCardById);
router.put('/:cardId', creditCardController.updateCreditCard);
router.delete('/:cardId', creditCardController.deleteCreditCard);

// NOVAS ROTAS PARA FATURA E PERÍODOS
router.get('/:cardId/invoice', creditCardController.getCreditCardInvoiceDetails);
router.get('/:cardId/available-periods', creditCardController.getAvailableInvoicePeriods);
router.get('/:cardId/available-limit', creditCardController.getAvailableCreditLimit); // Rota para limite se não vier na listagem
router.post('/:cardId/pay-invoice', creditCardController.payCreditCardInvoice); // Rota para pagar fatura
router.post('/:cardId/settle-invoice', creditCardController.settleOpenCreditCardInvoice); // NOVA ROTA AQUI


module.exports = router;
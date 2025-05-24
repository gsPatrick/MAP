// src/features/FinancialCategory/financialCategory.routes.js
const { Router } = require('express');
const financialCategoryController = require('./financialCategory.controller'); // Criaremos este controller
// const { authenticateToken, authorizeFinancialAccountAccess } = require('../../middlewares/authMiddleware');

// Este router espera que :financialAccountId seja fornecido pela rota pai
const router = Router({ mergeParams: true });

// Aplicar middlewares de autenticação e autorização da conta financeira aqui
// router.use(authenticateToken); // Se for admin
// router.use(authenticateClientToken); // Se for client
// router.use(authorizeFinancialAccountAccess); // Garante que o usuário/cliente logado tem acesso à financialAccountId

router.post('/', financialCategoryController.createFinancialCategoryForAccount);
router.get('/', financialCategoryController.getAllFinancialCategoriesForAccount);
router.get('/:categoryId', financialCategoryController.getFinancialCategoryByIdForAccount);
router.put('/:categoryId', financialCategoryController.updateFinancialCategoryForAccount);
router.delete('/:categoryId', financialCategoryController.deleteFinancialCategoryForAccount);

module.exports = router;
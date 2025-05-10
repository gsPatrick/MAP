// src/features/Product/product.routes.js
const { Router } = require('express');
const productController = require('./product.controller');
// const { authenticateToken, authorizeFinancialAccountAccess } = require('../../middlewares/authMiddleware');

const router = Router({ mergeParams: true }); // mergeParams para acessar :financialAccountId

// router.use(authenticateToken);
// router.use(authorizeFinancialAccountAccess); // Middleware para checar acesso à financialAccountId

router.post('/', productController.createProduct);
router.get('/', productController.getAllProducts);
router.get('/:productId', productController.getProductById);
router.put('/:productId', productController.updateProduct);
router.delete('/:productId', productController.deleteProduct);

module.exports = router;
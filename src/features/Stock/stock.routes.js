// src/features/Stock/stock.routes.js
const { Router } = require('express');
const stockController = require('./stock.controller');
// const productController = require('../Product/product.controller'); // Se o saldo for exposto via product routes
// const { authenticateToken, authorizeFinancialAccountAccessByProductId } = require('../../middlewares/authMiddleware'); // Novo middleware

const router = Router({ mergeParams: true }); // mergeParams pode ser útil se aninhado

// Este router será montado de forma um pouco diferente no index.js
// Para POST /api/products/:productId/stock-movements
// Para GET /api/stock/movements (global com filtros)
// Para GET /api/products/:productId/balance (já feito)

// Rota para registrar movimentação para um produto específico.
// Será montada sob /products/:productId/stock-movements no index.js
// Ex: POST /api/products/123/stock-movements
router.post('/', /* authorizeFinancialAccountAccessByProductId, */ stockController.recordStockMovement);


// Rota para listar todas as movimentações de estoque
// Será montada como /api/stock/movements no index.js
// GET /api/stock/movements?financialAccountId=1&productId=2&type=Entrada
// Esta rota está "solta" e não aninhada para permitir filtros mais globais.
// Se quiser aninhar, seria /api/financial-accounts/:financialAccountId/stock-movements
const globalStockRouter = Router();
globalStockRouter.get('/movements', stockController.getStockMovements);


// Rota para obter o saldo de um produto específico
// Será montada como /api/products/:productId/balance no index.js
// GET /api/products/123/balance
router.get('/balance', stockController.getProductStockBalance); // Note que o :productId virá do router pai


// Exportamos o router que será aninhado e o router global separadamente
module.exports = {
    productStockRouter: router, // Para /products/:productId/stock-movements e /products/:productId/balance
    globalStockRouter      // Para /stock/movements
};
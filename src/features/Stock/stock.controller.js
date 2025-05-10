// src/features/Stock/stock.controller.js
const stockService = require('./stock.service');
const logger = require('../../utils/logger');

async function recordStockMovement(req, res, next) {
  try {
    const productId = parseInt(req.params.productId, 10); // productId da rota
    if (isNaN(productId)) {
        const error = new Error('ID do Produto inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const movementData = req.body; // { type, quantity, reason, movementDate, relatedTransactionId }
    if (!movementData.type || !movementData.quantity) {
        const error = new Error('Tipo e Quantidade são obrigatórios no corpo da requisição.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }

    const newMovement = await stockService.recordStockMovement(productId, movementData);
    res.status(201).json({ status: 'success', data: newMovement });
  } catch (error) {
    next(error);
  }
}

async function getStockMovements(req, res, next) {
  try {
    // queryParams pode incluir productId, financialAccountId, type, dateStart, dateEnd
    const result = await stockService.getStockMovements(req.query);
    res.status(200).json({ status: 'success', ...result });
  } catch (error) {
    next(error);
  }
}

async function getProductStockBalance(req, res, next) {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) {
        const error = new Error('ID do Produto inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const balanceData = await stockService.getProductStockBalance(productId);
    if (!balanceData) { // Serviço já lança erro 404 se produto não existe
        const error = new Error('Produto não encontrado para consulta de saldo.');
        error.statusCode = 404; error.status = 'fail'; return next(error);
    }
    res.status(200).json({ status: 'success', data: balanceData });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  recordStockMovement,
  getStockMovements,
  getProductStockBalance,
};
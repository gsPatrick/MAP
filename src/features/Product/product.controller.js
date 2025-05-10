// src/features/Product/product.controller.js
const productService = require('./product.service');
const logger = require('../../utils/logger');

function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id)) {
        const error = new Error('ID da Conta Financeira inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function createProduct(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    // Adicionar validação de schema para req.body
    const newProduct = await productService.createProduct(financialAccountId, req.body);
    res.status(201).json({ status: 'success', data: newProduct });
  } catch (error) {
    next(error);
  }
}

async function getAllProducts(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const result = await productService.getAllProducts(financialAccountId, req.query);
    res.status(200).json({ status: 'success', ...result });
  } catch (error) {
    next(error);
  }
}

async function getProductById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const productId = parseInt(req.params.productId, 10); // productId da sub-rota
    if (isNaN(productId)) { /* ... erro 400 ... */ }
    const product = await productService.getProductById(financialAccountId, productId);
    if (!product) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: product });
  } catch (error) {
    next(error);
  }
}

async function updateProduct(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) { /* ... erro 400 ... */ }
    if (Object.keys(req.body).length === 0) { /* ... erro 400 ... */ }
    const updatedProduct = await productService.updateProduct(financialAccountId, productId, req.body);
    if (!updatedProduct) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: updatedProduct });
  } catch (error) {
    next(error);
  }
}

async function deleteProduct(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const productId = parseInt(req.params.productId, 10);
    if (isNaN(productId)) { /* ... erro 400 ... */ }
    const success = await productService.deleteProduct(financialAccountId, productId);
    if (!success) { /* ... erro 404 ... */ }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
};
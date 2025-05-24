// src/features/FinancialCategory/financialCategory.controller.js
const financialCategoryService = require('./financialCategory.service');
const logger = require('../../utils/logger');

// Helper para obter financialAccountId da rota pai
function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id)) {
        const error = new Error('ID da Conta Financeira inválido na rota para categorias.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function createFinancialCategoryForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const { name, type, parentId } = req.body;
        if (!name || !type) {
            const error = new Error('Nome e Tipo são obrigatórios para criar a categoria.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        const category = await financialCategoryService.createFinancialCategory(financialAccountId, { name, type, parentId });
        res.status(201).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function getAllFinancialCategoriesForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const { hierarchical, onlyTopLevel, type } = req.query;
        const options = {
            hierarchical: hierarchical === 'true',
            onlyTopLevel: onlyTopLevel === 'true',
            type: type // Passa o tipo para o service
        };
        // O service não usa mais `isActive` para FinancialCategory, então removemos daqui.
        const categories = await financialCategoryService.getAllFinancialCategories(financialAccountId, options);
        res.status(200).json({ status: 'success', data: categories });
    } catch (error) { next(error); }
}

async function getFinancialCategoryByIdForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const categoryId = parseInt(req.params.categoryId, 10);
        if (isNaN(categoryId)) { /* ... erro 400 ... */ }
        const category = await financialCategoryService.getFinancialCategoryById(financialAccountId, categoryId);
        if (!category) { /* ... erro 404 ... */ }
        res.status(200).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function updateFinancialCategoryForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const categoryId = parseInt(req.params.categoryId, 10);
        if (isNaN(categoryId)) { /* ... erro 400 ... */ }
        if (Object.keys(req.body).length === 0) { /* ... erro 400 ... */ }
        const { name, type, parentId } = req.body; // isActive e isDefault removidos
        const category = await financialCategoryService.updateFinancialCategory(financialAccountId, categoryId, { name, type, parentId });
        if (!category) { /* ... erro 404 ... */ }
        res.status(200).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function deleteFinancialCategoryForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const categoryId = parseInt(req.params.categoryId, 10);
        if (isNaN(categoryId)) { /* ... erro 400 ... */ }
        
        const { 
            actionForSubcategories = 'restrict',
            actionForTransactions = 'set_null',  
            reassignToCategoryId = null 
        } = req.query;

        const success = await financialCategoryService.deleteFinancialCategory(financialAccountId, categoryId, {
            actionForSubcategories,
            actionForTransactions,
            reassignToCategoryId: reassignToCategoryId ? parseInt(reassignToCategoryId, 10) : null
        });
        if (!success) { /* ... erro 404 ... */ }
        res.status(204).send();
    } catch (error) { next(error); }
}

module.exports = {
    createFinancialCategoryForAccount,
    getAllFinancialCategoriesForAccount,
    getFinancialCategoryByIdForAccount,
    updateFinancialCategoryForAccount,
    deleteFinancialCategoryForAccount,
};
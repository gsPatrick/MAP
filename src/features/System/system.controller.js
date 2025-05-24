// src/features/FinancialCategory/financialCategory.controller.js
const financialCategoryService = require('./financialCategory.service');
const logger = require('../../utils/logger');

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
        const { name, parentId } = req.body; // Removido 'type'
        if (!name) { // Apenas nome é obrigatório agora
            const error = new Error('Nome é obrigatório para criar a categoria.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        // 'type' não é mais enviado para o serviço
        const category = await financialCategoryService.createFinancialCategory(financialAccountId, { name, parentId });
        res.status(201).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function getAllFinancialCategoriesForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const { hierarchical, onlyTopLevel /*, type (removido) */ } = req.query;
        const options = {
            hierarchical: hierarchical === 'true',
            onlyTopLevel: onlyTopLevel === 'true',
            // type removido
        };
        const categories = await financialCategoryService.getAllFinancialCategories(financialAccountId, options);
        res.status(200).json({ status: 'success', data: categories });
    } catch (error) { next(error); }
}

async function getFinancialCategoryByIdForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const categoryId = parseInt(req.params.categoryId, 10);
        if (isNaN(categoryId)) {
            const error = new Error('ID da categoria inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        const category = await financialCategoryService.getFinancialCategoryById(financialAccountId, categoryId);
        if (!category) {
            const error = new Error('Categoria financeira não encontrada.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
        }
        res.status(200).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function updateFinancialCategoryForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const categoryId = parseInt(req.params.categoryId, 10);
        if (isNaN(categoryId)) {
            const error = new Error('ID da categoria inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        if (Object.keys(req.body).length === 0) {
            const error = new Error('Nenhum dado fornecido para atualização.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        const { name, parentId } = req.body; // Removido 'type'
        const category = await financialCategoryService.updateFinancialCategory(financialAccountId, categoryId, { name, parentId });
        if (!category) { // O serviço lança erro 404 se não encontrar
             const error = new Error('Categoria financeira não encontrada para atualização.');
             error.statusCode = 404; error.status = 'fail'; return next(error);
        }
        res.status(200).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function deleteFinancialCategoryForAccount(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const categoryId = parseInt(req.params.categoryId, 10);
        if (isNaN(categoryId)) {
            const error = new Error('ID da categoria inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        
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
        // O serviço agora lança erro 404 se não encontrar, então não precisa checar 'success' aqui.
        res.status(204).send();
    } catch (error) { 
        next(error); 
    }
}

module.exports = {
    createFinancialCategoryForAccount,
    getAllFinancialCategoriesForAccount,
    getFinancialCategoryByIdForAccount,
    updateFinancialCategoryForAccount,
    deleteFinancialCategoryForAccount,
};
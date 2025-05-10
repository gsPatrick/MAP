// src/features/System/system.controller.js
const systemService = require('./system.service');
const logger = require('../../utils/logger');

async function getSystemPreferences(req, res, next) {
  try {
    const preferences = await systemService.getSystemPreferences();
    res.status(200).json({ status: 'success', data: preferences });
  } catch (error) {
    next(error);
  }
}

async function updateSystemPreferences(req, res, next) {
  try {
    if (Object.keys(req.body).length === 0) {
        const error = new Error('Nenhum dado fornecido para atualização das preferências.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const updatedPreferences = await systemService.updateSystemPreferences(req.body);
    res.status(200).json({ status: 'success', data: updatedPreferences });
  } catch (error) {
    next(error);
  }
}

// --- Financial Category Controllers (ATUALIZADO) ---
async function createFinancialCategory(req, res, next) {
    try {
        const { name, type, parentId, isDefault, isActive } = req.body;
        // Adicionar validação de schema aqui (ex: Joi)
        if (!name || !type) {
            const error = new Error('Nome e Tipo são obrigatórios.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        const category = await systemService.createFinancialCategory({ name, type, parentId, isDefault, isActive });
        res.status(201).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function getAllFinancialCategories(req, res, next) {
    try {
        // Query params: hierarchical=true/false, onlyTopLevel=true/false, isActive=true/false
        const { hierarchical, onlyTopLevel, isActive } = req.query;
        const options = {
            hierarchical: hierarchical === 'true',
            onlyTopLevel: onlyTopLevel === 'true',
            isActive: isActive // undefined, 'true', ou 'false'
        };
        if (isActive !== undefined) options.isActive = (isActive === 'true');

        const categories = await systemService.getAllFinancialCategories(options);
        res.status(200).json({ status: 'success', data: categories });
    } catch (error) { next(error); }
}

async function getFinancialCategoryById(req, res, next) {
    try {
        const categoryId = parseInt(req.params.id, 10);
        if (isNaN(categoryId)) {
            const error = new Error('ID da categoria inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        const category = await systemService.getFinancialCategoryById(categoryId);
        if (!category) {
            const error = new Error('Categoria financeira não encontrada.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
        }
        res.status(200).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function updateFinancialCategory(req, res, next) {
    try {
        const categoryId = parseInt(req.params.id, 10);
        if (isNaN(categoryId)) {
            const error = new Error('ID da categoria inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        if (Object.keys(req.body).length === 0) {
            const error = new Error('Nenhum dado fornecido para atualização.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        const { name, type, parentId, isActive, isDefault } = req.body;
        const category = await systemService.updateFinancialCategory(categoryId, { name, type, parentId, isActive, isDefault });
        res.status(200).json({ status: 'success', data: category });
    } catch (error) { next(error); }
}

async function deleteFinancialCategory(req, res, next) {
    try {
        const categoryId = parseInt(req.params.id, 10);
        if (isNaN(categoryId)) {
            const error = new Error('ID da categoria inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        
        const { 
            actionForSubcategories = 'restrict',
            actionForTransactions = 'restrict',  
            reassignToCategoryId = null 
        } = req.query; // Pegando opções da query string

        const success = await systemService.deleteFinancialCategory(categoryId, {
            actionForSubcategories,
            actionForTransactions,
            reassignToCategoryId: reassignToCategoryId ? parseInt(reassignToCategoryId, 10) : null
        });

        if (!success) { // O serviço retorna false se não encontrou ANTES de tentar deletar.
            const error = new Error('Categoria financeira não encontrada para exclusão.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
        }
        res.status(204).send();
    } catch (error) { 
        // Erros de conflito (409) ou outros erros do serviço serão passados para o errorHandler
        next(error); 
    }
}

// --- Motivational Phrase Controllers (Permanece o mesmo) ---
async function createMotivationalPhrase(req, res, next) { /* ...código anterior... */ }
async function getAllMotivationalPhrases(req, res, next) { /* ...código anterior... */ }
async function updateMotivationalPhrase(req, res, next) { /* ...código anterior... */ }
async function deleteMotivationalPhrase(req, res, next) { /* ...código anterior... */ }
// (Cole os códigos das funções de MotivationalPhrase aqui, eles não mudam)
// COPIANDO AS FUNÇÕES DE MOTIVATIONALPHRASE PARA COMPLETUDE DO ARQUIVO:
async function createMotivationalPhrase(req, res, next) {
    try {
        const phrase = await systemService.createMotivationalPhrase(req.body);
        res.status(201).json({ status: 'success', data: phrase });
    } catch (error) { next(error); }
}
async function getAllMotivationalPhrases(req, res, next) {
    try {
        const phrases = await systemService.getAllMotivationalPhrases(req.query);
        res.status(200).json({ status: 'success', data: phrases });
    } catch (error) { next(error); }
}
async function updateMotivationalPhrase(req, res, next) {
    try {
        const phraseId = parseInt(req.params.id, 10);
         if (isNaN(phraseId)) { 
            const error = new Error('ID da frase inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
         }
        const phrase = await systemService.updateMotivationalPhrase(phraseId, req.body);
         if (!phrase) {
            const error = new Error('Frase não encontrada.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
         }
        res.status(200).json({ status: 'success', data: phrase });
    } catch (error) { next(error); }
}
async function deleteMotivationalPhrase(req, res, next) {
    try {
        const phraseId = parseInt(req.params.id, 10);
         if (isNaN(phraseId)) { 
            const error = new Error('ID da frase inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
         }
        const success = await systemService.deleteMotivationalPhrase(phraseId);
        if (!success) { 
            const error = new Error('Frase não encontrada.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
         }
        res.status(204).send();
    } catch (error) { next(error); }
}


module.exports = {
  getSystemPreferences,
  updateSystemPreferences,
  createFinancialCategory,
  getAllFinancialCategories,
  getFinancialCategoryById,
  updateFinancialCategory,
  deleteFinancialCategory,
  createMotivationalPhrase,
  getAllMotivationalPhrases,
  updateMotivationalPhrase,
  deleteMotivationalPhrase,
};
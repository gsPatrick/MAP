// src/features/System/system.controller.js
const systemService = require('./system.service');
const logger = require('../../utils/logger'); // Supondo que você tenha um logger

// --- Preferências do Sistema ---
async function getSystemPreferences(req, res, next) {
    try {
        const preferences = await systemService.getSystemPreferences();
        res.status(200).json({ status: 'success', data: preferences });
    } catch (error) {
        logger.error(`[SystemController] Erro em getSystemPreferences: ${error.message}`);
        next(error);
    }
}

async function updateSystemPreferences(req, res, next) {
    try {
        const updatedPreferences = await systemService.updateSystemPreferences(req.body);
        res.status(200).json({ status: 'success', data: updatedPreferences });
    } catch (error) {
        logger.error(`[SystemController] Erro em updateSystemPreferences: ${error.message}`);
        next(error);
    }
}

// --- Frases Motivacionais ---
async function createMotivationalPhrase(req, res, next) {
    try {
        const { text, isActive } = req.body;
        if (!text) {
            const error = new Error('Texto é obrigatório para criar a frase motivacional.');
            error.statusCode = 400; error.status = 'fail';
            return next(error);
        }
        const phrase = await systemService.createMotivationalPhrase({ text, isActive });
        res.status(201).json({ status: 'success', data: phrase });
    } catch (error) {
        logger.error(`[SystemController] Erro em createMotivationalPhrase: ${error.message}`);
        next(error);
    }
}

async function getAllMotivationalPhrases(req, res, next) {
    try {
        const { isActive } = req.query; // Captura o parâmetro de query
        const phrases = await systemService.getAllMotivationalPhrases({ isActive });
        res.status(200).json({ status: 'success', data: phrases });
    } catch (error) {
        logger.error(`[SystemController] Erro em getAllMotivationalPhrases: ${error.message}`);
        next(error);
    }
}

async function updateMotivationalPhrase(req, res, next) {
    try {
        const phraseId = parseInt(req.params.id, 10);
        if (isNaN(phraseId)) {
            const error = new Error('ID da frase motivacional inválido.');
            error.statusCode = 400; error.status = 'fail';
            return next(error);
        }
        const { text, isActive } = req.body;
        if (Object.keys(req.body).length === 0) {
             const error = new Error('Nenhum dado fornecido para atualização.');
            error.statusCode = 400; error.status = 'fail';
            return next(error);
        }
        const updatedPhrase = await systemService.updateMotivationalPhrase(phraseId, { text, isActive });
        // O serviço já lida com o caso de "não encontrado" lançando um erro 404
        res.status(200).json({ status: 'success', data: updatedPhrase });
    } catch (error) {
        logger.error(`[SystemController] Erro em updateMotivationalPhrase: ${error.message}`);
        next(error);
    }
}

async function deleteMotivationalPhrase(req, res, next) {
    try {
        const phraseId = parseInt(req.params.id, 10);
        if (isNaN(phraseId)) {
            const error = new Error('ID da frase motivacional inválido.');
            error.statusCode = 400; error.status = 'fail';
            return next(error);
        }
        const success = await systemService.deleteMotivationalPhrase(phraseId);
        if (!success) { // Embora o serviço possa não retornar false se lançar erro 404
            const error = new Error('Frase motivacional não encontrada para exclusão.');
            error.statusCode = 404; error.status = 'fail';
            return next(error);
        }
        res.status(204).send();
    } catch (error) {
        logger.error(`[SystemController] Erro em deleteMotivationalPhrase: ${error.message}`);
        next(error);
    }
}

module.exports = {
    getSystemPreferences,
    updateSystemPreferences,
    createMotivationalPhrase,
    getAllMotivationalPhrases,
    updateMotivationalPhrase,
    deleteMotivationalPhrase,
};
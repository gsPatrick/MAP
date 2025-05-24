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

// --- Financial Category Controllers - REMOVIDOS DESTE ARQUIVO ---

// --- Motivational Phrase Controllers ---
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
         if (!phrase) { // O service agora retorna null se não encontrar ou lança erro
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
            const error = new Error('Frase não encontrada para exclusão.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
         }
        res.status(204).send();
    } catch (error) { next(error); }
}


module.exports = {
  getSystemPreferences,
  updateSystemPreferences,
  // Controllers de FinancialCategory removidos daqui
  createMotivationalPhrase,
  getAllMotivationalPhrases,
  updateMotivationalPhrase,
  deleteMotivationalPhrase,
};
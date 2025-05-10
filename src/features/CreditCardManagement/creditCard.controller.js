// src/features/CreditCardManagement/creditCard.controller.js
const creditCardService = require('./creditCard.service');
const logger = require('../../utils/logger');

function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id)) {
        const error = new Error('ID da Conta Financeira inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function createCreditCard(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    // Adicionar validação de schema robusta para req.body
    const { name, limit, closingDay, paymentDay } = req.body;
    if(!name || limit === undefined || !closingDay || !paymentDay){
        const error = new Error('Campos obrigatórios (name, limit, closingDay, paymentDay) não fornecidos.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const newCard = await creditCardService.createCreditCard(financialAccountId, req.body);
    res.status(201).json({ status: 'success', data: newCard });
  } catch (error) {
    next(error);
  }
}

async function getAllCreditCards(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cards = await creditCardService.getAllCreditCards(financialAccountId, req.query);
    res.status(200).json({ status: 'success', data: cards });
  } catch (error) {
    next(error);
  }
}

async function getCreditCardById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = parseInt(req.params.cardId, 10);
    if (isNaN(cardId)) {
        const error = new Error('ID do Cartão de Crédito inválido.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const card = await creditCardService.getCreditCardById(financialAccountId, cardId);
    if (!card) {
      const error = new Error('Cartão de Crédito não encontrado.');
      error.statusCode = 404; error.status = 'fail'; return next(error);
    }
    res.status(200).json({ status: 'success', data: card });
  } catch (error) {
    next(error);
  }
}

async function updateCreditCard(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = parseInt(req.params.cardId, 10);
    if (isNaN(cardId)) { /* ... erro 400 ... */ }
    if (Object.keys(req.body).length === 0) { /* ... erro 400 ... */ }

    const updatedCard = await creditCardService.updateCreditCard(financialAccountId, cardId, req.body);
    if (!updatedCard) { // Serviço retorna null se não encontrar
      const error = new Error('Cartão de Crédito não encontrado para atualização.');
      error.statusCode = 404; error.status = 'fail'; return next(error);
    }
    res.status(200).json({ status: 'success', data: updatedCard });
  } catch (error) {
    next(error);
  }
}

async function deleteCreditCard(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = parseInt(req.params.cardId, 10);
    if (isNaN(cardId)) { /* ... erro 400 ... */ }

    const success = await creditCardService.deleteCreditCard(financialAccountId, cardId);
    if (!success) {
      const error = new Error('Cartão de Crédito não encontrado para exclusão.');
      error.statusCode = 404; error.status = 'fail'; return next(error);
    }
    res.status(204).send();
  } catch (error) {
    // Erros de conflito (409 se o cartão estiver em uso) serão passados pelo service
    next(error);
  }
}

module.exports = {
  createCreditCard,
  getAllCreditCards,
  getCreditCardById,
  updateCreditCard,
  deleteCreditCard,
};
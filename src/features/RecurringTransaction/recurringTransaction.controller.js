// src/features/RecurringTransaction/recurringTransaction.controller.js
const recurringTransactionService = require('./recurringTransaction.service');
const logger = require('../../utils/logger');

function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id)) {
        const error = new Error('ID da Conta Financeira inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function createRecurringRule(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    // Adicionar validação de schema robusta para req.body aqui
    const newRule = await recurringTransactionService.createRecurringRule(financialAccountId, req.body);
    res.status(201).json({ status: 'success', data: newRule });
  } catch (error) {
    next(error);
  }
}

async function getAllRecurringRules(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const rules = await recurringTransactionService.getAllRecurringRules(financialAccountId, req.query);
    res.status(200).json({ status: 'success', data: rules });
  } catch (error) {
    next(error);
  }
}

async function getRecurringRuleById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const ruleId = parseInt(req.params.ruleId, 10);
    if (isNaN(ruleId)) {
        const error = new Error('ID da Regra de Recorrência inválido.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    // Novo parâmetro para o service
    const includeHistory = req.query.includeHistory === 'true';
    const rule = await recurringTransactionService.getRecurringRuleById(financialAccountId, ruleId, includeHistory);

    if (!rule) {
      const error = new Error('Regra de recorrência não encontrada.');
      error.statusCode = 404; error.status = 'fail'; return next(error);
    }
    res.status(200).json({ status: 'success', data: rule });
  } catch (error) {
    next(error);
  }
}

async function updateRecurringRule(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const ruleId = parseInt(req.params.ruleId, 10);
    if (isNaN(ruleId)) { /* ... erro 400 ... */ }
    if (Object.keys(req.body).length === 0) { /* ... erro 400 ... */ }

    const updatedRule = await recurringTransactionService.updateRecurringRule(financialAccountId, ruleId, req.body);
    if (!updatedRule) { // Serviço retorna null se não encontrar
      const error = new Error('Regra de recorrência não encontrada para atualização.');
      error.statusCode = 404; error.status = 'fail'; return next(error);
    }
    res.status(200).json({ status: 'success', data: updatedRule });
  } catch (error) {
    next(error);
  }
}

async function deleteRecurringRule(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const ruleId = parseInt(req.params.ruleId, 10);
    if (isNaN(ruleId)) { /* ... erro 400 ... */ }

    const success = await recurringTransactionService.deleteRecurringRule(financialAccountId, ruleId);
    if (!success) {
      const error = new Error('Regra de recorrência não encontrada para exclusão.');
      error.statusCode = 404; error.status = 'fail'; return next(error);
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

// NOVO CONTROLLER
async function getRecurringRuleHistory(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const ruleId = parseInt(req.params.ruleId, 10);
    if (isNaN(ruleId)) {
        const error = new Error('ID da Regra de Recorrência inválido.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const result = await recurringTransactionService.getRecurringRuleHistory(financialAccountId, ruleId, req.query);
    res.status(200).json({ status: 'success', ...result });
  } catch (error) {
    next(error);
  }
}

async function payRecurringRuleInAdvance(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const ruleId = parseInt(req.params.ruleId, 10);
    if (isNaN(ruleId)) {
      const error = new Error('ID da Regra de Recorrência inválido.');
      error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const result = await recurringTransactionService.payRecurringRuleInAdvance(financialAccountId, ruleId, req.body?.paymentDate);
    res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createRecurringRule,
  getAllRecurringRules,
  getRecurringRuleById,
  updateRecurringRule,
  deleteRecurringRule,
  getRecurringRuleHistory, // <<< EXPORTADO
  payRecurringRuleInAdvance,
};
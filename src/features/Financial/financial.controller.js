// src/features/Financial/financial.controller.js
const financialService = require('./financial.service');
const logger = require('../../utils/logger'); // Para logs no controller se necessário





// Helper para validar e extrair financialAccountId da rota
function getFinancialAccountIdFromRequest(req, paramName = 'financialAccountId') {
    const id = parseInt(req.params[paramName], 10);
    if (isNaN(id)) {
        const error = new Error(`ID da Conta Financeira (${paramName}) inválido na rota.`);
        error.statusCode = 400; error.status = 'fail';
        throw error;
    }
    return id;
}


async function createTransaction(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const transactionData = req.body;
    const newTransaction = await financialService.createTransaction(financialAccountId, transactionData);
    res.status(201).json({ status: 'success', data: newTransaction });
  } catch (error) {
    next(error);
  }
}

async function createParcelledAccount(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const accountData = req.body;
    const result = await financialService.createParcelledAccount(financialAccountId, accountData);
    res.status(201).json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

async function getAllTransactions(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const result = await financialService.getAllTransactions(financialAccountId, req.query);
    res.status(200).json({ status: 'success', ...result });
  } catch (error) {
    next(error);
  }
}

async function getTransactionById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const transactionId = parseInt(req.params.transactionId, 10);
    if (isNaN(transactionId)) { /* ... erro 400 ... */ }
    const transaction = await financialService.getTransactionById(financialAccountId, transactionId);
    if (!transaction) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: transaction });
  } catch (error) {
    next(error);
  }
}

async function updateTransaction(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const transactionId = parseInt(req.params.transactionId, 10);
    if (isNaN(transactionId)) { /* ... erro 400 ... */ }
    if (Object.keys(req.body).length === 0) { /* ... erro 400 ... */ }
    const updatedTransaction = await financialService.updateTransaction(financialAccountId, transactionId, req.body);
    if (!updatedTransaction) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: updatedTransaction });
  } catch (error) {
    next(error);
  }
}

async function markAsPaidOrReceived(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const transactionId = parseInt(req.params.transactionId, 10);
    if (isNaN(transactionId)) { /* ... erro 400 ... */ }
    const { paymentDate } = req.body;
    const updatedTransaction = await financialService.markAsPaidOrReceived(financialAccountId, transactionId, paymentDate);
    if (!updatedTransaction) { /* ... erro 404 ou 400 (não é conta) ... */ }
    res.status(200).json({ status: 'success', data: updatedTransaction });
  } catch (error) {
    next(error);
  }
}

async function deleteTransaction(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const transactionId = parseInt(req.params.transactionId, 10);
    if (isNaN(transactionId)) { /* ... erro 400 ... */ }
    const success = await financialService.deleteTransaction(financialAccountId, transactionId);
    if (!success) { /* ... erro 404 ... */ }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

async function getFinancialSummary(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const summary = await financialService.getFinancialSummary(financialAccountId, req.query);
    res.status(200).json({ status: 'success', data: summary });
  } catch (error) {
    next(error);
  }
}

async function getMonthlyTrend(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const numberOfMonths = req.query.months ? parseInt(req.query.months, 10) : 6;
    if (isNaN(numberOfMonths) || numberOfMonths <= 0) {
        const error = new Error("Parâmetro 'months' deve ser um número positivo.");
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const trendData = await financialService.getMonthlyTrend(financialAccountId, numberOfMonths);
    res.status(200).json({ status: 'success', data: trendData });
  } catch (error) {
    next(error);
  }
}

async function getExpenseCategorySummary(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const { dateStart, dateEnd } = req.query; // Espera YYYY-MM-DD
    
    // Validação básica de datas (pode ser mais robusta com bibliotecas como Joi)
    if ((dateStart && !/^\d{4}-\d{2}-\d{2}$/.test(dateStart)) || (dateEnd && !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd))) {
        const error = new Error("Formato de data inválido. Use YYYY-MM-DD.");
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const summaryData = await financialService.getExpenseCategorySummary(financialAccountId, dateStart, dateEnd);
    res.status(200).json({ status: 'success', data: summaryData });
  } catch (error) {
    next(error);
  }
}

async function getIncomeCategorySummary(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const { dateStart, dateEnd } = req.query;

    if ((dateStart && !/^\d{4}-\d{2}-\d{2}$/.test(dateStart)) || (dateEnd && !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd))) {
        const error = new Error("Formato de data inválido. Use YYYY-MM-DD.");
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    // Assumindo que você já adicionou a função no service.js conforme a instrução anterior
    const summaryData = await financialService.getIncomeCategorySummary(financialAccountId, dateStart, dateEnd);
    res.status(200).json({ status: 'success', data: summaryData });
  } catch (error) {
    next(error);
  }
}




// TODO: Adicionar controllers para RecurringTransactionRule e CreditCard

module.exports = {
  createTransaction,
  createParcelledAccount,
  getAllTransactions,
  getTransactionById,
  updateTransaction,
  markAsPaidOrReceived,
  deleteTransaction,
  getFinancialSummary,
  getMonthlyTrend,
  getExpenseCategorySummary,
  getIncomeCategorySummary
  // ... controllers para RecurringTransactionRule e CreditCard
};
// src/features/CreditCardManagement/creditCard.controller.js
const creditCardService = require('./creditCard.service');
const logger = require('../../utils/logger');

function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id) || id <= 0) { // Adicionada checagem para id > 0
        const error = new Error('ID da Conta Financeira inválido ou não fornecido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

function getCardIdFromRequest(req) {
    const id = parseInt(req.params.cardId, 10);
    if (isNaN(id) || id <= 0) { // Adicionada checagem para id > 0
        const error = new Error('ID do Cartão de Crédito inválido ou não fornecido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function createCreditCard(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    // Validações básicas dos campos obrigatórios já estão no service
    const newCard = await creditCardService.createCreditCard(financialAccountId, req.body);
    res.status(201).json({ status: 'success', data: newCard });
  } catch (error) {
    next(error);
  }
}

async function getAllCreditCards(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const result = await creditCardService.getAllCreditCards(financialAccountId, req.query);
    res.status(200).json({ status: 'success', data: result.cards, totalItems: result.totalItems }); // Ajustado para retornar cards e totalItems
  } catch (error) {
    next(error);
  }
}

async function getCreditCardById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = getCardIdFromRequest(req);
    const card = await creditCardService.getCreditCardById(financialAccountId, cardId);
    res.status(200).json({ status: 'success', data: card });
  } catch (error) {
    next(error);
  }
}

async function updateCreditCard(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = getCardIdFromRequest(req);
    if (Object.keys(req.body).length === 0) { 
        const error = new Error('Nenhum dado fornecido para atualização.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const updatedCard = await creditCardService.updateCreditCard(financialAccountId, cardId, req.body);
    res.status(200).json({ status: 'success', data: updatedCard });
  } catch (error) {
    next(error);
  }
}

async function deleteCreditCard(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = getCardIdFromRequest(req);
    await creditCardService.deleteCreditCard(financialAccountId, cardId); // Service já lança erro se não sucesso
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

async function getCreditCardInvoiceDetails(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = getCardIdFromRequest(req);
    const { type, month, year } = req.query;

    const periodOptions = { type: type || 'aberta' };
    if (periodOptions.type === 'especifico') {
      if (!month || !year || isNaN(parseInt(month)) || isNaN(parseInt(year))) {
        const error = new Error('Para fatura de período específico, "month" (1-12) e "year" (AAAA) são obrigatórios na query.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
      }
      periodOptions.month = parseInt(month, 10);
      periodOptions.year = parseInt(year, 10);
    }

    const invoiceDetails = await creditCardService.getCreditCardInvoiceDetails(financialAccountId, cardId, periodOptions);
    res.status(200).json({ status: 'success', data: invoiceDetails });
  } catch (error) {
    next(error);
  }
}

async function getAvailableInvoicePeriods(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = getCardIdFromRequest(req);
    const periods = await creditCardService.getAvailableInvoicePeriods(financialAccountId, cardId);
    res.status(200).json({ status: 'success', data: periods });
  } catch (error) {
    next(error);
  }
}

async function getAvailableCreditLimit(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const cardId = getCardIdFromRequest(req);
        const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, cardId);
        res.status(200).json({ status: 'success', data: limitInfo });
    } catch (error) {
        next(error);
    }
}

async function payCreditCardInvoice(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountIdFromRequest(req);
        const cardId = getCardIdFromRequest(req);
        const { paymentAmount, paymentDate, originatingAccountDescription, financialCategoryId } = req.body;

        if (!paymentAmount || parseFloat(paymentAmount) <= 0) {
            const error = new Error('Valor do pagamento (paymentAmount) é obrigatório e deve ser positivo.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        // paymentDate é opcional no corpo, service usa hoje se não fornecido.
        // Mas se fornecido, precisa ser uma data válida.
        if (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
             const error = new Error('Data do pagamento (paymentDate) deve estar no formato YYYY-MM-DD.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }


        const paymentResult = await creditCardService.payCreditCardInvoice(
            financialAccountId,
            cardId,
            parseFloat(paymentAmount),
            paymentDate || new Date().toISOString().split('T')[0], // Default para hoje se não fornecido
            originatingAccountDescription,
            financialCategoryId ? parseInt(financialCategoryId, 10) : null
        );
        res.status(201).json({ status: 'success', data: paymentResult });
    } catch (error) {
        next(error);
    }
}


module.exports = {
  createCreditCard,
  getAllCreditCards,
  getCreditCardById,
  updateCreditCard,
  deleteCreditCard,
  getCreditCardInvoiceDetails,
  getAvailableInvoicePeriods,
  getAvailableCreditLimit,
  payCreditCardInvoice,
};
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

function getCardIdFromRequest(req) {
    const id = parseInt(req.params.cardId, 10);
    if (isNaN(id)) {
        const error = new Error('ID do Cartão de Crédito inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function createCreditCard(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
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
    // Passando req.query para o service para que ele possa pegar includeSummary, isActive, etc.
    const result = await creditCardService.getAllCreditCards(financialAccountId, req.query);
    res.status(200).json({ status: 'success', data: result }); // result agora é um objeto { cards, totalItems }
  } catch (error) {
    next(error);
  }
}

async function getCreditCardById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = getCardIdFromRequest(req);
    const card = await creditCardService.getCreditCardById(financialAccountId, cardId);
    // O service agora lança erro se não encontrar, então não precisamos checar aqui
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
    // O service lança erro se não encontrar
    res.status(200).json({ status: 'success', data: updatedCard });
  } catch (error) {
    next(error);
  }
}

async function deleteCreditCard(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = getCardIdFromRequest(req);
    const success = await creditCardService.deleteCreditCard(financialAccountId, cardId);
    // O service lança erro se não encontrar ou se houver conflito
    if (success) { // Embora o service lance erro, uma checagem dupla não prejudica
        res.status(204).send();
    } else {
        // Este caso pode não ser alcançado se o service sempre lançar erro
        const error = new Error('Falha ao excluir o cartão de crédito, pode não ter sido encontrado.');
        error.statusCode = 404; error.status = 'fail'; return next(error);
    }
  } catch (error) {
    next(error);
  }
}

// --- NOVOS CONTROLLERS ---
async function getCreditCardInvoiceDetails(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const cardId = getCardIdFromRequest(req);
    const { type, month, year } = req.query; // Pegar os query params

    const periodOptions = { type: type || 'aberta' };
    if (type === 'especifico') {
      if (!month || !year) {
        const error = new Error('Para fatura de período específico, "month" e "year" são obrigatórios na query.');
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
        const financialAccountId = getFinancialAccountIdFromRequest(req); // Conta de onde sairá o dinheiro
        const cardId = getCardIdFromRequest(req); // Cartão cuja fatura está sendo paga
        const { paymentAmount, paymentDate, originatingAccountDescription, financialCategoryId } = req.body;

        if (!paymentAmount || parseFloat(paymentAmount) <= 0) {
            const error = new Error('Valor do pagamento (paymentAmount) é obrigatório e deve ser positivo.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        if (!paymentDate) {
            const error = new Error('Data do pagamento (paymentDate) é obrigatória.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }

        const paymentResult = await creditCardService.payCreditCardInvoice(
            financialAccountId,
            cardId,
            parseFloat(paymentAmount),
            paymentDate,
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
  getCreditCardInvoiceDetails,    // <<< Adicionado
  getAvailableInvoicePeriods,     // <<< Adicionado
  getAvailableCreditLimit,        // <<< Adicionado
  payCreditCardInvoice,           // <<< Adicionado
};
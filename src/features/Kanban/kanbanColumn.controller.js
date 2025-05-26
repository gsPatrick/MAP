// src/features/Kanban/kanbanColumn.controller.js
const kanbanColumnService = require('./kanbanColumn.service');
const logger = require('../../utils/logger');

function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id)) {
        const error = new Error('ID da Conta Financeira inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function getAllColumns(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const columns = await kanbanColumnService.getAllColumns(financialAccountId);
    res.status(200).json({ status: 'success', data: columns });
  } catch (error) { next(error); }
}

async function createColumn(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    if (!req.body.title) {
        const error = new Error('Título é obrigatório para a coluna.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const newColumn = await kanbanColumnService.createColumn(financialAccountId, req.body);
    res.status(201).json({ status: 'success', data: newColumn });
  } catch (error) { next(error); }
}

async function updateColumn(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const columnId = parseInt(req.params.columnId, 10);
    if (isNaN(columnId)) { /* erro 400 */ }
    if (Object.keys(req.body).length === 0) { /* erro 400 */ }
    
    const updatedColumn = await kanbanColumnService.updateColumn(financialAccountId, columnId, req.body);
    res.status(200).json({ status: 'success', data: updatedColumn });
  } catch (error) { next(error); }
}

async function updateColumnOrder(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const { columnOrderArray } = req.body; // Espera um array [{id, order}, ...]
    if (!columnOrderArray || !Array.isArray(columnOrderArray)) {
        const error = new Error('Formato inválido. Envie "columnOrderArray".');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const updatedColumns = await kanbanColumnService.updateColumnOrder(financialAccountId, columnOrderArray);
    res.status(200).json({ status: 'success', data: updatedColumns });
  } catch (error) {
    next(error);
  }
}

async function deleteColumn(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const columnId = parseInt(req.params.columnId, 10);
    if (isNaN(columnId)) { /* erro 400 */ }
    await kanbanColumnService.deleteColumn(financialAccountId, columnId);
    res.status(204).send();
  } catch (error) { next(error); }
}

module.exports = {
  getAllColumns,
  createColumn,
  updateColumn,
  updateColumnOrder,
  deleteColumn,
};
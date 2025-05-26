// src/features/Kanban/kanban.controller.js
const kanbanService = require('./kanban.service');
const kanbanColumnService = require('./kanbanColumn.service'); // Para gerenciar colunas
const logger = require('../../utils/logger');

function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id)) {
        const error = new Error('ID da Conta Financeira inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

// --- Controladores para Colunas ---
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
    const { columnOrderArray } = req.body;
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

// --- Controladores para Tarefas (Tasks) ---
async function getAllTasks(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const result = await kanbanService.getAllTasks(financialAccountId, req.query);
    res.status(200).json({ status: 'success', ...result });
  } catch (error) { next(error); }
}

async function createTask(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    // Agora 'kanbanColumnId' é obrigatório no body em vez de 'status'
    if (!req.body.title || !req.body.kanbanColumnId) {
        const error = new Error('Título e ID da Coluna são obrigatórios para a tarefa.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const newTask = await kanbanService.createTask(financialAccountId, req.body);
    res.status(201).json({ status: 'success', data: newTask });
  } catch (error) { next(error); }
}

async function updateTask(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) { /* ... */ }
    if (Object.keys(req.body).length === 0) { /* ... */ }
    
    const updatedTask = await kanbanService.updateTask(financialAccountId, taskId, req.body);
    res.status(200).json({ status: 'success', data: updatedTask });
  } catch (error) { next(error); }
}

async function updateTaskOrderAndColumn(req, res, next) { // Renomeado
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) { /* ... */ }
    const { kanbanColumnId, order } = req.body; // Espera 'kanbanColumnId' em vez de 'status'
    if (kanbanColumnId === undefined && order === undefined) {
        const error = new Error('Pelo menos ID da Coluna ou Ordem deve ser fornecido.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    // A conversão de kanbanColumnId para inteiro deve ser feita no service ou antes, se necessário.
    const updatedTask = await kanbanService.updateTaskOrderAndColumn(financialAccountId, taskId, kanbanColumnId, order);
    res.status(200).json({ status: 'success', data: updatedTask });
  } catch (error) {
    next(error);
  }
}

async function deleteTask(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) { /* ... */ }
    await kanbanService.deleteTask(financialAccountId, taskId);
    res.status(204).send();
  } catch (error) { next(error); }
}

module.exports = {
  // Colunas
  getAllColumns,
  createColumn,
  updateColumn,
  updateColumnOrder,
  deleteColumn,
  // Tarefas
  getAllTasks,
  createTask,
  updateTask,
  updateTaskOrderAndColumn, // Renomeado
  deleteTask,
};
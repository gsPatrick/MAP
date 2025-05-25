// src/features/Kanban/kanban.controller.js
const kanbanService = require('./kanban.service');
const logger = require('../../utils/logger');

function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id)) {
        const error = new Error('ID da Conta Financeira inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function getAllTasks(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const result = await kanbanService.getAllTasks(financialAccountId, req.query); // Service agora retorna {tasks, totalItems, ...}
    res.status(200).json({ status: 'success', ...result }); // Envia o objeto completo
  } catch (error) { next(error); }
}

async function createTask(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    if (!req.body.title || !req.body.status) {
        const error = new Error('Título e Status são obrigatórios.');
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
    if (isNaN(taskId)) {
        const error = new Error('ID da Tarefa inválido.'); error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    if (Object.keys(req.body).length === 0) {
        const error = new Error('Nenhum dado fornecido para atualização.'); error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    
    const updatedTask = await kanbanService.updateTask(financialAccountId, taskId, req.body);
    // Service já trata o caso de não encontrar
    res.status(200).json({ status: 'success', data: updatedTask });
  } catch (error) { next(error); }
}

async function updateTaskOrderAndStatus(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) {
      const error = new Error('ID da Tarefa inválido.'); error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const { status, order } = req.body;
    // A validação se status ou order existem é feita no service
    // if (status === undefined && order === undefined) {
    //   const error = new Error('Pelo menos status ou order deve ser fornecido para atualização.'); error.statusCode = 400; error.status = 'fail'; return next(error);
    // }

    const updatedTask = await kanbanService.updateTaskOrderAndStatus(financialAccountId, taskId, status, order);
    res.status(200).json({ status: 'success', data: updatedTask });
  } catch (error) {
    next(error);
  }
}

async function deleteTask(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) {
        const error = new Error('ID da Tarefa inválido.'); error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const success = await kanbanService.deleteTask(financialAccountId, taskId);
    // Service já trata o caso de não encontrar (retorna erro 404)
    res.status(204).send();
  } catch (error) { next(error); }
}

module.exports = {
  getAllTasks,
  createTask,
  updateTask,
  updateTaskOrderAndStatus,
  deleteTask,
};
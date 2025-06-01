// src/features/Kanban/kanban.controller.js
const kanbanService = require('./kanban.service');
const logger = require('../../utils/logger');

// Helper para pegar financialAccountId da rota, já validado pelo middleware pai
function getFinancialAccountId(req) {
    return req.financialAccount.id; // req.financialAccount é populado por authorizeFinancialAccountOwnership
}

// --- Quadro Kanban ---
async function getKanbanBoard(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const boardData = await kanbanService.getBoardData(financialAccountId);
        res.status(200).json({ status: 'success', data: boardData });
    } catch (error) {
        next(error);
    }
}

// --- Colunas ---
async function createColumn(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const { title, color, order } = req.body;
        if (!title) {
            return res.status(400).json({ status: 'fail', message: 'Título da coluna é obrigatório.' });
        }
        const column = await kanbanService.createColumn(financialAccountId, { title, color, order });
        res.status(201).json({ status: 'success', data: column });
    } catch (error) {
        next(error);
    }
}

async function updateColumn(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const columnId = parseInt(req.params.columnId, 10);
        if (isNaN(columnId)) {
            return res.status(400).json({ status: 'fail', message: 'ID da coluna inválido.' });
        }
        const updatedColumn = await kanbanService.updateColumn(financialAccountId, columnId, req.body);
        res.status(200).json({ status: 'success', data: updatedColumn });
    } catch (error) {
        next(error);
    }
}

async function deleteColumn(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const columnId = parseInt(req.params.columnId, 10);
        if (isNaN(columnId)) {
            return res.status(400).json({ status: 'fail', message: 'ID da coluna inválido.' });
        }
        await kanbanService.deleteColumn(financialAccountId, columnId);
        res.status(204).send();
    } catch (error) {
        next(error);
    }
}

async function reorderColumns(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const { columnOrder } = req.body; // Espera um array de IDs de colunas na nova ordem
        if (!Array.isArray(columnOrder)) {
            return res.status(400).json({ status: 'fail', message: 'columnOrder deve ser um array de IDs.' });
        }
        await kanbanService.reorderColumns(financialAccountId, columnOrder);
        res.status(200).json({ status: 'success', message: 'Ordem das colunas atualizada.' });
    } catch (error) {
        next(error);
    }
}

// --- Tarefas ---
async function createTaskInColumn(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const columnId = parseInt(req.params.columnId, 10);
        if (isNaN(columnId)) {
            return res.status(400).json({ status: 'fail', message: 'ID da coluna inválido para criar tarefa.' });
        }
        const taskData = req.body;
        // O frontend envia 'content' para o nome da tarefa, mas o modelo usa 'title'
        if (taskData.content && !taskData.title) {
            taskData.title = taskData.content;
            delete taskData.content;
        }
        if (!taskData.title) {
            return res.status(400).json({ status: 'fail', message: 'Título (ou conteúdo) da tarefa é obrigatório.' });
        }
        const task = await kanbanService.createTask(financialAccountId, columnId, taskData);
        res.status(201).json({ status: 'success', data: task });
    } catch (error) {
        next(error);
    }
}

async function updateTask(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const taskId = parseInt(req.params.taskId, 10);
        if (isNaN(taskId)) {
            return res.status(400).json({ status: 'fail', message: 'ID da tarefa inválido.' });
        }
        const taskData = req.body;
        // Mapear 'content' do frontend para 'title' do backend se necessário
        if (taskData.content && taskData.title === undefined) {
            taskData.title = taskData.content;
            delete taskData.content;
        }
        const updatedTask = await kanbanService.updateTask(financialAccountId, taskId, taskData);
        res.status(200).json({ status: 'success', data: updatedTask });
    } catch (error) {
        next(error);
    }
}

async function deleteTask(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const taskId = parseInt(req.params.taskId, 10);
        if (isNaN(taskId)) {
            return res.status(400).json({ status: 'fail', message: 'ID da tarefa inválido.' });
        }
        await kanbanService.deleteTask(financialAccountId, taskId);
        res.status(204).send();
    } catch (error) {
        next(error);
    }
}

async function toggleTaskComplete(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const taskId = parseInt(req.params.taskId, 10);
        if (isNaN(taskId)) {
            return res.status(400).json({ status: 'fail', message: 'ID da tarefa inválido.' });
        }
        const updatedTask = await kanbanService.toggleTaskComplete(financialAccountId, taskId);
        res.status(200).json({ status: 'success', data: updatedTask });
    } catch (error) {
        next(error);
    }
}

async function reorderTasks(req, res, next) {
    try {
        const financialAccountId = getFinancialAccountId(req);
        const { taskId, sourceColumnId, destinationColumnId, sourceIndex, destinationIndex } = req.body;

        if (!taskId || !sourceColumnId || !destinationColumnId || sourceIndex === undefined || destinationIndex === undefined) {
            return res.status(400).json({ status: 'fail', message: 'Dados insuficientes para reordenar tarefas.' });
        }
        await kanbanService.reorderTasks(financialAccountId, {
            taskId,
            source: { droppableId: sourceColumnId, index: sourceIndex },
            destination: { droppableId: destinationColumnId, index: destinationIndex }
        });
        res.status(200).json({ status: 'success', message: 'Ordem das tarefas atualizada.' });
    } catch (error) {
        next(error);
    }
}


module.exports = {
    getKanbanBoard,
    createColumn,
    updateColumn,
    deleteColumn,
    reorderColumns,
    createTaskInColumn,
    updateTask,
    deleteTask,
    toggleTaskComplete,
    reorderTasks,
};
// src/features/Kanban/kanban.routes.js
const { Router } = require('express');
const kanbanController = require('./kanban.controller');

const router = Router({ mergeParams: true }); // Para herdar :financialAccountId

// --- Rotas para Colunas Kanban ---
// GET /api/financial-accounts/:financialAccountId/kanban-columns
router.get('/columns', kanbanController.getAllColumns);
// POST /api/financial-accounts/:financialAccountId/kanban-columns
router.post('/columns', kanbanController.createColumn);
// PUT /api/financial-accounts/:financialAccountId/kanban-columns/order (para reordenar todas as colunas)
router.put('/columns/order', kanbanController.updateColumnOrder);
// PUT /api/financial-accounts/:financialAccountId/kanban-columns/:columnId (para editar título, cor)
router.put('/columns/:columnId', kanbanController.updateColumn);
// DELETE /api/financial-accounts/:financialAccountId/kanban-columns/:columnId
router.delete('/columns/:columnId', kanbanController.deleteColumn);


// --- Rotas para Tarefas Kanban ---
// GET /api/financial-accounts/:financialAccountId/kanban-tasks
router.get('/tasks', kanbanController.getAllTasks); // Pode aceitar query param ?kanbanColumnId=X
// POST /api/financial-accounts/:financialAccountId/kanban-tasks
router.post('/tasks', kanbanController.createTask);
// PUT /api/financial-accounts/:financialAccountId/kanban-tasks/:taskId (para atualizar campos da tarefa)
router.put('/tasks/:taskId', kanbanController.updateTask);
// PATCH /api/financial-accounts/:financialAccountId/kanban-tasks/:taskId/order-column (para D&D de tasks)
router.patch('/tasks/:taskId/order-column', kanbanController.updateTaskOrderAndColumn);
// DELETE /api/financial-accounts/:financialAccountId/kanban-tasks/:taskId
router.delete('/tasks/:taskId', kanbanController.deleteTask);

module.exports = router;
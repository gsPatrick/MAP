// src/features/Kanban/kanban.routes.js
const { Router } = require('express');
const kanbanController = require('./kanban.controller');
// O middleware de autenticação e autorização de FinancialAccount
// já é aplicado no clientFinancialAccountRouter em src/routes/index.js

const router = Router({ mergeParams: true }); // Para acessar :financialAccountId

// --- Rotas para o Quadro Kanban Completo ---
router.get('/board', kanbanController.getKanbanBoard); // GET /api/financial-accounts/:financialAccountId/kanban/board

// --- Rotas para Colunas Kanban ---
router.post('/columns', kanbanController.createColumn);       // POST /api/financial-accounts/:financialAccountId/kanban/columns
router.put('/columns/:columnId', kanbanController.updateColumn); // PUT /api/financial-accounts/:financialAccountId/kanban/columns/:columnId
router.delete('/columns/:columnId', kanbanController.deleteColumn); // DELETE /api/financial-accounts/:financialAccountId/kanban/columns/:columnId
router.patch('/columns/reorder', kanbanController.reorderColumns); // PATCH /api/financial-accounts/:financialAccountId/kanban/columns/reorder

// --- Rotas para Tarefas Kanban ---
// As tarefas são geralmente aninhadas sob colunas para criação, mas podem ser gerenciadas globalmente para updates/deletes.
// O frontend parece adicionar tarefas a uma coluna específica (onAddTaskClick recebe columnId)
router.post('/columns/:columnId/tasks', kanbanController.createTaskInColumn); // POST /api/financial-accounts/:financialAccountId/kanban/columns/:columnId/tasks

router.put('/tasks/:taskId', kanbanController.updateTask);          // PUT /api/financial-accounts/:financialAccountId/kanban/tasks/:taskId
router.delete('/tasks/:taskId', kanbanController.deleteTask);        // DELETE /api/financial-accounts/:financialAccountId/kanban/tasks/:taskId
router.patch('/tasks/:taskId/toggle-complete', kanbanController.toggleTaskComplete); // PATCH /api/financial-accounts/:financialAccountId/kanban/tasks/:taskId/toggle-complete
router.patch('/tasks/reorder', kanbanController.reorderTasks);         // PATCH /api/financial-accounts/:financialAccountId/kanban/tasks/reorder (para mover entre colunas ou reordenar na mesma)

module.exports = router;
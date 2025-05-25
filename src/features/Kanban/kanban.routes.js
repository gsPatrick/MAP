// src/features/Kanban/kanban.routes.js
const { Router } = require('express');
const kanbanController = require('./kanban.controller');
// const { authenticateClientToken } = require('../../middlewares/authMiddleware'); // Removido authorizeFinancialAccountOwnership pois a rota pai já faz isso

const router = Router({ mergeParams: true }); // Para herdar :financialAccountId

// A rota pai (/api/financial-accounts/:financialAccountId) já aplicará
// authenticateClientToken e authorizeFinancialAccountOwnership (se configurado no seu index.js de rotas)

router.get('/', kanbanController.getAllTasks);
router.post('/', kanbanController.createTask);
router.put('/:taskId', kanbanController.updateTask); // Para atualizar todos os campos
router.patch('/:taskId/order-status', kanbanController.updateTaskOrderAndStatus); // Para D&D
router.delete('/:taskId', kanbanController.deleteTask);

module.exports = router;
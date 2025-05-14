// src/features/DevTools/devTools.routes.js
const { Router } = require('express');
const devToolsController = require('./devTools.controller');
// const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware'); // Se aplicável

const router = Router();

// Aplicar middlewares de autenticação/autorização se esta rota for protegida
// Ex: router.use(authenticateToken, authorizeRole(['admin']));

/**
 * @swagger
 * /dev-tools/activate-access/{clientId}:
 *   post:
 *     summary: Ativa um nível de acesso de teste para um cliente.
 *     description: Define o 'accessLevel' e 'accessExpiresAt' de um cliente para fins de teste.
 *     tags: [DevTools]
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: integer
 *         description: O ID do cliente.
 *       - in: query
 *         name: level
 *         schema:
 *           type: string
 *           enum: [gratuito, mensal, anual, vitalicio]
 *           default: mensal
 *         description: O nível de acesso a ser ativado (opcional, padrão 'mensal').
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               accessLevel:
 *                 type: string
 *                 enum: [gratuito, mensal, anual, vitalicio]
 *                 description: O nível de acesso a ser ativado (alternativa ao query param).
 *     responses:
 *       200:
 *         description: Nível de acesso de teste ativado com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               # Defina seu schema de resposta aqui
 *       400:
 *         description: Requisição inválida (ID do cliente, nível de acesso).
 *       404:
 *         description: Cliente não encontrado.
 *       500:
 *         description: Erro interno do servidor.
 */
router.post('/activate-access/:clientId', devToolsController.activateTestAccess);
// Você pode usar PUT também se fizer mais sentido semanticamente para "atualizar" o acesso do cliente
// router.put('/activate-access/:clientId', devToolsController.activateTestAccess);


module.exports = router;
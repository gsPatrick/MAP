// src/features/DevTools/devTools.routes.js
const { Router } = require('express');
const devToolsController = require('./devTools.controller');
// const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware'); // Se aplicável

const router = Router();

router.post('/activate-access/:clientId', devToolsController.activateTestAccess);
// Você pode usar PUT também se fizer mais sentido semanticamente para "atualizar" o acesso do cliente
// router.put('/activate-access/:clientId', devToolsController.activateTestAccess);


module.exports = router;
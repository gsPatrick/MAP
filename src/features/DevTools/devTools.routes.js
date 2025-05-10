// src/features/DevTools/devTools.routes.js
const { Router } = require('express');
const devToolsController = require('./devTools.controller');
// const { authenticateToken, authorizeRole } = require('../../middlewares/authMiddleware');

const router = Router();

// Proteger rotas de dev/admin
// router.use(authenticateToken);
// router.use(authorizeRole(['admin']));

router.post('/test-send-button-list', devToolsController.testSendButtonList);

module.exports = router;
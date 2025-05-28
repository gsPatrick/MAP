// src/features/ClientAuth/clientAuth.routes.js
const { Router } = require('express');
const clientAuthController = require('./clientAuth.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware'); // <<< IMPORTADO

const router = Router();

router.post('/client/set-credentials', clientAuthController.setCredentials); // <<< ATUALIZADO
router.post('/client/login', clientAuthController.login);
router.put('/client/me/update-profile', authenticateClientToken, clientAuthController.updateCurrentClientProfile); // <<< NOVA ROTA

// Rota para o client logado obter seus próprios dados (perfil, contas, assinatura)
router.get('/client/me', authenticateClientToken, clientAuthController.getCurrentClientProfile); // <<< ATUALIZADO

module.exports = router;
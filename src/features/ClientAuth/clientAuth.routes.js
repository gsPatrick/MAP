
// src/features/ClientAuth/clientAuth.routes.js
const { Router } = require('express');
const clientAuthController = require('./clientAuth.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware');

const router = Router();

// <<< NOVA ROTA DE CADASTRO PÚBLICA >>>
router.post('/client/register', clientAuthController.register);

// --- NOVAS ROTAS PARA ATIVAÇÃO DE CONTA DE USUÁRIO ANTIGO ---
// 1. Inicia o processo enviando um código para o WhatsApp
router.post('/client/request-activation-code', clientAuthController.requestActivationCode);
// 2. Verifica o código e permite a definição da nova senha
router.post('/client/set-password-with-code', clientAuthController.setPasswordWithCode);

router.post('/client/set-credentials', clientAuthController.setCredentials);
router.post('/client/login', clientAuthController.login);
router.get('/client/me', authenticateClientToken, clientAuthController.getCurrentClientProfile);
router.put('/client/me/calendar-preferences', authenticateClientToken, clientAuthController.updateCalendarPreferences);
router.put('/client/update-profile', authenticateClientToken, clientAuthController.updateMyProfile);

module.exports = router;
// src/features/GoogleAuth/googleAuth.routes.js
const { Router } = require('express');
const googleAuthController = require('./googleAuth.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware'); // Para proteger rotas de gerenciamento

const router = Router();

// Rota para iniciar o fluxo de autorização do Google
// O cliente (frontend) chamará esta rota, que redirecionará para o Google
// Esta rota precisa de `authenticateClientToken` para saber QUAL cliente está tentando conectar.
router.get('/connect', authenticateClientToken, googleAuthController.connectGoogleAccount);

// Rota de callback que o Google chamará após o usuário autorizar (ou negar)
// Não precisa de authenticateClientToken aqui, pois o 'state' parâmetro OAuth é usado para segurança.
router.get('/callback', googleAuthController.googleCallback);

// Rota para desconectar/revogar acesso do Google Calendar
router.post('/disconnect', authenticateClientToken, googleAuthController.disconnectGoogleAccount);

// Rota para verificar o status da sincronização
router.get('/status', authenticateClientToken, googleAuthController.getSyncStatus);

module.exports = router;
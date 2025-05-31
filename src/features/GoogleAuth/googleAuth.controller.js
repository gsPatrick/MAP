// src/features/GoogleAuth/googleAuth.controller.js
const googleAuthService = require('./googleAuth.service');
const logger = require('../../utils/logger');

async function connectGoogleAccount(req, res, next) {
  try {
    // req.client.id é fornecido pelo middleware authenticateClientToken
    const clientId = req.client.id;
    if (!clientId) {
      return res.status(401).json({ status: 'fail', message: 'Cliente não autenticado.' });
    }
    const authUrl = googleAuthService.getGoogleAuthUrl(clientId);
    // Em uma aplicação real, você pode querer retornar a URL para o frontend
    // ou redirecionar diretamente do backend. Para SPA, retornar a URL é comum.
    // res.redirect(authUrl);
    res.status(200).json({ status: 'success', data: { authorizationUrl: authUrl } });
  } catch (error) {
    logger.error('[GoogleAuthController] Erro ao iniciar conexão com Google:', error);
    next(error);
  }
}

async function googleCallback(req, res, next) {
  try {
    const { code, state, error: googleError } = req.query;

    if (googleError) {
      logger.error(`[GoogleAuthController] Erro retornado pelo Google: ${googleError}`);
      // Redirecionar para uma página de erro no frontend ou mostrar mensagem
      return res.status(400).send(`Erro na autorização do Google: ${googleError}. Tente novamente.`);
    }

    if (!code || !state) {
      logger.warn('[GoogleAuthController] Código ou estado faltando no callback do Google.');
      return res.status(400).send('Parâmetros inválidos no callback do Google.');
    }
    
    // O 'state' deve conter o clientId que iniciou o processo
    const clientId = parseInt(state, 10); // O state foi passado como clientId
    if (isNaN(clientId)) {
        logger.error('[GoogleAuthController] Parâmetro "state" inválido ou não numérico no callback do Google.');
        return res.status(400).send('Parâmetro de estado inválido.');
    }

    await googleAuthService.handleGoogleCallback(clientId, code);
    
    // Redirecionar para uma página de sucesso no frontend
    // Ex: res.redirect(`${process.env.FRONTEND_URL}/settings/integrations?google_auth_status=success`);
    res.status(200).send('Conta Google conectada com sucesso! Você pode fechar esta janela.');

  } catch (error) {
    logger.error('[GoogleAuthController] Erro no callback do Google:', { message: error.message, stack: error.stack });
    // Redirecionar para uma página de erro no frontend
    // Ex: res.redirect(`${process.env.FRONTEND_URL}/settings/integrations?google_auth_status=error&message=${encodeURIComponent(error.message)}`);
    res.status(500).send(`Erro ao processar conexão com Google: ${error.message}. Tente novamente.`);
  }
}

async function disconnectGoogleAccount(req, res, next) {
  try {
    const clientId = req.client.id;
    await googleAuthService.disconnectGoogleAccount(clientId);
    res.status(200).json({ status: 'success', message: 'Conta Google desconectada e sincronização interrompida.' });
  } catch (error) {
    logger.error('[GoogleAuthController] Erro ao desconectar conta Google:', error);
    next(error);
  }
}

async function getSyncStatus(req, res, next) {
    try {
        const clientId = req.client.id;
        const status = await googleAuthService.getSyncStatus(clientId);
        res.status(200).json({ status: 'success', data: status });
    } catch (error) {
        logger.error('[GoogleAuthController] Erro ao obter status da sincronização:', error);
        next(error);
    }
}

module.exports = {
  connectGoogleAccount,
  googleCallback,
  disconnectGoogleAccount,
  getSyncStatus,
};
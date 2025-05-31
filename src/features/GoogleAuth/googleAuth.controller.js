// src/features/GoogleAuth/googleAuth.controller.js
const googleAuthService = require('./googleAuth.service');
const googleCalendarService = require('../GoogleCalendar/googleCalendarService'); // Importar para watch/stop
const logger = require('../../utils/logger');
const { Client } = require('../../database'); // Para buscar o clientRecord atualizado

async function connectGoogleAccount(req, res, next) {
  try {
    const clientId = req.client.id;
    if (!clientId) {
      return res.status(401).json({ status: 'fail', message: 'Cliente não autenticado.' });
    }
    const authUrl = googleAuthService.getGoogleAuthUrl(clientId);
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
      return res.status(400).send(`Erro na autorização do Google: ${googleError}. Tente novamente.`);
    }
    if (!code || !state) {
      logger.warn('[GoogleAuthController] Código ou estado faltando no callback do Google.');
      return res.status(400).send('Parâmetros inválidos no callback do Google.');
    }
    const clientId = parseInt(state, 10);
    if (isNaN(clientId)) {
        logger.error('[GoogleAuthController] Parâmetro "state" inválido no callback do Google.');
        return res.status(400).send('Parâmetro de estado inválido.');
    }

    // 1. Lida com tokens
    const updatedClientRecord = await googleAuthService.handleGoogleCallback(clientId, code);

    // 2. Se os tokens foram salvos com sucesso, registra o watch
    if (updatedClientRecord && updatedClientRecord.isGoogleCalendarSynced && updatedClientRecord.googleCalendarIdPrincipal) {
        logger.info(`[GoogleAuthController] Tokens para Cliente ${clientId} OK. Tentando registrar watch...`);
        const watchResponse = await googleCalendarService.watchCalendar(clientId, updatedClientRecord.googleCalendarIdPrincipal);
        if (watchResponse && watchResponse.id && watchResponse.resourceId) {
            // Salva os detalhes do canal no cliente (precisa buscar novamente ou usar o updatedClientRecord)
            await Client.update( // Usar Client.update para garantir que estamos atualizando o BD
              {
                googleChannelId: watchResponse.id,
                googleChannelResourceId: watchResponse.resourceId,
                googleChannelExpiryDate: watchResponse.expiration ? new Date(parseInt(watchResponse.expiration, 10)) : null,
              },
              { where: { id: clientId } }
            );
            logger.info(`[GoogleAuthController] Webhook registrado para Cliente ID ${clientId}, Calendário: ${updatedClientRecord.googleCalendarIdPrincipal}. Channel ID: ${watchResponse.id}`);
        } else {
            logger.error(`[GoogleAuthController] Falha ao registrar webhook para Cliente ID ${clientId} após autenticação. Tokens foram salvos, mas watch falhou.`);
            // Considerar se deve reverter isGoogleCalendarSynced para false ou notificar o usuário
            await Client.update({ isGoogleCalendarSynced: false }, { where: { id: clientId }}); // Desfaz o sync se o watch falhou
            return res.status(500).send(`Conta Google conectada, mas houve um problema ao configurar as notificações em tempo real. Tente novamente ou contate o suporte.`);
        }
    } else if (updatedClientRecord && !updatedClientRecord.isGoogleCalendarSynced) {
        // Isso aconteceria se handleGoogleCallback revertesse isGoogleCalendarSynced devido a um erro interno lá
         logger.warn(`[GoogleAuthController] handleGoogleCallback não ativou a sincronização para Cliente ${clientId}. Watch não será registrado.`);
    }


    res.status(200).send('Conta Google conectada e notificações configuradas com sucesso! Você pode fechar esta janela.');

  } catch (error) {
    logger.error('[GoogleAuthController] Erro no callback do Google:', { message: error.message, stack: error.stack?.substring(0,500) });
    // Se o erro veio de handleGoogleCallback, os tokens já podem ter sido limpos.
    res.status(500).send(`Erro ao processar conexão com Google: ${error.message}. Tente novamente.`);
  }
}

async function disconnectGoogleAccount(req, res, next) {
  try {
    const clientId = req.client.id;
    const clientRecord = await Client.findByPk(clientId);

    if (clientRecord && clientRecord.isGoogleCalendarSynced && clientRecord.googleChannelId && clientRecord.googleChannelResourceId) {
        logger.info(`[GoogleAuthController] Tentando parar watch para Cliente ${clientId}, Channel ${clientRecord.googleChannelId}`);
        await googleCalendarService.stopWatchingCalendar(clientId, clientRecord.googleChannelId, clientRecord.googleChannelResourceId);
    }

    await googleAuthService.disconnectGoogleAccountTokens(clientId); // Apenas revoga tokens e limpa BD
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
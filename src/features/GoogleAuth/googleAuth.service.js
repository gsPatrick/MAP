// src/features/GoogleAuth/googleAuth.service.js
const { google } = require('googleapis');
const { Client } = require('../../database');
const logger =require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/cryptoUtils');
const googleCalendarService = require('../../services/googleCalendarService'); // Para chamar watchCalendar
const crypto = require('crypto'); // Para gerar UUID para o channel

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    logger.error('[GoogleAuthService] Variáveis Google OAuth não configuradas!');
}

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

function getGoogleAuthUrl(systemClientId) {
  if (!GOOGLE_CLIENT_ID) throw new Error("Google Client ID não configurado.");
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_CALENDAR_SCOPES,
    prompt: 'consent',
    state: systemClientId.toString(),
  });
}

async function handleGoogleCallback(clientId, code) {
  try {
    const { tokens } = await oauth2Client.getToken(code);
    const clientRecord = await Client.findByPk(clientId);
    if (!clientRecord) {
      throw new Error(`Cliente ID ${clientId} não encontrado para salvar tokens.`);
    }

    const encryptedAccessToken = tokens.access_token ? encrypt(tokens.access_token) : null;
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : clientRecord.googleRefreshToken;

    if (!encryptedAccessToken) {
        throw new Error('Falha ao criptografar o access_token do Google.');
    }

    await clientRecord.update({
      googleAccessToken: encryptedAccessToken,
      googleRefreshToken: encryptedRefreshToken,
      googleTokenExpiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      isGoogleCalendarSynced: true,
      googleCalendarIdPrincipal: 'primary',
    });
    logger.info(`Tokens Google armazenados para Cliente ID ${clientId}.`);

    // --- Registrar o Webhook (watch) ---
    if (clientRecord.isGoogleCalendarSynced && clientRecord.googleCalendarIdPrincipal) {
        const watchResponse = await googleCalendarService.watchCalendar(clientId, clientRecord.googleCalendarIdPrincipal);
        if (watchResponse && watchResponse.id && watchResponse.resourceId) {
            await clientRecord.update({
                googleChannelId: watchResponse.id,
                googleChannelResourceId: watchResponse.resourceId,
                googleChannelExpiryDate: watchResponse.expiration ? new Date(parseInt(watchResponse.expiration, 10)) : null,
            });
            logger.info(`Webhook registrado para Cliente ID ${clientId}, Calendário: ${clientRecord.googleCalendarIdPrincipal}. Channel ID: ${watchResponse.id}`);
        } else {
            logger.error(`Falha ao registrar webhook para Cliente ID ${clientId} após autenticação.`);
            // Considerar reverter isGoogleCalendarSynced ou tentar novamente depois.
        }
    }
    // --- Fim do Registro do Webhook ---

  } catch (error) {
    logger.error(`[GoogleAuthService] Erro no callback do Google para Cliente ID ${clientId}: ${error.message}`, { error });
    const clientRecord = await Client.findByPk(clientId);
    if (clientRecord && clientRecord.isGoogleCalendarSynced) {
        await clientRecord.update({ isGoogleCalendarSynced: false, googleAccessToken: null, googleTokenExpiryDate: null })
            .catch(updError => logger.error(`Erro ao limpar tokens para ${clientId}: ${updError.message}`));
    }
    throw error;
  }
}

async function disconnectGoogleAccount(clientId) {
  const clientRecord = await Client.scope('withGoogleTokens').findByPk(clientId);
  if (!clientRecord) {
    throw new Error(`Cliente ID ${clientId} não encontrado.`);
  }

  // Parar o canal de notificação se existir
  if (clientRecord.googleChannelId && clientRecord.googleChannelResourceId) {
      await googleCalendarService.stopWatchingCalendar(clientId, clientRecord.googleChannelId, clientRecord.googleChannelResourceId)
          .catch(err => logger.warn(`Falha ao parar watch channel ${clientRecord.googleChannelId} para cliente ${clientId}: ${err.message}`));
  }

  if (clientRecord.googleAccessToken) {
    const accessToken = decrypt(clientRecord.googleAccessToken);
    if (accessToken) {
      try { await oauth2Client.revokeToken(accessToken); logger.info(`Access token revogado para Cliente ${clientId}.`); }
      catch (e) { logger.warn(`Falha ao revogar access token para ${clientId}: ${e.message}`); }
    }
  }
  if (clientRecord.googleRefreshToken) {
    const refreshToken = decrypt(clientRecord.googleRefreshToken);
    if (refreshToken) {
        try { await oauth2Client.revokeToken(refreshToken); logger.info(`Refresh token revogado para ${clientId}.`); }
        catch (e) { logger.warn(`Falha ao revogar refresh token para ${clientId}: ${e.message}`);}
    }
  }

  await clientRecord.update({
    googleAccessToken: null, googleRefreshToken: null, googleTokenExpiryDate: null,
    isGoogleCalendarSynced: false, googleCalendarIdPrincipal: null,
    googleChannelId: null, googleChannelResourceId: null, googleChannelExpiryDate: null, googleLastSyncToken: null,
  });
  logger.info(`Conta Google desconectada para Cliente ID ${clientId}.`);
}

async function getAuthenticatedClient(clientId) {
  const clientRecord = await Client.scope('withGoogleTokens').findByPk(clientId);
  if (!clientRecord || !clientRecord.isGoogleCalendarSynced || !clientRecord.googleAccessToken) {
    return null;
  }
  const localOAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  const accessToken = decrypt(clientRecord.googleAccessToken);
  const refreshToken = clientRecord.googleRefreshToken ? decrypt(clientRecord.googleRefreshToken) : null;

  if (!accessToken) {
      logger.error(`Falha ao descriptografar access token para Cliente ${clientId}.`);
      await disconnectGoogleAccount(clientId); return null;
  }
  localOAuth2Client.setCredentials({
    access_token: accessToken, refresh_token: refreshToken,
    expiry_date: clientRecord.googleTokenExpiryDate ? clientRecord.googleTokenExpiryDate.getTime() : null,
  });

  if (localOAuth2Client.isTokenExpiring()) {
    logger.info(`Token Google para Cliente ${clientId} expirando. Tentando refresh...`);
    if (!refreshToken) {
      logger.error(`Refresh token ausente para Cliente ${clientId}. Desconectando.`);
      await disconnectGoogleAccount(clientId); return null;
    }
    try {
      const { credentials } = await localOAuth2Client.refreshAccessToken();
      const newEncryptedAccessToken = credentials.access_token ? encrypt(credentials.access_token) : null;
      const newEncryptedRefreshToken = credentials.refresh_token ? encrypt(credentials.refresh_token) : clientRecord.googleRefreshToken;
      if (!newEncryptedAccessToken) throw new Error("Falha ao criptografar novo access_token.");
      await clientRecord.update({
        googleAccessToken: newEncryptedAccessToken, googleRefreshToken: newEncryptedRefreshToken,
        googleTokenExpiryDate: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      });
      localOAuth2Client.setCredentials(credentials);
      logger.info(`Token Google atualizado para Cliente ${clientId}.`);
    } catch (refreshError) {
      logger.error(`Erro ao atualizar token para Cliente ${clientId}: ${refreshError.message}`, {details: refreshError.response?.data});
      if (refreshError.response && (refreshError.response.data.error === 'invalid_grant' || refreshError.response.data.error === 'unauthorized_client')) {
        await disconnectGoogleAccount(clientId);
      }
      return null;
    }
  }
  return localOAuth2Client;
}

async function getSyncStatus(clientId) {
    const client = await Client.findByPk(clientId);
    if (!client) throw new Error(`Cliente ID ${clientId} não encontrado.`);
    return {
        isGoogleCalendarSynced: client.isGoogleCalendarSynced,
        googleCalendarIdPrincipal: client.googleCalendarIdPrincipal,
        lastTokenExpiry: client.googleTokenExpiryDate,
        colorIdPF: client.googleCalendarColorIdPF,
        colorIdPJ: client.googleCalendarColorIdPJ,
        googleChannelId: client.googleChannelId,
        googleChannelExpiryDate: client.googleChannelExpiryDate,
    };
}

module.exports = {
  getGoogleAuthUrl, handleGoogleCallback, disconnectGoogleAccount,
  getAuthenticatedClient, getSyncStatus,
};
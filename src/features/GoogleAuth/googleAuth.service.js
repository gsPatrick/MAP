// src/features/GoogleAuth/googleAuth.service.js
const { google } = require('googleapis');
const { Client } = require('../../database');
const logger =require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/cryptoUtils');
// REMOVIDA: const googleCalendarService = require('../../services/googleCalendarService');
const crypto = require('crypto');

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

/**
 * Lida com o callback do Google após o usuário autorizar.
 * Troca o código de autorização por tokens e os armazena no cliente.
 * NÃO registra mais o watch diretamente aqui.
 * @param {number} clientId - O ID do cliente do seu sistema (recuperado do 'state').
 * @param {string} code - O código de autorização retornado pelo Google.
 * @returns {Promise<Client|null>} O registro do cliente atualizado ou null em caso de erro grave.
 */
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
    if (!encryptedRefreshToken && !clientRecord.googleRefreshToken) { // Verifica se realmente não temos um refresh token
        logger.warn(`[GoogleAuthService] Nenhum refresh_token recebido ou existente para Cliente ID ${clientId}. Acesso offline pode falhar.`);
    }


    await clientRecord.update({
      googleAccessToken: encryptedAccessToken,
      googleRefreshToken: encryptedRefreshToken,
      googleTokenExpiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      isGoogleCalendarSynced: true,
      googleCalendarIdPrincipal: 'primary',
      // Limpa os campos do channel aqui, pois um novo watch será registrado pelo controller
      googleChannelId: null,
      googleChannelResourceId: null,
      googleChannelExpiryDate: null,
    });
    logger.info(`Tokens Google armazenados para Cliente ID ${clientId}. Sincronização ATIVADA.`);
    return clientRecord; // Retorna o clientRecord para o controller usar

  } catch (error) {
    logger.error(`[GoogleAuthService] Erro no callback do Google para Cliente ID ${clientId}: ${error.message}`, { error });
    const clientRecord = await Client.findByPk(clientId);
    if (clientRecord && clientRecord.isGoogleCalendarSynced) {
        await clientRecord.update({
            isGoogleCalendarSynced: false,
            googleAccessToken: null,
            // Manter o refresh token se o erro foi apenas com o access token aqui não faz muito sentido,
            // pois o fluxo de obtenção de tokens falhou. Limpar tudo é mais seguro.
            googleRefreshToken: null,
            googleTokenExpiryDate: null,
            googleChannelId: null,
            googleChannelResourceId: null,
            googleChannelExpiryDate: null,
        })
            .catch(updError => logger.error(`Erro ao limpar tokens para ${clientId}: ${updError.message}`));
    }
    throw error;
  }
}

/**
 * Apenas revoga os tokens e limpa os campos no BD.
 * A ação de parar o 'watch' será feita no controller antes de chamar esta função.
 * @param {number} clientId - ID do cliente do seu sistema.
 */
async function disconnectGoogleAccountTokens(clientId) {
  const clientRecord = await Client.scope('withGoogleTokens').findByPk(clientId);
  if (!clientRecord) {
    throw new Error(`Cliente ID ${clientId} não encontrado.`);
  }

  // A lógica de stopWatchingCalendar foi movida para o controller

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
  logger.info(`Tokens Google e dados de sincronização limpos para Cliente ID ${clientId}.`);
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
      // Chamar a função de desconexão de tokens aqui para limpar o estado inválido
      await disconnectGoogleAccountTokens(clientId).catch(e => logger.error(`Erro ao limpar tokens após falha de descriptografia para cliente ${clientId}: ${e.message}`));
      return null;
  }
  localOAuth2Client.setCredentials({
    access_token: accessToken, refresh_token: refreshToken,
    expiry_date: clientRecord.googleTokenExpiryDate ? clientRecord.googleTokenExpiryDate.getTime() : null,
  });

  if (localOAuth2Client.isTokenExpiring()) {
    logger.info(`Token Google para Cliente ${clientId} expirando. Tentando refresh...`);
    if (!refreshToken) {
      logger.error(`Refresh token ausente para Cliente ${clientId}. Desconectando tokens.`);
      await disconnectGoogleAccountTokens(clientId).catch(e => logger.error(`Erro ao limpar tokens após falha de refresh (sem RT) para cliente ${clientId}: ${e.message}`));
      return null;
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
        logger.warn(`Refresh token inválido para Cliente ID ${clientId}. Desconectando tokens...`);
        await disconnectGoogleAccountTokens(clientId).catch(e => logger.error(`Erro ao limpar tokens após falha de refresh (invalid_grant) para cliente ${clientId}: ${e.message}`));
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
  getGoogleAuthUrl, handleGoogleCallback,
  disconnectGoogleAccountTokens, // Renomeado para clareza
  getAuthenticatedClient, getSyncStatus,
};
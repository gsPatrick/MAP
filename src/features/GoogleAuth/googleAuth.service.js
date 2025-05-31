// src/features/GoogleAuth/googleAuth.service.js
const { google } = require('googleapis');
const { Client } = require('../../database');
const logger =require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/cryptoUtils'); // Nosso utilitário de criptografia

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    logger.error('[GoogleAuthService] Variáveis de ambiente do Google OAuth não configuradas! GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI são obrigatórias.');
    // Em produção, você pode querer lançar um erro aqui para impedir a inicialização do serviço.
}

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events', // Ler, criar, modificar, excluir eventos
  'https://www.googleapis.com/auth/calendar.readonly', // Apenas para garantir que temos acesso de leitura, embora .events já inclua
  // 'https://www.googleapis.com/auth/calendar.settings.readonly' // Se precisar ler configurações do calendário
];

/**
 * Gera a URL de autorização do Google.
 * O 'state' é usado para passar o ID do cliente do seu sistema, para que no callback
 * saibamos qual cliente está sendo autenticado.
 * @param {number} systemClientId - O ID do cliente no seu sistema.
 * @returns {string} A URL de autorização.
 */
function getGoogleAuthUrl(systemClientId) {
  if (!GOOGLE_CLIENT_ID) throw new Error("Google Client ID não configurado.");
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Solicita refresh_token
    scope: GOOGLE_CALENDAR_SCOPES,
    prompt: 'consent', // Força o usuário a reconceder permissão, útil para obter refresh_token sempre
    state: systemClientId.toString(), // Passa o ID do cliente do seu sistema como 'state'
  });
  return authUrl;
}

/**
 * Lida com o callback do Google após o usuário autorizar.
 * Troca o código de autorização por tokens e os armazena no cliente.
 * @param {number} clientId - O ID do cliente do seu sistema (recuperado do 'state').
 * @param {string} code - O código de autorização retornado pelo Google.
 */
async function handleGoogleCallback(clientId, code) {
  try {
    const { tokens } = await oauth2Client.getToken(code);
    // tokens contém: access_token, refresh_token (se access_type='offline'), expiry_date, scope, token_type

    const client = await Client.findByPk(clientId);
    if (!client) {
      throw new Error(`Cliente com ID ${clientId} não encontrado para salvar tokens do Google.`);
    }

    const encryptedAccessToken = tokens.access_token ? encrypt(tokens.access_token) : null;
    // O refresh_token só é retornado na primeira autorização ou se prompt=consent for usado.
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : client.googleRefreshToken; // Mantém o antigo se um novo não vier

    if (!encryptedAccessToken) {
        throw new Error('Falha ao criptografar o access_token do Google.');
    }
    // Se o refresh token não veio e não temos um antigo, isso é um problema para acesso offline.
    if (!encryptedRefreshToken && !client.googleRefreshToken) {
        logger.warn(`[GoogleAuthService] Nenhum refresh_token recebido ou existente para o cliente ID ${clientId}. Acesso offline pode falhar após expiração do access_token.`);
        // Você pode querer lançar um erro aqui ou tentar o fluxo de autorização novamente.
    }

    await client.update({
      googleAccessToken: encryptedAccessToken,
      googleRefreshToken: encryptedRefreshToken, // Salva o novo (se houver) ou mantém o antigo
      googleTokenExpiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      isGoogleCalendarSynced: true,
      googleCalendarIdPrincipal: 'primary', // Assume o calendário principal por padrão
    });

    logger.info(`Tokens do Google armazenados com sucesso para o Cliente ID ${clientId}. Sincronização ativada.`);
    // TODO: Iniciar uma primeira sincronização ou registrar para um job de sincronização aqui.

  } catch (error) {
    logger.error(`[GoogleAuthService] Erro ao processar callback do Google para Cliente ID ${clientId}: ${error.message}`, { error });
    // Importante: Se houver erro, é bom desativar a flag de sincronização ou limpar tokens
    const client = await Client.findByPk(clientId);
    if (client && client.isGoogleCalendarSynced) {
        await client.update({
            isGoogleCalendarSynced: false,
            googleAccessToken: null,
            googleRefreshToken: client.googleRefreshToken, // Manter refresh token se o erro foi só com o access token
            googleTokenExpiryDate: null,
        }).catch(updError => logger.error(`Erro ao limpar tokens para cliente ${clientId} após falha no callback: ${updError.message}`));
    }
    throw error; // Relança o erro para ser tratado pelo controller
  }
}

/**
 * Desconecta a conta Google do cliente, revogando os tokens e limpando-os do BD.
 * @param {number} clientId - ID do cliente do seu sistema.
 */
async function disconnectGoogleAccount(clientId) {
  const client = await Client.scope('withGoogleTokens').findByPk(clientId);
  if (!client) {
    throw new Error(`Cliente ID ${clientId} não encontrado.`);
  }

  if (client.googleAccessToken) {
    const accessToken = decrypt(client.googleAccessToken);
    if (accessToken) {
      try {
        await oauth2Client.revokeToken(accessToken);
        logger.info(`Access token do Google revogado para Cliente ID ${clientId}.`);
      } catch (e) {
        logger.warn(`[GoogleAuthService] Falha ao revogar access token para Cliente ID ${clientId} (pode já estar inválido): ${e.message}`);
      }
    }
  }
  if (client.googleRefreshToken) {
    const refreshToken = decrypt(client.googleRefreshToken);
    if (refreshToken) {
        try {
            await oauth2Client.revokeToken(refreshToken);
            logger.info(`Refresh token do Google revogado para Cliente ID ${clientId}.`);
        } catch (e) {
            logger.warn(`[GoogleAuthService] Falha ao revogar refresh token para Cliente ID ${clientId}: ${e.message}`);
        }
    }
  }

  await client.update({
    googleAccessToken: null,
    googleRefreshToken: null,
    googleTokenExpiryDate: null,
    isGoogleCalendarSynced: false,
    googleCalendarIdPrincipal: null,
  });
  logger.info(`Conta Google desconectada para Cliente ID ${clientId}.`);
}

/**
 * Obtém uma instância autenticada do cliente OAuth2 para fazer chamadas à API do Google.
 * Lida com o refresh do token de acesso se necessário.
 * @param {number} clientId - ID do cliente do seu sistema.
 * @returns {Promise<google.auth.OAuth2|null>} Cliente OAuth2 autenticado ou null.
 */
async function getAuthenticatedClient(clientId) {
  const clientRecord = await Client.scope('withGoogleTokens').findByPk(clientId);
  if (!clientRecord || !clientRecord.isGoogleCalendarSynced || !clientRecord.googleAccessToken) {
    logger.warn(`[GoogleAuthService] Cliente ID ${clientId} não encontrado, não sincronizado ou sem access token.`);
    return null;
  }

  const localOAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  
  const accessToken = decrypt(clientRecord.googleAccessToken);
  const refreshToken = clientRecord.googleRefreshToken ? decrypt(clientRecord.googleRefreshToken) : null;

  if (!accessToken) {
      logger.error(`[GoogleAuthService] Falha ao descriptografar access token para Cliente ID ${clientId}.`);
      await disconnectGoogleAccount(clientId); // Desconecta se não conseguir usar os tokens
      return null;
  }
  
  localOAuth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: clientRecord.googleTokenExpiryDate ? clientRecord.googleTokenExpiryDate.getTime() : null,
  });

  // Verifica se o token de acesso expirou ou está prestes a expirar
  if (localOAuth2Client.isTokenExpiring()) {
    logger.info(`[GoogleAuthService] Token de acesso para Cliente ID ${clientId} expirando. Tentando refresh...`);
    if (!refreshToken) {
      logger.error(`[GoogleAuthService] Refresh token ausente para Cliente ID ${clientId}. Não é possível renovar o access token.`);
      await disconnectGoogleAccount(clientId); // Se não pode renovar, desconecta.
      return null;
    }
    try {
      const { credentials } = await localOAuth2Client.refreshAccessToken();
      // Salva os novos tokens (o refresh token pode ou não ser retornado aqui)
      const newEncryptedAccessToken = credentials.access_token ? encrypt(credentials.access_token) : null;
      // O Google nem sempre retorna um novo refresh token. Se retornar, atualize.
      const newEncryptedRefreshToken = credentials.refresh_token ? encrypt(credentials.refresh_token) : clientRecord.googleRefreshToken;

      if (!newEncryptedAccessToken) throw new Error("Falha ao criptografar novo access_token após refresh.");

      await clientRecord.update({
        googleAccessToken: newEncryptedAccessToken,
        googleRefreshToken: newEncryptedRefreshToken,
        googleTokenExpiryDate: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      });
      localOAuth2Client.setCredentials(credentials); // Atualiza o cliente local com os novos tokens
      logger.info(`[GoogleAuthService] Token de acesso atualizado para Cliente ID ${clientId}.`);
    } catch (refreshError) {
      logger.error(`[GoogleAuthService] Erro ao tentar atualizar token de acesso para Cliente ID ${clientId}: ${refreshError.message}`, {details: refreshError.response?.data});
      // Se o refresh token for inválido (ex: revogado pelo usuário), desconecta.
      if (refreshError.response && (refreshError.response.data.error === 'invalid_grant' || refreshError.response.data.error === 'unauthorized_client')) {
        logger.warn(`[GoogleAuthService] Refresh token inválido para Cliente ID ${clientId}. Desconectando...`);
        await disconnectGoogleAccount(clientId);
      }
      return null;
    }
  }
  return localOAuth2Client;
}

/**
 * Obtém o status da sincronização com o Google Calendar para um cliente.
 * @param {number} clientId - ID do cliente do seu sistema.
 * @returns {Promise<object>}
 */
async function getSyncStatus(clientId) {
    const client = await Client.findByPk(clientId);
    if (!client) {
        throw new Error(`Cliente ID ${clientId} não encontrado.`);
    }
    return {
        isGoogleCalendarSynced: client.isGoogleCalendarSynced,
        googleCalendarIdPrincipal: client.googleCalendarIdPrincipal,
        lastTokenExpiry: client.googleTokenExpiryDate,
        colorIdPF: client.googleCalendarColorIdPF,
        colorIdPJ: client.googleCalendarColorIdPJ,
    };
}


module.exports = {
  getGoogleAuthUrl,
  handleGoogleCallback,
  disconnectGoogleAccount,
  getAuthenticatedClient, // Será usado pelo GoogleCalendarService
  getSyncStatus,
};
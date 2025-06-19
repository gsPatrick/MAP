// src/services/googleCalendarService.js
const { google } = require('googleapis');
const logger = require('../../utils/logger');
const googleAuthService = require('../GoogleAuth/googleAuth.service');
const { Client, FinancialAccount } = require('../../database'); // Adicionado FinancialAccount
const crypto = require('crypto');

const calendar = google.calendar('v3');
const WEBHOOK_URL = `${process.env.API_BASE_URL || 'https://geral-agentewhatsappapi.r954jc.easypanel.host'}/api/webhooks/google-calendar`;

function mapToGoogleEvent(appointmentSystem, financialAccount, clientRecord) {
  const eventStartDateTime = new Date(appointmentSystem.eventDateTime);
  let eventEndDateTime = appointmentSystem.durationMinutes && appointmentSystem.durationMinutes > 0
    ? new Date(eventStartDateTime.getTime() + appointmentSystem.durationMinutes * 60000)
    : new Date(eventStartDateTime.getTime() + 60 * 60000);

  let eventTitle = appointmentSystem.title;
  let colorIdToUse = null;

  // <<< LÓGICA ATUALIZADA DE TÍTULO E COR >>>
  if (financialAccount.accountType === 'PF') {
    eventTitle = `[Pessoal] ${appointmentSystem.title}`;
    colorIdToUse = clientRecord.googleCalendarColorIdPF || '1'; // Azul, por exemplo
  } else if (financialAccount.accountType === 'PJ' || financialAccount.accountType === 'MEI') {
    eventTitle = `[${financialAccount.accountName}] ${appointmentSystem.title}`;
    colorIdToUse = clientRecord.googleCalendarColorIdPJ || '2'; // Verde, por exemplo
  }

  // <<< NOVA LÓGICA PARA STATUS 'Completed' >>>
  // Se o agendamento estiver concluído, adicionamos um emoji e mudamos a cor para cinza.
  if (appointmentSystem.status === 'Completed') {
      eventTitle = `✅ ${eventTitle}`;
      colorIdToUse = '8'; // Cinza no Google Calendar
  }

  // <<< NOVA LÓGICA DE DESCRIÇÃO >>>
  let description = appointmentSystem.description || '';
  
  // Adiciona a lista de serviços prestados
  if (appointmentSystem.services && appointmentSystem.services.length > 0) {
      description += `\n\n--- Serviços Prestados ---\n`;
      const totalValue = appointmentSystem.services.reduce((sum, s) => sum + parseFloat(s.price), 0);
      appointmentSystem.services.forEach(service => {
          description += `- ${service.name} (${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(service.price)})\n`;
      });
      description += `Valor Total: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalValue)}`;
  }

  // Adiciona a lista de clientes do negócio
  if ((financialAccount.accountType === 'PJ' || financialAccount.accountType === 'MEI') && appointmentSystem.businessClients?.length > 0) {
    description += `\n\n--- Participantes do Negócio ---\n`;
    appointmentSystem.businessClients.forEach(bc => {
      description += `- ${bc.name}\n`;
    });
  }

  // Adiciona as observações internas
  if (appointmentSystem.notes) {
      description += `\n\n--- Observações Internas ---\n${appointmentSystem.notes}`;
  }

  description = description.trim();

  // <<< NOVA LÓGICA PARA PARTICIPANTES (ATTENDEES) >>>
  const attendees = [];
  if ((financialAccount.accountType === 'PJ' || financialAccount.accountType === 'MEI') && appointmentSystem.businessClients?.length > 0) {
      appointmentSystem.businessClients.forEach(bc => {
          if (bc.email) attendees.push({ email: bc.email, displayName: bc.name });
      });
  }

  // <<< LÓGICA ATUALIZADA DE MAPEAMENTO DE STATUS >>>
  let googleStatus = 'confirmed'; // Padrão para eventos visíveis
  if (appointmentSystem.status === 'Cancelled') {
      googleStatus = 'cancelled';
  }
  // Note: 'Scheduled', 'Confirmed', e 'Completed' mapeiam para 'confirmed' no Google,
  // mas diferenciamos 'Completed' visualmente com o título e a cor.

  const googleEvent = {
    summary: eventTitle,
    description: description || null,
    location: appointmentSystem.location || null,
    start: { dateTime: eventStartDateTime.toISOString(), timeZone: process.env.TZ || 'America/Sao_Paulo' },
    end: { dateTime: eventEndDateTime.toISOString(), timeZone: process.env.TZ || 'America/Sao_Paulo' },
    colorId: colorIdToUse,
    extendedProperties: {
      private: {
        systemAppointmentId: String(appointmentSystem.id),
        financialAccountId: String(financialAccount.id),
        systemAccountType: financialAccount.accountType,
        systemStatus: appointmentSystem.status, // Adiciona nosso status interno para referência
        managedBySystem: 'true',
      }
    },
    status: googleStatus,
  };

  if (attendees.length > 0) {
      googleEvent.attendees = attendees;
  }

  return googleEvent;
}


async function createGoogleEvent(systemClientId, appointmentSystem) {
  try {
    const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
    if (!authClient) return null;
    const clientRecord = await Client.findByPk(systemClientId);
    if (!clientRecord || !clientRecord.isGoogleCalendarSynced) return null;
    const financialAccount = appointmentSystem.financialAccount;
    if (!financialAccount) return null;

    const eventPayload = mapToGoogleEvent(appointmentSystem, financialAccount, clientRecord);
    const calendarId = clientRecord.googleCalendarIdPrincipal || 'primary';
    logger.info(`[GoogleCalendarService] Criando evento Google para Appt ID ${appointmentSystem.id}.`);
    const response = await calendar.events.insert({
      auth: authClient, calendarId, requestBody: eventPayload,
      sendNotifications: eventPayload.attendees?.length > 0,
    });
    logger.info(`[GoogleCalendarService] Evento Google criado: ${response.data.id} para Appt ID ${appointmentSystem.id}.`);
    return response.data;
  } catch (error) {
    logger.error(`[GoogleCalendarService] Erro ao criar evento Google para Appt ${appointmentSystem.id} (Cliente ${systemClientId}): ${error.message}`, { details: error.response?.data });
    if (error.response?.status === 401) {
        await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao desconectar ${systemClientId}: ${e.message}`));
    }
    return null;
  }
}

async function updateGoogleEvent(systemClientId, googleEventIdToUpdate, appointmentSystem) {
  if (!googleEventIdToUpdate) return createGoogleEvent(systemClientId, appointmentSystem);
  try {
    const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
    if (!authClient) return null;
    const clientRecord = await Client.findByPk(systemClientId);
    if (!clientRecord || !clientRecord.isGoogleCalendarSynced) return null;
    // Precisa do FinancialAccount para determinar a cor e o prefixo do título
    const financialAccount = appointmentSystem.financialAccount || await FinancialAccount.findByPk(appointmentSystem.financialAccountId);
    if (!financialAccount) {
        logger.error(`[GoogleCalendarService] FinancialAccount não encontrada para Appt ID ${appointmentSystem.id} ao tentar atualizar evento Google ${googleEventIdToUpdate}.`);
        return null;
    }

    const eventPayload = mapToGoogleEvent(appointmentSystem, financialAccount, clientRecord);
    const calendarId = clientRecord.googleCalendarIdPrincipal || 'primary';
    logger.info(`[GoogleCalendarService] Atualizando evento Google ${googleEventIdToUpdate} para Appt ID ${appointmentSystem.id}.`);

    // Se o status for 'cancelled' no sistema, mas o evento já foi deletado no Google,
    // a API retornará 410 (Gone). Precisamos tratar isso.
    if (appointmentSystem.status === 'Cancelled' && googleEventIdToUpdate) {
        try {
            const existingGoogleEvent = await getGoogleEventDetails(systemClientId, googleEventIdToUpdate);
            if (existingGoogleEvent && existingGoogleEvent.status === 'cancelled') {
                logger.info(`[GoogleCalendarService] Evento ${googleEventIdToUpdate} já está cancelado no Google. Nenhuma atualização necessária.`);
                return existingGoogleEvent;
            }
        } catch (getErr) {
            if (getErr.response?.status === 410 || getErr.response?.status === 404) {
                 logger.info(`[GoogleCalendarService] Evento ${googleEventIdToUpdate} não existe mais no Google (status 410/404) ao tentar marcá-lo como cancelado. Considerar como já tratado.`);
                 return { id: googleEventIdToUpdate, status: 'cancelled' }; // Simula um evento cancelado
            }
            // Outros erros ao buscar o evento
            throw getErr;
        }
    }


    const response = await calendar.events.update({
      auth: authClient, calendarId, eventId: googleEventIdToUpdate, requestBody: eventPayload,
      sendNotifications: eventPayload.attendees?.length > 0,
    });
    logger.info(`[GoogleCalendarService] Evento Google ${googleEventIdToUpdate} atualizado.`);
    return response.data;
  } catch (error) {
    logger.error(`[GoogleCalendarService] Erro ao atualizar evento Google ${googleEventIdToUpdate} (Appt ${appointmentSystem.id}, Cliente ${systemClientId}): ${error.message}`, { details: error.response?.data });
    if (error.response?.status === 404) {
        // Se o evento não foi encontrado para atualizar, e o appointment no sistema não está cancelado,
        // pode ser que o evento foi deletado no Google. Recriamos.
        if (appointmentSystem.status !== 'Cancelled') {
            logger.warn(`[GoogleCalendarService] Evento ${googleEventIdToUpdate} não encontrado para atualização. Tentando recriar...`);
            return createGoogleEvent(systemClientId, appointmentSystem);
        } else {
            logger.info(`[GoogleCalendarService] Evento ${googleEventIdToUpdate} não encontrado para marcar como cancelado. Provavelmente já foi deletado do Google.`);
            return { id: googleEventIdToUpdate, status: 'cancelled' }; // Considera feito
        }
    }
    if (error.response?.status === 401) {
        await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao desconectar ${systemClientId}: ${e.message}`));
    }
    return null;
  }
}

async function deleteGoogleEvent(systemClientId, googleEventIdToDelete) {
  if (!googleEventIdToDelete) return false;
  try {
    const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
    if (!authClient) return false;
    const clientRecord = await Client.findByPk(systemClientId);
    if (!clientRecord || !clientRecord.isGoogleCalendarSynced) return false;
    const calendarId = clientRecord.googleCalendarIdPrincipal || 'primary';
    logger.info(`[GoogleCalendarService] Deletando evento Google ${googleEventIdToDelete} (Cliente ${systemClientId}).`);
    await calendar.events.delete({
      auth: authClient, calendarId, eventId: googleEventIdToDelete, sendNotifications: true,
    });
    logger.info(`[GoogleCalendarService] Evento Google ${googleEventIdToDelete} deletado.`);
    return true;
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 410) {
        logger.warn(`[GoogleCalendarService] Evento Google ${googleEventIdToDelete} não encontrado ou já deletado.`); return true;
    }
    logger.error(`[GoogleCalendarService] Erro ao deletar evento Google ${googleEventIdToDelete} (Cliente ${systemClientId}): ${error.message}`, { details: error.response?.data });
    if (error.response?.status === 401) {
        await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao desconectar ${systemClientId}: ${e.message}`));
    }
    return false;
  }
}

async function watchCalendar(systemClientId, calendarToWatchId) {
  try {
    const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
    if (!authClient) return null;
    const channelUuid = crypto.randomUUID();
    logger.info(`[GoogleCalendarService] Registrando watch: Calendário=${calendarToWatchId}, Cliente=${systemClientId}, ChannelUUID=${channelUuid}, WebhookURL=${WEBHOOK_URL}`);
    const response = await calendar.events.watch({
      auth: authClient, calendarId: calendarToWatchId,
      requestBody: { id: channelUuid, type: 'web_hook', address: WEBHOOK_URL },
    });
    logger.info(`[GoogleCalendarService] Watch registrado para Cliente ${systemClientId}:`, response.data);
    return response.data;
  } catch (error) {
    const errorDetails = error.response?.data?.error;
    logger.error(`[GoogleCalendarService] Erro ao registrar watch (Cliente ${systemClientId}): ${error.message}`, { details: error.response?.data });
    if (errorDetails?.errors?.[0]?.domain === 'push.webhook') {
        logger.error(`[GoogleCalendarService] ERRO DE DOMÍNIO DO WEBHOOK: ${errorDetails.errors[0].reason} - ${errorDetails.errors[0].message}. Verifique o domínio ${new URL(WEBHOOK_URL).hostname}.`);
    }
    if (error.response?.status === 401) {
        await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao desconectar ${systemClientId}: ${e.message}`));
    }
    return null;
  }
}

async function stopWatchingCalendar(systemClientId, channelId, resourceId) {
  try {
    const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
    if (!authClient) return false;
    logger.info(`[GoogleCalendarService] Parando watch: Channel=${channelId}, Resource=${resourceId}, Cliente=${systemClientId}`);
    await calendar.channels.stop({ auth: authClient, requestBody: { id: channelId, resourceId } });
    logger.info(`[GoogleCalendarService] Watch parado: Channel=${channelId}`);
    return true;
  } catch (error) {
    if (error.response && (error.response.status === 404 || error.response.status === 400)) {
        logger.warn(`[GoogleCalendarService] Watch channel ${channelId} não encontrado ao parar.`); return true;
    }
    logger.error(`[GoogleCalendarService] Erro ao parar watch ${channelId} (Cliente ${systemClientId}): ${error.message}`, { details: error.response?.data });
    if (error.response?.status === 401) {
        await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao desconectar ${systemClientId}: ${e.message}`));
    }
    return false;
  }
}

async function getGoogleEventDetails(systemClientId, googleEventId) {
    try {
        const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
        if (!authClient) return null;
        const clientRecord = await Client.findByPk(systemClientId);
        if (!clientRecord || !clientRecord.isGoogleCalendarSynced) return null;
        const calendarId = clientRecord.googleCalendarIdPrincipal || 'primary';
        const response = await calendar.events.get({ auth: authClient, calendarId, eventId: googleEventId });
        return response.data;
    } catch (error) {
        if (error.response && (error.response.status === 404 || error.response.status === 410)) {
            return { id: googleEventId, status: 'cancelled' }; // Simula um evento deletado
        }
        logger.error(`[GoogleCalendarService] Erro ao buscar evento Google ${googleEventId} (Cliente ${systemClientId}): ${error.message}`, { details: error.response?.data });
        if (error.response?.status === 401) {
           await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao desconectar ${systemClientId}: ${e.message}`));
        }
        return null;
    }
}

/**
 * Lista eventos do Google Calendar, opcionalmente usando um syncToken.
 * @param {number} systemClientId - ID do cliente do sistema.
 * @param {string|null} syncToken - Opcional. Token para sincronização incremental.
 * @returns {Promise<object|null>} Objeto com { items: [eventos], nextSyncToken: string } ou null.
 */
async function listGoogleEvents(systemClientId, syncToken = null) {
    try {
        const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
        if (!authClient) return null;

        const clientRecord = await Client.findByPk(systemClientId);
        if (!clientRecord || !clientRecord.isGoogleCalendarSynced) return null;
        const calendarId = clientRecord.googleCalendarIdPrincipal || 'primary';

        const requestParams = {
            auth: authClient,
            calendarId: calendarId,
            singleEvents: true,
            maxResults: 250,
        };

        if (syncToken) {
            requestParams.syncToken = syncToken;
            // NÃO DEFINA orderBy QUANDO USAR syncToken
        } else {
            const timeMin = new Date();
            timeMin.setDate(timeMin.getDate() - 30); // Ajuste conforme necessário para a janela de sync inicial
            requestParams.timeMin = timeMin.toISOString();
            requestParams.showDeleted = true;
            requestParams.orderBy = 'updated'; // 'orderBy' é permitido quando NÃO se usa syncToken
        }
        logger.info(`[GoogleCalendarService] Listando eventos para Cliente ${systemClientId}, Calendar ${calendarId}, syncToken: ${syncToken ? 'presente' : 'ausente'}`);
        // Log dos parâmetros para depuração
        logger.debug(`[GoogleCalendarService] Request params para events.list:`, requestParams);


        const response = await calendar.events.list(requestParams);

        logger.info(`[GoogleCalendarService] ${response.data.items?.length || 0} eventos retornados. nextSyncToken: ${response.data.nextSyncToken ? 'presente' : 'ausente'}`);
        return {
            items: response.data.items || [],
            nextSyncToken: response.data.nextSyncToken,
            nextPageToken: response.data.nextPageToken,
        };

    } catch (error) {
        if (error.response && error.response.status === 410 && error.response.data?.error?.errors?.[0]?.reason === 'fullSyncRequired') {
            logger.warn(`[GoogleCalendarService] SyncToken inválido para Cliente ${systemClientId}. Requer sincronização completa.`);
            await Client.update({ googleLastSyncToken: null }, { where: { id: systemClientId }});
            return listGoogleEvents(systemClientId, null); // Tenta novamente sem syncToken
        }
        logger.error(`[GoogleCalendarService] Erro ao listar eventos Google (Cliente ${systemClientId}): ${error.message}`, {
             message: error.message,
             code: error.response?.data?.error?.code,
             errors: error.response?.data?.error?.errors,
             details: error.response?.data
        });
        if (error.response?.status === 401) {
           await googleAuthService.disconnectGoogleAccountTokens(systemClientId).catch(e => logger.error(`Falha ao desconectar ${systemClientId}: ${e.message}`));
        }
        return null; // Retorna null para indicar falha na listagem
    }
}


module.exports = {
  createGoogleEvent, updateGoogleEvent, deleteGoogleEvent,
  watchCalendar, stopWatchingCalendar, getGoogleEventDetails,
  listGoogleEvents, // <<< ADICIONADO
};
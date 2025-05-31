// src/services/googleCalendarService.js
const { google } = require('googleapis');
const logger = require('../../utils/logger');
const googleAuthService = require('../../features/GoogleAuth/googleAuth.service');
const { FinancialAccount, Client, BusinessClient } = require('../../database/'); // Importar modelos necessários

const calendar = google.calendar('v3');

/**
 * Mapeia dados do Appointment do sistema para o formato de evento do Google Calendar.
 * @param {object} appointmentSystem - O objeto Appointment do seu sistema.
 * @param {object} financialAccount - O objeto FinancialAccount associado.
 * @param {object} clientRecord - O objeto Client (dono da conta Google).
 * @returns {object} Objeto de evento formatado para a API do Google Calendar.
 */
function mapToGoogleEvent(appointmentSystem, financialAccount, clientRecord) {
  const eventStartDateTime = new Date(appointmentSystem.eventDateTime);
  let eventEndDateTime;

  if (appointmentSystem.durationMinutes && appointmentSystem.durationMinutes > 0) {
    eventEndDateTime = new Date(eventStartDateTime.getTime() + appointmentSystem.durationMinutes * 60000);
  } else {
    // Se não houver duração, define um padrão (ex: 1 hora) ou o mesmo que o início (evento de dia inteiro, mas dateTime sugere horário)
    eventEndDateTime = new Date(eventStartDateTime.getTime() + 60 * 60000); // Padrão de 1 hora
  }

  let eventTitle = appointmentSystem.title;
  let colorIdToUse = null;

  if (financialAccount.accountType === 'PF') {
    eventTitle = `[Pessoal] ${appointmentSystem.title}`;
    colorIdToUse = clientRecord.googleCalendarColorIdPF || '1'; // Default '1' (Azul) se não configurado
  } else if (financialAccount.accountType === 'PJ' || financialAccount.accountType === 'MEI') {
    eventTitle = `[${financialAccount.accountName}] ${appointmentSystem.title}`;
    colorIdToUse = clientRecord.googleCalendarColorIdPJ || '2'; // Default '2' (Verde) se não configurado
  }

  let description = appointmentSystem.description || '';
  if (appointmentSystem.notes) {
    description += `\n\n--- Observações Internas ---\n${appointmentSystem.notes}`;
  }

  const attendees = [];
  if ((financialAccount.accountType === 'PJ' || financialAccount.accountType === 'MEI') && appointmentSystem.businessClients && appointmentSystem.businessClients.length > 0) {
    description += `\n\n--- Participantes do Negócio ---`;
    appointmentSystem.businessClients.forEach(bc => {
      description += `\n- ${bc.name}`;
      if (bc.email) {
        attendees.push({ email: bc.email, displayName: bc.name });
      }
    });
  }
  description = description.trim();

  const googleEvent = {
    summary: eventTitle,
    description: description || null, // API espera null se vazio, não string vazia
    location: appointmentSystem.location || null,
    start: {
      dateTime: eventStartDateTime.toISOString(),
      timeZone: process.env.TZ || 'America/Sao_Paulo', // Usar o fuso horário da sua aplicação
    },
    end: {
      dateTime: eventEndDateTime.toISOString(),
      timeZone: process.env.TZ || 'America/Sao_Paulo',
    },
    colorId: colorIdToUse,
    extendedProperties: {
      private: { // Propriedades privadas não são visíveis para outros participantes do evento
        systemAppointmentId: String(appointmentSystem.id),
        financialAccountId: String(financialAccount.id),
        systemAccountType: financialAccount.accountType,
        managedBySystem: 'true', // Usar string 'true' é mais seguro
      }
    },
    // Se quiser enviar convites, defina sendNotifications: true
    // sendNotifications: attendees.length > 0,
  };

  if (attendees.length > 0) {
    googleEvent.attendees = attendees;
  }
  
  // Mapear status
  // 'Cancelled' no sistema -> 'cancelled' no Google
  // Outros status (Scheduled, Confirmed, Completed, Rescheduled) -> 'confirmed' no Google por padrão
  // 'Completed' poderia ter um tratamento especial (ex: prefixo no título) se desejado.
  if (appointmentSystem.status === 'Cancelled') {
    googleEvent.status = 'cancelled';
  } else {
    googleEvent.status = 'confirmed'; // Default para outros status
  }


  return googleEvent;
}


/**
 * Cria um evento no Google Calendar.
 * @param {number} systemClientId - ID do cliente do sistema.
 * @param {object} appointmentSystem - O objeto Appointment completo do seu sistema, incluindo financialAccount e businessClients.
 * @returns {Promise<object|null>} O objeto do evento criado pelo Google ou null em caso de erro.
 */
async function createGoogleEvent(systemClientId, appointmentSystem) {
  try {
    const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
    if (!authClient) {
      logger.warn(`[GoogleCalendarService] Cliente OAuth não autenticado para systemClientId: ${systemClientId}. Não é possível criar evento.`);
      return null;
    }

    const clientRecord = await Client.findByPk(systemClientId);
    if (!clientRecord || !clientRecord.isGoogleCalendarSynced) {
        logger.warn(`[GoogleCalendarService] Sincronização desativada ou cliente não encontrado para systemClientId: ${systemClientId}.`);
        return null;
    }
    
    const financialAccount = appointmentSystem.financialAccount; // Deve vir populado
    if (!financialAccount) {
        logger.error(`[GoogleCalendarService] FinancialAccount não encontrada no appointmentSystem para criação do evento Google. Appointment ID: ${appointmentSystem.id}`);
        return null;
    }

    const eventPayload = mapToGoogleEvent(appointmentSystem, financialAccount, clientRecord);
    const calendarId = clientRecord.googleCalendarIdPrincipal || 'primary';

    logger.info(`[GoogleCalendarService] Criando evento no Google Calendar para Appointment ID ${appointmentSystem.id} (Cliente ID: ${systemClientId}, Calendário: ${calendarId}). Payload:`, JSON.stringify(eventPayload).substring(0, 500) + "...");

    const response = await calendar.events.insert({
      auth: authClient,
      calendarId: calendarId,
      requestBody: eventPayload,
      sendNotifications: eventPayload.attendees && eventPayload.attendees.length > 0, // Envia notificação se houver convidados
    });

    logger.info(`[GoogleCalendarService] Evento criado no Google Calendar com ID: ${response.data.id} para Appointment ID ${appointmentSystem.id}.`);
    return response.data; // Retorna o objeto completo do evento do Google
  } catch (error) {
    logger.error(`[GoogleCalendarService] Erro ao criar evento no Google Calendar para Appointment ID ${appointmentSystem.id} (Cliente ${systemClientId}): ${error.message}`, {
      errorMessage: error.message,
      response: error.response?.data,
      stack: error.stack?.substring(0, 500),
    });
    // Se o erro for de autenticação (401), pode ser útil tentar desconectar a conta para forçar reconexão.
    if (error.response && error.response.status === 401) {
        logger.warn(`[GoogleCalendarService] Erro 401 ao criar evento. Possível token inválido para cliente ${systemClientId}. Tentando desconectar...`);
        await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao tentar desconectar cliente ${systemClientId} após erro 401: ${e.message}`));
    }
    return null;
  }
}

/**
 * Atualiza um evento existente no Google Calendar.
 * @param {number} systemClientId - ID do cliente do sistema.
 * @param {string} googleEventIdToUpdate - ID do evento no Google Calendar.
 * @param {object} appointmentSystem - O objeto Appointment completo do seu sistema.
 * @returns {Promise<object|null>} O objeto do evento atualizado do Google ou null.
 */
async function updateGoogleEvent(systemClientId, googleEventIdToUpdate, appointmentSystem) {
  if (!googleEventIdToUpdate) {
    logger.warn(`[GoogleCalendarService] googleEventId não fornecido para atualização. Appointment ID ${appointmentSystem.id}. Tentando criar novo evento...`);
    return createGoogleEvent(systemClientId, appointmentSystem); // Tenta criar se não havia ID
  }
  try {
    const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
    if (!authClient) return null;

    const clientRecord = await Client.findByPk(systemClientId);
     if (!clientRecord || !clientRecord.isGoogleCalendarSynced) return null;

    const financialAccount = appointmentSystem.financialAccount;
    if (!financialAccount) {
        logger.error(`[GoogleCalendarService] FinancialAccount não encontrada no appointmentSystem para atualização do evento Google. GoogleEventID: ${googleEventIdToUpdate}`);
        return null;
    }

    const eventPayload = mapToGoogleEvent(appointmentSystem, financialAccount, clientRecord);
    const calendarId = clientRecord.googleCalendarIdPrincipal || 'primary';

    logger.info(`[GoogleCalendarService] Atualizando evento ${googleEventIdToUpdate} no Google Calendar para Appointment ID ${appointmentSystem.id} (Cliente ID: ${systemClientId}).`);

    const response = await calendar.events.update({
      auth: authClient,
      calendarId: calendarId,
      eventId: googleEventIdToUpdate,
      requestBody: eventPayload,
      sendNotifications: eventPayload.attendees && eventPayload.attendees.length > 0,
    });

    logger.info(`[GoogleCalendarService] Evento ${googleEventIdToUpdate} atualizado no Google Calendar.`);
    return response.data;
  } catch (error) {
    logger.error(`[GoogleCalendarService] Erro ao atualizar evento ${googleEventIdToUpdate} no Google Calendar para Appointment ID ${appointmentSystem.id} (Cliente ${systemClientId}): ${error.message}`, {
        errorMessage: error.message, response: error.response?.data
    });
     if (error.response && error.response.status === 404) { // Evento não encontrado no Google
        logger.warn(`[GoogleCalendarService] Evento ${googleEventIdToUpdate} não encontrado no Google para atualização. Tentando criar um novo...`);
        return createGoogleEvent(systemClientId, appointmentSystem);
    } else if (error.response && error.response.status === 401) {
        await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao tentar desconectar cliente ${systemClientId}: ${e.message}`));
    }
    return null;
  }
}

/**
 * Deleta um evento do Google Calendar.
 * @param {number} systemClientId - ID do cliente do sistema.
 * @param {string} googleEventIdToDelete - ID do evento no Google Calendar.
 * @returns {Promise<boolean>} True se bem-sucedido, false caso contrário.
 */
async function deleteGoogleEvent(systemClientId, googleEventIdToDelete) {
  if (!googleEventIdToDelete) {
    logger.warn(`[GoogleCalendarService] Tentativa de deletar evento Google sem googleEventId (Cliente ${systemClientId}).`);
    return false; // Não há o que deletar
  }
  try {
    const authClient = await googleAuthService.getAuthenticatedClient(systemClientId);
    if (!authClient) return false;
    
    const clientRecord = await Client.findByPk(systemClientId);
    if (!clientRecord || !clientRecord.isGoogleCalendarSynced) return false;

    const calendarId = clientRecord.googleCalendarIdPrincipal || 'primary';
    logger.info(`[GoogleCalendarService] Deletando evento ${googleEventIdToDelete} do Google Calendar (Cliente ID: ${systemClientId}).`);

    await calendar.events.delete({
      auth: authClient,
      calendarId: calendarId,
      eventId: googleEventIdToDelete,
      sendNotifications: true, // Notifica participantes se houver
    });

    logger.info(`[GoogleCalendarService] Evento ${googleEventIdToDelete} deletado do Google Calendar.`);
    return true;
  } catch (error) {
    if (error.response && error.response.status === 404) {
        logger.warn(`[GoogleCalendarService] Evento ${googleEventIdToDelete} não encontrado no Google para exclusão (Cliente ${systemClientId}). Já pode ter sido removido.`);
        return true; // Considera sucesso se não achou pra deletar
    } else if (error.response && error.response.status === 410) { // Gone (já deletado)
        logger.warn(`[GoogleCalendarService] Evento ${googleEventIdToDelete} já está marcado como deletado no Google (Cliente ${systemClientId}).`);
        return true;
    }
    logger.error(`[GoogleCalendarService] Erro ao deletar evento ${googleEventIdToDelete} do Google Calendar (Cliente ${systemClientId}): ${error.message}`, {
        errorMessage: error.message, response: error.response?.data
    });
    if (error.response && error.response.status === 401) {
        await googleAuthService.disconnectGoogleAccount(systemClientId).catch(e => logger.error(`Falha ao tentar desconectar cliente ${systemClientId}: ${e.message}`));
    }
    return false;
  }
}

module.exports = {
  createGoogleEvent,
  updateGoogleEvent,
  deleteGoogleEvent,
  // Futuramente: listGoogleEvents, getGoogleEvent, watchGoogleCalendar
};
// src/features/Appointment/appointment.service.js
const { Appointment, FinancialAccount, Client, UserPreference, BusinessClient, AppointmentBusinessClient, Service, AppointmentService, AvailabilityRule, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const googleCalendarService = require('../../features/GoogleCalendar/googleCalendarService');
const businessClientService = require('../BusinessClient/BusinessClient.service');
const financialService = require('../Financial/financial.service');
const { sendWhatsappMessage } = require('../../services/whatsappService'); // sendButtonListMessage não é usado diretamente aqui
const formatter = require('../WhatsappHandler/response.formatter');
const aiModelService = require('../../services/aiModelService');
const { RRule } = require('rrule');

const BUSINESS_CLIENT_INCLUDE_ATTRIBUTES = ['id', 'name', 'phone', 'email', 'photoUrl', 'notes'];
const SERVICE_INCLUDE_ATTRIBUTES = ['id', 'name', 'price', 'durationMinutes', 'description'];

async function validateOwningFinancialAccount(financialAccountId, transaction = null, includeClient = true) {
  const includeOptions = [];
  if (includeClient) includeOptions.push({ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone', 'email', 'isGoogleCalendarSynced', 'googleCalendarIdPrincipal', 'googleCalendarColorIdPF', 'googleCalendarColorIdPJ'] }); // Adicionado email e prefs de calendário

  const account = await FinancialAccount.findByPk(financialAccountId, {
    include: includeOptions,
    transaction
  });
  if (!account) {
    const error = new Error(`Conta Financeira com ID ${financialAccountId} não encontrada.`);
    error.statusCode = 404; error.status = 'fail'; throw error;
  }
  if (!account.isActive) {
    const error = new Error(`A Conta Financeira ID ${financialAccountId} ("${account.accountName}") está inativa.`);
    error.statusCode = 403; error.status = 'fail'; throw error;
  }
  return account;
}

async function scheduleAppointment(financialAccountId, appointmentData, actorId = null) {
  const t = await sequelize.transaction();
  let newAppointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true);

    if (!appointmentData.title || !appointmentData.eventDateTime) {
      const error = new Error('Título e Data/Hora do Evento são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    if (account.accountType === 'PF') {
        if (appointmentData.reminderEnabled !== false && appointmentData.reminderLeadTimeMinutes === undefined) {
            const preferences = await UserPreference.findOne({ where: { clientId: account.clientId }, order: [['id', 'ASC']], transaction: t });
            appointmentData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
        } else if (appointmentData.reminderEnabled === false) {
            appointmentData.reminderLeadTimeMinutes = null;
            appointmentData.reminderSentTimestamp = null;
        }
        appointmentData.origin = appointmentData.origin || 'system_pf';
    } else {
        appointmentData.origin = appointmentData.origin || 'system_pj_mei';
        appointmentData.reminderEnabled = false;
        appointmentData.reminderLeadTimeMinutes = null;
        appointmentData.reminderSentTimestamp = null;

        const businessClientIds = appointmentData.businessClientIds;
        if (businessClientIds && Array.isArray(businessClientIds) && businessClientIds.length > 0) {
            const validClients = await BusinessClient.findAll({
                where: { id: { [Op.in]: businessClientIds }, financialAccountId, isActive: true },
                transaction: t
            });
            if (validClients.length !== businessClientIds.length) {
                const missingIds = businessClientIds.filter(id => !validClients.some(client => client.id === id));
                const error = new Error(`Um ou mais Clientes de Negócio (IDs: ${missingIds.join(', ')}) não foram encontrados ou não pertencem a esta conta.`);
                error.statusCode = 404; error.status = 'fail'; throw error;
            }
        }

        const serviceIds = appointmentData.serviceIds;
        if (!serviceIds || !Array.isArray(serviceIds) || serviceIds.length === 0) {
            const error = new Error('Para agendamentos de contas PJ/MEI, pelo menos um serviço deve ser associado.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        const validServices = await Service.findAll({
            where: { id: { [Op.in]: serviceIds }, financialAccountId, isActive: true },
            transaction: t
        });
        if (validServices.length !== serviceIds.length) {
            const missingIds = serviceIds.filter(id => !validServices.some(service => service.id === id));
            const error = new Error(`Um ou mais Serviços (IDs: ${missingIds.join(', ')}) não foram encontrados, estão inativos ou não pertencem a esta conta.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        if (!appointmentData.durationMinutes) {
          const totalDuration = validServices.reduce((sum, service) => sum + service.durationMinutes, 0);
          appointmentData.durationMinutes = totalDuration > 0 ? totalDuration : 30;
        }
    }

    newAppointment = await Appointment.create(
      { ...appointmentData, financialAccountId, createdByClientId: actorId }, // Salva quem criou
      { transaction: t }
    );

    if (account.accountType !== 'PF') {
        if (appointmentData.businessClientIds && appointmentData.businessClientIds.length > 0) {
            const clientAssociations = appointmentData.businessClientIds.map(bcId => ({
                appointmentId: newAppointment.id, businessClientId: bcId
            }));
            await AppointmentBusinessClient.bulkCreate(clientAssociations, { transaction: t });
        }

        if (appointmentData.serviceIds && appointmentData.serviceIds.length > 0) {
            const servicesToAssociate = await Service.findAll({
                where: { id: { [Op.in]: appointmentData.serviceIds }, financialAccountId },
                attributes: ['id', 'price'],
                transaction: t
            });

            const serviceAssociations = servicesToAssociate.map(service => ({
                appointmentId: newAppointment.id,
                serviceId: service.id,
                priceAtTimeOfBooking: service.price,
                quantity: 1
            }));
            await AppointmentService.bulkCreate(serviceAssociations, { transaction: t });
        }
    }

    await t.commit();
    logger.info(`Compromisso "${newAppointment.title}" (ID: ${newAppointment.id}) agendado para FA ID ${financialAccountId}. Origem: ${newAppointment.origin}. Criado por Cliente ID: ${actorId}`);

    const reloadedApptForNotifications = await Appointment.findByPk(newAppointment.id, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone', 'email']}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
            { model: Service, as: 'services', through: { attributes: ['priceAtTimeOfBooking'] }, attributes: SERVICE_INCLUDE_ATTRIBUTES }
        ]
    });

    if (!reloadedApptForNotifications) {
        logger.error(`Falha ao recarregar o compromisso ID ${newAppointment.id} após a criação para notificações.`);
        return newAppointment.toJSON();
    }

    let notificationPayload = null;

    if (account.accountType !== 'PF' &&
        account.ownerClient?.phone &&
        reloadedApptForNotifications.status === 'Scheduled' &&
        (newAppointment.origin === 'public_booking' || newAppointment.origin === 'api_external')) {

        const ownerClient = account.ownerClient;
        const ownerName = ownerClient.name ? ownerClient.name.split(' ')[0] : 'Você';

        const creativeIntro = await aiModelService.generateNewBookingNotification(ownerName, reloadedApptForNotifications.toJSON());
        const formattedDetails = formatter.formatAppointmentDataStructure(reloadedApptForNotifications.toJSON(), false, null, true);

        const messageText = `${creativeIntro}\n\n${formattedDetails}\n\nO que você gostaria de fazer?`;

        const buttons = [
            { id: `confirm_appointment:${financialAccountId}:${reloadedApptForNotifications.id}`, label: '✅ Confirmar Agendamento' },
            { id: `cancel_appointment:${financialAccountId}:${reloadedApptForNotifications.id}`, label: '❌ Rejeitar/Cancelar' }
        ];

        notificationPayload = {
            targetAccountId: financialAccountId,
            recipientPhone: ownerClient.phone,
            messageText: messageText,
            buttons: buttons,
            expectedActionPrefix: 'appointment_pj_confirm_cancel',
            relatedResourceId: reloadedApptForNotifications.id
        };
        logger.info(`[APPOINTMENT SERVICE] Payload de notificação com botões preparado para Appt ID ${reloadedApptForNotifications.id}`);
    }

    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced) {
        const googleEvent = await googleCalendarService.createGoogleEvent(account.ownerClient.id, reloadedApptForNotifications.toJSON());
        if (googleEvent && googleEvent.id) {
            const apptToUpdateGoogleFields = await Appointment.findByPk(newAppointment.id);
            if (apptToUpdateGoogleFields) {
                 await apptToUpdateGoogleFields.update({ googleEventId: googleEvent.id, googleEventLastUpdated: new Date(googleEvent.updated || googleEvent.created) });
            }
            logger.info(`Compromisso ID ${newAppointment.id} sincronizado com Google Calendar Event ID ${googleEvent.id}.`);
        }
    }

    const finalAppointmentJson = reloadedApptForNotifications.toJSON();
    if (notificationPayload) {
        finalAppointmentJson.pendingConfirmationNotification = notificationPayload;
    }
    return finalAppointmentJson;

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbError) { logger.error("Erro no rollback após falha em scheduleAppointment:", rbError); }
    }
    logger.error(`Erro ao agendar compromisso para FA ID ${financialAccountId}: ${error.message}`, { error, appointmentData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAllAppointments(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId, null, false);
    const {
      page = 1, limit = 10, dateStart, dateEnd, specificDate,
      status, search,
      sortBy = 'eventDateTime', sortOrder = 'ASC',
      period // Novo parâmetro para lidar com "hoje", "amanhã", etc.
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };
    const includeOptions = [
        { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES, required: false },
        { model: Service, as: 'services', through: { attributes: ['priceAtTimeOfBooking'] }, attributes: SERVICE_INCLUDE_ATTRIBUTES, required: false }
    ];

    if (status) whereConditions.status = status;

    let effectiveDateStart = dateStart;
    let effectiveDateEnd = dateEnd;
    let periodDescription = "Período Personalizado"; // Default

    if (specificDate) {
        effectiveDateStart = `${specificDate}T00:00:00.000Z`;
        effectiveDateEnd = new Date(new Date(specificDate).setDate(new Date(specificDate).getDate() + 1)).toISOString().split('T')[0] + 'T00:00:00.000Z';
        periodDescription = `Dia ${formatter.formatDate(specificDate)}`;
    } else if (period) {
        const today = new Date(); today.setHours(0,0,0,0);
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const endOfToday = new Date(today); endOfToday.setHours(23,59,59,999);
        const endOfTomorrow = new Date(tomorrow); endOfTomorrow.setHours(23,59,59,999);

        switch(period.toLowerCase()) {
            case 'hoje':
                effectiveDateStart = today.toISOString();
                effectiveDateEnd = endOfToday.toISOString();
                periodDescription = "Hoje";
                break;
            case 'amanha':
                effectiveDateStart = tomorrow.toISOString();
                effectiveDateEnd = endOfTomorrow.toISOString();
                periodDescription = "Amanhã";
                break;
            case 'esta_semana': {
                const firstDayOfWeek = new Date(today);
                firstDayOfWeek.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1)); // Ajuste para segunda
                const lastDayOfWeek = new Date(firstDayOfWeek);
                lastDayOfWeek.setDate(firstDayOfWeek.getDate() + 6);
                lastDayOfWeek.setHours(23,59,59,999);
                effectiveDateStart = firstDayOfWeek.toISOString();
                effectiveDateEnd = lastDayOfWeek.toISOString();
                periodDescription = "Esta Semana";
                break;
            }
            case 'proximos_7_dias': {
                const next7Days = new Date(today);
                next7Days.setDate(today.getDate() + 6);
                next7Days.setHours(23,59,59,999);
                effectiveDateStart = today.toISOString();
                effectiveDateEnd = next7Days.toISOString();
                periodDescription = "Próximos 7 Dias";
                break;
            }
            // Adicionar mais períodos se necessário
        }
    }

    if (effectiveDateStart) whereConditions.eventDateTime = { ...whereConditions.eventDateTime, [Op.gte]: new Date(effectiveDateStart) };
    if (effectiveDateEnd) {
        const endDateObj = new Date(effectiveDateEnd);
        if(!specificDate && !period?.toLowerCase().includes('hoje') && !period?.toLowerCase().includes('amanha')) { // Se não for data específica ou "hoje/amanhã", seta para fim do dia
            endDateObj.setUTCHours(23, 59, 59, 999);
        }
        whereConditions.eventDateTime = { ...whereConditions.eventDateTime, [Op.lte]: endDateObj };
    }


    if (search) {
      whereConditions[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
        { location: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];

    const { count, rows } = await Appointment.findAndCountAll({
      where: whereConditions,
      include: includeOptions,
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
      distinct: true,
    });

    if (!periodDescription && effectiveDateStart && effectiveDateEnd) {
        periodDescription = `De ${formatter.formatDate(effectiveDateStart)} a ${formatter.formatDate(effectiveDateEnd)}`;
    } else if (!periodDescription && effectiveDateStart) {
        periodDescription = `A partir de ${formatter.formatDate(effectiveDateStart)}`;
    } else if (!periodDescription && effectiveDateEnd) {
        periodDescription = `Até ${formatter.formatDate(effectiveDateEnd)}`;
    } else if (!periodDescription) {
        periodDescription = "Todo o período";
    }


    logger.info(`Listados ${rows.length} compromissos para FA ID ${financialAccountId} (Total: ${count}) para o período: ${periodDescription}`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      appointments: rows.map(a => a.toJSON()),
      periodDescription // Retornar a descrição do período para o formatador
    };
  } catch (error) {
    logger.error(`Erro ao listar compromissos para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAppointmentById(financialAccountId, appointmentId) {
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, null, true); // Garante que a conta do ownerClient seja carregada
    const appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [
         { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email', 'phone', 'isGoogleCalendarSynced', 'googleCalendarIdPrincipal', 'googleCalendarColorIdPF', 'googleCalendarColorIdPJ']}] },
         { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
         { model: Service, as: 'services', through: { attributes: ['priceAtTimeOfBooking'] }, attributes: SERVICE_INCLUDE_ATTRIBUTES }
      ]
    });

    if (!appointment) {
      logger.warn(`Compromisso ID ${appointmentId} não encontrado ou não pertence à FA ID ${financialAccountId}.`);
      return null;
    }
    return appointment.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar compromisso ID ${appointmentId} para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateAppointment(financialAccountId, appointmentId, updateData, actorId = null) {
  const t = await sequelize.transaction();
  let appointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true);
    appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [
          { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
          { model: BusinessClient, as: 'businessClients', through: { attributes: [] } },
          { model: Service, as: 'services', through: { attributes: ['priceAtTimeOfBooking', 'serviceId'] } } // Inclui serviceId para lógica de atualização
      ],
      transaction: t
    });
    if (!appointment) {
      await t.rollback();
      const err404 = new Error(`Compromisso ID ${appointmentId} não encontrado.`);
      err404.statusCode = 404; err404.status = 'fail'; throw err404; // corrigido err4_4
    }

    if (account.accountType !== 'PF') {
        if (updateData.hasOwnProperty('businessClientIds') && Array.isArray(updateData.businessClientIds)) {
            const businessClientIds = updateData.businessClientIds;
            if (businessClientIds.length > 0) {
                 const validClients = await BusinessClient.findAll({
                     where: { id: { [Op.in]: businessClientIds }, financialAccountId, isActive: true }, transaction: t
                 });
                 if (validClients.length !== businessClientIds.length) {
                     const missingIds = businessClientIds.filter(id => !validClients.some(client => client.id === id));
                     const error = new Error(`Um ou mais Clientes de Negócio (IDs: ${missingIds.join(', ')}) não pertencem a esta conta.`);
                     error.statusCode = 404; error.status = 'fail'; throw error;
                 }
            }
            await AppointmentBusinessClient.destroy({ where: { appointmentId: appointment.id }, transaction: t });
            if (businessClientIds.length > 0) {
                 const associations = businessClientIds.map(bcId => ({ appointmentId: appointment.id, businessClientId: bcId }));
                 await AppointmentBusinessClient.bulkCreate(associations, { transaction: t });
            }
        }
        if (updateData.hasOwnProperty('serviceIds') && Array.isArray(updateData.serviceIds)) {
             const serviceIds = updateData.serviceIds;
             if (serviceIds.length === 0) throw new Error("Agendamentos PJ/MEI devem ter pelo menos um serviço.");
             const validServices = await Service.findAll({
                where: { id: { [Op.in]: serviceIds }, financialAccountId, isActive: true }, transaction: t
             });
             if (validServices.length !== serviceIds.length) {
                const missingIds = serviceIds.filter(id => !validServices.some(s => s.id === id));
                const error = new Error(`Um ou mais Serviços (IDs: ${missingIds.join(', ')}) não pertencem a esta conta.`);
                error.statusCode = 404; error.status = 'fail'; throw error;
             }
             await AppointmentService.destroy({ where: { appointmentId: appointment.id }, transaction: t });

             const serviceAssociations = validServices.map(service => {
                // Tenta encontrar a associação existente para manter o preço original, se o serviço não mudou
                const existingAssociation = appointment.services.find(s => s.id === service.id);
                return {
                    appointmentId: appointment.id,
                    serviceId: service.id,
                    priceAtTimeOfBooking: existingAssociation?.AppointmentService?.priceAtTimeOfBooking || service.price || 0,
                    quantity: 1
                };
             });
             await AppointmentService.bulkCreate(serviceAssociations, { transaction: t });
        }
    } else {
        if (updateData.reminderEnabled === false) {
            updateData.reminderLeadTimeMinutes = null;
            updateData.reminderSentTimestamp = null;
        } else if (updateData.reminderEnabled === true && updateData.reminderLeadTimeMinutes === undefined && appointment.reminderLeadTimeMinutes === null) {
            const preferences = await UserPreference.findOne({ where: { clientId: account.clientId }, order: [['id', 'ASC']], transaction: t });
            updateData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
        } else if (updateData.hasOwnProperty('reminderLeadTimeMinutes') && updateData.reminderLeadTimeMinutes !== null) {
            updateData.reminderEnabled = true;
        }
    }

    const fieldsToUpdate = { ...updateData };
    delete fieldsToUpdate.financialAccountId;
    delete fieldsToUpdate.businessClientIds;
    delete fieldsToUpdate.serviceIds;
    fieldsToUpdate.updatedByClientId = actorId; // Salva quem atualizou

    const hasOtherUpdates = Object.keys(fieldsToUpdate).length > 0;
    if(hasOtherUpdates){
        await appointment.update(fieldsToUpdate, { transaction: t });
    }

    await t.commit();
    logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") atualizado para FA ID ${financialAccountId}. Atualizado por Cliente ID: ${actorId}`);

    const updatedAppointmentFull = await appointment.reload({
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email', 'phone', 'isGoogleCalendarSynced', 'googleCalendarIdPrincipal', 'googleCalendarColorIdPF', 'googleCalendarColorIdPJ']}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
            { model: Service, as: 'services', through: { attributes: ['priceAtTimeOfBooking'] }, attributes: SERVICE_INCLUDE_ATTRIBUTES }
        ]
    });

    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced) {
        const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, appointment.googleEventId, updatedAppointmentFull.toJSON());
        if (googleEvent && googleEvent.id) {
            const apptInstanceToUpdateGoogleFields = await Appointment.findByPk(appointment.id);
            if (apptInstanceToUpdateGoogleFields) {
                await apptInstanceToUpdateGoogleFields.update({ googleEventId: googleEvent.id, googleEventLastUpdated: new Date(googleEvent.updated) });
            }
            logger.info(`Compromisso ID ${appointmentId} atualizado e sincronizado com Google Calendar Event ID ${googleEvent.id}.`);
        }
    }
    return updatedAppointmentFull.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbError) { logger.error("Erro no rollback após falha em updateAppointment:", rbError); }
    }
    logger.error(`Erro ao atualizar compromisso ID ${appointmentId}: ${error.message}`, { errorJson: JSON.stringify(error, Object.getOwnPropertyNames(error)), updateDataSent: updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteOrCancelAppointment(financialAccountId, appointmentId, actuallyDelete = false, actorId = null) {
  const t = await sequelize.transaction();
  let appointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true);
    appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [
          { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient' }] },
          { model: BusinessClient, as: 'businessClients', attributes: ['name', 'phone'] },
          { model: Service, as: 'services', attributes: ['name', 'price'], through: {attributes: ['priceAtTimeOfBooking']} }
      ],
      transaction: t
    });
    if (!appointment) {
      await t.rollback();
      logger.warn(`Compromisso ID ${appointmentId} não encontrado para ${actuallyDelete ? 'exclusão' : 'cancelamento'} na FA ID ${financialAccountId}.`);
      const err404 = new Error(`Compromisso ID ${appointmentId} não encontrado.`);
      err404.statusCode = 404; err404.status = 'fail'; throw err404;
    }

    const googleEventIdToProcess = appointment.googleEventId;

    if (actuallyDelete) {
      await appointment.destroy({ transaction: t });
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") EXCLUÍDO da FA ID ${financialAccountId}. Excluído por Cliente ID: ${actorId}`);
    } else {
      await appointment.update({ status: 'Cancelled', updatedByClientId: actorId }, { transaction: t });
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") CANCELADO na FA ID ${financialAccountId}. Cancelado por Cliente ID: ${actorId}`);
    }
    await t.commit();

    const reloadedApptForNotify = await Appointment.findByPk(appointmentId, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient' }] },
            { model: BusinessClient, as: 'businessClients', attributes: ['name', 'phone'] },
            { model: Service, as: 'services', attributes: ['name', 'price'], through: {attributes: ['priceAtTimeOfBooking']} }
        ]
    });

    if (!actuallyDelete && reloadedApptForNotify && account.accountType !== 'PF' && reloadedApptForNotify.businessClients.length > 0) {
        for (const bClient of reloadedApptForNotify.businessClients) {
            if (bClient.phone) {
                const providerName = reloadedApptForNotify.financialAccount.accountName || reloadedApptForNotify.financialAccount.ownerClient.name;
                const cancellationMessage = await aiModelService.generateClientCancellationMessage(providerName, bClient.name, reloadedApptForNotify.toJSON());
                const finalMessage = `${cancellationMessage}\n\n---\nMensagem de *${providerName}* via MAP no Controle.`;
                await sendWhatsappMessage(bClient.phone, finalMessage);
            }
        }
    }

    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced && googleEventIdToProcess) {
        if (actuallyDelete) {
            await googleCalendarService.deleteGoogleEvent(account.ownerClient.id, googleEventIdToProcess);
        } else {
            if(reloadedApptForNotify) { // reloadedApptForNotify terá status: Cancelled
                const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, googleEventIdToProcess, reloadedApptForNotify.toJSON());
                 if (googleEvent && googleEvent.id) {
                    const apptInstanceToUpdate = await Appointment.findByPk(appointmentId);
                    if (apptInstanceToUpdate) await apptInstanceToUpdate.update({ googleEventLastUpdated: new Date(googleEvent.updated) });
                }
            }
        }
    }
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbError) { logger.error("Erro no rollback após falha em deleteOrCancelAppointment:", rbError); }
    }
    logger.error(`Erro ao ${actuallyDelete ? 'excluir' : 'cancelar'} compromisso ID ${appointmentId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function confirmAppointment(financialAccountId, appointmentId, actorId = null) {
    const t = await sequelize.transaction();
    try {
        const account = await validateOwningFinancialAccount(financialAccountId, t, true);
        if (account.accountType === 'PF') {
            throw { statusCode: 400, message: 'A confirmação de agendamentos é uma funcionalidade para contas PJ/MEI.' };
        }
        const appointment = await Appointment.findOne({
            where: { id: appointmentId, financialAccountId },
            include: [
                { model: Service, as: 'services', attributes: ['name', 'price'], through: {attributes: ['priceAtTimeOfBooking']} },
                { model: BusinessClient, as: 'businessClients', attributes: ['name', 'phone'] }
            ],
            transaction: t
        });
        if (!appointment) {
            throw { statusCode: 404, message: `Agendamento ID ${appointmentId} não encontrado.` };
        }
        if (appointment.status !== 'Scheduled') {
            throw { statusCode: 409, message: `Este agendamento não está no estado 'Agendado' e não pode ser confirmado. Status atual: ${appointment.status}` };
        }

        await appointment.update({ status: 'Confirmed', updatedByClientId: actorId }, { transaction: t });
        await t.commit();

        const confirmedAppointmentFull = await getAppointmentById(financialAccountId, appointmentId);
        if (!confirmedAppointmentFull) {
            logger.error(`Falha ao recarregar o agendamento ${appointmentId} após confirmação.`);
            return null;
        }

        if (confirmedAppointmentFull.businessClients && confirmedAppointmentFull.businessClients.length > 0) {
            for (const bClient of confirmedAppointmentFull.businessClients) {
                if (bClient.phone) {
                    const providerName = account.accountName || account.ownerClient.name;
                    const creativeMessage = await aiModelService.generateClientConfirmationMessage(providerName, bClient.name, confirmedAppointmentFull);
                    const formattedDetails = formatter.formatAppointmentDataStructure(confirmedAppointmentFull);
                    const finalMessage = `${creativeMessage}\n\n${formattedDetails}\n\n` +
                                         `---\n` +
                                         `Esta é uma mensagem automática do sistema MAP no Controle em nome de *${providerName}*.`;
                    await sendWhatsappMessage(bClient.phone, finalMessage);
                }
            }
        }

        if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced && confirmedAppointmentFull.googleEventId) {
             const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, confirmedAppointmentFull.googleEventId, confirmedAppointmentFull);
             if (googleEvent && googleEvent.id) {
                const apptToUpdateGCal = await Appointment.findByPk(confirmedAppointmentFull.id);
                if (apptToUpdateGCal) await apptToUpdateGCal.update({googleEventLastUpdated: new Date(googleEvent.updated)});
             }
        }
        logger.info(`Compromisso ID ${appointmentId} confirmado para FA ID ${financialAccountId}. Confirmado por Cliente ID: ${actorId}`);
        return confirmedAppointmentFull;

    } catch(error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao confirmar agendamento ${appointmentId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function completeAppointment(financialAccountId, appointmentId, actorId = null) {
    const t = await sequelize.transaction();
    try {
        const account = await validateOwningFinancialAccount(financialAccountId, t, true);
        if (account.accountType === 'PF') {
            throw { statusCode: 400, message: 'A conclusão de agendamentos é uma funcionalidade para contas PJ/MEI.' };
        }
        const appointment = await Appointment.findOne({
            where: { id: appointmentId, financialAccountId },
            include: [
                { model: Service, as: 'services', through: {attributes: ['priceAtTimeOfBooking']} },
                { model: BusinessClient, as: 'businessClients' }
            ],
            transaction: t
        });

        if (!appointment) {
            throw { statusCode: 404, message: `Agendamento ID ${appointmentId} não encontrado.` };
        }
        if (appointment.status !== 'Confirmed' && appointment.status !== 'Scheduled') {
            throw { statusCode: 409, message: `Este agendamento não pode ser concluído. Status atual: ${appointment.status}` };
        }
        if (!appointment.services || appointment.services.length === 0) {
            throw { statusCode: 400, message: 'Não é possível concluir o agendamento pois não há serviços associados para gerar a transação financeira.' };
        }

        const totalValue = appointment.services.reduce((sum, service) => sum + parseFloat(service.AppointmentService.priceAtTimeOfBooking || service.price), 0);
        const serviceNames = appointment.services.map(s => s.name).join(', ');
        const clientName = appointment.businessClients.length > 0 ? appointment.businessClients[0].name : 'Cliente';
        const transactionDescription = `Serviço: ${serviceNames} para ${clientName}`;

        // Usar actorId para createdByClientId da transação
        await financialService.createTransaction(financialAccountId, {
            description: transactionDescription,
            type: 'Entrada',
            value: totalValue,
            transactionDate: new Date().toISOString().split('T')[0],
            isPayableOrReceivable: false,
            isPaidOrReceived: true,
            appointmentId: appointment.id
        }, actorId, { transaction: t });

        await appointment.update({ status: 'Completed', updatedByClientId: actorId }, { transaction: t });
        await t.commit();

        const completedAppointment = await getAppointmentById(financialAccountId, appointmentId);

        if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced && completedAppointment.googleEventId) {
             const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, completedAppointment.googleEventId, completedAppointment);
             if (googleEvent && googleEvent.id) {
                const apptToUpdateGCal = await Appointment.findByPk(completedAppointment.id);
                if (apptToUpdateGCal) await apptToUpdateGCal.update({googleEventLastUpdated: new Date(googleEvent.updated)});
             }
        }
        logger.info(`Compromisso ID ${appointmentId} concluído para FA ID ${financialAccountId}. Concluído por Cliente ID: ${actorId}`);
        return completedAppointment;
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao completar agendamento ${appointmentId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function getPFAppointmentsNeedingReminder(forFinancialAccountId = null) {
  try {
    const now = new Date();
    const whereConditions = {
      status: { [Op.in]: ['Scheduled', 'Confirmed'] },
      reminderEnabled: true,
      reminderSentTimestamp: null,
      eventDateTime: { [Op.gt]: now },
      origin: 'system_pf',
    };

    if (forFinancialAccountId !== null) {
        whereConditions.financialAccountId = forFinancialAccountId;
    }

    const appointments = await Appointment.findAll({
      where: whereConditions,
      include: [
        { model: FinancialAccount, as: 'financialAccount', attributes: ['id', 'accountName', 'accountType'], include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }] },
        { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
      ],
      order: [['eventDateTime', 'ASC']],
    });

    const needingReminder = appointments.filter(app => {
      const leadTime = app.reminderLeadTimeMinutes || 0;
      const reminderTime = new Date(new Date(app.eventDateTime).getTime() - (leadTime * 60000));
      return reminderTime <= now;
    });

    if (needingReminder.length > 0) {
      logger.info(`${needingReminder.length} compromissos de PF encontrados precisando de lembrete.`);
    }
    return needingReminder.map(app => app.toJSON());

  } catch (error) {
    logger.error('Erro ao buscar compromissos de PF para lembrete:', { error });
    return [];
  }
}

async function markReminderAsSent(appointmentId) {
    try {
        const [updatedCount] = await Appointment.update( { reminderSentTimestamp: new Date() }, { where: { id: appointmentId } });
        if (updatedCount > 0) logger.info(`Lembrete (PF) para compromisso ID ${appointmentId} marcado como enviado.`);
        return updatedCount > 0;
    } catch (error) {
        logger.error(`Erro ao marcar lembrete (PF) como enviado para compromisso ID ${appointmentId}:`, { error });
        return false;
    }
}

async function getPJAppointmentsNeeding24hReminder() {
    const now = new Date();
    const threshold = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return Appointment.findAll({
        where: {
            status: 'Confirmed',
            origin: 'system_pj_mei',
            reminder24hSentAt: null,
            eventDateTime: { [Op.lte]: threshold, [Op.gt]: now }
        },
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient' }] },
            { model: BusinessClient, as: 'businessClients', attributes: ['name', 'phone'], required: true },
            { model: Service, as: 'services', attributes: ['name'], through: {attributes:[]}, required: true }
        ]
    });
}

async function getPJAppointmentsNeeding30minReminder() {
    const now = new Date();
    const threshold = new Date(now.getTime() + 30 * 60 * 1000);
     return Appointment.findAll({
        where: {
            status: 'Confirmed',
            origin: 'system_pj_mei',
            reminder30minSentAt: null,
            eventDateTime: { [Op.lte]: threshold, [Op.gt]: now }
        },
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient' }] },
            { model: BusinessClient, as: 'businessClients', attributes: ['name', 'phone'], required: true },
            { model: Service, as: 'services', attributes: ['name'], through: {attributes:[]}, required: true }
        ]
    });
}

async function mark24hReminderAsSent(appointmentId) {
    return Appointment.update({ reminder24hSentAt: new Date() }, { where: { id: appointmentId } });
}

async function mark30minReminderAsSent(appointmentId) {
    return Appointment.update({ reminder30minSentAt: new Date() }, { where: { id: appointmentId } });
}

async function createOrUpdateAppointmentFromGoogle(googleEvent, systemClientId, defaultFinancialAccountIdPF, clientPjAccounts = []) {
  const t = await sequelize.transaction();
  try {
    if (!googleEvent || !googleEvent.id) {
      await t.rollback();
      logger.warn('[ApptServiceFromGoogle] Evento Google inválido ou sem ID fornecido.');
      return null;
    }

    const systemAppointmentIdFromGoogle = googleEvent.extendedProperties?.private?.systemAppointmentId;
    let appointmentLocal = null;
    let operation = 'updated';

    if (systemAppointmentIdFromGoogle) {
      appointmentLocal = await Appointment.findOne({
        where: { id: parseInt(systemAppointmentIdFromGoogle, 10), '$financialAccount.clientId$': systemClientId },
        include: [
            { model: FinancialAccount, as: 'financialAccount', required: true, attributes:['id', 'clientId', 'accountType', 'accountName'] }, // Adicionado accountName
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] } }
        ],
        transaction: t,
      });
      if (!appointmentLocal) {
          logger.warn(`[ApptServiceFromGoogle] Appointment local ID ${systemAppointmentIdFromGoogle} (do evento Google ${googleEvent.id}) não encontrado para Cliente ${systemClientId}, apesar da prop. Será tratado como novo.`);
      }
    } else {
      appointmentLocal = await Appointment.findOne({
        where: { googleEventId: googleEvent.id, '$financialAccount.clientId$': systemClientId },
        include: [
            { model: FinancialAccount, as: 'financialAccount', required: true, attributes:['id', 'clientId', 'accountType', 'accountName'] }, // Adicionado accountName
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] } }
        ],
        transaction: t,
      });
    }

    const startDateTimeString = googleEvent.start?.dateTime || googleEvent.start?.date;
    const endDateTimeString = googleEvent.end?.dateTime || googleEvent.end?.date;

    if (!startDateTimeString) {
      await t.rollback();
      logger.warn(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} sem data/hora de início. Ignorando.`);
      return null;
    }
    const eventStartDateTime = new Date(startDateTimeString);
    let durationMinutes = null;

    if (endDateTimeString) {
        const eventEndDateTime = new Date(endDateTimeString);
        if (eventEndDateTime > eventStartDateTime) {
            durationMinutes = Math.round((eventEndDateTime.getTime() - eventStartDateTime.getTime()) / 60000);
        }
    }

    let systemStatus = 'Scheduled';
    if (googleEvent.status === 'cancelled') {
        systemStatus = 'Cancelled';
    } else if (googleEvent.status === 'confirmed') {
        systemStatus = 'Confirmed';
    }
    if (googleEvent.extendedProperties?.private?.systemStatus === 'Completed') {
        systemStatus = 'Completed';
    }

    let systemTitle = googleEvent.summary || 'Compromisso do Google';
    const pfPrefix = "[Pessoal] ";
    const pjMeiPrefixRegex = /^\[([^\]]+)\]\s*/i; // Captura o nome da conta ou PJ/MEI

    let identifiedFinancialAccountId = appointmentLocal ? appointmentLocal.financialAccountId : null;
    let identifiedAccountType = appointmentLocal
        ? appointmentLocal.financialAccount.accountType
        : (googleEvent.extendedProperties?.private?.systemAccountType);
    let googleEventNeedsCosmeticUpdate = false;

    if (identifiedAccountType && !identifiedFinancialAccountId) {
        if (identifiedAccountType === 'PF') identifiedFinancialAccountId = defaultFinancialAccountIdPF;
        else if ((identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') && clientPjAccounts.length > 0) {
            const specificTypeAccounts = clientPjAccounts.filter(acc => acc.accountType === identifiedAccountType);
            if (specificTypeAccounts.length === 1) {
                identifiedFinancialAccountId = specificTypeAccounts[0].id;
            } else if (clientPjAccounts.length === 1 && (clientPjAccounts[0].accountType === 'PJ' || clientPjAccounts[0].accountType === 'MEI')) {
                identifiedFinancialAccountId = clientPjAccounts[0].id;
                identifiedAccountType = clientPjAccounts[0].accountType;
            }
        }
    }

    const currentGoogleSummary = googleEvent.summary || '';
    const pfPrefixLower = pfPrefix.toLowerCase();

    if (currentGoogleSummary.toLowerCase().startsWith(pfPrefixLower)) {
        systemTitle = currentGoogleSummary.substring(pfPrefix.length);
        if (!identifiedAccountType) identifiedAccountType = 'PF';
        if (identifiedAccountType === 'PF' && !identifiedFinancialAccountId) identifiedFinancialAccountId = defaultFinancialAccountIdPF;
        if (identifiedAccountType === 'PF' && !currentGoogleSummary.startsWith(pfPrefix)) googleEventNeedsCosmeticUpdate = true;
    } else {
      const pjMeiMatch = currentGoogleSummary.match(pjMeiPrefixRegex);
      if (pjMeiMatch) {
        const extractedNameOrType = pjMeiMatch[1];
        systemTitle = currentGoogleSummary.substring(pjMeiMatch[0].length);

        if (!identifiedAccountType) {
            if (extractedNameOrType.toUpperCase() === 'PJ') identifiedAccountType = 'PJ';
            else if (extractedNameOrType.toUpperCase() === 'MEI') identifiedAccountType = 'MEI';
            // Se for um nome, tenta encontrar a conta por esse nome
            else {
                 const matchedPjAccountByName = clientPjAccounts.find(acc => acc.accountName.toLowerCase() === extractedNameOrType.toLowerCase() && (acc.accountType === 'PJ' || acc.accountType === 'MEI'));
                 if (matchedPjAccountByName) identifiedAccountType = matchedPjAccountByName.accountType;
                 else identifiedAccountType = 'PJ'; // Default para PJ se não for PF e não for MEI explícito
            }
        }

        if (identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') {
            if (!identifiedFinancialAccountId) {
                const matchedPjAccountByName = clientPjAccounts.find(acc => acc.accountName.toLowerCase() === extractedNameOrType.toLowerCase() && acc.accountType === identifiedAccountType);
                if (matchedPjAccountByName) {
                    identifiedFinancialAccountId = matchedPjAccountByName.id;
                } else {
                    const specificTypeAccounts = clientPjAccounts.filter(acc => acc.accountType === identifiedAccountType);
                    if (specificTypeAccounts.length === 1) {
                        identifiedFinancialAccountId = specificTypeAccounts[0].id;
                    } else if (clientPjAccounts.length === 1 && (clientPjAccounts[0].accountType === 'PJ' || clientPjAccounts[0].accountType === 'MEI')) {
                        identifiedFinancialAccountId = clientPjAccounts[0].id;
                        identifiedAccountType = clientPjAccounts[0].accountType; // Corrige o tipo se pegou a única conta PJ/MEI
                    }
                }
            }
            if (identifiedFinancialAccountId) {
                const correctPjAccount = await FinancialAccount.findByPk(identifiedFinancialAccountId, {attributes: ['accountName'], transaction:t});
                if (correctPjAccount && !currentGoogleSummary.startsWith(`[${correctPjAccount.accountName}]`)) googleEventNeedsCosmeticUpdate = true;
            }
        }
      }
    }

    if (!appointmentLocal && !identifiedFinancialAccountId && googleEvent.colorId) {
        const clientFull = await Client.findByPk(systemClientId, { transaction: t, attributes:['id','googleCalendarColorIdPF', 'googleCalendarColorIdPJ'] });
        if (clientFull) {
            if (googleEvent.colorId === clientFull.googleCalendarColorIdPF) {
                identifiedFinancialAccountId = defaultFinancialAccountIdPF;
                if (!identifiedAccountType && defaultFinancialAccountIdPF) identifiedAccountType = 'PF';
                if (identifiedAccountType === 'PF' && !currentGoogleSummary.startsWith(pfPrefix)) googleEventNeedsCosmeticUpdate = true;
            } else if (googleEvent.colorId === clientFull.googleCalendarColorIdPJ) {
                const pjOrMeiAccounts = clientPjAccounts.filter(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                if (pjOrMeiAccounts.length === 1) {
                     identifiedFinancialAccountId = pjOrMeiAccounts[0].id;
                     identifiedAccountType = pjOrMeiAccounts[0].accountType;
                     if (!currentGoogleSummary.startsWith(`[${pjOrMeiAccounts[0].accountName}]`)) googleEventNeedsCosmeticUpdate = true;
                } else if (pjOrMeiAccounts.length > 1) {
                    logger.warn(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} com cor PJ, mas cliente ${systemClientId} tem múltiplas contas PJ/MEI. Título é necessário para desambiguar.`);
                }
            }
        }
    }

    if (identifiedFinancialAccountId && !identifiedAccountType) {
        const faForType = await FinancialAccount.findByPk(identifiedFinancialAccountId, { attributes: ['accountType'], transaction: t });
        if (faForType) {
            identifiedAccountType = faForType.accountType;
        } else {
             await t.rollback();
             logger.error(`[ApptServiceFromGoogle] FinancialAccount ID ${identifiedFinancialAccountId} (deduzida) não encontrada no banco para evento ${googleEvent.id}. Abortando.`);
             return null;
        }
    }

    if (!identifiedFinancialAccountId) {
      await t.rollback();
      logger.warn(`[ApptServiceFromGoogle] Não foi possível determinar FinancialAccount para Google Event ID ${googleEvent.id} (Cliente ${systemClientId}). Título: "${currentGoogleSummary}", Cor: ${googleEvent.colorId}. Ignorando.`);
      return null;
    }

    let systemDescription = googleEvent.description || '';
    systemDescription = systemDescription.replace(/\n\n--- Participantes do Negócio ---\n(- .+\n?)+/, '').trim();
    systemDescription = systemDescription.replace(/\n\n--- Observações Internas ---\n.*/, '').trim();
    systemDescription = systemDescription.replace(/\n\n--- Serviços Prestados ---.*/s, '').trim();

    const appointmentData = {
      title: systemTitle.substring(0, 255),
      description: systemDescription,
      eventDateTime: eventStartDateTime,
      durationMinutes: durationMinutes,
      location: googleEvent.location ? googleEvent.location.substring(0, 255) : null,
      status: systemStatus,
      financialAccountId: identifiedFinancialAccountId,
      googleEventId: googleEvent.id,
      googleEventLastUpdated: googleEvent.updated ? new Date(googleEvent.updated) : new Date(),
      origin: identifiedAccountType === 'PF' ? 'system_pf' : 'system_pj_mei',
      createdByClientId: appointmentLocal ? appointmentLocal.createdByClientId : systemClientId, // Mantém o criador original se atualizando
      updatedByClientId: systemClientId // Quem atualizou via Google
    };

    let currentAssociatedBusinessClientIds = [];
    if (appointmentLocal && appointmentLocal.businessClients) {
        currentAssociatedBusinessClientIds = appointmentLocal.businessClients.map(bc => bc.id);
    }
    let newBusinessClientIdsToAssociate = [];

    if ((identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') && googleEvent.attendees && googleEvent.attendees.length > 0) {
        const ownerClientEmailDb = await Client.findByPk(systemClientId, {attributes:['email'], transaction:t});
        const ownerClientEmail = ownerClientEmailDb?.email?.toLowerCase();

        for (const attendee of googleEvent.attendees) {
            const attendeeEmailLower = attendee.email?.toLowerCase();
            if (attendeeEmailLower && !attendee.organizer && attendee.responseStatus !== 'declined' && attendeeEmailLower !== ownerClientEmail) {
                let businessClient = await BusinessClient.findOne({
                    where: { email: attendeeEmailLower, financialAccountId: identifiedFinancialAccountId },
                    transaction: t
                });
                if (!businessClient) {
                    let nameForNewBC = attendee.displayName || attendeeEmailLower.split('@')[0];
                    nameForNewBC = nameForNewBC.trim().substring(0, 255);
                    logger.info(`[ApptServiceFromGoogle] Attendee "${nameForNewBC}" não encontrado. Criando BusinessClient para FA ${identifiedFinancialAccountId}.`);
                    try {
                        businessClient = await businessClientService.createBusinessClient(
                            identifiedFinancialAccountId, { name: nameForNewBC, email: attendeeEmailLower }, systemClientId, { transaction: t } // Passa systemClientId como actorId
                        );
                    } catch (createBcError) {
                        if (createBcError.message.includes('Já existe um cliente com o email') || createBcError.message.includes('unique_business_client_email_per_account')) {
                             businessClient = await BusinessClient.findOne({ where: { email: attendeeEmailLower, financialAccountId: identifiedFinancialAccountId }, transaction: t });
                        } else {
                            logger.warn(`[ApptServiceFromGoogle] Impossível criar/encontrar BC para ${attendeeEmailLower}. Erro: ${createBcError.message}`);
                            continue;
                        }
                    }
                }
                if (businessClient) newBusinessClientIdsToAssociate.push(businessClient.id);
            }
        }
    }

    if (appointmentLocal) {
        operation = 'updated';
        const localLastSyncTime = appointmentLocal.googleEventLastUpdated ? new Date(appointmentLocal.googleEventLastUpdated).getTime() : 0;
        const googleUpdateTime = googleEvent.updated ? new Date(googleEvent.updated).getTime() : new Date().getTime();
        let dataFieldsChanged = googleUpdateTime > localLastSyncTime;

        const attendeesActuallyChanged = JSON.stringify(currentAssociatedBusinessClientIds.sort()) !== JSON.stringify(newBusinessClientIdsToAssociate.sort());
        if (!dataFieldsChanged && !attendeesActuallyChanged && !googleEventNeedsCosmeticUpdate) {
            await t.commit();
            logger.info(`[ApptServiceFromGoogle] Appointment local ID ${appointmentLocal.id} (Google ${googleEvent.id}) e participantes já atualizados.`);
            return appointmentLocal.toJSON();
        }
        if(dataFieldsChanged){
            await appointmentLocal.update(appointmentData, { transaction: t });
        }
    } else {
        operation = 'created';
        appointmentLocal = await Appointment.create(appointmentData, { transaction: t });
        googleEventNeedsCosmeticUpdate = true;
    }

    if (appointmentLocal && (identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI')) {
        await AppointmentBusinessClient.destroy({ where: { appointmentId: appointmentLocal.id }, transaction: t });
        if (newBusinessClientIdsToAssociate.length > 0) {
            await AppointmentBusinessClient.bulkCreate(newBusinessClientIdsToAssociate.map(bcId => ({ appointmentId: appointmentLocal.id, businessClientId: bcId })), { transaction: t });
        }
    }

    if (googleEventNeedsCosmeticUpdate && appointmentLocal) {
        const reloadedApptForGoogleMap = await Appointment.findByPk(appointmentLocal.id, {
            include: [
                { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email', 'isGoogleCalendarSynced', 'googleCalendarIdPrincipal', 'googleCalendarColorIdPF', 'googleCalendarColorIdPJ'] }] },
                { model: BusinessClient, as: 'businessClients', through: {attributes:[]}, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
                { model: Service, as: 'services', through: {attributes:['priceAtTimeOfBooking']}, attributes: SERVICE_INCLUDE_ATTRIBUTES }
            ],
            transaction: t
        });
        if (reloadedApptForGoogleMap) {
            logger.info(`[ApptServiceFromGoogle] Appt ${appointmentLocal.id}. Evento Google ${googleEvent.id} precisa de atualização de props/cosmética.`);
            googleCalendarService.updateGoogleEvent(systemClientId, googleEvent.id, reloadedApptForGoogleMap.toJSON())
                .then(updatedGE => { if(updatedGE) logger.info(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} atualizado (cosmética/props) async.`);})
                .catch(err => logger.error(`[ApptServiceFromGoogle] Erro na atualização cosmética async do evento Google ${googleEvent.id}: ${err.message}`));
        }
    }

    await t.commit();
    logger.info(`[ApptServiceFromGoogle] Appointment ${operation} (ID: ${appointmentLocal.id}) para Cliente ${systemClientId} a partir do Google Event ID ${googleEvent.id}.`);
    const finalReloadedAppt = await Appointment.findByPk(appointmentLocal.id, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email', 'isGoogleCalendarSynced', 'googleCalendarIdPrincipal', 'googleCalendarColorIdPF', 'googleCalendarColorIdPJ']}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
            { model: Service, as: 'services', through: { attributes: ['priceAtTimeOfBooking'] }, attributes: SERVICE_INCLUDE_ATTRIBUTES }
        ]
    });
    return finalReloadedAppt.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbErr) { logger.error(`[ApptServiceFromGoogle] Erro no rollback: ${rbErr.message}`); }
    }
    logger.error(`[ApptServiceFromGoogle] Erro ao criar/atualizar Appointment do Google Event ID ${googleEvent?.id} (Cliente ${systemClientId}): ${error.message}`, { stack: error.stack?.substring(0,700), googleEventSummary: googleEvent?.summary });
    return null;
  }
}

async function deleteOrCancelAppointmentByGoogleId(googleEventId, systemClientId) {
  const t = await sequelize.transaction();
  try {
    const appointmentLocal = await Appointment.findOne({
      where: { googleEventId: googleEventId, '$financialAccount.clientId$': systemClientId },
      include: [{ model: FinancialAccount, as: 'financialAccount', required: true }],
      transaction: t
    });
    if (!appointmentLocal) {
      await t.commit();
      return true;
    }
    await appointmentLocal.update({
        status: 'Cancelled',
        googleEventId: null,
        googleEventLastUpdated: new Date(),
        updatedByClientId: systemClientId
    }, { transaction: t });
    await t.commit();
    return true;
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`[ApptServiceFromGoogleDelete] Erro ao cancelar/desvincular Appointment (Google ID ${googleEventId}): ${error.message}`);
    return false;
  }
}

async function getAgendaView(financialAccountId, startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  const agendaEvents = [];

  const appointments = await Appointment.findAll({
    where: {
      financialAccountId,
      status: { [Op.in]: ['Scheduled', 'Confirmed', 'Completed'] },
      eventDateTime: {
        [Op.between]: [start, end],
      },
    },
    include: [{
      model: BusinessClient,
      as: 'businessClients',
      attributes: ['name'],
      through: { attributes: [] }
    }, {
      model: Service,
      as: 'services',
      attributes: ['name'],
      through: { attributes: ['priceAtTimeOfBooking'] }
    }]
  });

  for (const appt of appointments) {
    const apptEnd = new Date(new Date(appt.eventDateTime).getTime() + (appt.durationMinutes || 60) * 60000);
    let backgroundColor = '#3788d8';
    let title = appt.title;

    if (appt.businessClients && appt.businessClients.length > 0) {
      title = `${appt.businessClients[0].name} - ${appt.title}`;
    } else if (appt.services && appt.services.length > 0) {
      title = appt.services.map(s => s.name).join(' + ');
    }

    if (appt.status === 'Completed') {
      backgroundColor = '#6c757d';
      title = `✅ ${title}`;
    } else if (appt.status === 'Scheduled') {
      backgroundColor = '#ffc107'; // Amarelo para agendado
    } else if (appt.status === 'Confirmed') {
        backgroundColor = '#28a745'; // Verde para confirmado
    }


    agendaEvents.push({
      id: `appt_${appt.id}`,
      type: 'appointment',
      appointmentId: appt.id,
      title,
      start: appt.eventDateTime,
      end: apptEnd.toISOString(),
      status: appt.status,
      backgroundColor,
      borderColor: backgroundColor,
      description: appt.description,
      businessClients: appt.businessClients,
      services: appt.services,
    });
  }

  const availabilityRules = await AvailabilityRule.findAll({ where: { financialAccountId } });

  for (let day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    const currentDayStr = day.toISOString().split('T')[0];

    for (const rule of availabilityRules) {
      let ruleApplies = false;
      if (rule.type === 'day_off' && rule.specificDate === currentDayStr) {
        ruleApplies = true;
      } else if (rule.rrule) {
        try {
            const rruleOptions = RRule.parseString(rule.rrule);
            rruleOptions.dtstart = new Date(currentDayStr + "T00:00:00.000Z"); // Garante que a recorrência seja avaliada a partir do início do dia
            const rruleInstance = new RRule(rruleOptions);

            const occurrences = rruleInstance.between(new Date(currentDayStr + "T00:00:00.000Z"), new Date(currentDayStr + "T23:59:59.999Z"), true);
            if(occurrences.length > 0) {
                ruleApplies = true;
            }
        } catch(e) {
            logger.error(`Erro ao processar RRULE ID ${rule.id}: ${e.message}`);
        }
      }

      if (ruleApplies) {
        let eventStart, eventEnd;
        if (rule.type === 'day_off') {
          eventStart = new Date(`${currentDayStr}T00:00:00`);
          eventEnd = new Date(`${currentDayStr}T23:59:59`);
        }
        else if (rule.type === 'break' && rule.startTime && rule.endTime) {
          eventStart = new Date(`${currentDayStr}T${rule.startTime}`);
          eventEnd = new Date(`${currentDayStr}T${rule.endTime}`);
        } else {
            continue;
        }

        agendaEvents.push({
          id: `break_${rule.id}_${currentDayStr}`,
          type: 'break',
          title: rule.title,
          start: eventStart.toISOString(),
          end: eventEnd.toISOString(),
          backgroundColor: '#6c757d', // Cinza para bloqueios
          borderColor: '#6c757d',
          display: 'background', // Mostra como um bloco de fundo
        });
      }
    }
  }

  logger.info(`[AgendaView] Retornando ${agendaEvents.length} eventos para FA ID ${financialAccountId}.`);
  return agendaEvents;
}


module.exports = {
  scheduleAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  deleteOrCancelAppointment,
  confirmAppointment,
  completeAppointment,
  getPFAppointmentsNeedingReminder,
  markReminderAsSent,
  getPJAppointmentsNeeding24hReminder,
  getPJAppointmentsNeeding30minReminder,
  mark24hReminderAsSent,
  mark30minReminderAsSent,
  createOrUpdateAppointmentFromGoogle,
  deleteOrCancelAppointmentByGoogleId,
  getAgendaView
};
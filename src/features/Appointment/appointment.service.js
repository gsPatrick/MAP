// src/features/Appointment/appointment.service.js
const { Appointment, FinancialAccount, Client, UserPreference, BusinessClient, AppointmentBusinessClient, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const googleCalendarService = require('../../features/GoogleCalendar/googleCalendarService'); 
const businessClientService = require('../BusinessClient/BusinessClient.service'); // Verifique este caminho

const BUSINESS_CLIENT_INCLUDE_ATTRIBUTES = ['id', 'name', 'phone', 'email', 'photoUrl', 'notes'];

async function validateOwningFinancialAccount(financialAccountId, transaction = null, includeClient = true) {
  const includeOptions = [];
  if (includeClient) includeOptions.push({ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone', 'isGoogleCalendarSynced'] }); // Adicionado isGoogleCalendarSynced

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

async function scheduleAppointment(financialAccountId, appointmentData) {
  const t = await sequelize.transaction();
  let newAppointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true); // Pega o cliente para checar sync

    if (!appointmentData.title || !appointmentData.eventDateTime) {
      const error = new Error('Título e Data/Hora do Evento são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    // Removida checagem de data passada, pois o Google Calendar pode permitir e sincronizar
    // if (new Date(appointmentData.eventDateTime) < new Date()) {
    //   const error = new Error('Não é possível agendar compromissos para datas/horas passadas.');
    //   error.statusCode = 400; error.status = 'fail'; throw error;
    // }

     const businessClientIds = appointmentData.businessClientIds;
     if (businessClientIds && Array.isArray(businessClientIds) && businessClientIds.length > 0) {
         if (!['PJ', 'MEI'].includes(account.accountType)) {
             const error = new Error(`Associação de Clientes de Negócio a compromissos é permitida apenas para Contas Financeiras do tipo PJ ou MEI.`);
             error.statusCode = 400; error.status = 'fail'; throw error;
         }
         const validClients = await BusinessClient.findAll({
             where: { id: { [Op.in]: businessClientIds }, financialAccountId, isActive: true },
             transaction: t
         });
         if (validClients.length !== businessClientIds.length) {
             const missingIds = businessClientIds.filter(id => !validClients.some(client => client.id === id));
             const error = new Error(`Um ou mais Clientes de Negócio (IDs: ${missingIds.join(', ')}) não foram encontrados ou não pertencem a esta conta financeira.`);
             error.statusCode = 404; error.status = 'fail'; throw error;
         }
     }
     delete appointmentData.businessClientIds; // Remove para não tentar salvar direto no Appointment

    if (appointmentData.reminderEnabled !== false && appointmentData.reminderLeadTimeMinutes === undefined) {
      const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
      appointmentData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
    } else if (appointmentData.reminderEnabled === false) {
        appointmentData.reminderLeadTimeMinutes = null;
        appointmentData.reminderSentTimestamp = null;
    }

    newAppointment = await Appointment.create(
      { ...appointmentData, financialAccountId },
      { transaction: t }
    );

    if (businessClientIds && Array.isArray(businessClientIds) && businessClientIds.length > 0) {
        const associations = businessClientIds.map(bcId => ({
            appointmentId: newAppointment.id,
            businessClientId: bcId
        }));
        await AppointmentBusinessClient.bulkCreate(associations, { transaction: t });
    }

    await t.commit(); // Commit antes de tentar sincronizar com Google
    logger.info(`Compromisso "${newAppointment.title}" (ID: ${newAppointment.id}) agendado para FA ID ${financialAccountId}.`);

    // --- Sincronização com Google Calendar ---
    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced) {
        const reloadedApptForGoogle = await Appointment.findByPk(newAppointment.id, {
            // Recarregar com todas as associações necessárias para mapToGoogleEvent
            include: [
                { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
                { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
            ]
        });
        if (reloadedApptForGoogle) {
            const googleEvent = await googleCalendarService.createGoogleEvent(account.ownerClient.id, reloadedApptForGoogle.toJSON());
            if (googleEvent && googleEvent.id) {
                await newAppointment.update({ googleEventId: googleEvent.id, googleEventLastUpdated: new Date(googleEvent.updated || googleEvent.created) });
                logger.info(`Compromisso ID ${newAppointment.id} sincronizado com Google Calendar Event ID ${googleEvent.id}.`);
            }
        }
    }
    // --- Fim Sincronização ---

    const finalAppointment = await Appointment.findByPk(newAppointment.id, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
        ]
    });
    return finalAppointment.toJSON();

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
      sortBy = 'eventDateTime', sortOrder = 'ASC'
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };
    const includeOptions = [
        {
            model: BusinessClient,
            as: 'businessClients',
            through: { attributes: [] },
            attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES,
            required: false
        }
    ];

    if (status) whereConditions.status = status;
    if (specificDate) {
        whereConditions.eventDateTime = {
            [Op.gte]: `${specificDate}T00:00:00.000Z`,
            [Op.lt]: new Date(new Date(specificDate).setDate(new Date(specificDate).getDate() + 1)).toISOString().split('T')[0] + 'T00:00:00.000Z'
        };
    } else {
        if (dateStart) whereConditions.eventDateTime = { ...whereConditions.eventDateTime, [Op.gte]: new Date(dateStart) };
        if (dateEnd) {
            const endDateObj = new Date(dateEnd);
            endDateObj.setUTCHours(23, 59, 59, 999);
            whereConditions.eventDateTime = { ...whereConditions.eventDateTime, [Op.lte]: endDateObj };
        }
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

    logger.info(`Listados ${rows.length} compromissos para FA ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      appointments: rows.map(a => a.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar compromissos para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAppointmentById(financialAccountId, appointmentId) {
  try {
    await validateOwningFinancialAccount(financialAccountId, null, true); // Pega info do cliente
    const appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [
         { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
         { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
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

async function updateAppointment(financialAccountId, appointmentId, updateData) {
  const t = await sequelize.transaction();
  let appointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true);
    appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [
          { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
          { model: BusinessClient, as: 'businessClients', through: { attributes: [] } }
      ],
      transaction: t
    });
    if (!appointment) {
      await t.rollback(); // Rollback antes de retornar ou lançar erro
      logger.warn(`Compromisso ID ${appointmentId} não encontrado para atualização na FA ID ${financialAccountId}.`);
      // Lançar um erro 404 aqui seria mais consistente com outros services
      const err404 = new Error(`Compromisso ID ${appointmentId} não encontrado.`);
      err404.statusCode = 404; err404.status = 'fail'; throw err404;
    }
    
    if (updateData.hasOwnProperty('businessClientIds') && Array.isArray(updateData.businessClientIds)) {
        const businessClientIds = updateData.businessClientIds;

        if (businessClientIds.length > 0 && !['PJ', 'MEI'].includes(account.accountType)) {
             const error = new Error(`Associação de Clientes de Negócio a compromissos é permitida apenas para Contas Financeiras do tipo PJ ou MEI.`);
             error.statusCode = 400; error.status = 'fail'; throw error;
        }

        if (businessClientIds.length > 0) {
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
        await AppointmentBusinessClient.destroy({ where: { appointmentId: appointment.id }, transaction: t });
        if (businessClientIds.length > 0) {
             const associations = businessClientIds.map(bcId => ({ appointmentId: appointment.id, businessClientId: bcId }));
             await AppointmentBusinessClient.bulkCreate(associations, { transaction: t });
        }
        delete updateData.businessClientIds;
    }

    delete updateData.financialAccountId;

    if (updateData.reminderEnabled === false) {
        updateData.reminderLeadTimeMinutes = null;
        updateData.reminderSentTimestamp = null;
    } else if (updateData.reminderEnabled === true && updateData.reminderLeadTimeMinutes === undefined && appointment.reminderLeadTimeMinutes === null) {
        const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
        updateData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
    } else if (updateData.hasOwnProperty('reminderLeadTimeMinutes') && updateData.reminderLeadTimeMinutes !== null) {
        updateData.reminderEnabled = true;
    }

    // Verifica se há dados válidos para atualizar além de businessClientIds que já foi tratado
    const hasOtherUpdates = Object.keys(updateData).length > 0;

    if (!hasOtherUpdates && !(updateData.hasOwnProperty('businessClientIds') && Array.isArray(updateData.businessClientIds))) { // A condição original estava !hasOtherUpdates && !updateData.businessClientIds (o que daria true se businessClientIds fosse um array vazio e não houvesse outros updates)
                                                                                                                            // A checagem de businessClientIds já foi feita e ele foi deletado de updateData.
                                                                                                                            // Se Object.keys(updateData) está vazio significa que businessClientIds era a única chave ou não havia nada.
        await t.commit();
        const reloadedNoChange = await Appointment.findByPk(appointmentId, {
            include: [
                { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
                { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
            ]
        });
        return reloadedNoChange.toJSON();
    }

    if(hasOtherUpdates){ // Só atualiza o appointment se houver outros campos em updateData
        await appointment.update(updateData, { transaction: t });
    }
    await t.commit();
    logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") atualizado para FA ID ${financialAccountId}.`);

    const updatedAppointmentFull = await appointment.reload({
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
        ]
    });

    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced) {
        const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, appointment.googleEventId, updatedAppointmentFull.toJSON());
        if (googleEvent && googleEvent.id) {
            // Usar o modelo Appointment para atualizar, para garantir hooks e validações se houver
            const apptInstanceToUpdateGoogleFields = await Appointment.findByPk(appointment.id);
            if (apptInstanceToUpdateGoogleFields) {
                await apptInstanceToUpdateGoogleFields.update({ googleEventId: googleEvent.id, googleEventLastUpdated: new Date(googleEvent.updated) });
            }
            logger.info(`Compromisso ID ${appointmentId} atualizado e sincronizado com Google Calendar Event ID ${googleEvent.id}.`);
        } else if (appointment.googleEventId && !googleEvent) {
             logger.warn(`Falha ao atualizar evento Google para Appointment ID ${appointmentId}. O evento pode ter sido removido do Google.`);
        }
    }
    return updatedAppointmentFull.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbError) { logger.error("Erro no rollback após falha em updateAppointment:", rbError); }
    }
    // Log mais detalhado do erro, incluindo o updateData
    logger.error(`Erro ao atualizar compromisso ID ${appointmentId}: ${error.message}`, { errorJson: JSON.stringify(error, Object.getOwnPropertyNames(error)), updateDataSent: updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteOrCancelAppointment(financialAccountId, appointmentId, actuallyDelete = false) {
  const t = await sequelize.transaction();
  let appointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true);
    appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      transaction: t
    });
    if (!appointment) {
      await t.rollback();
      logger.warn(`Compromisso ID ${appointmentId} não encontrado para ${actuallyDelete ? 'exclusão' : 'cancelamento'} na FA ID ${financialAccountId}.`);
      return false;
    }

    const googleEventIdToDelete = appointment.googleEventId; // Pega antes de modificar/deletar

    if (actuallyDelete) {
      await appointment.destroy({ transaction: t });
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") EXCLUÍDO da FA ID ${financialAccountId}.`);
    } else {
      await appointment.update({ status: 'Cancelled' }, { transaction: t }); // Apenas cancela
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") CANCELADO na FA ID ${financialAccountId}.`);
    }
    await t.commit();

    // --- Sincronização com Google Calendar ---
    // Se foi cancelado, atualiza no Google. Se foi deletado, deleta no Google.
    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced && googleEventIdToDelete) {
        if (actuallyDelete) {
            await googleCalendarService.deleteGoogleEvent(account.ownerClient.id, googleEventIdToDelete);
        } else { // Se foi cancelado, precisamos recarregar o appointment para pegar o status 'Cancelled'
            const cancelledAppointmentForGoogle = await Appointment.findByPk(appointmentId, {
                include: [
                    { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
                    { model: BusinessClient, as: 'businessClients', through: { attributes: [] } }
                ]
            });
            if(cancelledAppointmentForGoogle) {
                const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, googleEventIdToDelete, cancelledAppointmentForGoogle.toJSON());
                 if (googleEvent && googleEvent.id) {
                    await Appointment.update({ googleEventLastUpdated: new Date(googleEvent.updated) }, { where: { id: appointmentId } });
                }
            }
        }
    }
    // --- Fim Sincronização ---
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

async function getAppointmentsNeedingReminder(forFinancialAccountId = null) {
  try {
    const now = new Date();
    const whereConditions = {
      status: { [Op.in]: ['Scheduled', 'Confirmed'] },
      reminderEnabled: true,
      reminderSentTimestamp: null,
      eventDateTime: { [Op.gt]: now },
    };

    if (forFinancialAccountId !== null) {
        whereConditions.financialAccountId = forFinancialAccountId;
    }

    const appointments = await Appointment.findAll({
      where: whereConditions,
      include: [
        {
          model: FinancialAccount,
          as: 'financialAccount',
          attributes: ['id', 'accountName', 'accountType'],
          include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
        },
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
      logger.info(`${needingReminder.length} compromissos encontrados precisando de lembrete (Conta: ${forFinancialAccountId || 'Todas'}).`);
    }
    return needingReminder.map(app => app.toJSON());

  } catch (error) {
    logger.error('Erro ao buscar compromissos para lembrete:', { error });
    return [];
  }
}

async function markReminderAsSent(appointmentId) {
    try {
        const [updatedCount] = await Appointment.update(
            { reminderSentTimestamp: new Date() },
            { where: { id: appointmentId, reminderSentTimestamp: null } }
        );
        if (updatedCount > 0) {
            logger.info(`Lembrete para compromisso ID ${appointmentId} marcado como enviado.`);
            return true;
        }
        return false;
    } catch (error) {
        logger.error(`Erro ao marcar lembrete como enviado para compromisso ID ${appointmentId}:`, { error });
        return false;
    }
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
    let operation = 'updated'; // Assume atualização por padrão

    if (systemAppointmentIdFromGoogle) {
      appointmentLocal = await Appointment.findOne({
        where: { id: parseInt(systemAppointmentIdFromGoogle, 10), '$financialAccount.clientId$': systemClientId },
        include: [
            { model: FinancialAccount, as: 'financialAccount', required: true },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] } }
        ],
        transaction: t,
      });
      if (!appointmentLocal) {
          logger.warn(`[ApptServiceFromGoogle] Appointment local ID ${systemAppointmentIdFromGoogle} (do evento Google ${googleEvent.id}) não encontrado para Cliente ${systemClientId}, apesar da prop. Será tratado como novo.`);
      }
    } else { // Se não tem systemAppointmentId, tenta encontrar por googleEventId
      appointmentLocal = await Appointment.findOne({
        where: { googleEventId: googleEvent.id, '$financialAccount.clientId$': systemClientId },
        include: [
            { model: FinancialAccount, as: 'financialAccount', required: true },
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
        if (eventEndDateTime > eventStartDateTime) { // Garante que end é depois de start
            durationMinutes = Math.round((eventEndDateTime.getTime() - eventStartDateTime.getTime()) / 60000);
        }
        // Se for evento de dia inteiro (só date), durationMinutes permanece null
        // Se for evento com hora e a duração é zero ou negativa, mapToGoogleEvent no googleCalendarService define um default
    }


    let systemStatus = 'Scheduled'; // Default
    if (googleEvent.status === 'cancelled') systemStatus = 'Cancelled';
    else if (googleEvent.status === 'confirmed') systemStatus = 'Confirmed';


    let systemTitle = googleEvent.summary || 'Compromisso do Google';
    const pfPrefix = "[Pessoal] ";
    const pjMeiPrefixRegex = /^\[(PJ|MEI|[^\]]+)\]\s*/i;

    let identifiedFinancialAccountId = appointmentLocal ? appointmentLocal.financialAccountId : null;
    let identifiedAccountType = appointmentLocal
        ? appointmentLocal.financialAccount.accountType
        : (googleEvent.extendedProperties?.private?.systemAccountType);
    let googleEventNeedsCosmeticUpdate = false; // Flag para saber se precisamos atualizar o evento Google (cor/título/props)

    // 1. Tenta identificar FA e Tipo pelas props do Google Event se já sincronizado antes
    if (identifiedAccountType && !identifiedFinancialAccountId) {
        if (identifiedAccountType === 'PF') identifiedFinancialAccountId = defaultFinancialAccountIdPF;
        else if ((identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') && clientPjAccounts.length > 0) {
            // Se o tipo é PJ/MEI e só há uma conta desse tipo, podemos assumir.
            const specificTypeAccounts = clientPjAccounts.filter(acc => acc.accountType === identifiedAccountType);
            if (specificTypeAccounts.length === 1) {
                identifiedFinancialAccountId = specificTypeAccounts[0].id;
            } else if (clientPjAccounts.length === 1 && (clientPjAccounts[0].accountType === 'PJ' || clientPjAccounts[0].accountType === 'MEI')) {
                // Se só existe UMA conta empresarial no total, e o tipo da prop é PJ ou MEI
                identifiedFinancialAccountId = clientPjAccounts[0].id;
                identifiedAccountType = clientPjAccounts[0].accountType; // Garante que o tipo seja o da conta encontrada
            }
        }
    }
    
    // 2. Tenta identificar/refinar pelo título do evento Google
    const currentGoogleSummary = googleEvent.summary || '';
    const pfPrefixLower = pfPrefix.toLowerCase();

    if (currentGoogleSummary.toLowerCase().startsWith(pfPrefixLower)) {
        systemTitle = currentGoogleSummary.substring(pfPrefix.length);
        if (!identifiedAccountType) identifiedAccountType = 'PF'; // Define se não estava nas props
        if (identifiedAccountType === 'PF' && !identifiedFinancialAccountId) identifiedFinancialAccountId = defaultFinancialAccountIdPF;
        if (identifiedAccountType === 'PF' && !currentGoogleSummary.startsWith(pfPrefix)) googleEventNeedsCosmeticUpdate = true;
    } else {
      const pjMeiMatch = currentGoogleSummary.match(pjMeiPrefixRegex);
      if (pjMeiMatch) {
        const extractedNameOrType = pjMeiMatch[1];
        systemTitle = currentGoogleSummary.substring(pjMeiMatch[0].length);

        if (!identifiedAccountType) { // Se as props não definiram o tipo
            if (extractedNameOrType.toUpperCase() === 'PJ') identifiedAccountType = 'PJ';
            else if (extractedNameOrType.toUpperCase() === 'MEI') identifiedAccountType = 'MEI';
            else identifiedAccountType = 'PJ'; // Assume PJ se for um nome de empresa não específico
        }

        if (identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') {
            if (!identifiedFinancialAccountId) {
                const matchedPjAccountByName = clientPjAccounts.find(acc => acc.accountName.toLowerCase() === extractedNameOrType.toLowerCase());
                if (matchedPjAccountByName) {
                    identifiedFinancialAccountId = matchedPjAccountByName.id;
                    identifiedAccountType = matchedPjAccountByName.accountType; // Pega o tipo exato da conta
                } else {
                    // Se não achou pelo nome exato, e só tem uma conta do tipo identificado, usa ela
                    const specificTypeAccounts = clientPjAccounts.filter(acc => acc.accountType === identifiedAccountType);
                    if (specificTypeAccounts.length === 1) {
                        identifiedFinancialAccountId = specificTypeAccounts[0].id;
                    } else if (clientPjAccounts.length === 1 && (clientPjAccounts[0].accountType === 'PJ' || clientPjAccounts[0].accountType === 'MEI')) {
                        // Se só tem uma conta empresarial no total E o título indica algo empresarial
                        identifiedFinancialAccountId = clientPjAccounts[0].id;
                        identifiedAccountType = clientPjAccounts[0].accountType;
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

    // 3. Tenta pela cor se ainda sem FA e se for um evento novo para o sistema
    if (!appointmentLocal && !identifiedFinancialAccountId && googleEvent.colorId) {
        const clientFull = await Client.findByPk(systemClientId, { transaction: t }); // Para pegar as googleCalendarColorIdPF/PJ
        if (clientFull) {
            if (googleEvent.colorId === clientFull.googleCalendarColorIdPF) {
                identifiedFinancialAccountId = defaultFinancialAccountIdPF;
                if (!identifiedAccountType && defaultFinancialAccountIdPF) identifiedAccountType = 'PF';
                if (!currentGoogleSummary.startsWith(pfPrefix)) googleEventNeedsCosmeticUpdate = true;
            } else if (googleEvent.colorId === clientFull.googleCalendarColorIdPJ) {
                // Se a cor é PJ, tenta associar à conta PJ (se houver apenas uma, ou se o título ajudar)
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
    
    // 4. Se temos ID da FA mas não o tipo, busca o tipo.
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
                    let nameForNewBC = attendee.displayName;
                    if (!nameForNewBC && attendeeEmailLower) nameForNewBC = attendeeEmailLower.split('@')[0];
                    if (!nameForNewBC || nameForNewBC.trim() === '') nameForNewBC = "Convidado Google";
                    nameForNewBC = nameForNewBC.trim().substring(0, 255);
                    logger.info(`[ApptServiceFromGoogle] Attendee "${nameForNewBC}" (Email: ${attendeeEmailLower}) não encontrado. Criando BusinessClient para FA ${identifiedFinancialAccountId}.`);
                    try {
                        businessClient = await businessClientService.createBusinessClient(
                            identifiedFinancialAccountId, {
                                name: nameForNewBC, email: attendeeEmailLower, phone: null,
                                photoUrl: null, notes: '', isActive: true,
                            }, { transaction: t }
                        );
                    } catch (createBcError) {
                        logger.error(`[ApptServiceFromGoogle] Erro ao criar BC para ${attendeeEmailLower} ("${nameForNewBC}"): ${createBcError.message}. Verificando se já existe...`);
                        if (createBcError.message.includes('Já existe um cliente com o email') || createBcError.message.includes('unique_business_client_email_per_account')) {
                             businessClient = await BusinessClient.findOne({ where: { email: attendeeEmailLower, financialAccountId: identifiedFinancialAccountId }, transaction: t });
                        } else if (createBcError.message.includes('Já existe um cliente com o nome') || createBcError.message.includes('unique_business_client_name_per_account')) {
                             businessClient = await BusinessClient.findOne({ where: { name: nameForNewBC, financialAccountId: identifiedFinancialAccountId }, transaction: t });
                        }
                        if (!businessClient) { logger.warn(`[ApptServiceFromGoogle] Impossível criar/encontrar BC para ${attendeeEmailLower}.`); continue; }
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
        if (!dataFieldsChanged && systemAppointmentIdFromGoogle) {
             if (appointmentLocal.title !== appointmentData.title ||
                (appointmentLocal.description || null) !== (appointmentData.description || null) ||
                new Date(appointmentLocal.eventDateTime).toISOString() !== appointmentData.eventDateTime.toISOString() ||
                (appointmentLocal.durationMinutes || null) !== (appointmentData.durationMinutes || null) ||
                (appointmentLocal.location || null) !== (appointmentData.location || null) ||
                appointmentLocal.status !== appointmentData.status ||
                appointmentLocal.financialAccountId !== appointmentData.financialAccountId) {
                dataFieldsChanged = true;
            }
        }
        const attendeesActuallyChanged = JSON.stringify(currentAssociatedBusinessClientIds.sort()) !== JSON.stringify(newBusinessClientIdsToAssociate.sort());
        if (!dataFieldsChanged && !attendeesActuallyChanged && systemAppointmentIdFromGoogle && !googleEventNeedsCosmeticUpdate) { // Adicionado !googleEventNeedsCosmeticUpdate
            await t.commit();
            logger.info(`[ApptServiceFromGoogle] Appointment local ID ${appointmentLocal.id} (Google ${googleEvent.id}) e participantes já atualizados. Nenhuma ação.`);
            return appointmentLocal.toJSON();
        }
        if(dataFieldsChanged){
            logger.info(`[ApptServiceFromGoogle] Atualizando Appointment local ID ${appointmentLocal.id} com dados do Google Event ${googleEvent.id}.`);
            await appointmentLocal.update(appointmentData, { transaction: t });
        } else {
            logger.info(`[ApptServiceFromGoogle] Dados principais do Appt ${appointmentLocal.id} não mudaram, verificando participantes/cosmética.`);
        }
    } else {
        operation = 'created';
        appointmentLocal = await Appointment.create(appointmentData, { transaction: t });
        googleEventNeedsCosmeticUpdate = true; // Sempre precisa adicionar props para novos e garantir cor/título
    }

    if (appointmentLocal && (identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI')) {
        const toRemove = currentAssociatedBusinessClientIds.filter(id => !newBusinessClientIdsToAssociate.includes(id));
        if (toRemove.length > 0) await AppointmentBusinessClient.destroy({ where: { appointmentId: appointmentLocal.id, businessClientId: { [Op.in]: toRemove } }, transaction: t });
        const toAdd = newBusinessClientIdsToAssociate.filter(id => !currentAssociatedBusinessClientIds.includes(id));
        if (toAdd.length > 0) await AppointmentBusinessClient.bulkCreate(toAdd.map(bcId => ({ appointmentId: appointmentLocal.id, businessClientId: bcId })), { transaction: t });
    }

    if (googleEventNeedsCosmeticUpdate && appointmentLocal) {
        const clientOwner = await Client.findByPk(systemClientId, { transaction: t });
        const faForGoogleMap = await FinancialAccount.findByPk(identifiedFinancialAccountId, { include: [{ model: Client, as: 'ownerClient' }], transaction: t });
        let bcForGoogleMap = [];
        if (newBusinessClientIdsToAssociate.length > 0) {
            bcForGoogleMap = await BusinessClient.findAll({ where: { id: { [Op.in]: newBusinessClientIdsToAssociate } }, transaction: t });
        }
        if (clientOwner && faForGoogleMap && faForGoogleMap.ownerClient) { // Garante que ownerClient está carregado para as cores
            // Atualiza o ownerClient na FA com as cores mais recentes do clientOwner
            faForGoogleMap.ownerClient = clientOwner;

            const tempAppointmentForGoogleMap = {
                ...appointmentLocal.toJSON(),
                financialAccount: faForGoogleMap.toJSON(),
                businessClients: bcForGoogleMap.map(bc => bc.toJSON())
            };
            logger.info(`[ApptServiceFromGoogle] Appt ${appointmentLocal.id}. Evento Google ${googleEvent.id} precisa de atualização de props/cosmética.`);
            googleCalendarService.updateGoogleEvent(systemClientId, googleEvent.id, tempAppointmentForGoogleMap) // Async fire-and-forget
                .then(updatedGE => { if(updatedGE) logger.info(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} atualizado (cosmética/props) async.`);})
                .catch(err => logger.error(`[ApptServiceFromGoogle] Erro na atualização cosmética async do evento Google ${googleEvent.id}: ${err.message}`));
        }
    }

    await t.commit();
    logger.info(`[ApptServiceFromGoogle] Appointment ${operation} (ID: ${appointmentLocal.id}) para Cliente ${systemClientId} a partir do Google Event ID ${googleEvent.id}.`);
    const reloadedAppt = await Appointment.findByPk(appointmentLocal.id, {
        include: [ { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] }, { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }]
    });
    return reloadedAppt.toJSON();

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
      logger.info(`[ApptServiceFromGoogleDelete] Appointment local não encontrado para Google Event ID ${googleEventId} (Cliente ${systemClientId}). Nenhuma ação local.`);
      return true;
    }

    if (appointmentLocal.status !== 'Cancelled' || appointmentLocal.googleEventId !== null) {
        logger.info(`[ApptServiceFromGoogleDelete] Marcando Appointment ID ${appointmentLocal.id} (Google ID ${googleEventId}) como Cancelado e desvinculando...`);
        await appointmentLocal.update({
            status: 'Cancelled',
            googleEventId: null, 
            googleEventLastUpdated: new Date() 
        }, { transaction: t });
    } else {
        logger.info(`[ApptServiceFromGoogleDelete] Appointment ID ${appointmentLocal.id} (Google ID ${googleEventId}) já estava Cancelado/desvinculado.`);
    }

    await t.commit();
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbErr) { logger.error(`[ApptServiceFromGoogleDelete] Erro no rollback: ${rbErr.message}`); }
    }
    logger.error(`[ApptServiceFromGoogleDelete] Erro ao cancelar/desvincular Appointment (Google ID ${googleEventId}, Cliente ${systemClientId}): ${error.message}`);
    return false;
  }
}


module.exports = {
  scheduleAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  deleteOrCancelAppointment,
  getAppointmentsNeedingReminder,
  markReminderAsSent,
  createOrUpdateAppointmentFromGoogle, 
  deleteOrCancelAppointmentByGoogleId, 
};
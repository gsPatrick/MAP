// src/features/Appointment/appointment.service.js
const { Appointment, FinancialAccount, Client, UserPreference, BusinessClient, AppointmentBusinessClient, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const googleCalendarService = require('../../features/GoogleCalendar/googleCalendarService'); 

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

/**
 * Cria ou atualiza um Appointment no sistema com base em um evento do Google Calendar.
 * @param {object} googleEvent - O objeto evento do Google Calendar.
 * @param {number} systemClientId - ID do cliente do sistema.
 * @param {string} defaultFinancialAccountIdPF - ID da conta PF padrão do cliente.
 * @param {Array<object>} clientPjAccounts - Lista de contas PJ do cliente.
 * @returns {Promise<object|null>} O Appointment criado/atualizado ou null.
 */
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
        include: [{ model: FinancialAccount, as: 'financialAccount', required: true }],
        transaction: t,
      });
      if (!appointmentLocal) {
          logger.warn(`[ApptServiceFromGoogle] Appointment local ID ${systemAppointmentIdFromGoogle} (do evento Google ${googleEvent.id}) não encontrado para Cliente ${systemClientId}. Será tratado como novo.`);
          // Não encontrou, então será criado um novo, mesmo que tivesse systemAppointmentId
      }
    } else { // Se não tem systemAppointmentId, tenta encontrar por googleEventId (caso já tenha sido sincronizado antes e perdido as props)
      appointmentLocal = await Appointment.findOne({
        where: { googleEventId: googleEvent.id, '$financialAccount.clientId$': systemClientId },
        include: [{ model: FinancialAccount, as: 'financialAccount', required: true }],
        transaction: t,
      });
    }

    // Mapear dados do Google Event para o formato do Appointment do sistema
    const startDateTime = googleEvent.start?.dateTime || googleEvent.start?.date;
    const endDateTime = googleEvent.end?.dateTime || googleEvent.end?.date;
    if (!startDateTime) {
      await t.rollback();
      logger.warn(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} sem data/hora de início. Ignorando.`);
      return null;
    }

    let durationMinutes = null;
    if (startDateTime && endDateTime) {
      durationMinutes = Math.round((new Date(endDateTime).getTime() - new Date(startDateTime).getTime()) / 60000);
      if (durationMinutes <= 0) durationMinutes = null; // Duração inválida
    }
    
    let systemStatus = 'Scheduled'; // Default
    if (googleEvent.status === 'cancelled') systemStatus = 'Cancelled';
    else if (googleEvent.status === 'confirmed') systemStatus = 'Confirmed'; // Ou manter Scheduled

    // Título e Descrição: Remover prefixos se existirem
    let systemTitle = googleEvent.summary || 'Compromisso do Google';
    const pfPrefix = "[Pessoal] ";
    const pjPrefixRegex = /\[(.*?)\] /; // Captura o nome da empresa dentro dos colchetes

    let identifiedFinancialAccountId = null;
    let identifiedAccountType = googleEvent.extendedProperties?.private?.systemAccountType; // Prioriza o que já estava no evento

    if (systemTitle.startsWith(pfPrefix)) {
      systemTitle = systemTitle.substring(pfPrefix.length);
      if (!identifiedAccountType) identifiedAccountType = 'PF';
    } else {
      const pjMatch = systemTitle.match(pjPrefixRegex);
      if (pjMatch && pjMatch[1]) {
        systemTitle = systemTitle.substring(pjMatch[0].length);
        const companyNameInTitle = pjMatch[1];
        if (!identifiedAccountType) identifiedAccountType = 'PJ'; // Ou MEI
        // Tenta encontrar a conta PJ pelo nome no título
        const matchedPjAccount = clientPjAccounts.find(acc => acc.accountName.toLowerCase() === companyNameInTitle.toLowerCase());
        if (matchedPjAccount) identifiedFinancialAccountId = matchedPjAccount.id;
      }
    }
    
    // Se o tipo foi identificado (pela prop ou prefixo), e não o ID, seleciona a conta
    if (identifiedAccountType && !identifiedFinancialAccountId) {
        if (identifiedAccountType === 'PF') {
            identifiedFinancialAccountId = defaultFinancialAccountIdPF;
        } else if ((identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') && clientPjAccounts.length > 0) {
            // Se só tem uma conta PJ/MEI, usa ela. Se tiver mais, pode precisar de mais lógica ou deixar sem FA.
            if (clientPjAccounts.length === 1) identifiedFinancialAccountId = clientPjAccounts[0].id;
            else logger.warn(`[ApptServiceFromGoogle] Múltiplas contas PJ/MEI para cliente ${systemClientId} e evento Google ${googleEvent.id} sem ID de FA específico. A associação pode falhar.`);
        }
    }

    // Se ainda não tem FA, tenta pela cor (se não for um update de um evento já mapeado)
    if (!appointmentLocal && !identifiedFinancialAccountId && googleEvent.colorId) {
        const clientFull = await Client.findByPk(systemClientId, { transaction: t }); // Precisa das cores configuradas
        if (clientFull) {
            if (googleEvent.colorId === clientFull.googleCalendarColorIdPF) {
                identifiedFinancialAccountId = defaultFinancialAccountIdPF;
                if (!identifiedAccountType) identifiedAccountType = 'PF';
            } else if (googleEvent.colorId === clientFull.googleCalendarColorIdPJ) {
                 if (clientPjAccounts.length === 1) identifiedFinancialAccountId = clientPjAccounts[0].id;
                 if (!identifiedAccountType && clientPjAccounts.length > 0) identifiedAccountType = clientPjAccounts[0].accountType;
            }
        }
    }

    if (!identifiedFinancialAccountId) {
      // Se não conseguiu identificar uma FinancialAccount, não cria/atualiza
      // A menos que você tenha uma política de "fallback" ou um local para "agendamentos não categorizados"
      await t.rollback();
      logger.warn(`[ApptServiceFromGoogle] Não foi possível determinar a FinancialAccount para o evento Google ID ${googleEvent.id} (Cliente ${systemClientId}). Título: "${googleEvent.summary}", Cor: ${googleEvent.colorId}. Ignorando.`);
      return null;
    }
    
    // Limpar descrição de texto de participantes que o GoogleCalendarService adiciona
    let systemDescription = googleEvent.description || '';
    systemDescription = systemDescription.replace(/\n\n--- Participantes do Negócio ---\n(- .+\n?)+/, '').trim();
    systemDescription = systemDescription.replace(/\n\n--- Observações Internas ---\n.*/, '').trim();


    const appointmentData = {
      title: systemTitle,
      description: systemDescription || null,
      eventDateTime: new Date(startDateTime),
      durationMinutes: durationMinutes,
      location: googleEvent.location || null,
      status: systemStatus,
      financialAccountId: identifiedFinancialAccountId,
      googleEventId: googleEvent.id,
      googleEventLastUpdated: googleEvent.updated ? new Date(googleEvent.updated) : new Date(),
      // reminderEnabled e reminderLeadTimeMinutes não são diretamente mapeáveis do Google Event padrão
      // Poderiam ser configurados via extendedProperties se necessário, ou usar defaults do sistema.
    };

    // Lógica para associar BusinessClients baseados nos attendees do Google Event
    let businessClientIdsToAssociate = [];
    if (identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') {
        if (googleEvent.attendees && googleEvent.attendees.length > 0) {
            for (const attendee of googleEvent.attendees) {
                if (attendee.email && !attendee.organizer && attendee.responseStatus !== 'declined') {
                    // Tenta encontrar um BusinessClient existente por email
                    const existingBc = await BusinessClient.findOne({
                        where: { email: attendee.email.toLowerCase(), financialAccountId: identifiedFinancialAccountId },
                        transaction: t
                    });
                    if (existingBc) {
                        businessClientIdsToAssociate.push(existingBc.id);
                    } else if (attendee.displayName) {
                        // Se não encontrar por email, poderia criar um novo BusinessClient
                        // logger.info(`[ApptServiceFromGoogle] Attendee "${attendee.displayName}" (${attendee.email}) não encontrado como BusinessClient. Poderia ser criado.`);
                        // Por simplicidade, não vamos criar automaticamente por enquanto.
                    }
                }
            }
        }
    }


    if (appointmentLocal) { // Atualiza existente
      // Só atualiza se o evento do Google for mais novo (evitar loops e sobrescritas)
      if (appointmentLocal.googleEventLastUpdated && new Date(googleEvent.updated) <= new Date(appointmentLocal.googleEventLastUpdated)) {
        await t.commit(); // Importante comitar mesmo se não houver mudança para liberar locks se houver
        logger.info(`[ApptServiceFromGoogle] Appointment local ID ${appointmentLocal.id} (Google ID ${googleEvent.id}) já está atualizado ou mais recente. Nenhuma ação.`);
        return appointmentLocal.toJSON();
      }
      await appointmentLocal.update(appointmentData, { transaction: t });
    } else { // Cria novo
      operation = 'created';
      appointmentLocal = await Appointment.create(appointmentData, { transaction: t });
      // Se é um novo appointment criado a partir do Google, precisamos atualizar o evento Google com as extendedProperties
      // Isso é crucial para que na próxima vez ele seja reconhecido como gerenciado.
      const clientOwner = await Client.findByPk(systemClientId, { transaction: t });
      const faForMapping = await FinancialAccount.findByPk(identifiedFinancialAccountId, { transaction: t });
      if (clientOwner && faForMapping) {
            // Prepara um objeto "appointmentSystem" simulado para mapToGoogleEvent
            const tempAppointmentForGoogleMap = {
                ...appointmentLocal.toJSON(),
                financialAccount: faForMapping.toJSON(),
                // businessClients (se houver) já estariam em businessClientIdsToAssociate, precisa buscá-los para o map
            };
            // Se houve businessClients, buscá-los para popular o objeto para o map
            if(businessClientIdsToAssociate.length > 0) {
                tempAppointmentForGoogleMap.businessClients = await BusinessClient.findAll({where: {id: {[Op.in]: businessClientIdsToAssociate}}, transaction:t});
            }

            logger.info(`[ApptServiceFromGoogle] Novo Appointment ${appointmentLocal.id} criado a partir do Google Event ${googleEvent.id}. Atualizando evento Google com extendedProperties...`);
            // Chamada SÍNCRONA aqui pode ser um problema se o googleCalendarService fizer chamadas de rede demoradas sem `await`.
            // O ideal é que googleCalendarService.updateGoogleEvent seja realmente async.
            const updatedGoogleEvent = await googleCalendarService.updateGoogleEvent(systemClientId, googleEvent.id, tempAppointmentForGoogleMap);
            if (updatedGoogleEvent) {
                logger.info(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} atualizado com props do sistema.`);
            } else {
                logger.warn(`[ApptServiceFromGoogle] Falha ao atualizar evento Google ${googleEvent.id} com props do sistema após criação local.`);
            }
      }
    }

    // Atualizar associações de BusinessClient
    if (appointmentLocal && (identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI')) {
        await AppointmentBusinessClient.destroy({ where: { appointmentId: appointmentLocal.id }, transaction: t });
        if (businessClientIdsToAssociate.length > 0) {
            const associations = businessClientIdsToAssociate.map(bcId => ({
                appointmentId: appointmentLocal.id,
                businessClientId: bcId
            }));
            await AppointmentBusinessClient.bulkCreate(associations, { transaction: t });
        }
    }

    await t.commit();
    logger.info(`[ApptServiceFromGoogle] Appointment ${operation} (ID: ${appointmentLocal.id}) para Cliente ${systemClientId} a partir do Google Event ID ${googleEvent.id}.`);
    
    const reloadedAppt = await Appointment.findByPk(appointmentLocal.id, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
        ]
    });
    return reloadedAppt.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`[ApptServiceFromGoogle] Erro ao criar/atualizar Appointment a partir do Google Event ID ${googleEvent?.id} (Cliente ${systemClientId}): ${error.message}`, { stack: error.stack });
    // Não relança, pois o webhook service que chamou tratará o log.
    return null;
  }
}

/**
 * Deleta ou cancela um Appointment no sistema com base em um googleEventId.
 * @param {string} googleEventId - ID do evento no Google.
 * @param {number} systemClientId - ID do cliente do sistema.
 * @returns {Promise<boolean>} True se a ação foi realizada ou se o appointment não existia.
 */
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
      logger.info(`[ApptServiceFromGoogleDelete] Appointment local não encontrado para Google Event ID ${googleEventId} (Cliente ${systemClientId}). Nenhuma ação de exclusão/cancelamento local.`);
      return true; // Considera sucesso pois não há o que deletar
    }

    // Se o evento foi "cancelled" no Google, apenas cancelamos localmente.
    // Se foi efetivamente deletado (o webhook pode não diferenciar bem, mas getGoogleEventDetails retornaria 404/410), deletamos.
    // Para esta função, vamos assumir que se chegou aqui, é para deletar ou cancelar.
    // Poderíamos ter um parâmetro `markAsCancelledOnly`. Por ora, vamos deletar.
    // Ou melhor, vamos apenas marcar como cancelado para manter o histórico.
    // A decisão de deletar vs cancelar pode vir da lógica do webhook service.

    if (appointmentLocal.status !== 'Cancelled') {
        await appointmentLocal.update({ status: 'Cancelled', googleEventId: null, googleEventLastUpdated: new Date() }, { transaction: t }); // Remove o link com o evento Google
        logger.info(`[ApptServiceFromGoogleDelete] Appointment ID ${appointmentLocal.id} (Google ID ${googleEventId}) marcado como Cancelado e desvinculado do evento Google.`);
    } else {
        logger.info(`[ApptServiceFromGoogleDelete] Appointment ID ${appointmentLocal.id} (Google ID ${googleEventId}) já estava Cancelado.`);
    }
    // Para deletar de verdade:
    // await appointmentLocal.destroy({ transaction: t });
    // logger.info(`[ApptServiceFromGoogleDelete] Appointment ID ${appointmentLocal.id} (Google ID ${googleEventId}) deletado do sistema.`);

    await t.commit();
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`[ApptServiceFromGoogleDelete] Erro ao deletar/cancelar Appointment (Google ID ${googleEventId}, Cliente ${systemClientId}): ${error.message}`);
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
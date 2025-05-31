// src/features/Appointment/appointment.service.js
const { Appointment, FinancialAccount, Client, UserPreference, BusinessClient, AppointmentBusinessClient, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const googleCalendarService = require('../../features/GoogleCalendar/googleCalendarService'); // <<< NOVO IMPORT

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
      include: [ // Incluir para passar ao GoogleCalendarService
          { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
          { model: BusinessClient, as: 'businessClients', through: { attributes: [] } }
      ],
      transaction: t
    });
    if (!appointment) {
      await t.rollback();
      logger.warn(`Compromisso ID ${appointmentId} não encontrado para atualização na FA ID ${financialAccountId}.`);
      return null;
    }
    
    // A lógica de validação de data passada foi removida para permitir sincronização com Google
    // if (updateData.eventDateTime && new Date(updateData.eventDateTime) < new Date() && ...)

    if (updateData.hasOwnProperty('businessClientIds') && Array.isArray(updateData.businessClientIds)) {
        const businessClientIds = updateData.businessClientIds;
         if (!['PJ', 'MEI'].includes(account.accountType)) {
             const error = new Error(`Associação de Clientes de Negócio é permitida apenas para Contas PJ ou MEI.`);
             error.statusCode = 400; error.status = 'fail'; throw error;
         }
        if (businessClientIds.length > 0) {
             const validClients = await BusinessClient.findAll({
                 where: { id: { [Op.in]: businessClientIds }, financialAccountId, isActive: true },
                 transaction: t
             });
             if (validClients.length !== businessClientIds.length) {
                 const missingIds = businessClientIds.filter(id => !validClients.some(client => client.id === id));
                 const error = new Error(`Um ou mais Clientes de Negócio (IDs: ${missingIds.join(', ')}) não foram encontrados.`);
                 error.statusCode = 404; error.status = 'fail'; throw error;
             }
        }
        // Remove associações antigas e cria novas
        await AppointmentBusinessClient.destroy({ where: { appointmentId: appointment.id }, transaction: t });
        if (businessClientIds.length > 0) {
             const associations = businessClientIds.map(bcId => ({ appointmentId: appointment.id, businessClientId: bcId }));
             await AppointmentBusinessClient.bulkCreate(associations, { transaction: t });
        }
        delete updateData.businessClientIds; // Remove do updateData principal
    }

    delete updateData.financialAccountId; // Não permitir mudar a FA de um compromisso

    if (updateData.reminderEnabled === false) {
        updateData.reminderLeadTimeMinutes = null;
        updateData.reminderSentTimestamp = null;
    } else if (updateData.reminderEnabled === true && updateData.reminderLeadTimeMinutes === undefined && appointment.reminderLeadTimeMinutes === null) {
        const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
        updateData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
    } else if (updateData.hasOwnProperty('reminderLeadTimeMinutes') && updateData.reminderLeadTimeMinutes !== null) {
        updateData.reminderEnabled = true;
    }

    if (Object.keys(updateData).length === 0) {
        await t.commit();
        // Recarregar com associações para consistência, mesmo sem alteração de dados diretos do Appointment
        const reloadedNoChange = await Appointment.findByPk(appointmentId, {
            include: [
                { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
                { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
            ]
        });
        return reloadedNoChange.toJSON();
    }

    await appointment.update(updateData, { transaction: t });
    await t.commit(); // Commit antes da sincronização
    logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") atualizado para FA ID ${financialAccountId}.`);

    const updatedAppointmentFull = await appointment.reload({ // Recarrega com associações para a sincronização
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
        ]
    });

    // --- Sincronização com Google Calendar ---
    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced) {
        const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, appointment.googleEventId, updatedAppointmentFull.toJSON());
        if (googleEvent && googleEvent.id) {
            // Se o googleEventId era nulo e um novo evento foi criado no Google, atualiza o googleEventId local.
            // O googleEventLastUpdated também é atualizado para refletir a sincronização.
            await appointment.update({ googleEventId: googleEvent.id, googleEventLastUpdated: new Date(googleEvent.updated) });
            logger.info(`Compromisso ID ${appointmentId} atualizado e sincronizado com Google Calendar Event ID ${googleEvent.id}.`);
        } else if (appointment.googleEventId && !googleEvent) {
             logger.warn(`Falha ao atualizar evento Google para Appointment ID ${appointmentId}. O evento pode ter sido removido do Google.`);
             // Opcional: limpar googleEventId local se a atualização falhou porque o evento não existe mais lá.
             // await appointment.update({ googleEventId: null, googleEventLastUpdated: null });
        }
    }
    // --- Fim Sincronização ---

    return updatedAppointmentFull.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbError) { logger.error("Erro no rollback após falha em updateAppointment:", rbError); }
    }
    logger.error(`Erro ao atualizar compromisso ID ${appointmentId}: ${error.message}`, { error, updateData });
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


module.exports = {
  scheduleAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  deleteOrCancelAppointment,
  getAppointmentsNeedingReminder,
  markReminderAsSent,
};
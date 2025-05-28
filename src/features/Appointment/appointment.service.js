// src/features/Appointment/appointment.service.js
const { Appointment, FinancialAccount, Client, UserPreference, BusinessClient, AppointmentBusinessClient, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
// sendWhatsappMessage não é usado diretamente neste serviço

// ATRIBUTOS PADRÃO PARA SELEÇÃO DE BUSINESSCLIENT QUANDO INCLUÍDO EM APPOINTMENT
const BUSINESS_CLIENT_INCLUDE_ATTRIBUTES = ['id', 'name', 'phone', 'email', 'photoUrl', 'notes'];

// ... (validateOwningFinancialAccount existente) ...
async function validateOwningFinancialAccount(financialAccountId, transaction = null, includeClient = true) {
  const includeOptions = [];
  if (includeClient) includeOptions.push({ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] });

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
  // ... (lógica existente de scheduleAppointment, garantindo que o reload final inclua todos os campos de BusinessClient) ...
  const t = await sequelize.transaction();
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, false); 

    if (!appointmentData.title || !appointmentData.eventDateTime) {
      const error = new Error('Título e Data/Hora do Evento são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (new Date(appointmentData.eventDateTime) < new Date()) {
      const error = new Error('Não é possível agendar compromissos para datas/horas passadas.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

     const businessClientIds = appointmentData.businessClientIds;
     if (businessClientIds && Array.isArray(businessClientIds) && businessClientIds.length > 0) {
         if (!['PJ', 'MEI'].includes(account.accountType)) {
             await t.rollback();
             const error = new Error(`Associação de Clientes de Negócio a compromissos é permitida apenas para Contas Financeiras do tipo PJ ou MEI. Conta ID ${financialAccountId} é ${account.accountType}.`);
             error.statusCode = 400; error.status = 'fail'; throw error;
         }
         const validClients = await BusinessClient.findAll({
             where: { id: { [Op.in]: businessClientIds }, financialAccountId, isActive: true },
             transaction: t
         });
         if (validClients.length !== businessClientIds.length) {
              await t.rollback();
             const missingIds = businessClientIds.filter(id => !validClients.some(client => client.id === id));
             const error = new Error(`Um ou mais Clientes de Negócio (IDs: ${missingIds.join(', ')}) não foram encontrados ou não pertencem a esta conta financeira.`);
             error.statusCode = 404; error.status = 'fail'; throw error;
         }
     }
     delete appointmentData.businessClientIds;


    if (appointmentData.reminderEnabled !== false && appointmentData.reminderLeadTimeMinutes === undefined) {
      const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
      appointmentData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
    } else if (appointmentData.reminderEnabled === false) { 
        appointmentData.reminderLeadTimeMinutes = null;
        appointmentData.reminderSentTimestamp = null; 
    }


    const newAppointment = await Appointment.create(
      { ...appointmentData, financialAccountId },
      { transaction: t }
    );

    if (businessClientIds && Array.isArray(businessClientIds) && businessClientIds.length > 0) {
        const associations = businessClientIds.map(bcId => ({
            appointmentId: newAppointment.id,
            businessClientId: bcId
        }));
        await AppointmentBusinessClient.bulkCreate(associations, { transaction: t });
        logger.info(`Associados ${businessClientIds.length} BusinessClients ao compromisso ID ${newAppointment.id}.`);
    }


    await t.commit();
    logger.info(`Compromisso "${newAppointment.title}" (ID: ${newAppointment.id}) agendado para FinancialAccount ID ${financialAccountId} em ${newAppointment.eventDateTime}.`);
    
    const reloadedAppointment = await Appointment.findByPk(newAppointment.id, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES } // <<< USA A CONSTANTE DE ATRIBUTOS
        ],
        transaction: null 
    });
    return reloadedAppointment.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao agendar compromisso para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, appointmentData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAllAppointments(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId, null, false);
    // ... (lógica de filtros e ordenação existente) ...
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
            attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES, // <<< USA A CONSTANTE DE ATRIBUTOS
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
        // Para buscar em businessClients, a query fica mais complexa ou requer um JOIN explícito
        // Por agora, vamos manter a busca simples nos campos do Appointment.
        // Se for essencial, precisaria de um JOIN com `required: true` no include de BusinessClient e adicionar:
        // { '$businessClients.name$': { [Op.iLike]: `%${search}%` } }
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

    logger.info(`Listados ${rows.length} compromissos para FinancialAccount ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count, 
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      appointments: rows.map(a => a.toJSON()),
    };
  } catch (error) {
    // ... (bloco catch existente) ...
    logger.error(`Erro ao listar compromissos para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAppointmentById(financialAccountId, appointmentId) {
  try {
    await validateOwningFinancialAccount(financialAccountId, null, true);
    const appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [
         { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
         { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES } // <<< USA A CONSTANTE DE ATRIBUTOS
      ]
    });

    if (!appointment) {
      logger.warn(`Compromisso ID ${appointmentId} não encontrado ou não pertence à FinancialAccount ID ${financialAccountId}.`);
      return null;
    }
    return appointment.toJSON();
  } catch (error) {
    // ... (bloco catch existente) ...
    logger.error(`Erro ao buscar compromisso ID ${appointmentId} para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateAppointment(financialAccountId, appointmentId, updateData) {
  // ... (lógica existente de updateAppointment, garantindo que o reload final inclua todos os campos de BusinessClient) ...
  const t = await sequelize.transaction();
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, false); 
    const appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      transaction: t
    });
    if (!appointment) {
      await t.rollback();
      logger.warn(`Compromisso ID ${appointmentId} não encontrado para atualização na FinancialAccount ID ${financialAccountId}.`);
      return null;
    }

    if (updateData.eventDateTime && new Date(updateData.eventDateTime) < new Date() &&
        !['Completed', 'Cancelled'].includes(appointment.status) &&
        (!updateData.status || !['Completed', 'Cancelled'].includes(updateData.status))) {
        const error = new Error('Não é possível mover compromissos para datas/horas passadas, a menos que marque como "Concluído" ou "Cancelado".');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    if (updateData.hasOwnProperty('businessClientIds') && Array.isArray(updateData.businessClientIds)) {
        const businessClientIds = updateData.businessClientIds;
         if (!['PJ', 'MEI'].includes(account.accountType)) {
             await t.rollback();
             const error = new Error(`Associação de Clientes de Negócio a compromissos é permitida apenas para Contas Financeiras do tipo PJ ou MEI.`);
             error.statusCode = 400; error.status = 'fail'; throw error;
         }
        if (businessClientIds.length > 0) {
             const validClients = await BusinessClient.findAll({
                 where: { id: { [Op.in]: businessClientIds }, financialAccountId, isActive: true },
                 transaction: t
             });
             if (validClients.length !== businessClientIds.length) {
                 await t.rollback();
                 const missingIds = businessClientIds.filter(id => !validClients.some(client => client.id === id));
                 const error = new Error(`Um ou mais Clientes de Negócio (IDs: ${missingIds.join(', ')}) não foram encontrados ou não pertencem a esta conta financeira.`);
                 error.statusCode = 404; error.status = 'fail'; throw error;
             }
        }
        await AppointmentBusinessClient.destroy({ where: { appointmentId: appointment.id }, transaction: t });
        if (businessClientIds.length > 0) {
             const associations = businessClientIds.map(bcId => ({
                 appointmentId: appointment.id,
                 businessClientId: bcId
             }));
             await AppointmentBusinessClient.bulkCreate(associations, { transaction: t });
             logger.info(`Associações de BusinessClient para compromisso ID ${appointment.id} atualizadas (${businessClientIds.length} associados).`);
        } else {
             logger.info(`Todas as associações de BusinessClient para compromisso ID ${appointment.id} foram removidas.`);
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

    if (Object.keys(updateData).length === 0) {
        await t.commit();
        const reloadedAppointmentNoChange = await Appointment.findByPk(appointmentId, {
            include: [
                { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
                { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES }
            ],
            transaction: null
        });
        return reloadedAppointmentNoChange.toJSON();
    }

    await appointment.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    
    const reloadedAppointment = await Appointment.findByPk(appointmentId, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES } // <<< USA A CONSTANTE DE ATRIBUTOS
        ],
        transaction: null
    });
    return reloadedAppointment.toJSON();

  } catch (error) {
    // ... (bloco catch existente) ...
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao atualizar compromisso ID ${appointmentId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteOrCancelAppointment(financialAccountId, appointmentId, actuallyDelete = false) {
  // ... (código existente sem alteração) ...
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t, false); 
    const appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      transaction: t
    });
    if (!appointment) {
      await t.rollback();
      logger.warn(`Compromisso ID ${appointmentId} não encontrado para ${actuallyDelete ? 'exclusão' : 'cancelamento'} na FinancialAccount ID ${financialAccountId}.`);
      return false;
    }

    if (actuallyDelete) {
      await appointment.destroy({ transaction: t });
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") EXCLUÍDO da FinancialAccount ID ${financialAccountId}.`);
    } else {
      await appointment.update({ status: 'Cancelled' }, { transaction: t });
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") CANCELADO na FinancialAccount ID ${financialAccountId}.`);
    }
    await t.commit();
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
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
         { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES } // <<< USA A CONSTANTE DE ATRIBUTOS
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
  // ... (código existente sem alteração) ...
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
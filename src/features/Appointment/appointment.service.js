// src/features/Appointment/appointment.service.js
const { Appointment, FinancialAccount, Client, UserPreference, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService'); // Para os lembretes

/**
 * Valida se a FinancialAccount existe e está ativa.
 * @param {number} financialAccountId
 * @param {object} transaction - Transação Sequelize opcional.
 */
async function validateOwningFinancialAccount(financialAccountId, transaction = null) {
  const account = await FinancialAccount.findByPk(financialAccountId, {
    include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }], // Inclui dados do dono
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
  return account; // Retorna a conta com o cliente dono
}

/**
 * Agenda um novo compromisso para uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} appointmentData - Dados do compromisso.
 * @returns {Promise<object>} O compromisso agendado.
 */
async function scheduleAppointment(financialAccountId, appointmentData) {
  const t = await sequelize.transaction();
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t);

    if (!appointmentData.title || !appointmentData.eventDateTime) {
      const error = new Error('Título e Data/Hora do Evento são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (new Date(appointmentData.eventDateTime) < new Date()) {
      const error = new Error('Não é possível agendar compromissos para datas/horas passadas.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    // Se reminderLeadTimeMinutes não for fornecido e reminderEnabled não for explicitamente false
    if (appointmentData.reminderEnabled !== false && appointmentData.reminderLeadTimeMinutes === undefined) {
      const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
      appointmentData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
    }
    if (appointmentData.reminderEnabled === false) {
        appointmentData.reminderLeadTimeMinutes = null;
        appointmentData.reminderSentTimestamp = null; // Garante que não há lembrete
    }

    // Se um clientId for passado no corpo, verificar se corresponde ao dono da financialAccount (segurança)
    if (appointmentData.clientId && appointmentData.clientId !== account.clientId) {
        logger.warn(`Tentativa de agendar compromisso para financialAccountId ${financialAccountId} com clientId ${appointmentData.clientId} divergente do dono da conta (${account.clientId}). Usando o dono da conta.`);
    }
    // O clientId no compromisso (se você mantiver no modelo Appointment) deve ser o dono da financialAccount
    // Mas nosso modelo Appointment agora só tem financialAccountId.

    const newAppointment = await Appointment.create(
      { ...appointmentData, financialAccountId },
      { transaction: t }
    );
    await t.commit();
    logger.info(`Compromisso "${newAppointment.title}" (ID: ${newAppointment.id}) agendado para FinancialAccount ID ${financialAccountId} em ${newAppointment.eventDateTime}.`);
    
    const reloadedAppointment = await Appointment.findByPk(newAppointment.id, {
        include: [{ model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] }]
    });
    return reloadedAppointment.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao agendar compromisso para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, appointmentData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todos os compromissos de uma FinancialAccount com filtros e paginação.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} queryParams - Parâmetros.
 * @returns {Promise<object>}
 */
async function getAllAppointments(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const {
      page = 1, limit = 10, dateStart, dateEnd, specificDate,
      status, search,
      sortBy = 'eventDateTime', sortOrder = 'ASC'
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };

    if (status) whereConditions.status = status;
    if (specificDate) {
        whereConditions.eventDateTime = {
            [Op.gte]: `${specificDate}T00:00:00.000Z`, // Início do dia em UTC
            [Op.lt]: new Date(new Date(specificDate).setDate(new Date(specificDate).getDate() + 1)).toISOString().split('T')[0] + 'T00:00:00.000Z' // Início do próximo dia em UTC
        };
    } else {
        if (dateStart) whereConditions.eventDateTime = { ...whereConditions.eventDateTime, [Op.gte]: new Date(dateStart) };
        if (dateEnd) {
            const endDateObj = new Date(dateEnd);
            endDateObj.setUTCHours(23, 59, 59, 999); // Final do dia em UTC
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
      include: [
        // O financialAccount já é implícito pelo filtro, mas podemos incluir para retornar dados dele se necessário
        // { model: FinancialAccount, as: 'financialAccount', attributes: ['id', 'accountName', 'accountType'] }
      ],
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
    logger.error(`Erro ao listar compromissos para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca um compromisso pelo ID, verificando se pertence à FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} appointmentId
 * @returns {Promise<object|null>}
 */
async function getAppointmentById(financialAccountId, appointmentId) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [ // Incluir a conta e o cliente dono para contexto
         { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] }
      ]
    });

    if (!appointment) {
      logger.warn(`Compromisso ID ${appointmentId} não encontrado ou não pertence à FinancialAccount ID ${financialAccountId}.`);
      return null;
    }
    return appointment.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar compromisso ID ${appointmentId} para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Atualiza um compromisso.
 * @param {number} financialAccountId
 * @param {number} appointmentId
 * @param {object} updateData
 * @returns {Promise<object|null>}
 */
async function updateAppointment(financialAccountId, appointmentId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);
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
        /* ... erro data passada ... */
    }
    
    // Remover financialAccountId de updateData para não permitir mover entre contas por este método
    delete updateData.financialAccountId;

    if (updateData.reminderEnabled === false) {
        updateData.reminderLeadTimeMinutes = null;
        updateData.reminderSentTimestamp = null;
    } else if (updateData.reminderEnabled === true && updateData.reminderLeadTimeMinutes === undefined && appointment.reminderLeadTimeMinutes === null) {
        const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
        updateData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
    }

    await appointment.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    
    const reloadedAppointment = await Appointment.findByPk(appointmentId, {
        include: [{ model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] }]
    });
    return reloadedAppointment.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar compromisso ID ${appointmentId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui (hard delete) ou cancela (status = 'Cancelled') um compromisso.
 * @param {number} financialAccountId
 * @param {number} appointmentId
 * @param {boolean} actuallyDelete - Se true, deleta. Se false, atualiza status para 'Cancelled'.
 * @returns {Promise<boolean>}
 */
async function deleteOrCancelAppointment(financialAccountId, appointmentId, actuallyDelete = false) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);
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
    await t.rollback();
    logger.error(`Erro ao ${actuallyDelete ? 'excluir' : 'cancelar'} compromisso ID ${appointmentId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Obtém compromissos que precisam de lembrete (para uma specific FinancialAccount ou todas).
 * Se financialAccountId for null, busca para todas as contas.
 * @param {number|null} financialAccountId - Opcional.
 * @returns {Promise<Array<object>>}
 */
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
          attributes: ['id', 'accountName'],
          include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
        }
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

/**
 * Marca um lembrete de compromisso como enviado.
 * @param {number} appointmentId
 * @returns {Promise<boolean>}
 */
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
        logger.warn(`Lembrete para compromisso ID ${appointmentId} não atualizado (já enviado ou não existe?).`);
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
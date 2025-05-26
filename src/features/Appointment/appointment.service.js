// src/features/Appointment/appointment.service.js
const { Appointment, FinancialAccount, Client, UserPreference, BusinessClient, AppointmentBusinessClient, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService');

/**
 * Valida se a FinancialAccount existe e está ativa.
 * Inclui o cliente dono para contexto, se necessário.
 * @param {number} financialAccountId
 * @param {object} transaction - Transação Sequelize opcional.
 */
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
   // Para agendamentos associados a BusinessClients, a conta deve ser PJ ou MEI
   // Esta validação pode ser colocada aqui ou no controller/service que chama este método,
   // dependendo de onde se quer aplicar a restrição. Vamos adicionar ao service para garantir.
   // Mas APENAS se houver businessClientIds na criação/update.
  return account; // Retorna a conta (com cliente dono, se incluído)
}

/**
 * Agenda um novo compromisso para uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} appointmentData - Dados do compromisso. Pode incluir `businessClientIds: Array<number>`
 * @returns {Promise<object>} O compromisso agendado.
 */
async function scheduleAppointment(financialAccountId, appointmentData) {
  const t = await sequelize.transaction();
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, false); // Não precisa incluir cliente dono aqui inicialmente

    if (!appointmentData.title || !appointmentData.eventDateTime) {
      const error = new Error('Título e Data/Hora do Evento são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (new Date(appointmentData.eventDateTime) < new Date()) {
      // Pode ajustar para permitir agendar no futuro próximo (ex: 5min a partir de agora)
      const error = new Error('Não é possível agendar compromissos para datas/horas passadas.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

     // Validação para contas PJ/MEI se `businessClientIds` estiverem presentes
     const businessClientIds = appointmentData.businessClientIds;
     if (businessClientIds && Array.isArray(businessClientIds) && businessClientIds.length > 0) {
         if (!['PJ', 'MEI'].includes(account.accountType)) {
             await t.rollback();
             const error = new Error(`Associação de Clientes de Negócio a compromissos é permitida apenas para Contas Financeiras do tipo PJ ou MEI. Conta ID ${financialAccountId} é ${account.accountType}.`);
             error.statusCode = 400; error.status = 'fail'; throw error;
         }
         // Opcional: Verificar se todos os businessClientIds existem e pertencem a esta FinancialAccount
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
     // Remove businessClientIds antes de criar o appointment
     delete appointmentData.businessClientIds;


    // Se reminderLeadTimeMinutes não for fornecido e reminderEnabled não for explicitamente false
    if (appointmentData.reminderEnabled !== false && appointmentData.reminderLeadTimeMinutes === undefined) {
      const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
      appointmentData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
    } else if (appointmentData.reminderEnabled === false) { // Se explicitamente desabilitado
        appointmentData.reminderLeadTimeMinutes = null;
        appointmentData.reminderSentTimestamp = null; // Garante que não há lembrete
    }


    const newAppointment = await Appointment.create(
      { ...appointmentData, financialAccountId },
      { transaction: t }
    );

    // Cria as associações na tabela de junção se businessClientIds foram fornecidos
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
    
    // Recarrega o compromisso com as associações de BusinessClient
    const reloadedAppointment = await Appointment.findByPk(newAppointment.id, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: ['id', 'name', 'phone', 'email', 'photoUrl'] } // Inclui BusinessClients associados, agora com photoUrl
        ],
        transaction: null // Use uma nova transação ou nenhuma para a recarga, se a principal já comitou
    });
    return reloadedAppointment.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao agendar compromisso para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, appointmentData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todos os compromissos de uma FinancialAccount com filtros e paginação.
 * Inclui BusinessClients associados.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} queryParams - Parâmetros.
 * @returns {Promise<object>}
 */
async function getAllAppointments(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId, null, false); // Não precisa incluir cliente dono aqui
    const {
      page = 1, limit = 10, dateStart, dateEnd, specificDate,
      status, search, // businessClientId, // Opcional: filtrar por compromissos associados a um business client específico
      sortBy = 'eventDateTime', sortOrder = 'ASC'
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };
    const includeOptions = [
        { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: ['id', 'name'], required: false } // Inclui BusinessClients associados (left join por default)
    ];

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
        // Adicionar busca por nome/email/telefone do BusinessClient associado
        // Isso requer um JOIN e condições WHERE no include
        // { '$businessClients.name$': { [Op.iLike]: `%${search}%` } }, // Exemplo para nome do BusinessClient
        // { '$businessClients.phone$': { [Op.iLike]: `%${search}%` } },
        // { '$businessClients.email$': { [Op.iLike]: `%${search}%` } },
      ];
       // Se buscar em BusinessClients, o include deve ser required: true para filtrar
       // Se o search puder ser para campos do Appointment OU BusinessClient,
       // a query fica mais complexa ou precisa de subqueries/distinct com cuidado.
    }
    // Exemplo de filtro por BusinessClient específico:
    // if (queryParams.businessClientId) {
    //     includeOptions[0].where = { id: queryParams.businessClientId };
    //     includeOptions[0].required = true; // Garante que só traga compromissos COM esse cliente
    // }


    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];

    const { count, rows } = await Appointment.findAndCountAll({
      where: whereConditions,
      include: includeOptions,
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
      distinct: true, // Usar distinct: true e subQuery: false (ou true dependendo do DB/versão) com includes e limites
      // subQuery: false, // Experimente com true ou false dependendo do resultado do COUNT
    });

    logger.info(`Listados ${rows.length} compromissos para FinancialAccount ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count, // Nota: o count pode ser afetado por distinct/subQuery com includes. Verifique o comportamento.
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
 * Inclui BusinessClients associados.
 * @param {number} financialAccountId
 * @param {number} appointmentId
 * @returns {Promise<object|null>}
 */
async function getAppointmentById(financialAccountId, appointmentId) {
  try {
    await validateOwningFinancialAccount(financialAccountId, null, true); // Inclui cliente dono para contexto
    const appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [ // Incluir a conta e o cliente dono para contexto
         { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
         { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: ['id', 'name', 'phone', 'email', 'photoUrl'] } // Inclui BusinessClients associados, agora com photoUrl
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
 * Permite atualizar associações de BusinessClient.
 * @param {number} financialAccountId
 * @param {number} appointmentId
 * @param {object} updateData - Dados para atualizar. Pode incluir `businessClientIds: Array<number>` ou `[]` para remover todos.
 * @returns {Promise<object|null>}
 */
async function updateAppointment(financialAccountId, appointmentId, updateData) {
  const t = await sequelize.transaction();
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, false); // Não precisa incluir cliente dono aqui
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
        // Pode ajustar a mensagem de erro se necessário
        const error = new Error('Não é possível mover compromissos para datas/horas passadas, a menos que marque como "Concluído" ou "Cancelado".');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    // Lidar com a atualização das associações de BusinessClient SE estiverem presentes em updateData
    if (updateData.hasOwnProperty('businessClientIds') && Array.isArray(updateData.businessClientIds)) {
        const businessClientIds = updateData.businessClientIds;
         // Validação para contas PJ/MEI
         if (!['PJ', 'MEI'].includes(account.accountType)) {
             await t.rollback();
             const error = new Error(`Associação de Clientes de Negócio a compromissos é permitida apenas para Contas Financeiras do tipo PJ ou MEI.`);
             error.statusCode = 400; error.status = 'fail'; throw error;
         }
        // Verificar se todos os IDs fornecidos existem e pertencem a esta conta
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

        // Remove todas as associações existentes para este compromisso
        await AppointmentBusinessClient.destroy({ where: { appointmentId: appointment.id }, transaction: t });

        // Cria as novas associações
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
        // Remove businessClientIds de updateData para não tentar atualizar um campo inexistente no Appointment
        delete updateData.businessClientIds;
    }


    // Remover financialAccountId de updateData
    delete updateData.financialAccountId;

    if (updateData.reminderEnabled === false) {
        updateData.reminderLeadTimeMinutes = null;
        updateData.reminderSentTimestamp = null;
    } else if (updateData.reminderEnabled === true && updateData.reminderLeadTimeMinutes === undefined && appointment.reminderLeadTimeMinutes === null) {
        // Se reminderEnabled virou true, mas não especificou lead time, use o default global
        const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
        updateData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
    } else if (updateData.hasOwnProperty('reminderLeadTimeMinutes') && updateData.reminderLeadTimeMinutes !== null) {
        // Se o lead time foi explicitamente definido (inclusive para 0), use ele e garanta que reminderEnabled é true
        updateData.reminderEnabled = true;
    }


    // Garante que há algo para atualizar antes de chamar o update do modelo principal
    if (Object.keys(updateData).length === 0) {
        await t.commit();
         // Recarrega o compromisso com as associações (se elas foram modificadas)
        const reloadedAppointment = await Appointment.findByPk(appointmentId, {
            include: [
                { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
                { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: ['id', 'name', 'phone', 'email', 'photoUrl'] } // Inclui photoUrl
            ],
            transaction: null
        });
        return reloadedAppointment.toJSON();
    }

    await appointment.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    
    // Recarrega o compromisso com as associações atualizadas
    const reloadedAppointment = await Appointment.findByPk(appointmentId, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: ['id', 'name', 'phone', 'email', 'photoUrl'] } // Inclui photoUrl
        ],
        transaction: null
    });
    return reloadedAppointment.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao atualizar compromisso ID ${appointmentId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui (hard delete) ou cancela (status = 'Cancelled') um compromisso.
 * Também remove as associações BusinessClient-Appointment.
 * @param {number} financialAccountId
 * @param {number} appointmentId
 * @param {boolean} actuallyDelete - Se true, deleta. Se false, atualiza status para 'Cancelled'.
 * @returns {Promise<boolean>}
 */
async function deleteOrCancelAppointment(financialAccountId, appointmentId, actuallyDelete = false) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t, false); // Não precisa incluir cliente dono aqui
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
       // As associações BusinessClient-Appointment serão deletadas em cascata
       // devido ao onDelete: CASCADE na tabela AppointmentBusinessClient.
      await appointment.destroy({ transaction: t });
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") EXCLUÍDO da FinancialAccount ID ${financialAccountId}.`);
    } else {
       // Ao cancelar, as associações podem ser mantidas ou removidas dependendo da regra de negócio.
       // Por agora, vamos mantê-las.
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

/**
 * Obtém compromissos que precisam de lembrete (para uma specific FinancialAccount ou todas).
 * Se financialAccountId for null, busca para todas as contas.
 * Inclui BusinessClients associados.
 * @param {number|null} forFinancialAccountId - Opcional.
 * @returns {Promise<Array<object>>}
 */
async function getAppointmentsNeedingReminder(forFinancialAccountId = null) {
  try {
    const now = new Date();
    const whereConditions = {
      status: { [Op.in]: ['Scheduled', 'Confirmed'] },
      reminderEnabled: true,
      reminderSentTimestamp: null,
      eventDateTime: { [Op.gt]: now }, // Busca compromissos futuros
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
          attributes: ['id', 'accountName', 'accountType'], // Inclui tipo da conta
          include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
        },
         { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: ['id', 'name', 'photoUrl'] } // Inclui BusinessClients associados, agora com photoUrl (só nome e photoUrl para lembrete?)
      ],
      order: [['eventDateTime', 'ASC']],
    });

    const needingReminder = appointments.filter(app => {
      const leadTime = app.reminderLeadTimeMinutes || 0;
      const reminderTime = new Date(new Date(app.eventDateTime).getTime() - (leadTime * 60000));
      return reminderTime <= now; // Filtra os que já deveriam ter enviado lembrete
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
        // logger.debug(`Lembrete para compromisso ID ${appointmentId} não atualizado (já enviado ou não existe?).`);
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
  // Exportar funções auxiliares se forem úteis externamente (geralmente não são)
  // validateOwningFinancialAccount
};
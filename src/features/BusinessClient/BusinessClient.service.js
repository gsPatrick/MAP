// src/features/BusinessClient/businessClient.service.js
const { BusinessClient, FinancialAccount, Appointment, Service, AppointmentService, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

// ATRIBUTOS PADRÃO PARA SELEÇÃO DE BUSINESSCLIENT
const BUSINESS_CLIENT_ATTRIBUTES = ['id', 'financialAccountId', 'name', 'phone', 'email', 'photoUrl', 'notes', 'isActive', 'createdAt', 'updatedAt'];


async function validateBusinessClientOwningAccount(financialAccountId, transaction = null) {
  // ... (código existente sem alteração)
  const account = await FinancialAccount.findByPk(financialAccountId, { transaction });
  if (!account) {
    const error = new Error(`Conta Financeira com ID ${financialAccountId} não encontrada.`);
    error.statusCode = 404; error.status = 'fail'; throw error;
  }
  if (!account.isActive) {
    const error = new Error(`A Conta Financeira ID ${financialAccountId} ("${account.accountName}") está inativa.`);
    error.statusCode = 403; error.status = 'fail'; throw error;
  }
  if (!['PJ', 'MEI'].includes(account.accountType)) {
    const error = new Error(`Clientes de Negócio só podem ser associados a Contas Financeiras do tipo PJ ou MEI. Conta ID ${financialAccountId} é ${account.accountType}.`);
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  return account;
}

async function createBusinessClient(financialAccountId, clientData) {
  const t = await sequelize.transaction();
  try {
    await validateBusinessClientOwningAccount(financialAccountId, t);

    logger.debug('[SERVICE CREATE BC] clientData recebido no serviço:', clientData);

    if (!clientData.name || typeof clientData.name !== 'string' || clientData.name.trim() === '') {
      const error = new Error('Nome é obrigatório para criar um cliente de negócio.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const clientName = clientData.name.trim();

    const existingByName = await BusinessClient.findOne({ where: { name: { [Op.iLike]: clientName }, financialAccountId }, transaction:t });
    if (existingByName) {
      const error = new Error(`Já existe um cliente com o nome "${clientName}" nesta conta financeira.`);
      error.statusCode = 409; error.status = 'fail'; throw error;
    }

    let phoneToCreate = null;
    if (clientData.phone && typeof clientData.phone === 'string' && clientData.phone.trim() !== '') {
        const normalizedPhone = clientData.phone.replace(/\D/g, '');
        const existingByPhone = await BusinessClient.findOne({ where: { phone: normalizedPhone, financialAccountId }, transaction: t });
        if (existingByPhone) {
            const error = new Error(`Já existe um cliente com o telefone "${clientData.phone}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        phoneToCreate = normalizedPhone;
    }

    let emailToCreate = null;
    if (clientData.email && typeof clientData.email === 'string' && clientData.email.trim() !== '') {
        const lowerEmail = clientData.email.toLowerCase().trim();
        const existingByEmail = await BusinessClient.findOne({ where: { email: lowerEmail, financialAccountId }, transaction: t });
        if (existingByEmail) {
            const error = new Error(`Já existe um cliente com o email "${clientData.email}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        emailToCreate = lowerEmail;
    }
    
    const photoUrlToCreate = (clientData.photoUrl && typeof clientData.photoUrl === 'string' && clientData.photoUrl.trim() !== '')
                             ? clientData.photoUrl.trim()
                             : null;
    logger.debug('[SERVICE CREATE BC] photoUrl a ser criado:', photoUrlToCreate);

    const dataToCreateInDb = {
        name: clientName,
        phone: phoneToCreate,
        email: emailToCreate,
        photoUrl: photoUrlToCreate,
        notes: (clientData.notes && typeof clientData.notes === 'string' && clientData.notes.trim() !== '') ? clientData.notes.trim() : null,
        isActive: clientData.isActive !== undefined ? Boolean(clientData.isActive) : true,
        financialAccountId,
    };
    logger.debug('[SERVICE CREATE BC] Objeto final para BusinessClient.create:', dataToCreateInDb);

    const newBusinessClientInstance = await BusinessClient.create(dataToCreateInDb, { transaction: t });
    await t.commit();
    
    const reloadedClient = await BusinessClient.findByPk(newBusinessClientInstance.id, {
        attributes: BUSINESS_CLIENT_ATTRIBUTES // Garante que todos os campos sejam retornados
    });
    if (!reloadedClient) { 
        logger.error(`[SERVICE CREATE BC] Cliente ID ${newBusinessClientInstance.id} não encontrado após criação.`);
        throw new Error('Falha ao recarregar cliente após criação.');
    }

    logger.info(`Cliente de Negócio "${reloadedClient.name}" (ID: ${reloadedClient.id}) criado para FA ID ${financialAccountId}. Foto URL: ${reloadedClient.photoUrl}`);
    return reloadedClient.toJSON();
  } catch (error) {
    // ... (bloco catch existente) ...
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao criar cliente de negócio para FA ID ${financialAccountId}: ${error.message}`, { error, clientData });
    if (error.name === 'SequelizeValidationError' && error.errors) {
        const validationErrors = error.errors.map(e => `${e.path}: ${e.message}`).join(', ');
        const valError = new Error(`Erro de validação: ${validationErrors}`);
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
     if (error.name === 'SequelizeUniqueConstraintError') {
        const uniqueField = error.fields && Object.keys(error.fields).length > 0 ? Object.keys(error.fields)[0] : 'dado fornecido';
        const uniqueError = new Error(`Já existe um cliente com ${uniqueField === 'name' ? 'este nome' : (uniqueField === 'phone' ? 'este telefone' : (uniqueField === 'email' ? 'este email' : 'estes dados'))} nesta conta financeira.`);
        uniqueError.statusCode = 409; uniqueError.status = 'fail';
        throw uniqueError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAllBusinessClients(financialAccountId, queryParams = {}) {
  try {
    await validateBusinessClientOwningAccount(financialAccountId);
    // ... (lógica de filtros e ordenação existente) ...
    const { page = 1, limit = 10, search, isActive, sortBy = 'name', sortOrder = 'ASC' } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const whereConditions = { financialAccountId }; 

    if (isActive !== undefined && isActive !== null && isActive !== '') { 
        whereConditions.isActive = (String(isActive).toLowerCase() === 'true' || isActive === true);
    }

    if (search) {
      whereConditions[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { notes: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const validSortBy = ['name', 'phone', 'email', 'createdAt', 'updatedAt', 'isActive'];
    const validSortOrders = ['ASC', 'DESC'];
    let sortField = validSortBy.includes(sortBy) ? sortBy : 'name';
    let sortDirection = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC';

    const order = [[sortField, sortDirection]];
    if (sortField !== 'name') order.push(['name', 'ASC']);

    const { count, rows } = await BusinessClient.findAndCountAll({
      where: whereConditions,
      attributes: BUSINESS_CLIENT_ATTRIBUTES, // Seleciona explicitamente os atributos
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
    });

    logger.info(`Listados ${rows.length} clientes de negócio para FA ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      businessClients: rows.map(c => c.toJSON()),
    };
  } catch (error) {
    // ... (bloco catch existente) ...
    logger.error(`Erro ao listar clientes de negócio para FA ID ${financialAccountId}: ${error.message}`, { error, queryParams });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getBusinessClientById(financialAccountId, businessClientId) {
  try {
    await validateBusinessClientOwningAccount(financialAccountId);
    const client = await BusinessClient.findOne({
      where: { id: businessClientId, financialAccountId },
      attributes: BUSINESS_CLIENT_ATTRIBUTES, // Seleciona explicitamente os atributos
    });

    if (!client) {
      return null;
    }
    return client.toJSON();
  } catch (error) {
    // ... (bloco catch existente) ...
    logger.error(`Erro ao buscar cliente de negócio ID ${businessClientId} para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateBusinessClient(financialAccountId, businessClientId, updateData) {
  const t = await sequelize.transaction();
  try {
    // ... (lógica de validação e update existente, incluindo a de photoUrl) ...
    await validateBusinessClientOwningAccount(financialAccountId, t);
    const clientInstance = await BusinessClient.findOne({
      where: { id: businessClientId, financialAccountId },
      transaction: t
    });
    if (!clientInstance) {
      await t.rollback();
      const error = new Error(`Cliente de negócio ID ${businessClientId} não encontrado para atualização.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    logger.debug('[SERVICE UPDATE BC] updateData recebido no serviço:', updateData);
    logger.debug('[SERVICE UPDATE BC] clientInstance antes do update:', clientInstance.toJSON());

    const dataToPersist = {};

    if (updateData.hasOwnProperty('name')) {
        if (!updateData.name || typeof updateData.name !== 'string' || updateData.name.trim() === '') {
            await t.rollback();
            const error = new Error('Nome não pode ser vazio.'); error.statusCode = 400; error.status = 'fail'; throw error;
        }
        const clientNameTrimmed = updateData.name.trim();
        if (clientNameTrimmed.toLowerCase() !== clientInstance.name.toLowerCase()) { // Comparação case-insensitive para unicidade
            const existingByName = await BusinessClient.findOne({ where: { name: { [Op.iLike]: clientNameTrimmed }, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
            if(existingByName){
                await t.rollback();
                const error = new Error(`Já existe outro cliente com o nome "${clientNameTrimmed}" nesta conta.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        dataToPersist.name = clientNameTrimmed; // Salva o nome trimado
    }

    if (updateData.hasOwnProperty('phone')) {
        const phoneToUpdate = (updateData.phone && typeof updateData.phone === 'string' && updateData.phone.trim() !== '')
                            ? updateData.phone.replace(/\D/g, '')
                            : null;
        if (phoneToUpdate !== clientInstance.phone) {
            if (phoneToUpdate !== null) {
                const existingByPhone = await BusinessClient.findOne({ where: { phone: phoneToUpdate, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
                if (existingByPhone) {
                    await t.rollback();
                    const error = new Error(`Já existe outro cliente com o telefone "${updateData.phone}" nesta conta.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            dataToPersist.phone = phoneToUpdate;
        }
    }
    
    if (updateData.hasOwnProperty('email')) {
        const emailToUpdate = (updateData.email && typeof updateData.email === 'string' && updateData.email.trim() !== '')
                            ? updateData.email.toLowerCase().trim()
                            : null;
        if (emailToUpdate !== clientInstance.email) {
            if (emailToUpdate !== null) {
                 const existingByEmail = await BusinessClient.findOne({ where: { email: emailToUpdate, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
                if (existingByEmail) {
                    await t.rollback();
                    const error = new Error(`Já existe outro cliente com o email "${updateData.email}" nesta conta.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            dataToPersist.email = emailToUpdate;
        }
    }

     if (updateData.hasOwnProperty('isActive')) {
        dataToPersist.isActive = Boolean(updateData.isActive);
    }

     if (updateData.hasOwnProperty('photoUrl')) {
        dataToPersist.photoUrl = (updateData.photoUrl && typeof updateData.photoUrl === 'string' && updateData.photoUrl.trim() !== '')
                               ? updateData.photoUrl.trim()
                               : null;
        logger.debug('[SERVICE UPDATE BC] photoUrl a ser persistido:', dataToPersist.photoUrl);
     }

    if (updateData.hasOwnProperty('notes')) {
        dataToPersist.notes = (updateData.notes && typeof updateData.notes === 'string' && updateData.notes.trim() !== '')
                              ? updateData.notes.trim()
                              : null;
    }

    if (Object.keys(dataToPersist).length === 0) {
        await t.commit(); 
        logger.info(`[SERVICE UPDATE BC] Nenhum campo alterado para Cliente de Negócio ID ${businessClientId}.`);
        const reloadedClientNoChange = await BusinessClient.findByPk(clientInstance.id, {
            attributes: BUSINESS_CLIENT_ATTRIBUTES // Garante que todos os campos sejam retornados
        });
        return reloadedClientNoChange.toJSON();
    }
    logger.debug('[SERVICE UPDATE BC] Objeto final para clientInstance.update:', dataToPersist);

    await clientInstance.update(dataToPersist, { transaction: t });
    await t.commit();
    
    const reloadedClient = await BusinessClient.findByPk(clientInstance.id, {
        attributes: BUSINESS_CLIENT_ATTRIBUTES // Garante que todos os campos sejam retornados após o update
    });
    if (!reloadedClient) { 
        logger.error(`[SERVICE UPDATE BC] Cliente ID ${businessClientId} não encontrado após atualização.`);
        throw new Error('Falha ao recarregar cliente após atualização.');
    }

    logger.info(`Cliente de Negócio ID ${businessClientId} ("${reloadedClient.name}") atualizado. Foto URL: ${reloadedClient.photoUrl}`);
    return reloadedClient.toJSON();
  } catch (error) {
    // ... (bloco catch existente) ...
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao atualizar cliente de negócio ID ${businessClientId}: ${error.message}`, { error, updateData });
     if (error.name === 'SequelizeValidationError' && error.errors) {
        const validationErrors = error.errors.map(e => `${e.path}: ${e.message}`).join(', ');
        const valError = new Error(`Erro de validação: ${validationErrors}`);
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
     if (error.name === 'SequelizeUniqueConstraintError') {
        const uniqueField = error.fields && Object.keys(error.fields).length > 0 ? Object.keys(error.fields)[0] : 'dado fornecido';
        const uniqueError = new Error(`Já existe um cliente com ${uniqueField === 'name' ? 'este nome' : (uniqueField === 'phone' ? 'este telefone' : (uniqueField === 'email' ? 'este email' : 'estes dados'))} nesta conta financeira.`);
        uniqueError.statusCode = 409; uniqueError.status = 'fail';
        throw uniqueError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteBusinessClient(financialAccountId, businessClientId) {
  // ... (código existente sem alteração) ...
  const t = await sequelize.transaction();
  try {
    await validateBusinessClientOwningAccount(financialAccountId, t);
    const client = await BusinessClient.findOne({
      where: { id: businessClientId, financialAccountId },
      transaction: t
    });
    if (!client) {
      await t.rollback();
      return false;
    }

    await client.destroy({ transaction: t });
    await t.commit();
    logger.info(`Cliente de Negócio ID ${businessClientId} ("${client.name}") excluído da FinancialAccount ID ${financialAccountId}.`);
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao excluir cliente de negócio ID ${businessClientId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function findBusinessClientsByIdentifiers(financialAccountId, identifiers, transaction = null) {
    // ... (código existente sem alteração, mas garantindo que 'attributes' seja usado) ...
    if (!identifiers || identifiers.length === 0) return [];
    
    await validateBusinessClientOwningAccount(financialAccountId, transaction); 
    
    const identifierConditions = identifiers.map(id => {
        const lowerId = String(id).toLowerCase().trim();
        const normalizedPhone = String(id).replace(/\D/g, '');
        const isPossiblePhone = normalizedPhone.length >= 8 && normalizedPhone.length <= 15; 
        const isPossibleEmail = lowerId.includes('@');

        let orConditions = [ { name: { [Op.iLike]: `%${lowerId}%` } } ];
        if (isPossiblePhone) orConditions.push({ phone: normalizedPhone });
        if (isPossibleEmail) orConditions.push({ email: lowerId });
        return { [Op.or]: orConditions };
    });

    const clients = await BusinessClient.findAll({
        where: { financialAccountId, isActive: true, [Op.or]: identifierConditions },
        attributes: BUSINESS_CLIENT_ATTRIBUTES, // Usa a constante de atributos
        transaction
    });
    logger.info(`Encontrados ${clients.length} BusinessClients para FA ID ${financialAccountId} com identificadores: ${identifiers.join(', ')}.`);
    return clients.map(c => c.toJSON());
}


/**
 * Busca o histórico de agendamentos de um cliente de negócio específico.
 * @param {number} financialAccountId - ID da conta financeira do proprietário.
 * @param {number} businessClientId - ID do cliente de negócio.
 * @returns {Promise<Array>} Um array de objetos de agendamento.
 */
async function getAppointmentHistoryForClient(financialAccountId, businessClientId) {
  // Valida se o businessClient pertence à financialAccount
  const client = await BusinessClient.findOne({ where: { id: businessClientId, financialAccountId } });
  if (!client) {
    const error = new Error('Cliente de negócio não encontrado ou não pertence a esta conta.');
    error.statusCode = 404;
    throw error;
  }

  const appointments = await Appointment.findAll({
    include: [
      {
        model: BusinessClient,
        as: 'businessClients',
        where: { id: businessClientId },
        attributes: [], // Não precisa dos atributos do cliente aqui, já temos o ID
        through: { attributes: [] }
      },
      {
        model: Service,
        as: 'services',
        attributes: ['name', 'price'],
        through: { attributes: [] }
      }
    ],
    where: {
      financialAccountId: financialAccountId
    },
    order: [['eventDateTime', 'DESC']],
  });

  logger.info(`Histórico de ${appointments.length} agendamentos encontrado para BusinessClient ID ${businessClientId}.`);
  return appointments.map(app => app.toJSON());
}


/**
 * Obtém detalhes completos de um cliente de negócio, incluindo faturamento total.
 * @param {number} financialAccountId - ID da conta financeira do proprietário.
 * @param {number} businessClientId - ID do cliente de negócio.
 * @returns {Promise<object>} Um objeto com os detalhes do cliente e dados agregados.
 */
async function getBusinessClientDetails(financialAccountId, businessClientId) {
  const client = await BusinessClient.findOne({ where: { id: businessClientId, financialAccountId } });
  if (!client) {
    const error = new Error('Cliente de negócio não encontrado ou não pertence a esta conta.');
    error.statusCode = 404;
    throw error;
  }

  // Subquery para encontrar os IDs dos agendamentos concluídos para este cliente
  const completedAppointmentIds = await Appointment.findAll({
    attributes: ['id'],
    where: {
      financialAccountId: financialAccountId,
      status: 'Completed'
    },
    include: [{
      model: BusinessClient,
      as: 'businessClients',
      where: { id: businessClientId },
      attributes: []
    }]
  }).then(apps => apps.map(app => app.id));

  let totalFaturado = 0;
  if (completedAppointmentIds.length > 0) {
    // Soma os preços dos serviços associados a esses agendamentos concluídos
    const result = await AppointmentService.findOne({
        attributes: [
            // <<< MUDANÇA: Usar o preço salvo na tabela de junção para precisão histórica
            [sequelize.fn('SUM', sequelize.col('priceAtTimeOfBooking')), 'totalValue']
        ],
        where: {
            appointmentId: { [Op.in]: completedAppointmentIds }
        },
        raw: true
    });
    totalFaturado = parseFloat(result.totalValue) || 0;
  }

  const history = await getAppointmentHistoryForClient(financialAccountId, businessClientId);

  logger.info(`Detalhes e faturamento total calculados para BusinessClient ID ${businessClientId}.`);
  return {
    ...client.toJSON(),
    totalFaturado,
    appointmentHistory: history
  };
}


module.exports = {
  createBusinessClient,
  getAllBusinessClients,
  getBusinessClientById,
  updateBusinessClient,
  deleteBusinessClient,
  findBusinessClientsByIdentifiers,
   getAppointmentHistoryForClient,
  getBusinessClientDetails,
};
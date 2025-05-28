// src/features/BusinessClient/businessClient.service.js
const { BusinessClient, FinancialAccount, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Valida se a FinancialAccount existe, está ativa e é do tipo PJ ou MEI.
 * @param {number} financialAccountId
 * @param {object} transaction - Transação Sequelize opcional.
 */
async function validateBusinessClientOwningAccount(financialAccountId, transaction = null) {
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

/**
 * Cria um novo cliente de negócio para uma FinancialAccount PJ/MEI.
 * @param {number} financialAccountId - ID da conta financeira (PJ/MEI).
 * @param {object} clientData - Dados do cliente de negócio.
 * @returns {Promise<object>} O cliente de negócio criado.
 */
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
    
    // Busca novamente para garantir que todos os campos, incluindo photoUrl, sejam retornados com o defaultScope do modelo.
    // O defaultScope não deve excluir photoUrl, mas esta é uma forma de garantir.
    const reloadedClient = await BusinessClient.findByPk(newBusinessClientInstance.id);
    if (!reloadedClient) { // Segurança, improvável de acontecer
        logger.error(`[SERVICE CREATE BC] Cliente ID ${newBusinessClientInstance.id} não encontrado após criação.`);
        throw new Error('Falha ao recarregar cliente após criação.');
    }

    logger.info(`Cliente de Negócio "${reloadedClient.name}" (ID: ${reloadedClient.id}) criado para FA ID ${financialAccountId}. Foto URL: ${reloadedClient.photoUrl}`);
    return reloadedClient.toJSON();
  } catch (error) {
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

    // Garantir que photoUrl seja selecionado
    const attributesToSelect = ['id', 'financialAccountId', 'name', 'phone', 'email', 'photoUrl', 'notes', 'isActive', 'createdAt', 'updatedAt'];

    const { count, rows } = await BusinessClient.findAndCountAll({
      where: whereConditions,
      attributes: attributesToSelect, // <<< ADICIONADO PARA GARANTIR
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
    });

    logger.info(`Listados ${rows.length} clientes de negócio para FA ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      businessClients: rows.map(c => c.toJSON()), // toJSON() deve incluir todos os atributos selecionados
    };
  } catch (error) {
    logger.error(`Erro ao listar clientes de negócio para FA ID ${financialAccountId}: ${error.message}`, { error, queryParams });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getBusinessClientById(financialAccountId, businessClientId) {
  try {
    await validateBusinessClientOwningAccount(financialAccountId);
    // Garantir que photoUrl seja selecionado
    const attributesToSelect = ['id', 'financialAccountId', 'name', 'phone', 'email', 'photoUrl', 'notes', 'isActive', 'createdAt', 'updatedAt'];
    const client = await BusinessClient.findOne({
      where: { id: businessClientId, financialAccountId },
      attributes: attributesToSelect, // <<< ADICIONADO PARA GARANTIR
    });

    if (!client) {
      return null;
    }
    return client.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar cliente de negócio ID ${businessClientId} para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateBusinessClient(financialAccountId, businessClientId, updateData) {
  const t = await sequelize.transaction();
  try {
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
        // Busca novamente para garantir que o retorno esteja consistente com o defaultScope
        const reloadedClientNoChange = await BusinessClient.findByPk(clientInstance.id);
        return reloadedClientNoChange.toJSON();
    }
    logger.debug('[SERVICE UPDATE BC] Objeto final para clientInstance.update:', dataToPersist);

    await clientInstance.update(dataToPersist, { transaction: t });
    await t.commit();
    
    // Recarrega após o commit para pegar os dados atualizados do banco, incluindo hooks e default scopes
    const reloadedClient = await BusinessClient.findByPk(clientInstance.id);
    if (!reloadedClient) { // Segurança
        logger.error(`[SERVICE UPDATE BC] Cliente ID ${businessClientId} não encontrado após atualização.`);
        throw new Error('Falha ao recarregar cliente após atualização.');
    }

    logger.info(`Cliente de Negócio ID ${businessClientId} ("${reloadedClient.name}") atualizado. Foto URL: ${reloadedClient.photoUrl}`);
    return reloadedClient.toJSON();
  } catch (error) {
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
        // Garantir que photoUrl seja selecionado
        attributes: ['id', 'financialAccountId', 'name', 'phone', 'email', 'photoUrl', 'notes', 'isActive', 'createdAt', 'updatedAt'],
        transaction
    });
    logger.info(`Encontrados ${clients.length} BusinessClients para FA ID ${financialAccountId} com identificadores: ${identifiers.join(', ')}.`);
    return clients.map(c => c.toJSON()); // Retorna JSON para consistência
}

module.exports = {
  createBusinessClient,
  getAllBusinessClients,
  getBusinessClientById,
  updateBusinessClient,
  deleteBusinessClient,
  findBusinessClientsByIdentifiers,
};
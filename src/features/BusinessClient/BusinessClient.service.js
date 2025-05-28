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
 * @param {object} clientData - Dados do cliente de negócio, incluindo `photoUrl` opcional.
 * @returns {Promise<object>} O cliente de negócio criado.
 */
async function createBusinessClient(financialAccountId, clientData) {
  const t = await sequelize.transaction();
  try {
    await validateBusinessClientOwningAccount(financialAccountId, t);
    logger.debug('[SERVICE CREATE BC] clientData recebido:', clientData);


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


    const newBusinessClient = await BusinessClient.create({
        name: clientName,
        phone: phoneToCreate,
        email: emailToCreate,
        photoUrl: photoUrlToCreate,
        notes: clientData.notes || null,
        isActive: clientData.isActive !== undefined ? clientData.isActive : true,
        financialAccountId,
    }, { transaction: t });

    await t.commit();
    logger.info(`Cliente de Negócio "${newBusinessClient.name}" (ID: ${newBusinessClient.id}) criado para FinancialAccount ID ${financialAccountId}.`);
    return newBusinessClient.toJSON();
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao criar cliente de negócio para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, clientData });
    if (error.name === 'SequelizeValidationError' && error.errors) {
        const validationErrors = error.errors.map(e => `${e.path}: ${e.message}`).join(', ');
        const valError = new Error(`Erro de validação: ${validationErrors}`);
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
     if (error.name === 'SequelizeUniqueConstraintError') {
        const uniqueError = new Error(`Erro de unicidade nos dados fornecidos. Verifique nome, telefone ou email.`);
        uniqueError.statusCode = 409; uniqueError.status = 'fail';
        throw uniqueError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todos os clientes de negócio de uma FinancialAccount com filtros e paginação.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} queryParams - Parâmetros.
 * @returns {Promise<object>}
 */
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

    const { count, rows } = await BusinessClient.findAndCountAll({
      where: whereConditions,
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
    });

    logger.info(`Listados ${rows.length} clientes de negócio para FinancialAccount ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      businessClients: rows.map(c => c.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar clientes de negócio para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, queryParams });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca um cliente de negócio pelo ID, verificando se pertence à FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} businessClientId
 * @returns {Promise<object|null>}
 */
async function getBusinessClientById(financialAccountId, businessClientId) {
  try {
    await validateBusinessClientOwningAccount(financialAccountId);
    const client = await BusinessClient.findOne({
      where: { id: businessClientId, financialAccountId },
    });

    if (!client) {
      // O controller tratará o 404 com base no retorno null
      return null;
    }
    return client.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar cliente de negócio ID ${businessClientId} para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Atualiza um cliente de negócio de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} businessClientId
 * @param {object} updateData - Dados para atualizar, incluindo `photoUrl` opcional.
 * @returns {Promise<object|null>}
 */
async function updateBusinessClient(financialAccountId, businessClientId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateBusinessClientOwningAccount(financialAccountId, t);
    const clientInstance = await BusinessClient.findOne({ // Renomeado para clientInstance para evitar conflito com o nome do parâmetro
      where: { id: businessClientId, financialAccountId },
      transaction: t
    });
    if (!clientInstance) {
      await t.rollback();
      const error = new Error(`Cliente de negócio ID ${businessClientId} não encontrado para atualização.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    logger.debug('[SERVICE UPDATE BC] updateData recebido:', updateData);
    logger.debug('[SERVICE UPDATE BC] Cliente antes da atualização:', clientInstance.toJSON());


    // Prepara os dados para atualização, aplicando normalizações e validações de unicidade
    const dataForSequelizeUpdate = {};

    if (updateData.name && typeof updateData.name === 'string' && updateData.name.trim() !== '' && updateData.name.trim() !== clientInstance.name) {
        const clientName = updateData.name.trim();
        const existingByName = await BusinessClient.findOne({ where: { name: { [Op.iLike]: clientName }, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
        if(existingByName){
            await t.rollback();
            const error = new Error(`Já existe outro cliente com o nome "${clientName}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        dataForSequelizeUpdate.name = clientName;
    } else if (updateData.hasOwnProperty('name') && (updateData.name === null || (typeof updateData.name === 'string' && updateData.name.trim() === ''))) {
         await t.rollback();
         const error = new Error('Nome não pode ser vazio para um cliente de negócio.');
         error.statusCode = 400; error.status = 'fail'; throw error;
    }

    if (updateData.hasOwnProperty('phone')) { // Se 'phone' está presente em updateData (pode ser null, "", ou um valor)
        if (updateData.phone && typeof updateData.phone === 'string' && updateData.phone.trim() !== '') {
             const normalizedPhone = updateData.phone.replace(/\D/g, '');
             if (normalizedPhone !== clientInstance.phone) { // Só verifica unicidade se o telefone realmente mudou
                const existingByPhone = await BusinessClient.findOne({ where: { phone: normalizedPhone, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
                if (existingByPhone) {
                     await t.rollback();
                    const error = new Error(`Já existe outro cliente com o telefone "${updateData.phone}" nesta conta financeira.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
             }
             dataForSequelizeUpdate.phone = normalizedPhone;
        } else { // Se phone é null, undefined ou string vazia
             dataForSequelizeUpdate.phone = null;
        }
    }

    if (updateData.hasOwnProperty('email')) {
        if (updateData.email && typeof updateData.email === 'string' && updateData.email.trim() !== '') {
            const lowerEmail = updateData.email.toLowerCase().trim();
            if (lowerEmail !== clientInstance.email) {
                 const existingByEmail = await BusinessClient.findOne({ where: { email: lowerEmail, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
                if (existingByEmail) {
                     await t.rollback();
                    const error = new Error(`Já existe outro cliente com o email "${updateData.email}" nesta conta financeira.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            dataForSequelizeUpdate.email = lowerEmail;
        } else {
             dataForSequelizeUpdate.email = null;
        }
    }

    if (updateData.hasOwnProperty('isActive')) { // Se isActive foi passado
        dataForSequelizeUpdate.isActive = (String(updateData.isActive).toLowerCase() === 'true' || updateData.isActive === true);
    }

    if (updateData.hasOwnProperty('photoUrl')) {
        dataForSequelizeUpdate.photoUrl = (updateData.photoUrl && typeof updateData.photoUrl === 'string' && updateData.photoUrl.trim() !== '')
                                        ? updateData.photoUrl.trim()
                                        : null;
        logger.debug('[SERVICE UPDATE BC] photoUrl a ser atualizado para:', dataForSequelizeUpdate.photoUrl);
    }

    // Trata notes: null se string vazia, não atualiza se não fornecido e já for null
    if (updateData.hasOwnProperty('notes')) {
        if (updateData.notes === null || (typeof updateData.notes === 'string' && updateData.notes.trim() === '')) {
            dataForSequelizeUpdate.notes = null;
        } else if (typeof updateData.notes === 'string') {
            dataForSequelizeUpdate.notes = updateData.notes.trim();
        }
    }

    // financialAccountId não deve ser alterado por este método
    // delete dataForSequelizeUpdate.financialAccountId; // Desnecessário pois não está em updateData

    const keysToUpdate = Object.keys(dataForSequelizeUpdate);
    if (keysToUpdate.length === 0) {
        logger.info(`[SERVICE UPDATE BC] Nenhum campo alterado para BusinessClient ID ${businessClientId}. Nenhuma atualização necessária.`);
        await t.commit(); // Comita a transação mesmo se nada for alterado, pois não houve erro.
        return clientInstance.toJSON();
    }
    logger.debug('[SERVICE UPDATE BC] dataForSequelizeUpdate final:', dataForSequelizeUpdate);

    await clientInstance.update(dataForSequelizeUpdate, { transaction: t });
    await t.commit();
    logger.info(`Cliente de Negócio ID ${businessClientId} ("${clientInstance.name}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    const reloadedClient = await clientInstance.reload(); // Recarrega para pegar os valores atualizados do DB
    logger.debug('[SERVICE UPDATE BC] Cliente após reload:', reloadedClient.toJSON());
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
        // O erro já deve ser mais específico devido às verificações acima
        const uniqueError = new Error(`Erro de unicidade nos dados fornecidos. Verifique nome, telefone ou email.`);
        uniqueError.statusCode = 409; uniqueError.status = 'fail';
        throw uniqueError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui um cliente de negócio de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} businessClientId
 * @returns {Promise<boolean>}
 */
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
      // Não loga aqui, o controller deve tratar o retorno false como 404
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

/**
 * Busca BusinessClients por identificadores (nome, telefone, email) dentro de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {Array<string>} identifiers - Array de strings (nomes, telefones ou emails).
 * @param {object} transaction - Transação Sequelize opcional.
 * @returns {Promise<Array<object>>} Array de modelos BusinessClient.
 */
async function findBusinessClientsByIdentifiers(financialAccountId, identifiers, transaction = null) {
    if (!identifiers || identifiers.length === 0) return [];
    
    await validateBusinessClientOwningAccount(financialAccountId, transaction); 
    
    const identifierConditions = identifiers.map(idStr => {
        const lowerId = String(idStr).toLowerCase().trim();
        const normalizedPhone = String(idStr).replace(/\D/g, '');
        // Critério simples para telefone: se contém apenas números e tem comprimento razoável
        const isPossiblePhone = /^\d+$/.test(normalizedPhone) && normalizedPhone.length >= 8 && normalizedPhone.length <= 15;
        const isPossibleEmail = lowerId.includes('@');

        let orConditions = [
            { name: { [Op.iLike]: `%${lowerId}%` } } // Busca por nome (parcial e insensível a caixa)
        ];

        if (isPossiblePhone) {
            orConditions.push({ phone: normalizedPhone }); // Busca por telefone exato (normalizado)
        }
         if (isPossibleEmail) {
            orConditions.push({ email: lowerId }); // Busca por email exato (normalizado)
        }
        // Adicionar busca por ID numérico se o identificador for um número
        if (!isNaN(parseInt(idStr, 10))) {
            orConditions.push({ id: parseInt(idStr, 10) });
        }

        return { [Op.or]: orConditions };
    });

    const clients = await BusinessClient.findAll({
        where: {
            financialAccountId,
            isActive: true,
            [Op.or]: identifierConditions
        },
        transaction
    });
    logger.info(`Encontrados ${clients.length} BusinessClients para FinancialAccount ID ${financialAccountId} com identificadores: ${identifiers.join(', ')}.`);
    return clients; // Retorna modelos Sequelize
}

module.exports = {
  createBusinessClient,
  getAllBusinessClients,
  getBusinessClientById,
  updateBusinessClient,
  deleteBusinessClient,
  findBusinessClientsByIdentifiers,
};
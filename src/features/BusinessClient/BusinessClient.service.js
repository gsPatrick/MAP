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
  // Clientes de Negócio são para contas PJ ou MEI
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

    if (!clientData.name || typeof clientData.name !== 'string' || clientData.name.trim() === '') {
      const error = new Error('Nome é obrigatório para criar um cliente de negócio.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const clientName = clientData.name.trim();

    // Validação de unicidade de nome DENTRO da financialAccount
    const existingByName = await BusinessClient.findOne({ where: { name: { [Op.iLike]: clientName }, financialAccountId }, transaction:t });
    if (existingByName) {
      const error = new Error(`Já existe um cliente com o nome "${clientName}" nesta conta financeira.`);
      error.statusCode = 409; error.status = 'fail'; throw error;
    }

    // Validação de unicidade de telefone/email DENTRO da financialAccount, se fornecidos
    if (clientData.phone && clientData.phone.trim() !== '') {
        const normalizedPhone = clientData.phone.replace(/\D/g, '');
        const existingByPhone = await BusinessClient.findOne({ where: { phone: normalizedPhone, financialAccountId }, transaction: t });
        if (existingByPhone) {
            const error = new Error(`Já existe um cliente com o telefone "${clientData.phone}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        clientData.phone = normalizedPhone; // Normaliza antes de criar
    } else {
        clientData.phone = null; // Garante null se vazio ou undefined
    }

    if (clientData.email && clientData.email.trim() !== '') {
        const lowerEmail = clientData.email.toLowerCase().trim();
        const existingByEmail = await BusinessClient.findOne({ where: { email: lowerEmail, financialAccountId }, transaction: t });
        if (existingByEmail) {
            const error = new Error(`Já existe um cliente com o email "${clientData.email}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        clientData.email = lowerEmail; // Normaliza antes de criar
    } else {
        clientData.email = null; // Garante null se vazio ou undefined
    }
    
    // Tratamento para photoUrl: null se for string vazia
    const photoUrlToCreate = clientData.hasOwnProperty('photoUrl') && clientData.photoUrl !== '' ? clientData.photoUrl : null;


    const newBusinessClient = await BusinessClient.create({
        ...clientData,
        name: clientName, // Usa o nome normalizado
        financialAccountId,
        photoUrl: photoUrlToCreate, // Usa a URL normalizada
        phone: clientData.phone, // Usa o telefone normalizado
        email: clientData.email, // Usa o email normalizado
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
        // Já tratado pelas mensagens de erro acima, mas fallback
        const uniqueError = new Error(`Erro de unicidade nos dados fornecidos.`);
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

    const whereConditions = { financialAccountId }; // Filtro principal

    if (isActive !== undefined) {
        whereConditions.isActive = (isActive === 'true' || isActive === true);
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
    if (sortField !== 'name') order.push(['name', 'ASC']); // Desempate por nome

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
      logger.warn(`Cliente de Negócio ID ${businessClientId} não encontrado ou não pertence à FinancialAccount ID ${financialAccountId}.`);
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
    const client = await BusinessClient.findOne({
      where: { id: businessClientId, financialAccountId },
      transaction: t
    });
    if (!client) {
      await t.rollback();
      const error = new Error(`Cliente de negócio ID ${businessClientId} não encontrado para atualização.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    // Validações de unicidade se campos únicos forem alterados
    if (updateData.name && updateData.name.trim() !== '' && updateData.name.trim() !== client.name) {
        const clientName = updateData.name.trim();
        const existingByName = await BusinessClient.findOne({ where: { name: { [Op.iLike]: clientName }, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
        if(existingByName){
            await t.rollback();
            const error = new Error(`Já existe outro cliente com o nome "${clientName}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        updateData.name = clientName; // Normaliza nome antes do update
    } else if (updateData.hasOwnProperty('name') && (updateData.name === null || updateData.name.trim() === '')) { // Permite limpar o nome? O modelo não permite null.
         await t.rollback();
         const error = new Error('Nome não pode ser vazio para um cliente de negócio.');
         error.statusCode = 400; error.status = 'fail'; throw error;
    } // Se updateData.name não existir, não atualiza o nome

    if (updateData.phone !== undefined) { // Permite definir para null
        if (updateData.phone && updateData.phone.trim() !== '') {
             const normalizedPhone = updateData.phone.replace(/\D/g, '');
             if (normalizedPhone !== client.phone) {
                const existingByPhone = await BusinessClient.findOne({ where: { phone: normalizedPhone, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
                if (existingByPhone) {
                     await t.rollback();
                    const error = new Error(`Já existe outro cliente com o telefone "${updateData.phone}" nesta conta financeira.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
             }
             updateData.phone = normalizedPhone; // Normaliza
        } else {
             updateData.phone = null; // Define para null se fornecido vazio
        }
    }
    if (updateData.email !== undefined) { // Permite definir para null
        if (updateData.email && updateData.email.trim() !== '') {
            const lowerEmail = updateData.email.toLowerCase().trim();
            if (lowerEmail !== client.email) {
                 const existingByEmail = await BusinessClient.findOne({ where: { email: lowerEmail, financialAccountId, id: {[Op.ne]: businessClientId} }, transaction: t });
                if (existingByEmail) {
                     await t.rollback();
                    const error = new Error(`Já existe outro cliente com o email "${updateData.email}" nesta conta financeira.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            updateData.email = lowerEmail; // Normaliza
        } else {
             updateData.email = null; // Define para null se fornecido vazio
        }
    }
     if (updateData.isActive !== undefined) {
        updateData.isActive = (String(updateData.isActive).toLowerCase() === 'true' || updateData.isActive === true);
    } // Se updateData.isActive não existir, não atualiza

     if (updateData.hasOwnProperty('photoUrl')) { // Permite definir para null ou string vazia para remover a foto
        updateData.photoUrl = updateData.photoUrl && updateData.photoUrl.trim() !== '' ? updateData.photoUrl : null;
     } // Se updateData.photoUrl não existir, não atualiza

    if (updateData.notes === undefined) delete updateData.notes; // Não atualiza notes se não fornecido

    // Remover financialAccountId de updateData
    delete updateData.financialAccountId;

    // Garante que há algo para atualizar (além do ID)
    const keysToUpdate = Object.keys(updateData).filter(key => key !== 'id');
    if (keysToUpdate.length === 0) {
        await t.commit();
        return client.toJSON(); // Nada a atualizar
    }


    await client.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Cliente de Negócio ID ${businessClientId} ("${client.name}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    return client.reload().then(c => c.toJSON());
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
        // Já tratado pelas mensagens de erro acima, mas fallback
        const uniqueError = new Error(`Erro de unicidade nos dados fornecidos.`);
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
      logger.warn(`Cliente de Negócio ID ${businessClientId} não encontrado para exclusão na FinancialAccount ID ${financialAccountId}.`);
      return false;
    }

    // A exclusão de associações na tabela AppointmentBusinessClient
    // deve ocorrer automaticamente devido ao onDelete: CASCADE definido na tabela de junção.
    // Não precisamos verificar ou excluir manualmente compromissos associados AQUI.
    // Se houvesse alguma outra relação (ex: BusinessClient temMany Vendas),
    // precisaríamos verificar a política onDelete dessas outras relações.

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

// Função auxiliar para buscar BusinessClients por nomes/telefones/emails (útil para integração com IA/WhatsApp)
async function findBusinessClientsByIdentifiers(financialAccountId, identifiers, transaction = null) {
    if (!identifiers || identifiers.length === 0) return [];
    
    const account = await validateBusinessClientOwningAccount(financialAccountId, transaction); // Valida a conta
    
    const identifierConditions = identifiers.map(id => {
        const lowerId = String(id).toLowerCase().trim();
        const normalizedPhone = String(id).replace(/\D/g, '');
        const isPossiblePhone = normalizedPhone.length >= 8 && normalizedPhone.length <= 15; // Criterio simples
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

        return { [Op.or]: orConditions };
    });


    const clients = await BusinessClient.findAll({
        where: {
            financialAccountId,
            isActive: true, // Busca apenas clientes ativos
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
  findBusinessClientsByIdentifiers, // Exporta a função de busca por identificadores
};
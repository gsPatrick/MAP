// src/features/Client/client.service.js
const { Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

/**
 * Busca um Client (contato WhatsApp) pelo número de telefone.
 * @param {string} phone - Número de telefone.
 * @returns {Promise<object|null>} O Client encontrado (toJSON) ou null.
 */
async function findClientByPhone(phone) {
  if (!phone) return null;
  const normalizedPhone = phone.replace(/\D/g, '');
  try {
    const client = await Client.findOne({ where: { phone: normalizedPhone } });
    return client ? client.toJSON() : null;
  } catch (error) {
    logger.error(`Erro ao buscar cliente por telefone ${normalizedPhone}: ${error.message}`, { error });
    throw error;
  }
}

/**
 * Cria um novo Client (contato do WhatsApp) com nome e telefone.
 * Usado durante o onboarding explícito via WhatsApp.
 * @param {object} clientData - { phone (OBRIGATÓRIO), name (OBRIGATÓRIO), email (opcional) }
 * @returns {Promise<object>} O Client criado (toJSON).
 */
async function createClient(clientData) {
  const { phone, name, email } = clientData;
  const t = await sequelize.transaction();
  try {
    if (!phone || !name) {
      const error = new Error('Nome e número de telefone são obrigatórios para criar um cliente.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const normalizedPhone = phone.replace(/\D/g, '');

    const existingClient = await Client.findOne({ where: { phone: normalizedPhone }, transaction: t });
    if (existingClient) {
      await t.commit(); // Commit pois não houve erro, apenas cliente já existe
      logger.warn(`Tentativa de criar cliente com telefone ${normalizedPhone} que já existe (ID: ${existingClient.id}). Retornando existente.`);
      return existingClient.toJSON();
    }

    const newClient = await Client.create({
        phone: normalizedPhone,
        name: name,
        email: email || null,
        status: 'Ativo', // Ou 'Aguardando Pagamento' se esse for o fluxo pós-criação inicial
    }, { transaction: t });

    await t.commit();
    logger.info(`Novo Cliente criado com sucesso: ID ${newClient.id}, Telefone: ${newClient.phone}, Nome: ${newClient.name}`);
    return newClient.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar cliente: ${error.message}`, { error, clientData });
    if (error.name === 'SequelizeValidationError') {
        const valError = new Error(error.errors.map(e => e.message).join(', '));
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Cria um novo Client (contato do WhatsApp) - Usado por admin ou sistema interno.
 * @param {object} clientData - { phone, name (opcional), status (opcional), email (opcional) }
 * @returns {Promise<object>} O Client criado.
 */
async function createClientContact(clientData) {
  const t = await sequelize.transaction();
  try {
    if (!clientData.phone) {
      const error = new Error('Número de telefone é obrigatório para criar um cliente.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const normalizedPhone = clientData.phone.replace(/\D/g, '');

    const existingClient = await Client.findOne({ where: { phone: normalizedPhone }, transaction: t });
    if (existingClient) {
      await t.commit();
      logger.info(`Cliente com telefone ${normalizedPhone} já existe (ID: ${existingClient.id}). Retornando existente.`);
      return existingClient.toJSON();
    }

    const newClient = await Client.create({
        phone: normalizedPhone,
        name: clientData.name, // Pode ser null
        email: clientData.email || null,
        status: clientData.status || 'Ativo',
    }, { transaction: t });
    await t.commit();
    logger.info(`Novo Contato Cliente criado (manual/admin): ID ${newClient.id}, Telefone: ${newClient.phone}`);
    return newClient.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar contato cliente (manual/admin): ${error.message}`, { error, clientData });
     if (error.name === 'SequelizeValidationError') {
        const valError = new Error(error.errors.map(e => e.message).join(', '));
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todos os Clients (contatos) com opções de filtro e paginação.
 * @param {object} queryParams - Parâmetros de consulta (page, limit, status, search).
 * @returns {Promise<object>} Objeto com lista de clients e informações de paginação.
 */
async function getAllClientContacts(queryParams = {}) {
  try {
    const { page = 1, limit = 10, status, search } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = {};
    if (status) whereConditions.status = status;
    if (search) {
      whereConditions[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await Client.findAndCountAll({
      where: whereConditions,
      limit: parseInt(limit, 10),
      offset: offset,
      order: [['name', 'ASC']],
      include: [
        { model: FinancialAccount, as: 'financialAccounts', attributes: ['id', 'accountName', 'accountType', 'isActive', 'isDefault'] }
      ]
    });
    logger.info(`Listados ${rows.length} contatos clientes de um total de ${count}.`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      clients: rows.map(client => client.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar contatos clientes: ${error.message}`, { error });
    throw new Error(`Erro ao listar contatos clientes.`);
  }
}

/**
 * Busca um Client (contato) específico pelo ID.
 * @param {number} clientId - ID do Client.
 * @returns {Promise<object|null>} O Client encontrado ou null.
 */
async function getClientContactById(clientId) {
  try {
    const client = await Client.findByPk(clientId, {
      include: [{ model: FinancialAccount, as: 'financialAccounts' }]
    });
    if (!client) {
      logger.warn(`Contato Cliente com ID ${clientId} não encontrado.`);
      return null;
    }
    logger.info(`Contato Cliente ID ${clientId} encontrado: ${client.name || client.phone}`);
    return client.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar contato cliente por ID ${clientId}: ${error.message}`, { error });
    throw new Error(`Erro ao buscar contato cliente.`);
  }
}

/**
 * Atualiza os dados de um Client (contato).
 * @param {number} clientId - ID do Client.
 * @param {object} updateData - { name, status, email }
 * @returns {Promise<object|null>} O Client atualizado ou null se não encontrado.
 */
async function updateClientContact(clientId, updateData) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      await t.rollback();
      logger.warn(`Contato Cliente ID ${clientId} não encontrado para atualização.`);
      return null;
    }

    const allowedFields = ['name', 'status', 'email'];
    const filteredData = {};
    for(const key of allowedFields) {
        if(updateData.hasOwnProperty(key)) { // Usar hasOwnProperty para permitir '' ou false como valores válidos
            filteredData[key] = updateData[key];
        }
    }

    if(updateData.email && updateData.email !== client.email) {
        const existingEmail = await Client.findOne({ where: { email: updateData.email.toLowerCase(), id: {[Op.ne]: clientId }}, transaction: t});
        if(existingEmail) {
            await t.rollback();
            const error = new Error('O email fornecido já está em uso por outro cliente.');
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }


    if(Object.keys(filteredData).length === 0) {
        await t.commit();
        return client.toJSON(); // Nada a atualizar
    }

    await client.update(filteredData, { transaction: t });
    await t.commit();
    logger.info(`Contato Cliente ID ${clientId} atualizado.`);
    return client.reload().then(c => c.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar contato cliente ID ${clientId}: ${error.message}`, { error, updateData });
    if (error.name === 'SequelizeValidationError') {
        const valError = new Error(error.errors.map(e => e.message).join(', '));
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui um Client (contato) e todas as suas FinancialAccounts e dados relacionados.
 * @param {number} clientId - ID do Client.
 * @returns {Promise<boolean>} True se excluído, false se não encontrado.
 */
async function deleteClientContact(clientId) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      await t.rollback();
      logger.warn(`Contato Cliente ID ${clientId} não encontrado para exclusão.`);
      return false;
    }
    await client.destroy({ transaction: t }); // Cascade delete definido no modelo Client para FinancialAccounts, Subscriptions, etc.
    await t.commit();
    logger.info(`Contato Cliente ID ${clientId} (${client.name || client.phone}) e todos os dados associados foram excluídos.`);
    return true;
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao excluir contato cliente ID ${clientId}: ${error.message}`, { error });
    throw new Error(`Erro ao excluir contato cliente.`);
  }
}


// === Gerenciamento de FinancialAccounts de um Client ===

/**
 * Cria uma nova FinancialAccount para um Client.
 * @param {number} clientId - ID do Client (dono da conta).
 * @param {object} accountData - { accountName, accountType, documentNumber (opcional), isActive (opcional), isDefault (opcional) }
 * @returns {Promise<object>} A FinancialAccount criada.
 */
async function createFinancialAccount(clientId, accountData) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      await t.rollback();
      const error = new Error(`Cliente com ID ${clientId} não encontrado para associar a conta financeira.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    if (!accountData.accountName || !accountData.accountType) {
      await t.rollback();
      const error = new Error('Nome da Conta e Tipo da Conta são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!['PF', 'PJ', 'MEI'].includes(accountData.accountType)) {
        await t.rollback();
        const error = new Error('Tipo de conta inválido. Use PF, PJ ou MEI.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const existingAccountName = await FinancialAccount.findOne({
        where: { clientId, accountName: accountData.accountName }, transaction: t
    });
    if(existingAccountName){
        await t.rollback();
        const error = new Error(`O cliente já possui uma conta financeira chamada "${accountData.accountName}".`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }
    if(accountData.documentNumber){
        const existingDoc = await FinancialAccount.findOne({
            where: { documentNumber: accountData.documentNumber }, transaction: t
        });
        if(existingDoc){
            await t.rollback();
            const error = new Error(`O documento ${accountData.documentNumber} já está associado a outra conta financeira (ID: ${existingDoc.id}).`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    if (accountData.isDefault === true || accountData.isDefault === 'true') {
      await FinancialAccount.update(
        { isDefault: false },
        { where: { clientId, isDefault: true }, transaction: t }
      );
    } else {
      const defaultCount = await FinancialAccount.count({ where: { clientId, isDefault: true }, transaction: t });
      if (defaultCount === 0) {
        accountData.isDefault = true; // A primeira conta do cliente se torna default
      } else {
        accountData.isDefault = false; // Garante que seja false se não explicitamente true
      }
    }
    accountData.isActive = accountData.isActive === undefined ? true : (accountData.isActive === 'true' || accountData.isActive === true);


    const newAccount = await FinancialAccount.create({ ...accountData, clientId }, { transaction: t });
    await t.commit();
    logger.info(`Conta Financeira "${newAccount.accountName}" (Tipo: ${newAccount.accountType}) criada para Cliente ID ${clientId}. Default: ${newAccount.isDefault}`);
    return newAccount.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar conta financeira para Cliente ID ${clientId}: ${error.message}`, { error, accountData });
    if (error.name === 'SequelizeValidationError' || error.name === 'SequelizeUniqueConstraintError') {
        const customError = new Error(error.errors.map(e => e.message).join(', '));
        customError.statusCode = error.name === 'SequelizeUniqueConstraintError' ? 409 : 400;
        customError.status = 'fail';
        throw customError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todas as FinancialAccounts de um Client.
 * @param {number} clientId - ID do Client.
 * @param {object} queryParams - { isActive (boolean) }
 * @returns {Promise<Array<object>>}
 */
async function getClientFinancialAccounts(clientId, queryParams = {}) {
  try {
    const whereConditions = { clientId };
    if (queryParams.isActive !== undefined) {
      whereConditions.isActive = (queryParams.isActive === 'true' || queryParams.isActive === true);
    }
    const accounts = await FinancialAccount.findAll({
      where: whereConditions,
      order: [['isDefault', 'DESC'], ['accountName', 'ASC']],
    });
    return accounts.map(acc => acc.toJSON());
  } catch (error) {
    logger.error(`Erro ao listar contas financeiras do Cliente ID ${clientId}: ${error.message}`, { error });
    throw new Error('Erro ao listar contas financeiras.');
  }
}

/**
 * Obtém uma FinancialAccount específica pelo seu ID, incluindo o proprietário.
 * @param {number} financialAccountId
 * @returns {Promise<object|null>}
 */
async function getFinancialAccountById(financialAccountId) {
    try {
        const account = await FinancialAccount.findByPk(financialAccountId, {
            include: [{model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone']}]
        });
        if(!account) return null;
        return account.toJSON();
    } catch (error) {
        logger.error(`Erro ao buscar conta financeira ID ${financialAccountId}: ${error.message}`, { error });
        throw new Error('Erro ao buscar conta financeira.');
    }
}


/**
 * Atualiza uma FinancialAccount.
 * @param {number} financialAccountId - ID da FinancialAccount.
 * @param {object} updateData - Dados a serem atualizados.
 * @returns {Promise<object|null>} A FinancialAccount atualizada.
 */
async function updateFinancialAccount(financialAccountId, updateData) {
  const t = await sequelize.transaction();
  try {
    const account = await FinancialAccount.findByPk(financialAccountId, { transaction: t });
    if (!account) {
      await t.rollback();
      logger.warn(`Conta Financeira ID ${financialAccountId} não encontrada para atualização.`);
      return null;
    }

    if (updateData.accountName && updateData.accountName !== account.accountName) {
        const existingAccountName = await FinancialAccount.findOne({
            where: { clientId: account.clientId, accountName: updateData.accountName, id: {[Op.ne]: financialAccountId} }, transaction: t
        });
        if(existingAccountName){
            await t.rollback();
            const error = new Error(`O cliente já possui outra conta financeira chamada "${updateData.accountName}".`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }
    if(updateData.documentNumber && updateData.documentNumber !== account.documentNumber){
        const existingDoc = await FinancialAccount.findOne({
            where: { documentNumber: updateData.documentNumber, id: {[Op.ne]: financialAccountId} }, transaction: t
        });
        if(existingDoc){
            await t.rollback();
            const error = new Error(`O documento ${updateData.documentNumber} já está associado a outra conta financeira (ID: ${existingDoc.id}).`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    if ((updateData.isDefault === true || updateData.isDefault === 'true') && !account.isDefault) {
      await FinancialAccount.update(
        { isDefault: false },
        { where: { clientId: account.clientId, isDefault: true, id: { [Op.ne]: financialAccountId } }, transaction: t }
      );
    } else if ((updateData.isDefault === false || updateData.isDefault === 'false') && account.isDefault) {
      const otherActiveAccountsCount = await FinancialAccount.count({
        where: { clientId: account.clientId, isActive: true, id: { [Op.ne]: financialAccountId } }, transaction: t
      });
      if (otherActiveAccountsCount === 0 && (updateData.isDefault === false || updateData.isDefault === 'false')) {
          updateData.isDefault = true; // Se for a única conta ativa, força a ser default
          logger.info(`Conta ID ${financialAccountId} é a única ativa, forçada a ser default.`);
      } else if (otherActiveAccountsCount > 0 && (updateData.isDefault === false || updateData.isDefault === 'false')) {
          logger.warn(`Tentativa de desmarcar conta default ID ${financialAccountId} sem definir outra. A UI deve garantir a seleção de um novo padrão, ou uma será promovida.`);
          // Não impede, mas a lógica para promover outra a default ao deletar esta é mais importante.
      }
    }

    // Evitar que clientId ou accountType sejam alterados por este método se não for intencional
    delete updateData.clientId;
    // delete updateData.accountType; // Permitir mudar tipo pode ter implicações (ex: produtos só em PJ/MEI) - avaliar

    await account.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Conta Financeira ID ${financialAccountId} ("${account.accountName}") atualizada.`);
    return account.reload({ include: [{model: Client, as: 'ownerClient'}] }).then(acc => acc.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar conta financeira ID ${financialAccountId}: ${error.message}`, { error, updateData });
    if (error.name === 'SequelizeValidationError' || error.name === 'SequelizeUniqueConstraintError') {
        const customError = new Error(error.errors.map(e => e.message).join(', '));
        customError.statusCode = error.name === 'SequelizeUniqueConstraintError' ? 409 : 400;
        customError.status = 'fail';
        throw customError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui uma FinancialAccount.
 * @param {number} financialAccountId - ID da FinancialAccount.
 * @returns {Promise<boolean>} True se excluído, false se não encontrado.
 */
async function deleteFinancialAccount(financialAccountId) {
  const t = await sequelize.transaction();
  try {
    const account = await FinancialAccount.findByPk(financialAccountId, { transaction: t });
    if (!account) {
      await t.rollback();
      logger.warn(`Conta Financeira ID ${financialAccountId} não encontrada para exclusão.`);
      return false;
    }

    if (account.isDefault) {
      const otherAccount = await FinancialAccount.findOne({
        where: { clientId: account.clientId, isActive: true, id: { [Op.ne]: financialAccountId } },
        order: [['createdAt', 'ASC']],
        transaction: t,
      });
      if (otherAccount) {
        await otherAccount.update({ isDefault: true }, { transaction: t });
        logger.info(`Conta Financeira ID ${otherAccount.id} ("${otherAccount.accountName}") promovida a default para Cliente ID ${account.clientId}.`);
      }
    }

    await account.destroy({ transaction: t }); // Cascade delete definido nos modelos associados
    await t.commit();
    logger.info(`Conta Financeira ID ${financialAccountId} ("${account.accountName}") e dados associados foram excluídos.`);
    return true;
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao excluir conta financeira ID ${financialAccountId}: ${error.message}`, { error });
    throw new Error('Erro ao excluir conta financeira.');
  }
}

/**
 * Obtém a conta financeira ativa e padrão de um cliente. Se não houver padrão, retorna a primeira ativa.
 * @param {number} clientId
 * @returns {Promise<object|null>}
 */
async function getActiveOrDefaultFinancialAccount(clientId) {
    try {
        let account = await FinancialAccount.findOne({
            where: { clientId, isActive: true, isDefault: true }
        });
        if (!account) {
            account = await FinancialAccount.findOne({
                where: { clientId, isActive: true },
                order: [['createdAt', 'ASC']]
            });
        }
        return account ? account.toJSON() : null;
    } catch (error) {
        logger.error(`Erro ao buscar conta ativa/padrão para cliente ID ${clientId}: ${error.message}`, { error });
        throw error;
    }
}


module.exports = {
  findClientByPhone,
  createClient,
  createClientContact,
  getAllClientContacts,
  getClientContactById,
  updateClientContact,
  deleteClientContact,
  createFinancialAccount,
  getClientFinancialAccounts,
  getFinancialAccountById,
  updateFinancialAccount,
  deleteFinancialAccount,
  getActiveOrDefaultFinancialAccount,
};
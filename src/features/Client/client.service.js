// src/features/Client/client.service.js
const { Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

// === Gerenciamento de Clients (Contatos do WhatsApp) ===

/**
 * Cria um novo Client (contato do WhatsApp).
 * Geralmente chamado quando uma nova interação de um número desconhecido ocorre.
 * @param {object} clientData - { phone, name (opcional), status (opcional) }
 * @returns {Promise<object>} O Client criado.
 */
async function createClientContact(clientData) {
  try {
    if (!clientData.phone) {
      const error = new Error('Número de telefone é obrigatório para criar um cliente.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    // Normalizar telefone (remover não dígitos)
    clientData.phone = clientData.phone.replace(/\D/g, '');

    const existingClient = await Client.findOne({ where: { phone: clientData.phone } });
    if (existingClient) {
      logger.info(`Cliente com telefone ${clientData.phone} já existe (ID: ${existingClient.id}). Retornando existente.`);
      return existingClient.toJSON();
    }

    const newClient = await Client.create(clientData);
    logger.info(`Novo Contato Cliente criado com sucesso: ID ${newClient.id}, Telefone: ${newClient.phone}`);
    return newClient.toJSON();
  } catch (error) {
    logger.error(`Erro ao criar contato cliente: ${error.message}`, { error, clientData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca ou cria um Client (contato WhatsApp) com base no número de telefone.
 * Se criado, também pode criar uma FinancialAccount padrão para ele.
 * @param {string} phone - Número de telefone.
 * @param {object} defaultClientData - { name (opcional, ex: pushName do WhatsApp) }
 * @param {boolean} createDefaultFinancialAccount - Se true, cria uma conta PF padrão.
 * @returns {Promise<object>} O Client encontrado ou criado.
 */
async function findOrCreateClientByPhone(phone, defaultClientData = {}, createDefaultFinancialAccount = true) {
  if (!phone) {
    const error = new Error('Número de telefone é obrigatório.');
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  const normalizedPhone = phone.replace(/\D/g, '');

  const t = await sequelize.transaction();
  try {
    let client = await Client.findOne({ where: { phone: normalizedPhone }, transaction: t });
    let clientWasCreated = false;

    if (!client) {
      client = await Client.create({
        phone: normalizedPhone,
        name: defaultClientData.name || `Usuário ${normalizedPhone.slice(-4)}`,
        status: 'Ativo',
      }, { transaction: t });
      clientWasCreated = true;
      logger.info(`Novo Contato Cliente criado: ID ${client.id}, Telefone ${normalizedPhone}`);
    } else {
      logger.info(`Contato Cliente encontrado: ID ${client.id}, Telefone ${normalizedPhone}`);
      // Opcional: Atualizar nome se um novo pushName for fornecido e diferente do atual
      if (defaultClientData.name && defaultClientData.name !== client.name) {
        await client.update({ name: defaultClientData.name }, { transaction: t });
        logger.info(`Nome do Contato Cliente ID ${client.id} atualizado para "${defaultClientData.name}".`);
      }
    }

    if (createDefaultFinancialAccount) {
      // Verifica se já existe alguma conta financeira para este cliente
      const existingFinancialAccounts = await FinancialAccount.count({ where: { clientId: client.id }, transaction: t });
      if (existingFinancialAccounts === 0) {
        // Cria uma conta financeira PF padrão
        await FinancialAccount.create({
          clientId: client.id,
          accountName: 'Pessoal',
          accountType: 'PF',
          isActive: true,
          isDefault: true, // A primeira conta é a padrão
        }, { transaction: t });
        logger.info(`Conta Financeira PF Padrão ("Pessoal") criada para Cliente ID ${client.id}`);
      }
    }

    await t.commit();
    return client.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro em findOrCreateClientByPhone para ${normalizedPhone}: ${error.message}`, { error });
    throw error; // Repassa o erro
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
      ];
    }

    const { count, rows } = await Client.findAndCountAll({
      where: whereConditions,
      limit: parseInt(limit, 10),
      offset: offset,
      order: [['name', 'ASC']],
      include: [ // Opcional: Contar quantas contas financeiras cada cliente tem
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
      include: [{ model: FinancialAccount, as: 'financialAccounts' }] // Inclui suas contas financeiras
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
 * @param {object} updateData - { name, status }
 * @returns {Promise<object|null>} O Client atualizado ou null se não encontrado.
 */
async function updateClientContact(clientId, updateData) {
  try {
    const client = await Client.findByPk(clientId);
    if (!client) {
      logger.warn(`Contato Cliente ID ${clientId} não encontrado para atualização.`);
      return null;
    }
    // Filtrar campos permitidos para atualização do Client (phone não deve ser alterado facilmente)
    const allowedFields = ['name', 'status'];
    const filteredData = {};
    for(const key of allowedFields) {
        if(updateData[key] !== undefined) filteredData[key] = updateData[key];
    }
    if(Object.keys(filteredData).length === 0) return client.toJSON(); // Nada a atualizar

    await client.update(filteredData);
    logger.info(`Contato Cliente ID ${clientId} atualizado.`);
    return client.reload().then(c => c.toJSON());
  } catch (error) {
    logger.error(`Erro ao atualizar contato cliente ID ${clientId}: ${error.message}`, { error, updateData });
    throw new Error(`Erro ao atualizar contato cliente.`);
  }
}

/**
 * Exclui um Client (contato) e todas as suas FinancialAccounts e dados relacionados (devido ao onDelete: CASCADE).
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
    // A deleção das FinancialAccounts e seus dados associados (transactions, cards, etc.)
    // acontecerá em cascata devido ao onDelete: 'CASCADE' nas associações.
    await client.destroy({ transaction: t });
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
      const error = new Error(`Cliente com ID ${clientId} não encontrado para associar a conta financeira.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    if (!accountData.accountName || !accountData.accountType) {
      const error = new Error('Nome da Conta e Tipo da Conta são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!['PF', 'PJ', 'MEI'].includes(accountData.accountType)) {
        const error = new Error('Tipo de conta inválido. Use PF, PJ ou MEI.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    // Validação de unicidade de nome de conta por cliente
    const existingAccountName = await FinancialAccount.findOne({
        where: { clientId, accountName: accountData.accountName }, transaction: t
    });
    if(existingAccountName){
        const error = new Error(`O cliente já possui uma conta financeira chamada "${accountData.accountName}".`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }
    // Validação de unicidade de documento (CNPJ/CPF), se fornecido
    if(accountData.documentNumber){
        const existingDoc = await FinancialAccount.findOne({
            where: { documentNumber: accountData.documentNumber }, transaction: t
        });
        if(existingDoc){
            const error = new Error(`O documento ${accountData.documentNumber} já está associado a outra conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }


    // Lógica para 'isDefault': se esta for marcada como default, desmarcar outras do mesmo cliente.
    if (accountData.isDefault === true) {
      await FinancialAccount.update(
        { isDefault: false },
        { where: { clientId, isDefault: true }, transaction: t }
      );
    } else {
      // Se não for default e não houver nenhuma default para o cliente, torna esta a default
      const defaultCount = await FinancialAccount.count({ where: { clientId, isDefault: true }, transaction: t });
      if (defaultCount === 0) {
        accountData.isDefault = true;
      }
    }

    const newAccount = await FinancialAccount.create({ ...accountData, clientId }, { transaction: t });
    await t.commit();
    logger.info(`Conta Financeira "${newAccount.accountName}" (Tipo: ${newAccount.accountType}) criada para Cliente ID ${clientId}. Default: ${newAccount.isDefault}`);
    return newAccount.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar conta financeira para Cliente ID ${clientId}: ${error.message}`, { error, accountData });
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
      order: [['isDefault', 'DESC'], ['accountName', 'ASC']], // Padrão primeiro, depois por nome
    });
    return accounts.map(acc => acc.toJSON());
  } catch (error) {
    logger.error(`Erro ao listar contas financeiras do Cliente ID ${clientId}: ${error.message}`, { error });
    throw new Error('Erro ao listar contas financeiras.');
  }
}

/**
 * Obtém uma FinancialAccount específica pelo seu ID.
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

    // Validação de unicidade de nome de conta por cliente, se o nome estiver sendo alterado
    if (updateData.accountName && updateData.accountName !== account.accountName) {
        const existingAccountName = await FinancialAccount.findOne({
            where: { clientId: account.clientId, accountName: updateData.accountName, id: {[Op.ne]: financialAccountId} }, transaction: t
        });
        if(existingAccountName){
            const error = new Error(`O cliente já possui outra conta financeira chamada "${updateData.accountName}".`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }
    // Validação de unicidade de documento, se alterado
    if(updateData.documentNumber && updateData.documentNumber !== account.documentNumber){
        const existingDoc = await FinancialAccount.findOne({
            where: { documentNumber: updateData.documentNumber, id: {[Op.ne]: financialAccountId} }, transaction: t
        });
        if(existingDoc){
            const error = new Error(`O documento ${updateData.documentNumber} já está associado a outra conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    // Lógica para 'isDefault'
    if (updateData.isDefault === true && !account.isDefault) {
      await FinancialAccount.update(
        { isDefault: false },
        { where: { clientId: account.clientId, isDefault: true, id: { [Op.ne]: financialAccountId } }, transaction: t }
      );
    } else if (updateData.isDefault === false && account.isDefault) {
      // Impedir que um cliente fique sem conta default se ele tiver outras contas ativas
      const otherActiveAccountsCount = await FinancialAccount.count({
        where: { clientId: account.clientId, isActive: true, id: { [Op.ne]: financialAccountId } }, transaction: t
      });
      if (otherActiveAccountsCount > 0) {
        // Não pode desmarcar a última default se há outras. Outra deve ser setada como default primeiro.
        // Ou, automaticamente, promove outra a default (mais complexo).
        // Por simplicidade, a UI/controller pode forçar que, ao desmarcar uma default, outra seja marcada.
        // Se aqui for a única conta, ela permanecerá default implicitamente (ou a lógica de criação de outra a tornará não-default).
         logger.warn(`Tentativa de desmarcar conta default ID ${financialAccountId} sem definir outra. A lógica de ter sempre uma default (se houver contas) deve ser garantida.`);
      } else if (otherActiveAccountsCount === 0) {
          updateData.isDefault = true; // Se for a única conta, força a ser default
      }
    }

    await account.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Conta Financeira ID ${financialAccountId} ("${account.accountName}") atualizada.`);
    return account.reload({ include: [{model: Client, as: 'ownerClient'}] }).then(acc => acc.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar conta financeira ID ${financialAccountId}: ${error.message}`, { error, updateData });
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

    // Se esta for a conta default, e houver outras, promover outra a default
    if (account.isDefault) {
      const otherAccount = await FinancialAccount.findOne({
        where: { clientId: account.clientId, isActive: true, id: { [Op.ne]: financialAccountId } },
        order: [['createdAt', 'ASC']], // Promove a mais antiga ativa
        transaction: t,
      });
      if (otherAccount) {
        await otherAccount.update({ isDefault: true }, { transaction: t });
        logger.info(`Conta Financeira ID ${otherAccount.id} ("${otherAccount.accountName}") promovida a default para Cliente ID ${account.clientId}.`);
      }
    }

    // Deleção em cascata (Transactions, RecurringRules, CreditCards, Products, Appointments)
    // é definida nas associações dos modelos (onDelete: 'CASCADE').
    await account.destroy({ transaction: t });
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
                order: [['createdAt', 'ASC']] // Pega a mais antiga ativa se não houver default
            });
        }
        return account ? account.toJSON() : null;
    } catch (error) {
        logger.error(`Erro ao buscar conta ativa/padrão para cliente ID ${clientId}: ${error.message}`, { error });
        throw error;
    }
}


module.exports = {
  // Client Contact Management
  createClientContact,
  findOrCreateClientByPhone,
  getAllClientContacts,
  getClientContactById,
  updateClientContact,
  deleteClientContact,
  // Financial Account Management
  createFinancialAccount,
  getClientFinancialAccounts,
  getFinancialAccountById,
  updateFinancialAccount,
  deleteFinancialAccount,
  getActiveOrDefaultFinancialAccount,
};
// src/features/Client/client.service.js
// <<< CORREÇÃO: Importado 'FinancialCategory' em vez de 'Category' >>>
const { Client, FinancialAccount, FinancialCategory, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const crypto = require('node:crypto'); // <<<< ADICIONE ESTA LINHA AQUI



// <<< INÍCIO DA MODIFICAÇÃO: DEFINIÇÃO DAS CATEGORIAS PADRÃO POR TIPO DE CONTA >>>

// Lista de categorias para Contas Pessoais (PF)
const defaultPersonalCategoryNames = [
    'Alimentação', 'Supermercado', 'Restaurantes', 'Ifood', 'Delivery', 'Moradia', 'Aluguel',
    'Condomínio', 'Contas' , 'Conta de Água', 'Conta de Luz', 'Conta de Gás', 'Internet', 'Transporte', 'Abastecimento',
    'Estacionamento', 'Uber', '99', 'Transporte Público', 'Manutenção Veicular', 'Saúde',
    'Farmácia', 'Plano de Saúde', 'Consultas', 'Exames', 'Academia', 'Lazer', 'Entretenimento',
    'Viagens', 'Cinema', 'Shows', 'Assinaturas', 'Streamings', 'Cuidados Pessoais', 'Beleza',
    'Compras', 'Vestuário', 'Eletrônicos', 'Casa', 'Presentes', 'Educação',
    'Dívidas', 'Empréstimos', 'Pagamento de Fatura', 'Receitas', 'Salário', 'Renda Extra', 'Investimentos'
];

// Lista de categorias para Contas de Negócio (PJ/MEI)
const defaultBusinessCategoryNames = [
    'Receitas Operacionais', 'Venda de Produtos', 'Prestação de Serviços', 'Outras Receitas',
    'Custos dos Produtos/Serviços (CPV/CSV)', 'Matéria-prima e Insumos', 'Mercadorias para Revenda',
    'Fretes sobre Vendas', 'Despesas Administrativas', 'Salários e Pró-labore', 'Aluguel (Escritório/Loja)',
    'Contas (Luz, Água, Internet)', 'Telefonia', 'Honorários (Contador, Advogado)', 'Material de Escritório',
    'Despesas de Marketing', 'Marketing e Publicidade', 'Comissões de Vendas', 'Despesas Financeiras',
    'Taxas Bancárias', 'Juros de Empréstimos', 'Taxas de Cartão', 'Impostos e Tributos',
    'Simples Nacional / DAS', 'Outros Impostos', 'Investimentos e Ativos', 'Compra de Equipamentos',
    'Manutenção de Ativos', 'Despesas com Pessoal', 'Benefícios (VT, VR)', 'Treinamentos',
    'Outras Despesas Operacionais', 'Viagens e Representação', 'Manutenção de Software/Licenças'
];


/**
 * <<< MODIFICAÇÃO: Nova função auxiliar para criar categorias padrão >>>
 * Cria as categorias padrão para uma nova conta financeira com base em seu tipo.
 * @param {number} financialAccountId - O ID da conta financeira.
 * @param {string} accountType - O tipo da conta ('PF', 'PJ', 'MEI').
 * @param {object} transaction - O objeto de transação do Sequelize.
 */
async function createDefaultCategoriesForAccount(financialAccountId, accountType, transaction) {
    logger.info(`Iniciando criação de categorias padrão para conta ID ${financialAccountId}, tipo ${accountType}.`);
    
    let categoryNames;
    if (accountType === 'PF') {
        categoryNames = defaultPersonalCategoryNames;
    } else if (['PJ', 'MEI'].includes(accountType)) {
        categoryNames = defaultBusinessCategoryNames;
    } else {
        logger.warn(`Tipo de conta '${accountType}' não tem categorias padrão definidas. Nenhuma categoria será criada.`);
        return; // Não há categorias para este tipo de conta
    }

    // <<< CORREÇÃO: Removida a lógica do campo 'type' que não existe mais no modelo FinancialCategory >>>
    const categoriesToCreate = categoryNames.map(name => {
        return {
            financialAccountId: financialAccountId,
            name: name,
            // O campo 'type' foi removido do objeto de criação.
        };
    });

    if (categoriesToCreate.length > 0) {
        // <<< CORREÇÃO: Usando 'FinancialCategory.bulkCreate' em vez de 'Category.bulkCreate' >>>
        await FinancialCategory.bulkCreate(categoriesToCreate, { transaction });
        logger.info(`${categoriesToCreate.length} categorias padrão do tipo '${accountType}' criadas com sucesso para a conta ID ${financialAccountId}.`);
    }
}


/**
 * Busca um Client (contato WhatsApp) pelo número de telefone.
 * @param {string} phone - Número de telefone.
 * @returns {Promise<object|null>} O Client encontrado (toJSON) ou null.
 */
async function findClientByPhone(phone) {
  if (!phone) return null;
  const normalizedPhone = phone.replace(/\D/g, '');
  try {
    // CORREÇÃO: Usamos .scope('withPassword') para incluir o passwordHash na consulta.
    const client = await Client.scope('withPassword').findOne({ where: { phone: normalizedPhone } });
    
    // Retorna o objeto completo para que a lógica de verificação de estado funcione.
    // O toJSON() é chamado depois pelo serviço de whatsapp se necessário.
    return client; // Retorna a instância do Sequelize diretamente
  } catch (error) {
    logger.error(`Erro ao buscar cliente por telefone ${normalizedPhone}: ${error.message}`, { error });
    throw error;
  }
}
// --- FUNÇÃO DE DEBUG MODIFICADA ---
/**
 * ATENÇÃO: Função de debug para listar todos os CLIENTES com dados de afiliado.
 * @returns {Promise<Array<object>>} Lista de clientes com detalhes.
 */
async function getClientsForDebug() {
  try {
    const clients = await Client.scope('withPassword').findAll({
      include: [
        {
          model: Client,
          as: 'referrer', // Inclui o modelo Client novamente, usando o alias 'referrer'
          attributes: ['name', 'affiliateCode'], // Pega apenas o nome e o código de afiliado do indicador
          required: false // Usa LEFT JOIN para não excluir clientes que não foram indicados
        }
      ],
      order: [['id', 'ASC']],
    });

    const clientsWithDetails = clients.map(client => {
      const clientJSON = client.toJSON();
      return {
        id: clientJSON.id,
        name: clientJSON.name,
        email: clientJSON.email,
        phone: clientJSON.phone,
        senha_hash: clientJSON.passwordHash,
        senha_plana_debug: clientJSON.debugPassword,
        plano_acesso: clientJSON.accessLevel,
        plano_expira_em: clientJSON.accessExpiresAt,
        status: clientJSON.status,
        meu_codigo_afiliado: clientJSON.affiliateCode, // O código do próprio cliente
        saldo_comissao: clientJSON.balance,
        indicado_por_id: clientJSON.referredByClientId,
        indicado_por_nome: clientJSON.referrer ? clientJSON.referrer.name : null, // Nome do indicador
        codigo_do_indicador: clientJSON.referrer ? clientJSON.referrer.affiliateCode : null, // Código do indicador
      };
    });

    logger.warn('Executada função de debug getClientsForDebug que expõe dados sensíveis de clientes.');
    return clientsWithDetails;
  } catch (error) {
    logger.error(`Erro na função de debug getClientsForDebug: ${error.message}`, { error });
    throw new Error(`Erro ao buscar clientes para debug.`);
  }
}

/**
 * Busca um cliente pelo telefone. Se não existir, cria um novo.
 * Esta função é destinada ao uso pelo WhatsappHandler.
 * @param {string} phone - Número de telefone do cliente.
 * @param {object} defaultData - Dados para usar na criação se o cliente não existir (ex: { name }).
 * @returns {Promise<object>} O objeto Client encontrado ou criado (toJSON).
 */
async function findOrCreateClientByPhone(phone, defaultData = {}) {
  const normalizedPhone = phone.replace(/\D/g, '');
  const t = await sequelize.transaction();
  try {
    let client = await Client.findOne({
      where: { phone: normalizedPhone },
      transaction: t
    });

    if (client) {
      // ===== INÍCIO DA LÓGICA DE PROTEÇÃO =====
      // Se o cliente já tem um nome e email definidos, consideramos ele "completo".
      // Não faremos nenhuma atualização para evitar apagar dados. Apenas o retornamos.
      if (client.name && client.email) {
        logger.info(`Cliente ${normalizedPhone} (ID: ${client.id}) já está totalmente configurado. Nenhuma atualização necessária.`);
        await t.commit();
        return client.toJSON();
      }

      // Se chegamos aqui, o cliente existe mas é um "esqueleto" (pode não ter nome ou email).
      // É seguro tentar preencher os dados faltantes com o que veio do WhatsApp.
      let clientNeedsUpdate = false;
      const updatePayload = {};

      // Atualiza o nome apenas se o novo nome for mais completo ou se o atual for nulo.
      if (defaultData.name && defaultData.name.trim() !== "") {
        const existingNameWords = client.name ? client.name.split(' ').length : 0;
        const newNameWords = defaultData.name.split(' ').length;
        if (newNameWords > existingNameWords || !client.name) {
          updatePayload.name = defaultData.name;
          clientNeedsUpdate = true;
        }
      }
      
      // Atualiza o email apenas se ele não existir ainda.
      if (defaultData.email && !client.email) {
        updatePayload.email = defaultData.email;
        clientNeedsUpdate = true;
      }

      if (clientNeedsUpdate) {
        await client.update(updatePayload, { transaction: t });
        logger.info(`Cliente ${normalizedPhone} (ID: ${client.id}) encontrado e dados de perfil (nome/email) foram preenchidos.`);
      } else {
        logger.info(`Cliente ${normalizedPhone} (ID: ${client.id}) encontrado. Nenhum dado novo para preencher.`);
      }
      // ===== FIM DA LÓGICA DE PROTEÇÃO =====

    } else {
      // Cliente não encontrado, criar novo.
      // Esta parte já estava correta, criando um registro com o que tiver disponível.
      logger.info(`Cliente com telefone ${normalizedPhone} não encontrado. Criando novo...`);
      client = await Client.create({
        phone: normalizedPhone,
        name: defaultData.name || null,
        email: defaultData.email || null,
        status: defaultData.status || 'Ativo',
      }, { transaction: t });
      logger.info(`Novo Cliente criado via findOrCreate: ID ${client.id}, Telefone: ${client.phone}, Nome: ${client.name}`);
    }

    await t.commit();
    return client.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro em findOrCreateClientByPhone para ${normalizedPhone}: ${error.message}`, { error, defaultData });
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
 * MODIFICADO para aceitar um código de afiliado.
 * @param {object} clientData - { phone, name, status, email, affiliateCode (opcional) }
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

    const newClientPayload = {
        phone: normalizedPhone,
        name: clientData.name,
        email: clientData.email || null,
        status: clientData.status || 'Ativo',
    };

    // === NOVA LÓGICA DE AFILIADO ===
    if (clientData.affiliateCode) {
        const referrer = await Client.findOne({ 
            where: { affiliateCode: clientData.affiliateCode.toUpperCase() }, // Busca pelo código em maiúsculas
            transaction: t 
        });
        if (referrer) {
            newClientPayload.referredByClientId = referrer.id;
            logger.info(`Novo cliente ${normalizedPhone} será vinculado ao afiliado ID ${referrer.id}.`);
        } else {
            logger.warn(`Código de afiliado "${clientData.affiliateCode}" fornecido mas não encontrado. Cliente será criado sem indicador.`);
        }
    }
    // === FIM DA LÓGICA DE AFILIADO ===

    const newClient = await Client.create(newClientPayload, { transaction: t });
    
    // Supondo que você tem a função para criar contas PF e categorias...
    const pfAccount = await FinancialAccount.create({
        clientId: newClient.id,
        accountName: 'Pessoal',
        accountType: 'PF',
        isDefault: true,
    }, { transaction: t });
    await createDefaultCategoriesForAccount(pfAccount.id, 'PF', t);
    
    await t.commit();
    logger.info(`Novo Contato Cliente criado: ID ${newClient.id}, Telefone: ${newClient.phone}`);
    return newClient.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar contato cliente: ${error.message}`, { error, clientData });
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
 * Atualiza as preferências de mensagem motivacional para um cliente específico.
 * @param {number} clientId - O ID do cliente a ser atualizado.
 * @param {object} prefs - { enable: boolean, time: 'HH:MM' }
 * @returns {Promise<object>} O cliente atualizado.
 */
async function updateClientMotivationPrefs(clientId, prefs) {
  try {
    const client = await Client.findByPk(clientId);
    if (!client) {
      throw { statusCode: 404, message: 'Cliente não encontrado.' };
    }

    const updateData = {
      wantsMotivationMessage: prefs.enable,
    };

    // <<<< INÍCIO DA LÓGICA DE RESET >>>>
    // Verifica se o horário está sendo ativado ou alterado para um novo valor.
    if (prefs.enable && prefs.time) {
      // Compara o novo horário com o horário salvo no banco.
      // Se forem diferentes, significa que o usuário está mudando o horário.
      if (client.motivationMessageTime !== prefs.time) {
        updateData.motivationMessageTime = prefs.time;
        // Reseta a data do último envio para permitir que a mensagem seja enviada novamente hoje no novo horário.
        updateData.lastMotivationSentDate = null; 
        logger.info(`Horário de motivação para Cliente ID ${clientId} alterado para ${prefs.time}. Resetando lastMotivationSentDate.`);
      }
    } else if (!prefs.enable) {
      // Se o usuário está desativando, não precisamos mexer no horário ou na data.
      // A verificação `wantsMotivationMessage: true` no job já vai impedi-lo de receber.
    }
    // <<<< FIM DA LÓGICA DE RESET >>>>

    // Se não houver nada para atualizar (ex: o usuário pediu para ativar no mesmo horário que já estava), não faz nada.
    if (Object.keys(updateData).length === 0) {
        logger.info(`Nenhuma alteração nas preferências de motivação para Cliente ID ${clientId}.`);
        return client.toJSON();
    }

    await client.update(updateData);
    logger.info(`Preferências de motivação atualizadas para Cliente ID ${clientId}. Ativo: ${prefs.enable}, Horário: ${prefs.time || client.motivationMessageTime}`);
    return client.toJSON();

  } catch (error) {
    logger.error(`Erro ao atualizar preferências de motivação para cliente ID ${clientId}: ${error.message}`, error);
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
    
    // <<< MODIFICAÇÃO: Chamada para a nova função de criação de categorias >>>
    // Passa o tipo da conta para que a função saiba quais categorias criar.
    await createDefaultCategoriesForAccount(newAccount.id, newAccount.accountType, t);
    
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

async function backfillAffiliateCodes() {
  const t = await sequelize.transaction();
  try {
    const clientsWithoutCode = await Client.findAll({
      where: {
        affiliateCode: null
      },
      transaction: t
    });

    if (clientsWithoutCode.length === 0) {
      await t.commit();
      logger.info('[Backfill] Nenhum cliente encontrado sem código de afiliado.');
      return { message: 'Nenhum cliente precisava de um código de afiliado.', updatedCount: 0 };
    }

    logger.info(`[Backfill] Encontrados ${clientsWithoutCode.length} clientes sem código de afiliado. Gerando códigos...`);
    let updatedCount = 0;

    for (const client of clientsWithoutCode) {
      // Gera um código único para evitar colisões, mesmo que seja improvável
      let newCode;
      let isUnique = false;
      while (!isUnique) {
        // Formato: MAP + primeiras 4 letras do nome (se houver) + 4 caracteres aleatórios
        const namePart = client.name ? client.name.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase() : '';
        const randomPart = crypto.randomBytes(2).toString('hex').toUpperCase();
        newCode = `MAP${namePart}${randomPart}`;

        const existingCode = await Client.findOne({ where: { affiliateCode: newCode }, transaction: t });
        if (!existingCode) {
          isUnique = true;
        }
      }
      
      await client.update({ affiliateCode: newCode }, { transaction: t });
      updatedCount++;
    }

    await t.commit();
    logger.info(`[Backfill] ${updatedCount} clientes foram atualizados com novos códigos de afiliado.`);
    return { message: `Operação concluída com sucesso.`, updatedCount: updatedCount };

  } catch (error) {
    await t.rollback();
    logger.error(`[Backfill] Erro ao gerar códigos de afiliado para clientes existentes: ${error.message}`, { error });
    throw new Error('Falha ao executar o backfill dos códigos de afiliado.');
  }
}


module.exports = {
  findClientByPhone,
  findOrCreateClientByPhone,
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
  getClientsForDebug,
  updateClientMotivationPrefs,
  backfillAffiliateCodes
};
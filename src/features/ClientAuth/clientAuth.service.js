// src/features/ClientAuth/clientAuth.service.js
const { Client, Subscription, Plan, FinancialAccount, sequelize } = require('../../database'); // Adicionado FinancialAccount e sequelize
const logger = require('../../utils/logger');
const { generateToken } = require('../../utils/authUtils');
const { Op } = require('sequelize');
const subscriptionService = require('../Subscription/subscription.service'); // Para verificar assinatura no login

/**
 * Permite um Client definir ou atualizar sua senha e email,
 * geralmente após um primeiro contato via WhatsApp ou para acesso ao dashboard.
 * @param {string} phone - Número de telefone do Client.
 * @param {string} password - Nova senha.
 * @param {string} [name] - Nome a ser definido/atualizado (opcional).
 * @param {string} [email] - Email a ser definido/atualizado (opcional, mas recomendado para login).
 * @returns {Promise<object>} Client atualizado (sem hash de senha).
 */
async function setClientCredentials(phone, password, name = null, email = null) {
  const t = await sequelize.transaction();
  try {
    if (!phone || !password) {
      await t.rollback();
      const error = new Error('Telefone e nova senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (password.length < 6) {
      await t.rollback();
      const error = new Error('A senha deve ter pelo menos 6 caracteres.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const normalizedPhone = phone.replace(/\D/g, '');
    let client = await Client.findOne({ where: { phone: normalizedPhone }, transaction: t });

    if (!client) {
      // Se o cliente não existe, podemos optar por criá-lo aqui ou retornar erro.
      // Para o fluxo de "definir senha para um contato do WhatsApp", ele já deveria existir.
      // Se for um "registro" web puro, poderíamos criar.
      // Por ora, vamos assumir que o client foi pré-criado pelo WhatsApp ou outro meio.
      // Se quiser permitir criação aqui:
      // if (!name || !email) { // Nome e email seriam obrigatórios para criar um novo client web
      //   await t.rollback();
      //   const error = new Error('Nome e email são necessários para registrar um novo cliente via web.');
      //   error.statusCode = 400; error.status = 'fail'; throw error;
      // }
      // client = await Client.create({ phone: normalizedPhone, name, email, passwordHash: password, status: 'Aguardando Pagamento' }, { transaction: t });
      // logger.info(`Novo Cliente ${normalizedPhone} criado via setClientCredentials.`);
      // O hook faria o hash da senha.
      await t.rollback();
      const error = new Error('Cliente não encontrado com este número de telefone. O registro inicial deve ocorrer via WhatsApp ou outro canal designado.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const updateData = { passwordHash: password }; // Hook do modelo Client fará o hash

    if (email) {
      const lowerEmail = email.toLowerCase();
      // Verificar se o email já está em uso por outro cliente
      const existingEmailClient = await Client.findOne({
        where: {
          email: lowerEmail,
          id: { [Op.ne]: client.id } // Exclui o próprio cliente da verificação
        },
        transaction: t
      });
      if (existingEmailClient) {
        await t.rollback();
        const error = new Error('Este endereço de email já está em uso por outro cliente.');
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
      updateData.email = lowerEmail; // Hook do modelo Client também faz toLowerCase, mas bom garantir
    }

    if (name && name !== client.name) {
        updateData.name = name;
    }

    await client.update(updateData, { transaction: t });
    await t.commit();
    // O defaultScope do Client já remove o passwordHash
    logger.info(`Credenciais (senha e/ou email/nome) atualizadas para o Cliente ${client.phone}.`);
    return client.reload().then(c => c.toJSON()); // Recarrega para pegar dados atualizados pelo defaultScope
  } catch (error) {
    await t.rollback(); // Garante rollback em qualquer erro não tratado explicitamente acima
    logger.error(`Erro ao definir credenciais para cliente ${phone}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Realiza o login de um Client (para acesso ao dashboard web).
 * @param {string} identifier - Email ou telefone do Client.
 * @param {string} password - Senha do Client.
 * @returns {Promise<object>} Objeto com client, token, e financialAccounts.
 */
async function loginClient(identifier, password) {
  try {
    if (!identifier || !password) {
      const error = new Error('Identificador (email/telefone) e senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const normalizedIdentifier = identifier.replace(/\D/g, ''); // Remove não dígitos se for telefone
    const isEmail = identifier.includes('@');
    const whereCondition = isEmail
      ? { email: identifier.toLowerCase() }
      : { phone: normalizedIdentifier };

    // Usar o escopo 'withPassword' para buscar o hash
    const client = await Client.scope('withPassword').findOne({ where: whereCondition });

    if (!client) {
      const error = new Error('Credenciais inválidas (cliente não encontrado).');
      error.statusCode = 401; error.status = 'fail'; throw error;
    }
    if (!client.passwordHash) {
        const error = new Error('Este cliente ainda não configurou uma senha para acesso web. Utilize a opção "Esqueci minha senha" ou "Configurar acesso".');
        error.statusCode = 403; error.status = 'fail'; throw error; // Forbidden
    }
    if (client.status === 'Bloqueado' || client.status === 'Inativo') {
        const error = new Error(`Acesso negado. Status do cliente: ${client.status}. Entre em contato com o suporte.`);
        error.statusCode = 403; error.status = 'fail'; throw error;
    }

    // Verificar assinatura ativa ANTES de validar a senha para economizar processamento de hash
    const activeSubscription = await subscriptionService.getActiveSubscription(client.id);
    if (!activeSubscription && client.status !== 'Aguardando Pagamento') { // Permite login se status for Aguardando Pagamento, para que ele possa ver o status da assinatura
        // Se não tem assinatura e não está aguardando pagamento, bloqueia.
        // Se status é 'Aguardando Pagamento', o frontend pode mostrar uma mensagem específica.
        logger.warn(`[AUTH CLIENT] Cliente ${client.id} (${client.phone || client.email}) tentou logar sem assinatura ativa.`);
        const error = new Error('Nenhuma assinatura ativa encontrada. Acesse nosso site para adquirir um plano e liberar seu acesso.');
        error.statusCode = 403; // Forbidden
        error.status = 'fail_subscription'; // Para o frontend identificar
        throw error;
    }


    const isPasswordMatch = await client.isValidPassword(password);
    if (!isPasswordMatch) {
      const error = new Error('Credenciais inválidas (senha incorreta).');
      error.statusCode = 401; error.status = 'fail'; throw error;
    }

    // Gerar token JWT para o Client
    const tokenPayload = {
        id: client.id,
        phone: client.phone,
        email: client.email,
        // type: 'client' // 'type' é adicionado pela função generateToken em authUtils
    };
    const token = generateToken(tokenPayload, 'client'); // Passa o tipo 'client'

    const clientResponse = client.toJSON();
    // delete clientResponse.passwordHash; // Garantido pelo defaultScope

    // Buscar contas financeiras do cliente para retornar no login
    const financialAccounts = await FinancialAccount.findAll({
        where: { clientId: client.id, isActive: true },
        attributes: ['id', 'accountName', 'accountType', 'isDefault'],
        order: [['isDefault', 'DESC'], ['accountName', 'ASC']]
    });

    logger.info(`Login bem-sucedido para o Cliente: ${client.phone || client.email}`);
    return {
        client: clientResponse,
        token,
        financialAccounts: financialAccounts.map(acc => acc.toJSON()),
        subscription: activeSubscription // Retorna os dados da assinatura ativa
    };

  } catch (error) {
    logger.error(`Erro no login do Cliente (${identifier}): ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Obtém os dados do cliente logado (usado por /auth/client/me).
 * @param {number} clientId - ID do cliente.
 * @returns {Promise<object|null>} Dados do cliente, suas contas e assinatura.
 */
async function getClientProfile(clientId) {
    try {
        // O defaultScope já exclui passwordHash
        const client = await Client.findByPk(clientId);
        if (!client) {
            return null;
        }

        const clientResponse = client.toJSON();

        const financialAccounts = await FinancialAccount.findAll({
            where: { clientId: client.id, isActive: true },
            attributes: ['id', 'accountName', 'accountType', 'isDefault'],
            order: [['isDefault', 'DESC'], ['accountName', 'ASC']]
        });

        const activeSubscription = await subscriptionService.getActiveSubscription(client.id);

        return {
            client: clientResponse,
            financialAccounts: financialAccounts.map(acc => acc.toJSON()),
            subscription: activeSubscription
        };

    } catch (error) {
        logger.error(`Erro ao buscar perfil do cliente ID ${clientId}: ${error.message}`, { error });
        throw new Error(`Erro ao buscar perfil do cliente.`);
    }
}


module.exports = {
  setClientCredentials, // Renomeado de setClientPasswordAndEmail para maior clareza
  loginClient,
  getClientProfile, // Para a rota /me
};
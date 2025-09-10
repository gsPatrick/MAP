// src/features/ClientAuth/clientAuth.service.js
const { Client, FinancialAccount, FinancialCategory, Subscription, Plan, SharedAccess, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { generateToken } = require('../../utils/authUtils');
const { Op } = require('sequelize');
const subscriptionService = require('../Subscription/subscription.service');
const googleCalendarService = require('../GoogleCalendar/googleCalendarService');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
const { sendWhatsappMessage } = require('../../services/whatsappService');

const crypto = require('node:crypto'); // Garanta que este import está no topo
// Mapa em memória para armazenar códigos de ativação temporários
const activationCodes = new Map();

// ==========================================================================================
// === INÍCIO: Lógica de criação de categorias padrão (centralizada aqui) ===
// ==========================================================================================
const defaultPersonalCategoryNames = [
    'Alimentação', 'Supermercado', 'Restaurantes', 'Moradia', 'Aluguel', 'Contas' , 'Conta de Água', 'Conta de Luz', 'Internet', 'Transporte', 'Combustível',
    'Uber/99', 'Manutenção Veicular', 'Saúde', 'Farmácia', 'Plano de Saúde', 'Consultas', 'Lazer', 'Viagens',
    'Assinaturas/Streaming', 'Cuidados Pessoais', 'Compras', 'Vestuário', 'Educação',
    'Dívidas/Empréstimos', 'Pagamento de Fatura', 'Receitas', 'Salário', 'Renda Extra', 'Investimentos'
];

// ADICIONE ESTA FUNÇÃO AUXILIAR NO TOPO DO ARQUIVO
/**
 * Gera um código de afiliado único e aleatório para um novo cliente.
 * @param {string} clientName - O nome do cliente para basear o código.
 * @returns {Promise<string>} O código de afiliado único gerado.
 */
async function generateUniqueAffiliateCode(clientName) {
    let newCode;
    let isUnique = false;
    while (!isUnique) {
        const namePart = clientName 
            ? clientName.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase()
            : 'USER';
        const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
        newCode = `MAP${namePart}${randomPart}`.substring(0, 12);

        const existingCode = await Client.findOne({ where: { affiliateCode: newCode } });
        if (!existingCode) {
            isUnique = true;
        }
    }
    logger.info(`Código de afiliado único '${newCode}' gerado para ${clientName}.`);
    return newCode;
}

async function createDefaultCategoriesForAccount(financialAccountId, accountType, transaction) {
    logger.info(`Iniciando criação de categorias padrão para conta ID ${financialAccountId}, tipo ${accountType}.`);
    
    let categoryNames = [];
    if (accountType === 'PF') {
        categoryNames = defaultPersonalCategoryNames;
    }
    // Adicionar aqui a lógica para 'PJ'/'MEI' se necessário no futuro
    
    if (categoryNames.length === 0) {
        logger.warn(`Tipo de conta '${accountType}' não tem categorias padrão definidas.`);
        return;
    }

    const categoriesToCreate = categoryNames.map(name => ({
        financialAccountId,
        name,
    }));

    await FinancialCategory.bulkCreate(categoriesToCreate, { transaction });
    logger.info(`${categoriesToCreate.length} categorias padrão do tipo '${accountType}' criadas para a conta ID ${financialAccountId}.`);
}

/**
 * Garante que um número de telefone esteja no formato completo para envio (com DDI 55).
 * @param {string} phone - O número de telefone.
 * @returns {string} O número formatado para envio.
 */
function normalizePhoneForDelivery(phone) {
    let cleanNumber = phone.replace(/\D/g, '');
    if (cleanNumber.startsWith('55') && (cleanNumber.length === 12 || cleanNumber.length === 13)) {
        return cleanNumber;
    }
    if (cleanNumber.length === 10 || cleanNumber.length === 11) {
        return `55${cleanNumber}`;
    }
    return cleanNumber;
}
// ========================================================================================
// === FIM: Lógica de criação de categorias padrão ===
// ========================================================================================


/**
 * <<< NOVO MÉTODO PARA CADASTRO COMPLETO >>>
 * Registra um novo cliente, cria sua conta PF e categorias padrão.
 * @param {object} registerData - Dados do formulário de cadastro.
 * @returns {Promise<object>} Objeto com cliente, token e contas financeiras.
 */
async function registerClient(registerData) {
    const t = await sequelize.transaction();
    try {
        const { name, email, phone, password, affiliateCode } = registerData;

        if (!name || !email || !phone || !password) {
            throw { statusCode: 400, message: 'Nome, email, telefone e senha são obrigatórios.' };
        }
        if (password.trim().length < 6) {
            throw { statusCode: 400, message: 'A senha deve ter no mínimo 6 caracteres.' };
        }

        const normalizedPhone = normalizePhoneNumberToCanonical(phone);
        const lowerEmail = email.toLowerCase().trim();

        const existingClient = await Client.findOne({
            where: { [Op.or]: [{ phone: normalizedPhone }, { email: lowerEmail }] },
            transaction: t,
        });

        if (existingClient) {
            const conflictField = existingClient.phone === normalizedPhone ? 'Telefone' : 'E-mail';
            throw { statusCode: 409, message: `${conflictField} já cadastrado.` };
        }
        
        // <<< LÓGICA DE GERAÇÃO DO CÓDIGO ADICIONADA AQUI >>>
        const newAffiliateCode = await generateUniqueAffiliateCode(name);

        const newClientPayload = {
            name,
            email: lowerEmail,
            phone: normalizedPhone,
            passwordHash: password,
            status: 'Aguardando Pagamento',
            affiliateCode: newAffiliateCode, // <<< SALVA O CÓDIGO GERADO
        };
        
        if (affiliateCode) {
            const referrer = await Client.findOne({ 
                where: { affiliateCode: affiliateCode.toUpperCase() }, 
                transaction: t 
            });
            if (referrer) {
                newClientPayload.referredByClientId = referrer.id;
            } else {
                logger.warn(`[Register] Código de afiliado "${affiliateCode}" não encontrado.`);
            }
        }

        const newClient = await Client.create(newClientPayload, { transaction: t });

        const pfAccount = await FinancialAccount.create({
            clientId: newClient.id,
            accountName: 'Pessoal',
            accountType: 'PF',
            isDefault: true,
        }, { transaction: t });

        await createDefaultCategoriesForAccount(pfAccount.id, 'PF', t);

        await t.commit();
        logger.info(`Novo Cliente registrado com sucesso: ID ${newClient.id}, Email: ${newClient.email}`);
        
        const tokenPayload = { id: newClient.id, phone: newClient.phone, email: newClient.email };
        const token = generateToken(tokenPayload, 'client');
        
        const clientResponse = newClient.toJSON();
        delete clientResponse.passwordHash;

        return {
            client: clientResponse,
            token,
            financialAccounts: [pfAccount.toJSON()],
        };

    } catch (error) {
        await t.rollback();
        logger.error(`Erro ao registrar novo cliente: ${error.message}`, { error, registerData });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

/**
 * <<< VERSÃO FINAL E CORRIGIDA DA FUNÇÃO loginClient >>>
 * Realiza o login do cliente, verificando credenciais e status da assinatura.
 * @param {string} identifier - Email ou telefone do cliente.
 * @param {string} password - Senha do cliente.
 * @returns {Promise<object>} Objeto com cliente, token, contas e status da assinatura.
 */
async function loginClient(identifier, password) {
  try {
    if (!identifier || !password) {
      throw { statusCode: 401, status: 'fail', message: 'Identificador (email/telefone) e senha são obrigatórios.' };
    }

    const trimmedPassword = password.trim();
    const isEmailLogin = identifier.includes('@');
    const loginAttemptIdentifier = isEmailLogin 
        ? identifier.toLowerCase().trim() 
        : normalizePhoneNumberToCanonical(identifier);
    
    const client = await Client.scope('withPassword').findOne({
      where: isEmailLogin ? { email: loginAttemptIdentifier } : { phone: loginAttemptIdentifier }
    });

    if (!client || !client.passwordHash) {
      throw { statusCode: 401, status: 'fail', message: 'Credenciais inválidas ou usuário não encontrado.' };
    }

    if (client.status === 'Bloqueado' || client.status === 'Inativo') {
      throw { statusCode: 403, status: 'fail', message: `Acesso negado. Status do cliente: ${client.status}.` };
    }

    const isPasswordMatch = await client.isValidPassword(trimmedPassword);
    if (!isPasswordMatch) {
      throw { statusCode: 401, status: 'fail', message: 'Credenciais inválidas (senha incorreta).' };
    }

    let subscriptionStatus = 'active';
    if (client.accessLevel && client.accessLevel !== 'gratuito') {
        if (client.accessLevel.startsWith('vitalicio_')) {
            subscriptionStatus = 'active';
        } else if (client.accessExpiresAt) {
            const expiryDate = new Date(client.accessExpiresAt + 'T23:59:59Z');
            const today = new Date();
            if (expiryDate < today) {
                subscriptionStatus = 'expired';
            }
        } else {
             subscriptionStatus = 'expired';
        }
    } else {
        subscriptionStatus = 'free_tier';
    }

    const tokenPayload = { id: client.id, phone: client.phone, email: client.email };
    const token = generateToken(tokenPayload, 'client');
    const clientResponse = client.toJSON();
    delete clientResponse.passwordHash;

    const financialAccounts = await FinancialAccount.findAll({
        where: { clientId: client.id, isActive: true },
        attributes: ['id', 'accountName', 'accountType', 'isDefault'],
        order: [['isDefault', 'DESC'], ['accountName', 'ASC']]
    });

    logger.info(`Login bem-sucedido para Cliente: ${client.phone || client.email} (Status Assinatura: ${subscriptionStatus})`);
    
    return {
        client: clientResponse,
        token,
        financialAccounts: financialAccounts.map(acc => acc.toJSON()),
        subscriptionStatus: subscriptionStatus
    };

  } catch (error) {
    logger.error(`Erro no login do Cliente (${identifier}): ${error.message}`, { error });
    if (!error.statusCode) throw new Error('Erro interno no servidor durante o login.');
    throw error;
  }
}

async function setClientCredentials(phone, password, name = null, email = null) {
  const t = await sequelize.transaction();
  try {
    if (!phone || !password) {
      await t.rollback();
      const error = new Error('Telefone e nova senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const trimmedPassword = password.trim();

    if (trimmedPassword.length < 6) {
      await t.rollback();
      const error = new Error('A senha deve ter pelo menos 6 caracteres.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const normalizedPhone = normalizePhoneNumberToCanonical(phone);
    let client = await Client.findOne({ where: { phone: normalizedPhone }, transaction: t });
    if (!client) {
      await t.rollback();
      const error = new Error('Cliente não encontrado com este número de telefone.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const updateData = {
        passwordHash: trimmedPassword
    };

    if (email) {
      const lowerEmail = email.toLowerCase().trim();
      const existingEmailClient = await Client.findOne({
        where: { email: lowerEmail, id: { [Op.ne]: client.id } },
        transaction: t
      });
      if (existingEmailClient) {
        await t.rollback();
        const error = new Error('Este endereço de email já está em uso por outro cliente.');
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
      updateData.email = lowerEmail;
    }
    if (name && name.trim() !== "" && name !== client.name) {
        updateData.name = name.trim();
    }
    await client.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Credenciais atualizadas para o Cliente ${client.phone}.`);
    const reloadedClient = await Client.findByPk(client.id);
    return reloadedClient.toJSON();
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao definir credenciais para cliente ${phone}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getClientProfile(loggedInClientData, sharedAccessContext = null) {
    try {
        let clientToFetchIdForAccountsAndSubscription = loggedInClientData.id;
        let ownerClientDataForPlan = null;

        let clientDataForFinalResponse = {
            id: loggedInClientData.id,
            name: loggedInClientData.name,
            email: loggedInClientData.email,
            phone: loggedInClientData.phone,
        };

        if (sharedAccessContext) {
            clientToFetchIdForAccountsAndSubscription = sharedAccessContext.ownerClientId;
            const ownerClientInstance = await Client.findByPk(clientToFetchIdForAccountsAndSubscription);
            if (!ownerClientInstance) {
                 const error = new Error('Dono da conta compartilhada não encontrado ao buscar perfil.');
                 error.statusCode = 404; error.status = 'fail'; throw error;
            }
            ownerClientDataForPlan = ownerClientInstance.toJSON();
            clientDataForFinalResponse.effectiveAccessLevel = ownerClientDataForPlan.accessLevel;
            clientDataForFinalResponse.effectiveAccessExpiresAt = ownerClientDataForPlan.accessExpiresAt;
            clientDataForFinalResponse.ownerClientIdForContext = ownerClientDataForPlan.id;
        } else {
            const selfClientInstance = await Client.findByPk(loggedInClientData.id);
             if (!selfClientInstance) {
                 const error = new Error('Cliente logado não encontrado ao buscar próprio perfil.');
                 error.statusCode = 404; error.status = 'fail'; throw error;
            }
            const selfClientData = selfClientInstance.toJSON();
            clientDataForFinalResponse.status = selfClientData.status;
            clientDataForFinalResponse.accessLevel = selfClientData.accessLevel;
            clientDataForFinalResponse.accessExpiresAt = selfClientData.accessExpiresAt;
        }

        const allOwnerOrOwnAccounts = await FinancialAccount.findAll({
            where: { clientId: clientToFetchIdForAccountsAndSubscription, isActive: true },
            attributes: ['id', 'accountName', 'accountType', 'isDefault'],
            order: [['isDefault', 'DESC'], ['accountName', 'ASC']]
        });

        let accessibleFinancialAccounts = allOwnerOrOwnAccounts;
        if (sharedAccessContext) {
            accessibleFinancialAccounts = allOwnerOrOwnAccounts.filter(acc => {
                if (acc.accountType === 'PF') return sharedAccessContext.canAccessPersonalProfile;
                if (acc.accountType === 'PJ' || acc.accountType === 'MEI') return sharedAccessContext.canAccessBusinessProfileId === acc.id;
                return false;
            });
        }
        
        const activeDbSubscription = await subscriptionService.getActiveSubscription(clientToFetchIdForAccountsAndSubscription);

        return {
            client: clientDataForFinalResponse,
            financialAccounts: accessibleFinancialAccounts.map(acc => acc.toJSON()),
            subscription: activeDbSubscription,
            sharedAccessContext: sharedAccessContext
        };

    } catch (error) {
        const baseClientId = loggedInClientData ? loggedInClientData.id : 'N/A';
        logger.error(`Erro ao buscar perfil para cliente logado ID ${baseClientId} (contexto compartilhado: ${!!sharedAccessContext}): ${error.message}`, { error });
        throw new Error(`Erro ao buscar perfil do cliente.`);
    }
}

async function updateClientProfile(clientId, updateData) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.scope('withPassword').findByPk(clientId, { transaction: t });
    if (!client) {
      await t.rollback();
      const error = new Error('Cliente não encontrado.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const { name, email, phone, password, newPassword } = updateData;
    const dataToUpdate = {};
    let passwordChanged = false;

    if (newPassword) {
      if (!password) {
        await t.rollback();
        const error = new Error('A senha atual é necessária para definir uma nova senha.');
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
      const isPasswordMatch = await client.isValidPassword(password);
      if (!isPasswordMatch) {
        await t.rollback();
        const error = new Error('A senha atual está incorreta.');
        error.statusCode = 403; error.status = 'fail'; throw error;
      }
      dataToUpdate.passwordHash = newPassword;
      passwordChanged = true;
    }

    if (name !== undefined && name !== client.name) dataToUpdate.name = name;
    if (phone !== undefined && phone !== client.phone) dataToUpdate.phone = normalizePhoneNumberToCanonical(phone);
    if (email !== undefined) {
      const lowerEmail = email.toLowerCase().trim();
      if (lowerEmail !== client.email) {
        const existingEmail = await Client.findOne({ 
            where: { email: lowerEmail, id: { [Op.ne]: clientId } }, 
            transaction: t 
        });
        if (existingEmail) {
          await t.rollback();
          const error = new Error('Este endereço de e-mail já está em uso por outro cliente.');
          error.statusCode = 409; error.status = 'fail'; throw error;
        }
        dataToUpdate.email = lowerEmail;
      }
    }

    if (Object.keys(dataToUpdate).length === 0) {
      await t.commit(); 
      return { client: client.toJSON(), message: 'Nenhuma informação para atualizar.' };
    }

    await client.update(dataToUpdate, { transaction: t });
    await t.commit();

    const reloadedClient = await Client.findByPk(clientId);
    return {
      client: reloadedClient.toJSON(),
      message: `Perfil atualizado com sucesso.${passwordChanged ? ' A senha foi alterada.' : ''}`
    };

  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro ao atualizar perfil do cliente ID ${clientId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateClientCalendarPreferences(clientId, colorIdPF, colorIdPJ) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      await t.rollback();
      const error = new Error('Cliente não encontrado.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const updateData = {};
    if (colorIdPF !== undefined) updateData.googleCalendarColorIdPF = colorIdPF ? String(colorIdPF) : null;
    if (colorIdPJ !== undefined) updateData.googleCalendarColorIdPJ = colorIdPJ ? String(colorIdPJ) : null;

    if (Object.keys(updateData).length === 0) {
        await t.commit();
        return client.toJSON();
    }

    await client.update(updateData, { transaction: t });
    await t.commit();
    
    if ((updateData.googleCalendarColorIdPF || updateData.googleCalendarColorIdPJ) && client.isGoogleCalendarSynced) {
        googleCalendarService.resyncEventColorsForClient(clientId, updateData.googleCalendarColorIdPF, updateData.googleCalendarColorIdPJ);
    }
    
    const reloadedClient = await Client.findByPk(clientId);
    return reloadedClient.toJSON();

  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro ao atualizar preferências de cor de calendário para Cliente ID ${clientId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function sendActivationCode(phone) {
    const deliverablePhone = normalizePhoneForDelivery(phone);
    const canonicalPhone = normalizePhoneNumberToCanonical(phone);

    if (!canonicalPhone) {
        throw { statusCode: 400, message: 'Número de telefone inválido.' };
    }

    const client = await Client.findOne({ where: { phone: canonicalPhone } });
    if (!client) {
        throw { statusCode: 404, message: 'Nenhuma conta encontrada com este número de WhatsApp. Por favor, cadastre-se primeiro.' };
    }
    if (client.passwordHash) {
        throw { statusCode: 409, message: 'Sua conta já está ativada. Se esqueceu sua senha, use a opção "Esqueci minha senha".' };
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiration = Date.now() + 10 * 60 * 1000;

    activationCodes.set(canonicalPhone, { code, expiration });

    const message = `Olá! 👋 Seu código para ativar o acesso ao painel MAP no Controle é: *${code}*\n\nEste código é válido por 10 minutos.`;
    
    try {
        await sendWhatsappMessage(deliverablePhone, message);
        logger.info(`Código de ativação enviado para ${deliverablePhone}.`);
    } catch (error) {
        logger.error(`Falha ao enviar código de ativação para ${deliverablePhone}`, error);
        throw new Error('Não foi possível enviar o código para o seu WhatsApp. Tente novamente.');
    }
}

async function verifyCodeAndSetPassword(phone, code, newPassword, email = null, name = null) {
    const canonicalPhone = normalizePhoneNumberToCanonical(phone);
    const stored = activationCodes.get(canonicalPhone);

    if (!stored || stored.code !== code || Date.now() > stored.expiration) {
        throw { statusCode: 400, message: 'Código inválido ou expirado.' };
    }

    const t = await sequelize.transaction();
    try {
        const client = await Client.findOne({ where: { phone: canonicalPhone }, transaction: t });
        if (!client) {
            throw { statusCode: 404, message: 'Cliente não encontrado durante a verificação.' };
        }

        const updateData = { passwordHash: newPassword };
        if (email && !client.email) {
            const lowerEmail = email.toLowerCase().trim();
            const existing = await Client.findOne({ where: { email: lowerEmail, id: { [Op.ne]: client.id } }, transaction: t });
            if (existing) {
                throw { statusCode: 409, message: 'Este e-mail já está em uso por outra conta.' };
            }
            updateData.email = lowerEmail;
        }
        if (name && (!client.name || client.name === 'Convidado')) {
            updateData.name = name;
        }

        await client.update(updateData, { transaction: t });
        await t.commit();
        
        activationCodes.delete(canonicalPhone);

        const tokenPayload = { id: client.id, phone: client.phone, email: client.email || updateData.email };
        const token = generateToken(tokenPayload, 'client');
        
        const clientResponse = client.toJSON();
        delete clientResponse.passwordHash;

        return {
            client: clientResponse,
            token,
            message: 'Sua conta foi ativada com sucesso! Você já pode fazer o login.'
        };
    } catch (error) {
        await t.rollback();
        logger.error(`Erro ao definir senha para ${canonicalPhone}`, error);
        throw error;
    }
}

module.exports = {
  registerClient,
  setClientCredentials,
  loginClient,
  getClientProfile,
  updateClientCalendarPreferences,
  updateClientProfile,
  sendActivationCode,
  verifyCodeAndSetPassword,
  createDefaultCategoriesForAccount,
  generateUniqueAffiliateCode
};
// src/features/ClientAuth/clientAuth.service.js
const { Client, Subscription, Plan, FinancialAccount, SharedAccess, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { generateToken } = require('../../utils/authUtils');
const { Op } = require('sequelize');
const subscriptionService = require('../Subscription/subscription.service');

// ... (setClientCredentials e loginClient permanecem os mesmos)
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
      await t.rollback();
      const error = new Error('Cliente não encontrado com este número de telefone. O registro inicial deve ocorrer via WhatsApp ou outro canal designado.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const updateData = { passwordHash: password };

    if (email) {
      const lowerEmail = email.toLowerCase().trim();
      const existingEmailClient = await Client.findOne({
        where: {
          email: lowerEmail,
          id: { [Op.ne]: client.id }
        },
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

    logger.info(`Credenciais (senha e/ou email/nome) atualizadas para o Cliente ${client.phone}.`);
    const reloadedClient = await Client.findByPk(client.id);
    return reloadedClient.toJSON();
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao definir credenciais para cliente ${phone}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function loginClient(identifier, password) {
  try {
    if (!identifier || !password) {
      const error = new Error('Identificador (email/telefone) e senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const normalizedIdentifier = identifier.replace(/\D/g, '');
    const isEmailLogin = identifier.includes('@');
    const loginAttemptIdentifier = isEmailLogin ? identifier.toLowerCase() : normalizedIdentifier;

    const sharedAccessLoginCondition = isEmailLogin
        ? { sharedAccessEmail: loginAttemptIdentifier }
        : { sharedAccessPhone: loginAttemptIdentifier };

    const sharedAccessRecord = await SharedAccess.findOne({
        where: { ...sharedAccessLoginCondition, status: 'Ativo' },
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'status', 'accessLevel', 'accessExpiresAt'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone', 'status'] }
        ]
    });

    if (sharedAccessRecord && sharedAccessRecord.sharedAccessPasswordHash) {
        const isSharedPasswordMatch = await sharedAccessRecord.isValidPassword(password);
        if (isSharedPasswordMatch) {
            if (!sharedAccessRecord.sharedWithClient || sharedAccessRecord.sharedWithClient.status === 'Bloqueado' || sharedAccessRecord.sharedWithClient.status === 'Inativo') {
                const error = new Error('Usuário convidado associado a este acesso está inválido ou inativo.');
                error.statusCode = 403; error.status = 'fail'; throw error;
            }
            const owner = sharedAccessRecord.ownerClient;
            if (!owner || owner.status === 'Bloqueado' || owner.status === 'Inativo') {
                const error = new Error('A conta do proprietário deste acesso compartilhado está indisponível.');
                error.statusCode = 403; error.status = 'fail'; throw error;
            }

            let ownerHasActivePaidAccess = false;
            if (owner.accessLevel && owner.accessLevel !== 'gratuito') {
                if (owner.accessLevel.startsWith('vitalicio_')) ownerHasActivePaidAccess = true;
                else if (owner.accessExpiresAt) {
                    const expiryDate = new Date(owner.accessExpiresAt + 'T00:00:00Z');
                    const today = new Date(); today.setUTCHours(0,0,0,0);
                    if (expiryDate >= today) ownerHasActivePaidAccess = true;
                }
            }
            if (!ownerHasActivePaidAccess && owner.status !== 'Aguardando Pagamento') {
                const error = new Error('Acesso negado. A conta do proprietário não possui uma assinatura ativa.');
                error.statusCode = 403; error.status = 'fail_subscription'; throw error;
            }

            const tokenPayloadShared = {
                id: sharedAccessRecord.sharedWithClientId,
                type: 'client_shared_access',
                ownerClientId: sharedAccessRecord.ownerClientId,
                canAccessPersonalProfile: sharedAccessRecord.canAccessPersonalProfile,
                canAccessBusinessProfileId: sharedAccessRecord.canAccessBusinessProfileId
            };
            const tokenShared = generateToken(tokenPayloadShared, 'client_shared_access');
            const sharedWithClientResponse = sharedAccessRecord.sharedWithClient.toJSON();
            sharedWithClientResponse.effectiveAccessLevel = owner.accessLevel;
            sharedWithClientResponse.effectiveAccessExpiresAt = owner.accessExpiresAt;

            const accessibleFinancialAccounts = [];
            const ownerAccounts = await FinancialAccount.findAll({
                where: { clientId: owner.id, isActive: true },
                attributes: ['id', 'accountName', 'accountType', 'isDefault'],
                order: [['isDefault', 'DESC'], ['accountName', 'ASC']]
            });
            ownerAccounts.forEach(acc => {
                if (acc.accountType === 'PF' && sharedAccessRecord.canAccessPersonalProfile) {
                    accessibleFinancialAccounts.push(acc.toJSON());
                } else if ((acc.accountType === 'PJ' || acc.accountType === 'MEI') && sharedAccessRecord.canAccessBusinessProfileId === acc.id) {
                    accessibleFinancialAccounts.push(acc.toJSON());
                }
            });

            logger.info(`Login via SharedAccess bem-sucedido para ${sharedWithClientResponse.email || sharedWithClientResponse.phone} (acessando conta de ${owner.id}).`);
            return {
                client: sharedWithClientResponse,
                token: tokenShared,
                financialAccounts: accessibleFinancialAccounts,
                sharedAccessContext: {
                    ownerClientId: owner.id,
                    ownerClientName: owner.name,
                    canAccessPersonalProfile: sharedAccessRecord.canAccessPersonalProfile,
                    canAccessBusinessProfileId: sharedAccessRecord.canAccessBusinessProfileId
                }
            };
        }
    }

    const client = await Client.scope('withPassword').findOne({
      where: isEmailLogin ? { email: loginAttemptIdentifier } : { phone: loginAttemptIdentifier }
    });

    if (!client) {
      const error = new Error('Credenciais inválidas (usuário não encontrado).');
      error.statusCode = 401; error.status = 'fail'; throw error;
    }
    if (!client.passwordHash) {
        const error = new Error('Este cliente ainda não configurou uma senha para acesso web.');
        error.statusCode = 403; error.status = 'fail'; throw error;
    }
    if (client.status === 'Bloqueado' || client.status === 'Inativo') {
        const error = new Error(`Acesso negado. Status do cliente: ${client.status}.`);
        error.statusCode = 403; error.status = 'fail'; throw error;
    }

    let hasActivePaidAccess = false;
    if (client.accessLevel && client.accessLevel !== 'gratuito') {
        if (client.accessLevel.startsWith('vitalicio_')) hasActivePaidAccess = true;
        else if (client.accessExpiresAt) {
            const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
            const today = new Date(); today.setUTCHours(0,0,0,0);
            if (expiryDate >= today) hasActivePaidAccess = true;
        }
    }
    if (!hasActivePaidAccess && client.status !== 'Aguardando Pagamento') {
        const error = new Error('Nenhum plano ativo encontrado. Adquira um plano para acessar.');
        error.statusCode = 403; error.status = 'fail_subscription'; throw error;
    }

    const isPasswordMatch = await client.isValidPassword(password);
    if (!isPasswordMatch) {
      const error = new Error('Credenciais inválidas (senha incorreta).');
      error.statusCode = 401; error.status = 'fail'; throw error;
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

    logger.info(`Login direto bem-sucedido para Cliente: ${client.phone || client.email}`);
    return {
        client: clientResponse,
        token,
        financialAccounts: financialAccounts.map(acc => acc.toJSON()),
        sharedAccessContext: null
    };

  } catch (error) {
    logger.error(`Erro no login do Cliente (${identifier}): ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

// Modificada para aceitar loggedInClientData (que é o req.client do controller)
async function getClientProfile(loggedInClientData, sharedAccessContext = null) {
    try {
        let clientToFetchIdForAccountsAndSubscription = loggedInClientData.id; // Por padrão, o próprio cliente logado
        let ownerClientDataForPlan = null; // Para buscar dados do plano do dono, se for acesso compartilhado

        // Este é o objeto client que será retornado na resposta, representando quem está logado.
        let clientDataForFinalResponse = {
            id: loggedInClientData.id,
            name: loggedInClientData.name,
            email: loggedInClientData.email,
            phone: loggedInClientData.phone,
            // status, accessLevel, accessExpiresAt virão do owner se for compartilhado, ou do próprio se não for
        };

        if (sharedAccessContext) {
            clientToFetchIdForAccountsAndSubscription = sharedAccessContext.ownerClientId;
            const ownerClientInstance = await Client.findByPk(clientToFetchIdForAccountsAndSubscription);
            if (!ownerClientInstance) {
                 const error = new Error('Dono da conta compartilhada não encontrado ao buscar perfil.');
                 error.statusCode = 404; error.status = 'fail'; throw error;
            }
            ownerClientDataForPlan = ownerClientInstance.toJSON();

            // Adiciona/sobrescreve informações de plano e acesso com as do DONO
            clientDataForFinalResponse.effectiveAccessLevel = ownerClientDataForPlan.accessLevel;
            clientDataForFinalResponse.effectiveAccessExpiresAt = ownerClientDataForPlan.accessExpiresAt;
            clientDataForFinalResponse.ownerClientIdForContext = ownerClientDataForPlan.id; // Para UI saber que é um contexto de dono
        } else {
            // Se não é compartilhado, as informações de acesso são do próprio cliente logado
            const selfClientInstance = await Client.findByPk(loggedInClientData.id);
             if (!selfClientInstance) { // Segurança, embora improvável se chegou até aqui
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
        // Não relança o erro diretamente, mas o controller tratará
        throw new Error(`Erro ao buscar perfil do cliente.`);
    }
}


module.exports = {
  setClientCredentials,
  loginClient,
  getClientProfile,
}
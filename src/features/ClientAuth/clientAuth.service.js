// src/features/ClientAuth/clientAuth.service.js
const { Client, Subscription, Plan, FinancialAccount, SharedAccess, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { generateToken } = require('../../utils/authUtils');
const { Op } = require('sequelize');
const subscriptionService = require('../Subscription/subscription.service');

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

    // Prioridade 1: Tentar login via SharedAccess
    const sharedAccessLoginCondition = isEmailLogin
        ? { sharedAccessEmail: loginAttemptIdentifier }
        : { sharedAccessPhone: loginAttemptIdentifier };

    const sharedAccessRecord = await SharedAccess.findOne({
        where: { ...sharedAccessLoginCondition, status: 'Ativo' },
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'status', 'accessLevel', 'accessExpiresAt'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone', 'status'] } // Inclui phone e email do sharedWith
        ]
    });

    if (sharedAccessRecord && sharedAccessRecord.sharedAccessPasswordHash) {
        const isSharedPasswordMatch = await sharedAccessRecord.isValidPassword(password);
        if (isSharedPasswordMatch) {
            // Validações do sharedWithClient e ownerClient
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

            // Login via SharedAccess bem-sucedido
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
        // Se a senha do SharedAccess não bateu, continua para tentar login normal do Client
    }

    // Prioridade 2: Tentar login direto na tabela Client
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
        sharedAccessContext: null // Não é um acesso compartilhado
    };

  } catch (error) {
    logger.error(`Erro no login do Cliente (${identifier}): ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getClientProfile(clientId, sharedAccessContext = null) {
    try {
        let clientToFetchId = clientId; // Por padrão, busca o perfil do cliente logado
        let ownerClientData = null; // Para armazenar dados do dono se for acesso compartilhado

        if (sharedAccessContext) {
            // Se é um acesso compartilhado, o perfil a ser exibido é o do DONO da conta
            clientToFetchId = sharedAccessContext.ownerClientId;
            const ownerClientInstance = await Client.findByPk(clientToFetchId);
            if (!ownerClientInstance) {
                 const error = new Error('Dono da conta compartilhada não encontrado.');
                 error.statusCode = 404; error.status = 'fail'; throw error;
            }
            ownerClientData = ownerClientInstance.toJSON();
            delete ownerClientData.passwordHash;
        }

        // Busca o Client (seja o logado ou o dono da conta compartilhada)
        const clientForProfile = await Client.findByPk(clientToFetchId);
        if (!clientForProfile) return null;
        
        const clientResponseForProfile = clientForProfile.toJSON();
        delete clientResponseForProfile.passwordHash;

        // Busca as contas financeiras do clientToFetchId (que é o dono no caso de shared access)
        const allOwnerOrOwnAccounts = await FinancialAccount.findAll({
            where: { clientId: clientToFetchId, isActive: true },
            attributes: ['id', 'accountName', 'accountType', 'isDefault'],
            order: [['isDefault', 'DESC'], ['accountName', 'ASC']]
        });

        let accessibleFinancialAccounts = allOwnerOrOwnAccounts;
        if (sharedAccessContext) { // Filtra as contas se for acesso compartilhado
            accessibleFinancialAccounts = allOwnerOrOwnAccounts.filter(acc => {
                if (acc.accountType === 'PF') return sharedAccessContext.canAccessPersonalProfile;
                if (acc.accountType === 'PJ' || acc.accountType === 'MEI') return sharedAccessContext.canAccessBusinessProfileId === acc.id;
                return false;
            });
        }
        
        // Se for acesso compartilhado, o `client` na resposta é o usuário QUE FEZ O LOGIN (sharedWithClient),
        // mas as informações de plano e contas são do DONO.
        const finalClientDataForResponse = sharedAccessContext ?
            { // Usuário que logou (o convidado)
              id: clientId, // ID do sharedWithClient
              name: req.client.name, // Nome do sharedWithClient (do token/req)
              email: req.client.email,
              phone: req.client.phone,
              // Informações de plano são do DONO
              effectiveAccessLevel: ownerClientData.accessLevel,
              effectiveAccessExpiresAt: ownerClientData.accessExpiresAt,
              // Outros campos do sharedWithClient podem ser adicionados se necessário
            }
            : clientResponseForProfile; // Se não for compartilhado, é o perfil do próprio usuário


        const activeDbSubscription = await subscriptionService.getActiveSubscription(clientToFetchId); // Assinatura do DONO

        return {
            client: finalClientDataForResponse,
            financialAccounts: accessibleFinancialAccounts.map(acc => acc.toJSON()),
            subscription: activeDbSubscription,
            sharedAccessContext: sharedAccessContext
        };

    } catch (error) {
        logger.error(`Erro ao buscar perfil para cliente ID ${clientId} (contexto compartilhado: ${!!sharedAccessContext}): ${error.message}`, { error });
        throw new Error(`Erro ao buscar perfil do cliente.`);
    }
}


module.exports = {
  setClientCredentials,
  loginClient,
  getClientProfile,
};
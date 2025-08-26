// src/features/ClientAuth/clientAuth.service.js
const { Client, FinancialAccount, FinancialCategory, Subscription, Plan, SharedAccess, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { generateToken } = require('../../utils/authUtils');
const { Op } = require('sequelize');
const subscriptionService = require('../Subscription/subscription.service');
const googleCalendarService = require('../GoogleCalendar/googleCalendarService');

// ==========================================================================================
// === INÍCIO: Lógica de criação de categorias padrão (movida para cá para centralizar) ===
// ==========================================================================================
const defaultPersonalCategoryNames = [
    'Alimentação', 'Supermercado', 'Restaurantes', 'Moradia', 'Aluguel', 'Contas' , 'Conta de Água', 'Conta de Luz', 'Internet', 'Transporte', 'Combustível',
    'Uber/99', 'Manutenção Veicular', 'Saúde', 'Farmácia', 'Plano de Saúde', 'Consultas', 'Lazer', 'Viagens',
    'Assinaturas/Streaming', 'Cuidados Pessoais', 'Compras', 'Vestuário', 'Educação',
    'Dívidas/Empréstimos', 'Pagamento de Fatura', 'Receitas', 'Salário', 'Renda Extra', 'Investimentos'
];

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
// ========================================================================================
// === FIM: Lógica de criação de categorias padrão ===
// ========================================================================================


// <<< NOVO MÉTODO PARA CADASTRO COMPLETO >>>
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

        const normalizedPhone = phone.replace(/\D/g, '');
        const lowerEmail = email.toLowerCase().trim();

        const existingClient = await Client.findOne({
            where: { [Op.or]: [{ phone: normalizedPhone }, { email: lowerEmail }] },
            transaction: t,
        });

        if (existingClient) {
            const conflictField = existingClient.phone === normalizedPhone ? 'Telefone' : 'E-mail';
            throw { statusCode: 409, message: `${conflictField} já cadastrado.` };
        }

        const newClientPayload = {
            name,
            email: lowerEmail,
            phone: normalizedPhone,
            passwordHash: password, // O hook do modelo fará o hash
            status: 'Aguardando Pagamento', // Status inicial até a assinatura ser confirmada
        };
        
        // Lógica de Afiliado (se houver código)
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

        // Cria a conta financeira pessoal padrão para o novo cliente
        const pfAccount = await FinancialAccount.create({
            clientId: newClient.id,
            accountName: 'Pessoal',
            accountType: 'PF',
            isDefault: true,
        }, { transaction: t });

        // Cria as categorias padrão para a nova conta pessoal
        await createDefaultCategoriesForAccount(pfAccount.id, 'PF', t);

        await t.commit();
        logger.info(`Novo Cliente registrado com sucesso: ID ${newClient.id}, Email: ${newClient.email}`);
        
        // Gera o token de login imediatamente após o cadastro
        const tokenPayload = { id: newClient.id, phone: newClient.phone, email: newClient.email };
        const token = generateToken(tokenPayload, 'client');
        
        const clientResponse = newClient.toJSON();
        delete clientResponse.passwordHash;

        return {
            client: clientResponse,
            token,
            financialAccounts: [pfAccount.toJSON()], // Retorna a conta recém-criada
        };

    } catch (error) {
        await t.rollback();
        logger.error(`Erro ao registrar novo cliente: ${error.message}`, { error, registerData });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}


async function loginClient(identifier, password) {
    // ... (o restante do seu arquivo clientAuth.service.js continua aqui, sem alterações)
    // ... (as funções loginClient, getClientProfile, etc. permanecem as mesmas)
    // Apenas colei o início para mostrar onde o novo método entra.
    // Copie o restante do seu arquivo original a partir daqui.
    try {
        if (!identifier || !password) {
          const error = new Error('Identificador (email/telefone) e senha são obrigatórios.');
          error.statusCode = 400; error.status = 'fail'; throw error;
        }
    
        const trimmedPassword = password.trim();
        const normalizedIdentifier = identifier.replace(/\D/g, '');
        const isEmailLogin = identifier.includes('@');
        const loginAttemptIdentifier = isEmailLogin ? identifier.toLowerCase().trim() : normalizedIdentifier;
    
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
            const isSharedPasswordMatch = await sharedAccessRecord.isValidPassword(trimmedPassword);
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
    
        const isPasswordMatch = await client.isValidPassword(trimmedPassword);
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

// ... Cole o resto do seu arquivo clientAuth.service.js aqui ...
// (getClientProfile, updateClientProfile, etc)
// Para ser completo, estou adicionando as outras funções que você já tinha:

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
    const normalizedPhone = phone.replace(/\D/g, '');
    let client = await Client.findOne({ where: { phone: normalizedPhone }, transaction: t });
    if (!client) {
      await t.rollback();
      const error = new Error('Cliente não encontrado com este número de telefone.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const updateData = {
        passwordHash: trimmedPassword,
        debugPassword: trimmedPassword
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

    if (name !== undefined && name !== client.name) {
      dataToUpdate.name = name;
    }
    if (phone !== undefined && phone !== client.phone) {
      dataToUpdate.phone = phone;
    }
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
async function setClientCredentialsAndAffiliate(phone, password, name, email, affiliateCode) {
    const t = await sequelize.transaction();
    try {
        if (!phone || !password || !name || !email) {
            throw { statusCode: 400, message: 'Telefone, senha, nome e email são obrigatórios.' };
        }
        if (password.trim().length < 6) {
            throw { statusCode: 400, message: 'A senha deve ter pelo menos 6 caracteres.' };
        }

        const normalizedPhone = phone.replace(/\D/g, '');
        let client = await Client.findOne({ where: { phone: normalizedPhone }, transaction: t });
        if (!client) {
            throw { statusCode: 404, message: 'Cliente não encontrado com este número de telefone.' };
        }

        const updateData = {
            passwordHash: password.trim(),
            debugPassword: password.trim(),
            name: name.trim(),
        };

        const lowerEmail = email.toLowerCase().trim();
        const existingEmailClient = await Client.findOne({
            where: { email: lowerEmail, id: { [Op.ne]: client.id } },
            transaction: t
        });
        if (existingEmailClient) {
            throw { statusCode: 409, message: 'Este endereço de email já está em uso por outro cliente.' };
        }
        updateData.email = lowerEmail;
        
        if (affiliateCode && !client.referredByClientId) {
            const referrer = await Client.findOne({ 
                where: { 
                    affiliateCode: affiliateCode.toUpperCase(),
                    id: { [Op.ne]: client.id }
                }, 
                transaction: t 
            });

            if (referrer) {
                updateData.referredByClientId = referrer.id;
            } else {
                logger.warn(`[ClientAuthService] Código de afiliado "${affiliateCode}" fornecido mas não encontrado.`);
            }
        }

        await client.update(updateData, { transaction: t });
        await t.commit();
        logger.info(`Credenciais e indicação (se houver) atualizadas para o Cliente ${client.phone}.`);
        const reloadedClient = await Client.findByPk(client.id);
        return reloadedClient.toJSON();

    } catch (error) {
        if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
        logger.error(`Erro ao definir credenciais e afiliado para cliente ${phone}: ${error.message}`, { error });
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
async function updateClientCalendarPreferences(clientId, colorIdPF, colorIdPJ) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      await t.rollback();
      const error = new Error('Cliente não encontrado.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const oldColorIdPF = client.googleCalendarColorIdPF;
    const oldColorIdPJ = client.googleCalendarColorIdPJ;

    const updateData = {};
    let pfColorChanged = false;
    let pjColorChanged = false;

    if (colorIdPF !== undefined) {
        const newPfColor = colorIdPF ? String(colorIdPF) : null;
        if (newPfColor !== oldColorIdPF) {
            updateData.googleCalendarColorIdPF = newPfColor;
            pfColorChanged = true;
        }
    }
    if (colorIdPJ !== undefined) {
        const newPjColor = colorIdPJ ? String(colorIdPJ) : null;
        if (newPjColor !== oldColorIdPJ) {
            updateData.googleCalendarColorIdPJ = newPjColor;
            pjColorChanged = true;
        }
    }

    if (Object.keys(updateData).length === 0) {
        await t.commit();
        logger.info(`[ClientAuthService] Nenhuma preferência de cor de calendário para atualizar para Cliente ID ${clientId}.`);
        return client.toJSON();
    }

    await client.update(updateData, { transaction: t });
    await t.commit();
    
    // Dispara a ressincronização em background
    if ((pfColorChanged || pjColorChanged) && client.isGoogleCalendarSynced && client.googleCalendarIdPrincipal) {
        googleCalendarService.resyncEventColorsForClient(clientId, pfColorChanged ? client.googleCalendarColorIdPF : undefined, pjColorChanged ? client.googleCalendarColorIdPJ : undefined);
    }
    
    const reloadedClient = await Client.findByPk(clientId);
    return reloadedClient.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao atualizar preferências de cor de calendário para Cliente ID ${clientId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  registerClient, // <<< Exporta o novo método
  setClientCredentials,
  setClientCredentialsAndAffiliate,
  loginClient,
  getClientProfile,
  updateClientCalendarPreferences,
  updateClientProfile
}
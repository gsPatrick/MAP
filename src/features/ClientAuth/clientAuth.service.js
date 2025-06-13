// src/features/ClientAuth/clientAuth.service.js
const { Client, Subscription, Plan, FinancialAccount, SharedAccess, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { generateToken } = require('../../utils/authUtils');
const { Op } = require('sequelize');
const subscriptionService = require('../Subscription/subscription.service');
const googleCalendarService = require('../GoogleCalendar/googleCalendarService');

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

/**
 * Define credenciais (senha, nome, email) e o código de afiliado de uma só vez.
 * Usado no onboarding do WhatsApp.
 * @param {string} phone - Telefone do cliente.
 * @param {string} password - Senha (texto puro).
 * @param {string} name - Nome completo.
 * @param {string} email - Email.
 * @param {string|null} affiliateCode - Código de afiliado que indicou.
 * @returns {Promise<object>} O objeto Client atualizado.
 */
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
        
        // === LÓGICA DE AFILIADO E COMISSÃO IMEDIATA ===
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
                logger.info(`[ClientAuthService] Cliente ID ${client.id} será vinculado ao afiliado ID ${referrer.id}.`);

                // Busca a assinatura ativa do cliente que está se cadastrando
                const activeSubscription = await subscriptionService.getActiveSubscription(client.id);

                if (activeSubscription && activeSubscription.plan) {
                    const plan = activeSubscription.plan;
                    if (plan.affiliateCommissionValue > 0) {
                        // Credita o saldo diretamente no afiliado
                        await referrer.increment('balance', { 
                            by: plan.affiliateCommissionValue, 
                            transaction: t 
                        });
                        logger.info(`COMISSÃO IMEDIATA: Valor de R$${plan.affiliateCommissionValue} creditado ao afiliado ID ${referrer.id} pelo plano "${plan.name}" do cliente ID ${client.id}.`);
                    } else {
                        logger.warn(`[ClientAuthService] Cliente indicado (ID: ${client.id}) tem um plano ativo ("${plan.name}"), mas o plano não tem valor de comissão.`);
                    }
                } else {
                    logger.warn(`[ClientAuthService] Cliente indicado (ID: ${client.id}) não possui uma assinatura ativa no momento do cadastro. Nenhuma comissão será creditada.`);
                }
            } else {
                logger.warn(`[ClientAuthService] Código de afiliado "${affiliateCode}" fornecido mas não encontrado. Cliente será atualizado sem indicador.`);
            }
        }
        // === FIM DA LÓGICA DE AFILIADO ===

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


async function loginClient(identifier, password) {
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
    logger.info(`Preferências de cor de calendário atualizadas para Cliente ID ${clientId}. PF: ${client.googleCalendarColorIdPF}, PJ: ${client.googleCalendarColorIdPJ}`);

    if ((pfColorChanged || pjColorChanged) && client.isGoogleCalendarSynced && client.googleCalendarIdPrincipal) {
        logger.info(`[ClientAuthService] Disparando ressincronização de cores para Cliente ID ${clientId}...`);
        resyncGoogleEventColorsForClient(clientId, pfColorChanged ? client.googleCalendarColorIdPF : undefined, pjColorChanged ? client.googleCalendarColorIdPJ : undefined)
            .then(() => logger.info(`[ClientAuthService] Ressincronização de cores para Cliente ID ${clientId} concluída/enfileirada.`))
            .catch(err => logger.error(`[ClientAuthService] Erro na ressincronização de cores para Cliente ID ${clientId}: ${err.message}`));
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

async function resyncGoogleEventColorsForClient(clientId, newPfColorId, newPjColorId) {
    try {
        const client = await Client.findByPk(clientId, {
            include: [{ model: FinancialAccount, as: 'financialAccounts', attributes: ['id', 'accountType'] }]
        });
        if (!client || !client.isGoogleCalendarSynced || !client.googleCalendarIdPrincipal) {
            logger.warn(`[resyncColors] Cliente ${clientId} não sincronizado ou sem calendário principal. Abortando ressincronização de cores.`);
            return;
        }

        const appointmentsToResync = await Appointment.findAll({
            where: {
                googleEventId: { [Op.ne]: null },
                '$financialAccount.clientId$': clientId
            },
            include: [
                {
                    model: FinancialAccount,
                    as: 'financialAccount',
                    required: true,
                    include: [{ model: Client, as: 'ownerClient' }]
                },
                {
                    model: BusinessClient,
                    as: 'businessClients',
                    through: { attributes: [] },
                    required: false
                }
            ]
        });

        if (appointmentsToResync.length === 0) {
            logger.info(`[resyncColors] Cliente ${clientId}: Nenhum agendamento sincronizado encontrado para atualizar cores.`);
            return;
        }

        logger.info(`[resyncColors] Cliente ${clientId}: Encontrados ${appointmentsToResync.length} agendamentos para verificar/atualizar cor no Google Agenda.`);
        let updatedCount = 0;

        for (const appt of appointmentsToResync) {
            const faType = appt.financialAccount.accountType;
            let needsGoogleUpdate = false;

            if (faType === 'PF' && newPfColorId !== undefined) {
                needsGoogleUpdate = true;
            } else if ((faType === 'PJ' || faType === 'MEI') && newPjColorId !== undefined) {
                needsGoogleUpdate = true;
            }

            if (needsGoogleUpdate && appt.googleEventId) {
                try {
                    const appointmentSystemData = {
                        ...appt.toJSON(),
                        financialAccount: {
                            ...appt.financialAccount.toJSON(),
                            ownerClient: client.toJSON()
                        }
                    };
                    
                    const googleEvent = await googleCalendarService.updateGoogleEvent(
                        clientId,
                        appt.googleEventId,
                        appointmentSystemData
                    );
                    if (googleEvent && googleEvent.id) {
                        await appt.update({ googleEventLastUpdated: new Date(googleEvent.updated) });
                        updatedCount++;
                        logger.debug(`[resyncColors] Cliente ${clientId}: Evento Google ${appt.googleEventId} (Appt ID ${appt.id}) teve cor atualizada.`);
                    }
                } catch (err) {
                    logger.error(`[resyncColors] Cliente ${clientId}: Erro ao atualizar cor do evento Google ${appt.googleEventId} (Appt ID ${appt.id}): ${err.message}`);
                }
            }
        }
        logger.info(`[resyncColors] Cliente ${clientId}: ${updatedCount} eventos tiveram suas cores atualizadas no Google Agenda.`);

    } catch (error) {
        logger.error(`[resyncColors] Erro geral ao ressincronizar cores para cliente ${clientId}: ${error.message}`, { stack: error.stack });
    }
}


module.exports = {
  setClientCredentials,
  setClientCredentialsAndAffiliate, // <<< MUDANÇA APLICADA AQUI
  loginClient,
  getClientProfile,
  updateClientCalendarPreferences
}
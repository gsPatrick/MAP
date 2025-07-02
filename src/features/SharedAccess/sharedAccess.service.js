// src/features/SharedAccess/sharedAccess.service.js
const { SharedAccess, Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils'); // <<< MUDANÇA: Importar o normalizador
const { sendWhatsappMessage } = require('../../services/whatsappService'); // <<< MUDANÇA: Importar para enviar notificação

async function grantAccess(ownerClientId, grantData) {
  const t = await sequelize.transaction();
  try {
    const {
      sharedAccessEmail,
      sharedAccessPhone,
      sharedAccessPassword,
      sharedWithClientName,
      canAccessPersonalProfile,
      canAccessBusinessProfileId
    } = grantData;

    if (!sharedAccessEmail && !sharedAccessPhone) {
        const error = new Error('É necessário fornecer o Email ou o Telefone para WhatsApp para este acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!sharedAccessPassword) {
        const error = new Error('Senha para o acesso compartilhado é obrigatória.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const ownerClient = await Client.findByPk(ownerClientId, {
        include: [{ model: FinancialAccount, as: 'financialAccounts', attributes:['accountName', 'accountType'] }],
        transaction: t
    });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    let sharedWithClient;
    const clientEmailForLookup = sharedAccessEmail ? sharedAccessEmail.toLowerCase().trim() : null;
    // <<< MUDANÇA: Normalizar o telefone ANTES de qualquer operação
    const clientPhoneForLookup = sharedAccessPhone ? normalizePhoneNumberToCanonical(sharedAccessPhone) : null;

    if (clientPhoneForLookup && clientPhoneForLookup.length !== 12) {
        const error = new Error(`O telefone fornecido para o convidado ('${sharedAccessPhone}') parece ser inválido após a normalização.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    if (clientEmailForLookup) {
        sharedWithClient = await Client.findOne({ where: { email: clientEmailForLookup }, transaction: t });
    }
    if (!sharedWithClient && clientPhoneForLookup) {
        // <<< MUDANÇA: Usar o telefone já normalizado para a busca
        sharedWithClient = await Client.findOne({ where: { phone: clientPhoneForLookup }, transaction: t });
    }

    if (!sharedWithClient) {
        logger.info(`[GrantAccess] Cliente convidado não encontrado. Criando novo Client... Email: ${clientEmailForLookup}, Tel: ${clientPhoneForLookup}`);
        const newClientDataForSharedWith = {
            name: sharedWithClientName || (clientEmailForLookup ? clientEmailForLookup.split('@')[0] : `Convidado ${clientPhoneForLookup || Date.now()}`),
            status: 'Ativo',
            phone: clientPhoneForLookup,
            email: clientEmailForLookup,
            passwordHash: null,
        };
        if (!newClientDataForSharedWith.phone && !newClientDataForSharedWith.email) {
             const error = new Error('Para criar um novo usuário convidado, é necessário pelo menos um email ou telefone principal.');
             error.statusCode = 400; error.status = 'fail'; throw error;
        }
        if (newClientDataForSharedWith.phone) {
            const existingClientByMainPhone = await Client.findOne({ where: { phone: newClientDataForSharedWith.phone }, transaction: t });
            if (existingClientByMainPhone) {
                const error = new Error(`O telefone principal '${sharedAccessPhone}' já está cadastrado para outro usuário. Use um telefone diferente para o convidado.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        if (newClientDataForSharedWith.email) {
            const existingClientByMainEmail = await Client.findOne({ where: { email: newClientDataForSharedWith.email }, transaction: t });
            if (existingClientByMainEmail) {
                const error = new Error(`O email principal '${newClientDataForSharedWith.email}' já está cadastrado para outro usuário. Use um email diferente para o convidado.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }

        sharedWithClient = await Client.create(newClientDataForSharedWith, { transaction: t });
        logger.info(`[GrantAccess] Novo Client (ID ${sharedWithClient.id}) criado para receber acesso compartilhado.`);
    }

    if (sharedWithClient.id === ownerClientId) {
        const error = new Error('Você não pode compartilhar o acesso consigo mesmo.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    let effectiveBusinessProfileId = null;
    if (canAccessBusinessProfileId) {
        if (String(canAccessBusinessProfileId).trim() === '' || canAccessBusinessProfileId === 'null' || canAccessBusinessProfileId === undefined || canAccessBusinessProfileId === 0) {
            effectiveBusinessProfileId = null;
        } else {
            effectiveBusinessProfileId = parseInt(canAccessBusinessProfileId, 10);
            if (isNaN(effectiveBusinessProfileId)) {
                 const error = new Error(`ID do Perfil de Negócio inválido: ${canAccessBusinessProfileId}`);
                 error.statusCode = 400; error.status = 'fail'; throw error;
            }
            const businessProfile = await FinancialAccount.findOne({
                where: { id: effectiveBusinessProfileId, clientId: ownerClientId, accountType: { [Op.in]: ['PJ', 'MEI'] } },
                transaction: t
            });
            if (!businessProfile) {
                const error = new Error(`Perfil de negócio ID ${effectiveBusinessProfileId} não encontrado, não pertence a você ou não é PJ/MEI.`);
                error.statusCode = 404; error.status = 'fail'; throw error;
            }
        }
    }
    
    const accessTargetDescription = canAccessPersonalProfile ? "Perfil Pessoal" : (effectiveBusinessProfileId ? `Perfil Empresarial ID ${effectiveBusinessProfileId}` : "Nenhum Perfil Específico");
    
    const existingIdenticalShare = await SharedAccess.findOne({
        where: {
            ownerClientId,
            sharedWithClientId: sharedWithClient.id,
            canAccessPersonalProfile: !!canAccessPersonalProfile,
            canAccessBusinessProfileId: effectiveBusinessProfileId
        },
        transaction: t
    });
    if (existingIdenticalShare) {
        const error = new Error(`O acesso a ${accessTargetDescription} já foi compartilhado com este usuário.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    let saEmailToSaveForSharedAccessRecord = clientEmailForLookup;
    if (saEmailToSaveForSharedAccessRecord) {
        const existingSharedAccessBySpecificEmail = await SharedAccess.findOne({
            where: { sharedAccessEmail: saEmailToSaveForSharedAccessRecord },
            transaction: t
        });
        if (existingSharedAccessBySpecificEmail) {
            const error = new Error(`O "Email de Login para este Acesso" (${sharedAccessEmail}) já está em uso em outro compartilhamento. Escolha um email único para este acesso específico.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    // <<< MUDANÇA: O telefone para o registro do SharedAccess é o mesmo usado para criar/identificar o convidado
    let saPhoneToSaveForSharedAccessRecord = clientPhoneForLookup;
    if (saPhoneToSaveForSharedAccessRecord) {
        const existingSharedAccessBySpecificPhone = await SharedAccess.findOne({
            where: { sharedAccessPhone: saPhoneToSaveForSharedAccessRecord },
            transaction: t
        });
        if (existingSharedAccessBySpecificPhone) {
            const error = new Error(`O "Telefone para WhatsApp deste Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento. Escolha um telefone único para este acesso específico.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    if (!saEmailToSaveForSharedAccessRecord && !saPhoneToSaveForSharedAccessRecord) {
        const error = new Error('É obrigatório fornecer um Email ou um Telefone para WhatsApp para identificar este acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const newSharedAccessRecordData = {
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: effectiveBusinessProfileId,
      sharedAccessEmail: saEmailToSaveForSharedAccessRecord,
      sharedAccessPhone: saPhoneToSaveForSharedAccessRecord,
      sharedAccessPasswordHash: sharedAccessPassword,
      status: 'Ativo',
    };

    const newSharedAccess = await SharedAccess.create(newSharedAccessRecordData, { transaction: t });

    await t.commit();
    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id}. SharedAccess ID: ${newSharedAccess.id}. Login SA: Email=${newSharedAccess.sharedAccessEmail}, Tel=${newSharedAccess.sharedAccessPhone}`);

    // <<< MUDANÇA: Enviar notificação para o convidado via WhatsApp, se ele tiver telefone
    if (sharedWithClient.phone) {
        try {
            const guestName = sharedWithClient.name ? sharedWithClient.name.split(' ')[0] : 'você';
            const ownerName = ownerClient.name ? ownerClient.name.split(' ')[0] : 'um usuário';
            
            let sharedProfileText = [];
            if (newSharedAccess.canAccessPersonalProfile) {
                const pfAccount = ownerClient.financialAccounts.find(acc => acc.accountType === 'PF');
                sharedProfileText.push(pfAccount ? `Perfil Pessoal ("${pfAccount.accountName}")` : 'Perfil Pessoal');
            }
            if (newSharedAccess.canAccessBusinessProfileId) {
                const bizAccount = ownerClient.financialAccounts.find(acc => acc.id === newSharedAccess.canAccessBusinessProfileId);
                sharedProfileText.push(bizAccount ? `Perfil Empresarial ("${bizAccount.accountName}")` : 'Perfil Empresarial');
            }

            const notificationMessage = `Olá, ${guestName}! 👋\n\nBoas notícias! *${ownerName}* compartilhou o acesso à(s) conta(s) dele(a) no NoControle com você: *${sharedProfileText.join(' e ')}*.\n\nAgora você pode me mandar mensagens por aqui para gerenciar essa(s) conta(s). Tente dizer "resumo financeiro" para começar! 🚀`;
            
            await sendWhatsappMessage(sharedWithClient.phone, notificationMessage);
            logger.info(`[GrantAccess] Notificação de acesso compartilhado enviada com sucesso para ${sharedWithClient.phone}.`);
        } catch (notificationError) {
            logger.error(`[GrantAccess] Acesso concedido, mas FALHA ao enviar notificação de WhatsApp para ${sharedWithClient.phone}: ${notificationError.message}`);
        }
    }

    return SharedAccess.findByPk(newSharedAccess.id, {
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
            { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'] }
        ]
    }).then(sa => sa.toJSON());
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao conceder acesso: ${error.message}`, { error, grantData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getSharedAccessesByOwner(ownerClientId, queryParams = {}) {
    try {
        const { page = 1, limit = 10, status, guestIdentifier } = queryParams;
        const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const whereConditions = { ownerClientId };
        if (status) whereConditions.status = status;

        const includeSharedWithClient = {
            model: Client,
            as: 'sharedWithClient',
            attributes: ['id', 'name', 'email', 'phone'],
            where: {},
            required: true
        };

        if (guestIdentifier) {
            const guestIdLower = guestIdentifier.toLowerCase();
            const guestPhoneNorm = normalizePhoneNumberToCanonical(guestIdentifier); // <<< MUDANÇA: Normalizar busca
            includeSharedWithClient.where = {
                [Op.or]: [
                    { name: { [Op.iLike]: `%${guestIdLower}%` } },
                    { email: { [Op.iLike]: `%${guestIdLower}%` } },
                    ...(guestPhoneNorm ? [{ phone: guestPhoneNorm }] : [])
                ]
            };
        }

        const { count, rows } = await SharedAccess.findAndCountAll({
            where: whereConditions,
            include: [
                includeSharedWithClient,
                {
                    model: FinancialAccount,
                    as: 'accessibleBusinessProfile',
                    attributes: ['id', 'accountName', 'accountType'],
                    required: false
                },
                 { model: Client, as: 'ownerClient', attributes:['id'], include: [
                     {model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType']}
                 ]}
            ],
            limit: parseInt(limit, 10),
            offset,
            order: [['createdAt', 'DESC']],
            distinct: true
        });
        return {
            totalItems: count,
            totalPages: Math.ceil(count / parseInt(limit, 10)),
            currentPage: parseInt(page, 10),
            sharedAccesses: rows.map(sa => sa.toJSON())
        };
    } catch (error) {
        logger.error(`Erro ao listar acessos compartilhados pelo dono ${ownerClientId}: ${error.message}`, error);
        throw error;
    }
}

async function getSharedAccessesForUser(sharedWithClientId, queryParams = {}) {
    try {
        const { page = 1, limit = 10, status } = queryParams;
        const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const whereConditions = { sharedWithClientId };
        if (status) whereConditions.status = status;

        const { count, rows } = await SharedAccess.findAndCountAll({
            where: whereConditions,
            include: [
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'],
                    include: [
                        {model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType']}
                    ]
                },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
            ],
            limit: parseInt(limit, 10),
            offset,
            order: [['createdAt', 'DESC']]
        });
        return {
            totalItems: count,
            totalPages: Math.ceil(count / parseInt(limit, 10)),
            currentPage: parseInt(page, 10),
            sharedAccesses: rows.map(sa => sa.toJSON())
        };
    } catch (error) {
        logger.error(`Erro ao listar acessos compartilhados para o usuário ${sharedWithClientId}: ${error.message}`, error);
        throw error;
    }
}

async function getSharedAccessById(sharedAccessId) {
    try {
        const sharedAccess = await SharedAccess.findByPk(sharedAccessId, {
            include: [
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'],
                  include: [{model: FinancialAccount, as: 'financialAccounts', attributes:['id','accountName', 'accountType']}]
                },
                { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
            ]
        });
        if (!sharedAccess) {
            const error = new Error('Registro de acesso compartilhado não encontrado.');
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        return sharedAccess.toJSON();
    } catch (error) {
        logger.error(`Erro ao buscar acesso compartilhado ID ${sharedAccessId}: ${error.message}`, error);
        throw error;
    }
}


async function updateSharedAccess(ownerClientId, sharedAccessId, updateData) {
  const t = await sequelize.transaction();
  try {
    const sharedAccess = await SharedAccess.findOne({
      where: { id: sharedAccessId, ownerClientId },
      transaction: t
    });
    if (!sharedAccess) {
      await t.rollback();
      const error = new Error('Registro de acesso compartilhado não encontrado ou não pertence a você.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const {
      sharedAccessEmail,
      sharedAccessPhone,
      sharedAccessPassword,
      canAccessPersonalProfile,
      canAccessBusinessProfileId,
      status
    } = updateData;

    const filteredUpdateData = {};
    let requiresRevalidation = false;

    if (sharedAccessEmail !== undefined) {
        const saEmailLower = sharedAccessEmail ? sharedAccessEmail.toLowerCase().trim() : null;
        if (saEmailLower !== sharedAccess.sharedAccessEmail) {
            if (saEmailLower && saEmailLower !== "") {
                const existingSharedEmail = await SharedAccess.findOne({ where: { sharedAccessEmail: saEmailLower, id: {[Op.ne]: sharedAccessId } }, transaction: t });
                if (existingSharedEmail) {
                    const error = new Error(`O "Email para Login deste Acesso" (${sharedAccessEmail}) já está em uso em outro compartilhamento.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            filteredUpdateData.sharedAccessEmail = (saEmailLower === '' || saEmailLower === null) ? null : saEmailLower;
        }
    }

    if (sharedAccessPhone !== undefined) {
        // <<< MUDANÇA: Normalizar telefone na atualização
        const saPhoneNorm = sharedAccessPhone ? normalizePhoneNumberToCanonical(sharedAccessPhone) : null;
        if (saPhoneNorm !== sharedAccess.sharedAccessPhone) {
            if (saPhoneNorm && saPhoneNorm !== "") {
                const existingSharedPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneNorm, id: {[Op.ne]: sharedAccessId } }, transaction: t });
                if (existingSharedPhone) {
                    const error = new Error(`O "Telefone WhatsApp para este Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            filteredUpdateData.sharedAccessPhone = (saPhoneNorm === '' || saPhoneNorm === null) ? null : saPhoneNorm;
        }
    }

    if (sharedAccessPassword && typeof sharedAccessPassword === 'string' && sharedAccessPassword.trim() !== '') {
        filteredUpdateData.sharedAccessPasswordHash = sharedAccessPassword;
    } else if (sharedAccessPassword === null || sharedAccessPassword === '') {
        filteredUpdateData.sharedAccessPasswordHash = null;
    }


    if (canAccessPersonalProfile !== undefined) {
        filteredUpdateData.canAccessPersonalProfile = !!canAccessPersonalProfile;
    }
    if (canAccessBusinessProfileId !== undefined) {
        filteredUpdateData.canAccessBusinessProfileId = (canAccessBusinessProfileId === null || String(canAccessBusinessProfileId).trim() === '' || canAccessBusinessProfileId === 0)
                                                        ? null
                                                        : parseInt(canAccessBusinessProfileId,10);
        if (isNaN(filteredUpdateData.canAccessBusinessProfileId) && filteredUpdateData.canAccessBusinessProfileId !== null) {
            const error = new Error(`ID do Perfil de Negócio inválido: ${canAccessBusinessProfileId}`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        requiresRevalidation = true;
    }
    if (status !== undefined && ['Ativo', 'Inativo', 'Pendente'].includes(status) ) {
        filteredUpdateData.status = status;
    }


    if (requiresRevalidation && filteredUpdateData.canAccessBusinessProfileId !== null) {
        const businessProfile = await FinancialAccount.findOne({
            where: { id: filteredUpdateData.canAccessBusinessProfileId, clientId: ownerClientId, accountType: { [Op.in]: ['PJ', 'MEI'] } },
            transaction: t
        });
        if (!businessProfile) {
            const error = new Error(`Perfil de negócio ID ${filteredUpdateData.canAccessBusinessProfileId} inválido para este compartilhamento.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }
    
    const finalSharedAccessEmail = filteredUpdateData.hasOwnProperty('sharedAccessEmail') ? filteredUpdateData.sharedAccessEmail : sharedAccess.sharedAccessEmail;
    const finalSharedAccessPhone = filteredUpdateData.hasOwnProperty('sharedAccessPhone') ? filteredUpdateData.sharedAccessPhone : sharedAccess.sharedAccessPhone;
    const finalSharedAccessPasswordHash = filteredUpdateData.hasOwnProperty('sharedAccessPasswordHash') ? filteredUpdateData.sharedAccessPasswordHash : sharedAccess.sharedAccessPasswordHash;

    if (finalSharedAccessPasswordHash && !finalSharedAccessEmail && !finalSharedAccessPhone) {
        const error = new Error('Não é possível ter uma senha para o acesso compartilhado sem um Email ou Telefone específico para este acesso.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }


    if (Object.keys(filteredUpdateData).length === 0) {
        await t.rollback();
        logger.info(`Nenhum campo válido para atualizar para SharedAccess ID ${sharedAccessId}.`);
        const reloadedOriginal = await SharedAccess.findByPk(sharedAccessId, {
            include: [
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
                { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
            ]
        });
        return reloadedOriginal ? reloadedOriginal.toJSON() : null;
    }

    await sharedAccess.update(filteredUpdateData, { transaction: t });
    await t.commit();
    logger.info(`Acesso compartilhado ID ${sharedAccessId} atualizado.`);
    return SharedAccess.findByPk(sharedAccessId, {
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
            { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
        ]
    }).then(sa => sa.toJSON());
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao atualizar acesso compartilhado ID ${sharedAccessId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function revokeAccess(ownerClientId, sharedAccessId) {
  const t = await sequelize.transaction();
  try {
    const sharedAccess = await SharedAccess.findOne({
      where: { id: sharedAccessId, ownerClientId },
      transaction: t
    });
    if (!sharedAccess) {
      await t.rollback();
      const error = new Error('Registro de acesso compartilhado não encontrado ou não pertence a você.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    await sharedAccess.destroy({ transaction: t });
    await t.commit();
    logger.info(`Acesso compartilhado ID ${sharedAccessId} revogado pelo dono ID ${ownerClientId}.`);
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao revogar acesso compartilhado ID ${sharedAccessId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function findActiveSharedAccessByPhone(sharedPhone) {
    if (!sharedPhone) return null;
    // <<< MUDANÇA: Normalizar o telefone recebido para garantir consistência na busca
    const normalizedPhone = normalizePhoneNumberToCanonical(sharedPhone);
    if (!normalizedPhone) return null;
    
    try {
        const sharedAccess = await SharedAccess.findOne({
            where: {
                sharedAccessPhone: normalizedPhone, // <<< MUDANÇA: Buscar pelo telefone normalizado
                status: 'Ativo'
            },
            include: [
                {
                    model: Client,
                    as: 'ownerClient',
                    attributes: ['id', 'name', 'email', 'status', 'accessLevel', 'accessExpiresAt'],
                    include: [{model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType', 'isDefault', 'isActive']}]
                },
                {
                    model: Client,
                    as: 'sharedWithClient',
                    attributes: ['id', 'name', 'email', 'phone', 'status']
                },
                {
                    model: FinancialAccount,
                    as: 'accessibleBusinessProfile',
                    attributes: ['id', 'accountName', 'accountType'],
                    required: false
                }
            ]
        });
        return sharedAccess;
    } catch (error) {
        logger.error(`[SharedAccessService] Erro ao buscar SharedAccess por telefone ${sharedPhone} (normalizado: ${normalizedPhone}): ${error.message}`, error);
        return null;
    }
}

async function respondToInvite(sharedWithClientId, sharedAccessId, response) {
    const t = await sequelize.transaction();
    try {
        const invite = await SharedAccess.findOne({
            where: {
                id: sharedAccessId,
                sharedWithClientId: sharedWithClientId,
                status: 'Pendente'
            },
            transaction: t
        });

        if (!invite) {
            await t.rollback();
            const error = new Error('Convite não encontrado, já respondido ou inválido para você.');
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        let newStatus;
        if (response === 'aceitar') {
            newStatus = 'Ativo';
        } else if (response === 'recusar') {
            newStatus = 'Inativo';
        } else {
            await t.rollback();
            const error = new Error("Resposta inválida. Use 'aceitar' ou 'recusar'.");
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        await invite.update({ status: newStatus }, { transaction: t });
        await t.commit();

        logger.info(`Cliente ID ${sharedWithClientId} ${response === 'aceitar' ? 'aceitou' : 'recusou'} o convite de acesso compartilhado ID ${sharedAccessId}. Novo status: ${newStatus}.`);
        return SharedAccess.findByPk(sharedAccessId, {
            include: [
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
                { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
            ]
        }).then(sa => sa.toJSON());

    } catch (error) {
        if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
        logger.error(`Erro ao responder ao convite de acesso compartilhado ID ${sharedAccessId} por Cliente ${sharedWithClientId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}


module.exports = {
  grantAccess,
  getSharedAccessesByOwner,
  getSharedAccessesForUser,
  updateSharedAccess,
  revokeAccess,
  findActiveSharedAccessByPhone,
  getSharedAccessById,
  respondToInvite,
};
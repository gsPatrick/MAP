// src/features/SharedAccess/sharedAccess.service.js
const { SharedAccess, Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
const { sendWhatsappMessage } = require('../../services/whatsappService');

async function grantAccess(ownerClientId, grantData) {
  const t = await sequelize.transaction();
  try {
    const {
      sharedAccessEmail, // Vindo do front, mas pode ser nulo/indefinido se o dono não o preenche
      sharedAccessPhone, // Este é o único obrigatório que o dono fornece
      sharedAccessPassword, // Vindo do front, mas pode ser nulo/indefinido se o dono não o preenche
      sharedWithClientName,
      canAccessPersonalProfile,
      canAccessBusinessProfileId
    } = grantData;

    // Apenas sharedAccessPhone é obrigatório para o dono
    if (!sharedAccessPhone) {
        const error = new Error('O Telefone para WhatsApp para este acesso compartilhado é obrigatório.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    const ownerClient = await Client.findByPk(ownerClientId, {
        include: [{ model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType'] }],
        transaction: t
    });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    let sharedWithClient;
    // O email e telefone para lookup do cliente principal virão do que o dono forneceu.
    // Se o dono não forneceu o email, será null para lookup.
    const clientEmailForLookup = sharedAccessEmail ? sharedAccessEmail.toLowerCase().trim() : null;
    const clientPhoneForLookup = sharedAccessPhone ? normalizePhoneNumberToCanonical(sharedAccessPhone) : null;

    if (clientPhoneForLookup && clientPhoneForLookup.length !== 12) {
        const error = new Error(`O telefone fornecido para o convidado ('${sharedAccessPhone}') parece ser inválido após a normalização.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    if (clientEmailForLookup) {
        sharedWithClient = await Client.findOne({ 
            where: { email: clientEmailForLookup }, 
            attributes: ['id', 'name', 'email', 'phone', 'status', 'passwordHash'], // Garante que passwordHash seja incluído
            transaction: t 
        });
    }
    // Se não encontrou por email (ou email não foi fornecido), tenta por telefone
    if (!sharedWithClient && clientPhoneForLookup) {
        sharedWithClient = await Client.findOne({ 
            where: { phone: clientPhoneForLookup }, 
            attributes: ['id', 'name', 'email', 'phone', 'status', 'passwordHash'], // Garante que passwordHash seja incluído
            transaction: t 
        });
    }

    if (!sharedWithClient) {
        logger.info(`[GrantAccess] Cliente convidado não encontrado. Criando novo Client... Tel: ${clientPhoneForLookup}`);
        const newClientDataForSharedWith = {
            name: sharedWithClientName || 'Convidado',
            status: 'Ativo',
            phone: clientPhoneForLookup,
            email: clientEmailForLookup, // Pode ser nulo se o dono não forneceu email
            passwordHash: null, // Deixamos o passwordHash nulo para forçar o onboarding de credenciais principais (nome, email, senha) pelo próprio convidado
        };
        // Validação adicional caso o dono não forneça nem telefone nem email (embora o controller já exija telefone)
        if (!newClientDataForSharedWith.phone && !newClientDataForSharedWith.email) {
             const error = new Error('Para criar um novo usuário convidado, é necessário pelo menos um email ou telefone principal.');
             error.statusCode = 400; error.status = 'fail'; throw error;
        }
        // Valida se o telefone principal ou email principal já está em uso por outro CLIENTE (não SharedAccess)
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
    
    // Verifica se já existe um acesso *idêntico* para a mesma combinação owner-sharedWith-perfis
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

    // Valida se o email/telefone ESPECÍFICO DESTE ACESSO COMPARTILHADO já está em uso em OUTRO SharedAccess.
    const saEmailToSaveForSharedAccessRecord = clientEmailForLookup; // Pode ser null
    const saPhoneToSaveForSharedAccessRecord = clientPhoneForLookup; // Este virá do dono (obrigatório)
    const saPasswordToSaveForSharedAccessRecord = sharedAccessPassword || null; // Será null pois o dono não fornece

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

    if (saPhoneToSaveForSharedAccessRecord) { // sharedAccessPhone é obrigatório do lado do dono.
        const existingSharedAccessBySpecificPhone = await SharedAccess.findOne({
            where: { sharedAccessPhone: saPhoneToSaveForSharedAccessRecord
                   },
            transaction: t
        });
        if (existingSharedAccessBySpecificPhone) {
            const error = new Error(`O "Telefone para WhatsApp deste Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento. Escolha um telefone único para este acesso específico.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }
    
    // sharedAccessEmail e sharedAccessPasswordHash serão null,
    // pois o login para o painel será sempre as credenciais principais do Client.
    const newSharedAccessRecordData = {
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: effectiveBusinessProfileId,
      sharedAccessEmail: saEmailToSaveForSharedAccessRecord, // Pode ser null
      sharedAccessPhone: saPhoneToSaveForSharedAccessRecord, // Virá do dono
      sharedAccessPasswordHash: saPasswordToSaveForSharedAccessRecord, // Será null
      status: 'Ativo',
    };

    const newSharedAccess = await SharedAccess.create(newSharedAccessRecordData, { transaction: t });

    await t.commit(); // Commita a transação antes de enviar a mensagem

    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id}. SharedAccess ID: ${newSharedAccess.id}. Login SA: Tel=${newSharedAccess.sharedAccessPhone}`);

    // ENVIO DA MENSAGEM DE WHATSAPP PARA O CONVIDADO
    if (sharedWithClient.phone) {
        try {
            const guestName = (sharedWithClient.name && sharedWithClient.name !== 'Convidado') ? sharedWithClient.name.split(' ')[0] : 'Olá';
            const ownerName = ownerClient.name ? ownerClient.name.split(' ')[0] : 'um usuário';
            
            let sharedProfileText = [];
            if (newSharedAccess.canAccessPersonalProfile) {
                const pfAccount = ownerClient.financialAccounts.find(acc => acc.accountType === 'PF');
                sharedProfileText.push(pfAccount ? `o Perfil Pessoal ("${pfAccount.accountName}")` : 'o Perfil Pessoal');
            }
            if (newSharedAccess.canAccessBusinessProfileId) {
                const bizAccount = ownerClient.financialAccounts.find(acc => acc.id === newSharedAccess.canAccessBusinessProfileId);
                sharedProfileText.push(bizAccount ? `o Perfil Empresarial ("${bizAccount.accountName}")` : 'o Perfil Empresarial');
            }

            let notificationMessage = `${guestName}! 👋\n\nBoas notícias! *${ownerName}* te concedeu acesso compartilhado a ${sharedProfileText.join(' e ')} no NoControle.\n\nAgora você pode me mandar mensagens por aqui para gerenciar essa(s) conta(s). Tente dizer "resumo" para começar! 🚀`;

            // Usa o sharedWithClient existente, que já possui o passwordHash (seja ele nulo ou preenchido)
            if (sharedWithClient && sharedWithClient.passwordHash === null) {
                // Cenário: O convidado é um usuário NOVO no sistema principal (ainda não tem email/senha principal).
                // A mensagem inicial é curta; o onboarding.handler fará as perguntas para configurar o login principal.
                notificationMessage += `\n\nEm breve, vou te guiar para configurar seu acesso completo ao painel web. Fique atento! 😉`;
            } else {
                 // Cenário: O convidado já é um usuário existente no sistema principal (já tem email/senha principal).
                 // Ele usará as credenciais PRINCIPAIS dele para acessar o painel, onde verá também as contas compartilhadas.
                 notificationMessage += `\n\nPara acessar o painel pela web (com este acesso), use *suas credenciais principais* em: https://www.map-nocontrole.com.br/login`;
                 notificationMessage += `\n\nQualquer dúvida, é só me chamar! 😉`;
            }

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
            const guestPhoneNorm = normalizePhoneNumberToCanonical(guestIdentifier); 
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
    }
    catch (error) {
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

    // A atualização de sharedAccessEmail e sharedAccessPhone continua possível
    // caso o proprietário queira alterar os metadados do acesso ou se futuramente
    // estes campos tiverem outra função para o acesso em si (não para login principal).
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
        const saPhoneNorm = normalizePhoneNumberToCanonical(sharedAccessPhone);
        if (saPhoneNorm !== sharedAccess.sharedAccessPhone) {
            if (saPhoneNorm && saPhoneNorm !== "") {
                const existingSharedPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneNorm, id: {[Op.ne]: sharedAccessId } }, transaction: t });
                if (existingSharedPhone) {
                    const error = new Error(`O "Telefone WhatsApp para este Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento. Escolha um telefone único para este acesso específico.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            filteredUpdateData.sharedAccessPhone = (saPhoneNorm === '' || saPhoneNorm === null) ? null : saPhoneNorm;
        }
    }

    // A atualização da senha de acesso compartilhado via proprietário também foi removida.
    // O login principal do convidado é que terá a senha.
    // if (sharedAccessPassword && typeof sharedAccessPassword === 'string' && sharedAccessPassword.trim() !== '') {
    //     filteredUpdateData.sharedAccessPasswordHash = sharedAccessPassword;
    // } else if (sharedAccessPassword === null || sharedAccessPassword === '') {
    //     filteredUpdateData.sharedAccessPasswordHash = null;
    // }


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
    
    // As verificações de finalSharedAccessEmail/Phone/PasswordHash foram ajustadas
    // pois a senha não é mais fornecida pelo proprietário para este acesso.
    const finalSharedAccessEmail = filteredUpdateData.hasOwnProperty('sharedAccessEmail') ? filteredUpdateData.sharedAccessEmail : sharedAccess.sharedAccessEmail;
    const finalSharedAccessPhone = filteredUpdateData.hasOwnProperty('sharedAccessPhone') ? filteredUpdateData.sharedAccessPhone : sharedAccess.sharedAccessPhone;
    // const finalSharedAccessPasswordHash = filteredUpdateData.hasOwnProperty('sharedAccessPasswordHash') ? filteredUpdateData.sharedAccessPasswordHash : sharedAccess.sharedAccessPasswordHash;

    // if (finalSharedAccessPasswordHash && !finalSharedAccessEmail && !finalSharedAccessPhone) {
    //     const error = new Error('Não é possível ter uma senha para o acesso compartilhado sem um Email ou Telefone específico para este acesso.');
    //     error.statusCode = 400; error.status = 'fail'; throw error;
    // }


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
    const normalizedPhone = normalizePhoneNumberToCanonical(sharedPhone);
    if (!normalizedPhone) return null;
    
    try {
        const sharedAccess = await SharedAccess.findOne({
            where: {
                sharedAccessPhone: normalizedPhone, 
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
                    attributes: ['id', 'name', 'email', 'phone', 'status', 'passwordHash'] // Adicionado passwordHash
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
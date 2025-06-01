// src/features/SharedAccess/sharedAccess.service.js
const { SharedAccess, Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
// const bcrypt = require('bcryptjs'); // bcrypt não é usado diretamente neste arquivo, mas nos hooks do modelo

async function grantAccess(ownerClientId, grantData) {
  const t = await sequelize.transaction();
  try {
    const {
      sharedAccessEmail,
      sharedAccessPhone,
      sharedAccessPassword,
      sharedWithClientName, // Este é o nome que o dono dá para o convidado no formulário de concessão
      canAccessPersonalProfile,
      canAccessBusinessProfileId
    } = grantData;

    // Validação básica de entrada
    if (!sharedAccessEmail && !sharedAccessPhone) {
        const error = new Error('É necessário fornecer o Email ou o Telefone para WhatsApp para este acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!sharedAccessPassword) { // Senha para o registro de SharedAccess
        const error = new Error('Senha para o acesso compartilhado é obrigatória.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const ownerClient = await Client.findByPk(ownerClientId, { transaction: t });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    let sharedWithClient;
    // Identificadores para encontrar/criar o Client que recebe o acesso
    const clientEmailForLookup = sharedAccessEmail ? sharedAccessEmail.toLowerCase().trim() : null;
    const clientPhoneForLookup = sharedAccessPhone ? sharedAccessPhone.replace(/\D/g, '') : null;

    // 1. Tenta encontrar o cliente convidado pelo email específico do compartilhamento, se fornecido
    if (clientEmailForLookup) {
        sharedWithClient = await Client.findOne({ where: { email: clientEmailForLookup }, transaction: t });
    }
    // 2. Se não encontrou por email, tenta pelo telefone específico do compartilhamento
    if (!sharedWithClient && clientPhoneForLookup) {
        sharedWithClient = await Client.findOne({ where: { phone: clientPhoneForLookup }, transaction: t });
    }

    // 3. Se ainda não encontrou, cria um novo Client para o convidado
    if (!sharedWithClient) {
        logger.info(`[GrantAccess] Cliente convidado não encontrado por email '${clientEmailForLookup}' ou telefone '${clientPhoneForLookup}'. Criando novo Client...`);
        const newClientDataForSharedWith = {
            name: sharedWithClientName || (clientEmailForLookup ? clientEmailForLookup.split('@')[0] : `Convidado ${clientPhoneForLookup || Date.now()}`),
            status: 'Ativo', // Cliente convidado é criado como ativo
            phone: clientPhoneForLookup, // Pode ser null se o convite for só por email
            email: clientEmailForLookup, // Pode ser null se o convite for só por telefone
            passwordHash: null, // Novo client criado por compartilhamento não tem senha principal definida por este fluxo
        };
        // Garante que pelo menos um identificador principal (email ou phone) exista para o Client
        if (!newClientDataForSharedWith.phone && !newClientDataForSharedWith.email) {
             const error = new Error('Para criar um novo usuário convidado, é necessário pelo menos um email ou telefone principal.');
             error.statusCode = 400; error.status = 'fail'; throw error;
        }
         // Verifica se o telefone principal já existe em outro Client
        if (newClientDataForSharedWith.phone) {
            const existingClientByMainPhone = await Client.findOne({ where: { phone: newClientDataForSharedWith.phone }, transaction: t });
            if (existingClientByMainPhone) {
                const error = new Error(`O telefone principal '${newClientDataForSharedWith.phone}' já está cadastrado para outro usuário. Use um telefone diferente para o convidado.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        // Verifica se o email principal já existe em outro Client
        if (newClientDataForSharedWith.email) {
            const existingClientByMainEmail = await Client.findOne({ where: { email: newClientDataForSharedWith.email }, transaction: t });
            if (existingClientByMainEmail) {
                const error = new Error(`O email principal '${newClientDataForSharedWith.email}' já está cadastrado para outro usuário. Use um email diferente para o convidado.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }

        sharedWithClient = await Client.create(newClientDataForSharedWith, { transaction: t });
        logger.info(`[GrantAccess] Novo Client (ID ${sharedWithClient.id}) criado para receber acesso compartilhado. Email: ${sharedWithClient.email}, Tel: ${sharedWithClient.phone}.`);
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
    
    // Verifica se um compartilhamento IDÊNTICO (mesmo owner, mesmo guest, mesmo target) já existe
    const existingIdenticalShare = await SharedAccess.findOne({
        where: {
            ownerClientId,
            sharedWithClientId: sharedWithClient.id,
            canAccessPersonalProfile: !!canAccessPersonalProfile, // Garante booleano
            canAccessBusinessProfileId: effectiveBusinessProfileId // Pode ser null
        },
        transaction: t
    });
    if (existingIdenticalShare) {
        const error = new Error(`O acesso a ${accessTargetDescription} já foi compartilhado com este usuário.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }


    // Credenciais para o REGISTRO SharedAccess (identificadores específicos para este login compartilhado)
    let saEmailToSaveForSharedAccessRecord = null;
    if (sharedAccessEmail && String(sharedAccessEmail).trim() !== '') {
        saEmailToSaveForSharedAccessRecord = sharedAccessEmail.toLowerCase().trim();
        const existingSharedAccessBySpecificEmail = await SharedAccess.findOne({
            where: { sharedAccessEmail: saEmailToSaveForSharedAccessRecord },
            transaction: t
        });
        if (existingSharedAccessBySpecificEmail) {
            const error = new Error(`O "Email de Login para este Acesso" (${sharedAccessEmail}) já está em uso em outro compartilhamento. Escolha um email único para este acesso específico.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    let saPhoneToSaveForSharedAccessRecord = null;
    if (sharedAccessPhone && String(sharedAccessPhone).trim() !== '') {
        saPhoneToSaveForSharedAccessRecord = sharedAccessPhone.replace(/\D/g, '');
        const existingSharedAccessBySpecificPhone = await SharedAccess.findOne({
            where: { sharedAccessPhone: saPhoneToSaveForSharedAccessRecord },
            transaction: t
        });
        if (existingSharedAccessBySpecificPhone) {
            const error = new Error(`O "Telefone para WhatsApp deste Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento. Escolha um telefone único para este acesso específico.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    // Pelo menos um identificador (email ou telefone) específico para o SharedAccess é necessário
    if (!saEmailToSaveForSharedAccessRecord && !saPhoneToSaveForSharedAccessRecord) {
        const error = new Error('É obrigatório fornecer um Email ou um Telefone para WhatsApp para identificar este acesso compartilhado (pode ser diferente do email/telefone principal do convidado).');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const newSharedAccessRecordData = {
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: effectiveBusinessProfileId,
      sharedAccessEmail: saEmailToSaveForSharedAccessRecord,
      sharedAccessPhone: saPhoneToSaveForSharedAccessRecord,
      sharedAccessPasswordHash: sharedAccessPassword, // Hook do SharedAccess vai hashear
      status: 'Ativo', // O convite é criado como ativo
    };

    const newSharedAccess = await SharedAccess.create(newSharedAccessRecordData, { transaction: t });

    await t.commit();
    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id}. SharedAccess ID: ${newSharedAccess.id}. Login SA: Email=${newSharedAccess.sharedAccessEmail}, Tel=${newSharedAccess.sharedAccessPhone}`);

    // Retorna o SharedAccess com as associações para o controller
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
            where: {}, // Inicializa where para sharedWithClient
            required: true // Garante que o Client convidado exista
        };

        if (guestIdentifier) {
            const guestIdLower = guestIdentifier.toLowerCase();
            const guestPhoneNorm = guestIdentifier.replace(/\D/g, '');
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
                    // Se o include for opcional (canAccessBusinessProfileId pode ser null)
                    required: false
                },
                // Incluir o ownerClient para pegar os financialAccounts dele e popular na resposta
                 { model: Client, as: 'ownerClient', attributes:['id'], include: [
                     {model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType']}
                 ]}
            ],
            limit: parseInt(limit, 10),
            offset,
            order: [['createdAt', 'DESC']],
            distinct: true // Importante quando usando includes com 'where'
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
                    include: [ // Inclui as contas do dono para referência no frontend
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
        const saPhoneNorm = sharedAccessPhone ? sharedAccessPhone.replace(/\D/g, '') : null;
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
        filteredUpdateData.sharedAccessPasswordHash = sharedAccessPassword; // Hook hasheará
    } else if (sharedAccessPassword === null || sharedAccessPassword === '') { // Permitir limpar a senha do SA
        filteredUpdateData.sharedAccessPasswordHash = null;
    }


    if (canAccessPersonalProfile !== undefined) {
        filteredUpdateData.canAccessPersonalProfile = !!canAccessPersonalProfile;
    }
    if (canAccessBusinessProfileId !== undefined) { // Permite null
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
    
    // Se o resultado da atualização for nenhum email e nenhum telefone para o SA, e uma senha ainda estiver presente, é um erro.
    const finalSharedAccessEmail = filteredUpdateData.hasOwnProperty('sharedAccessEmail') ? filteredUpdateData.sharedAccessEmail : sharedAccess.sharedAccessEmail;
    const finalSharedAccessPhone = filteredUpdateData.hasOwnProperty('sharedAccessPhone') ? filteredUpdateData.sharedAccessPhone : sharedAccess.sharedAccessPhone;
    const finalSharedAccessPasswordHash = filteredUpdateData.hasOwnProperty('sharedAccessPasswordHash') ? filteredUpdateData.sharedAccessPasswordHash : sharedAccess.sharedAccessPasswordHash;

    if (finalSharedAccessPasswordHash && !finalSharedAccessEmail && !finalSharedAccessPhone) {
        const error = new Error('Não é possível ter uma senha para o acesso compartilhado sem um Email ou Telefone específico para este acesso.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }


    if (Object.keys(filteredUpdateData).length === 0) {
        await t.rollback(); // Rollback pois nada será alterado
        logger.info(`Nenhum campo válido para atualizar para SharedAccess ID ${sharedAccessId}.`);
        // Retornar o objeto original já com includes
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
    // Retorna o SharedAccess atualizado com as associações para o controller
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

// >>>>> NOVA FUNÇÃO ADICIONADA <<<<<
/**
 * Encontra um registro de SharedAccess ativo pelo telefone específico do compartilhamento.
 * Usado pelo whatsapp.service para identificar se uma mensagem veio de um acesso compartilhado.
 * @param {string} sharedPhone - O número de telefone normalizado do SharedAccess.
 * @returns {Promise<object|null>} O registro SharedAccess encontrado (com includes) ou null.
 */
async function findActiveSharedAccessByPhone(sharedPhone) {
    if (!sharedPhone) return null;
    try {
        const sharedAccess = await SharedAccess.findOne({
            where: {
                sharedAccessPhone: sharedPhone,
                status: 'Ativo'
            },
            include: [
                {
                    model: Client,
                    as: 'ownerClient',
                    attributes: ['id', 'name', 'email', 'status', 'accessLevel', 'accessExpiresAt'],
                    // Inclui as contas do dono para que o whatsapp.service possa determinar quais são acessíveis
                    include: [{model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType', 'isDefault', 'isActive']}]
                },
                {
                    model: Client,
                    as: 'sharedWithClient', // Este é o "ator"
                    attributes: ['id', 'name', 'email', 'phone', 'status']
                },
                {
                    model: FinancialAccount,
                    as: 'accessibleBusinessProfile', // Se o acesso for para um perfil PJ/MEI específico
                    attributes: ['id', 'accountName', 'accountType'],
                    required: false
                }
            ]
        });
        return sharedAccess; // Retorna a instância do Sequelize ou null
    } catch (error) {
        logger.error(`[SharedAccessService] Erro ao buscar SharedAccess por telefone ${sharedPhone}: ${error.message}`, error);
        return null; // Em caso de erro, assume que não encontrou para não quebrar o fluxo do WhatsApp
    }
}

// >>>>> NOVA FUNÇÃO ADICIONADA <<<<<
/**
 * Responde a um convite de acesso compartilhado.
 * @param {number} sharedWithClientId - ID do cliente que está respondendo (o convidado).
 * @param {number} sharedAccessId - ID do registro SharedAccess (o convite).
 * @param {string} response - 'aceitar' ou 'recusar'.
 * @returns {Promise<object>} O registro SharedAccess atualizado.
 */
async function respondToInvite(sharedWithClientId, sharedAccessId, response) {
    const t = await sequelize.transaction();
    try {
        const invite = await SharedAccess.findOne({
            where: {
                id: sharedAccessId,
                sharedWithClientId: sharedWithClientId,
                status: 'Pendente' // Só pode responder a convites pendentes
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
            newStatus = 'Inativo'; // Ou um status 'Recusado' se preferir
        } else {
            await t.rollback();
            const error = new Error("Resposta inválida. Use 'aceitar' ou 'recusar'.");
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        await invite.update({ status: newStatus }, { transaction: t });
        await t.commit();

        logger.info(`Cliente ID ${sharedWithClientId} ${response === 'aceitar' ? 'aceitou' : 'recusou'} o convite de acesso compartilhado ID ${sharedAccessId}. Novo status: ${newStatus}.`);
        // Retorna o SharedAccess atualizado com as associações para o controller/serviço
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
  findActiveSharedAccessByPhone, // <<< EXPORTAR A NOVA FUNÇÃO
  getSharedAccessById,           // <<< EXPORTAR ESTA FUNÇÃO
  respondToInvite,               // <<< EXPORTAR ESTA FUNÇÃO
};
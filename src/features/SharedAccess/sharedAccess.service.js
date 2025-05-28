// src/features/SharedAccess/sharedAccess.service.js
const { SharedAccess, Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');

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

    const ownerClient = await Client.findByPk(ownerClientId, { transaction: t });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    let sharedWithClient;
    // Identificadores para encontrar/criar o Client que recebe o acesso
    const clientEmailForLookup = sharedAccessEmail ? sharedAccessEmail.toLowerCase().trim() : null;
    const clientPhoneForLookup = sharedAccessPhone ? sharedAccessPhone.replace(/\D/g, '') : null;

    if (clientEmailForLookup) {
        sharedWithClient = await Client.findOne({ where: { email: clientEmailForLookup }, transaction: t });
    }
    if (!sharedWithClient && clientPhoneForLookup) {
        sharedWithClient = await Client.findOne({ where: { phone: clientPhoneForLookup }, transaction: t });
    }

    if (!sharedWithClient) {
        // Cria um novo Client se não encontrado.
        // IMPORTANTE: Este novo Client NÃO terá a sharedAccessPassword como sua senha principal.
        // A sharedAccessPassword é para o registro SharedAccess.
        const newClientDataForSharedWith = {
            name: sharedWithClientName || (clientEmailForLookup ? clientEmailForLookup.split('@')[0] : clientPhoneForLookup),
            status: 'Ativo',
            phone: null, // Será preenchido abaixo se clientPhoneForLookup existir
            email: null, // Será preenchido abaixo se clientEmailForLookup existir
            passwordHash: null, // Novo client criado por compartilhamento não tem senha principal definida por este fluxo
        };

        if (clientEmailForLookup) {
            const existingByEmail = await Client.findOne({ where: { email: clientEmailForLookup }, transaction: t });
            if (existingByEmail) { // Deve ter sido pego acima, mas segurança extra
                 sharedWithClient = existingByEmail; // Usa o existente
            } else {
                newClientDataForSharedWith.email = clientEmailForLookup;
            }
        }

        if (clientPhoneForLookup) {
            if (sharedWithClient && sharedWithClient.phone && sharedWithClient.phone !== clientPhoneForLookup) {
                // Encontrou por email, mas o telefone é diferente do que já existe no client.
                // Isso é um cenário complexo: o email já existe, mas o telefone do form é outro.
                // O que fazer? Por ora, vamos priorizar o email. Se o telefone do form não bater com o do client encontrado,
                // não vamos setar no Client. O sharedAccessPhone no SharedAccess pode ser diferente.
                logger.warn(`[GrantAccess] Cliente encontrado por email ${clientEmailForLookup}, mas telefone fornecido (${clientPhoneForLookup}) difere do telefone existente do cliente (${sharedWithClient.phone}). Telefone principal do cliente não será alterado.`);
            } else if (!sharedWithClient) { // Se não achou por email, e agora estamos verificando/criando por telefone
                const existingByPhone = await Client.findOne({ where: { phone: clientPhoneForLookup }, transaction: t });
                if (existingByPhone) {
                    sharedWithClient = existingByPhone; // Usa o existente
                } else {
                    newClientDataForSharedWith.phone = clientPhoneForLookup;
                }
            }
        }
        
        // Se sharedWithClient ainda é null, significa que não foi encontrado nem por email nem por telefone,
        // então podemos criar um novo Client com os dados coletados.
        if (!sharedWithClient) {
            if (!newClientDataForSharedWith.phone) { // O modelo Client exige 'phone'
                 const error = new Error('Telefone é obrigatório para criar uma nova conta de usuário convidado, mesmo que seja via email.');
                 error.statusCode = 400; error.status = 'fail'; throw error;
            }
            sharedWithClient = await Client.create(newClientDataForSharedWith, { transaction: t });
            logger.info(`Novo Client (ID ${sharedWithClient.id}) criado (sem senha principal) para receber acesso compartilhado.`);
        }
    }


    if (sharedWithClient.id === ownerClientId) {
        const error = new Error('Você não pode compartilhar o acesso consigo mesmo.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    let effectiveBusinessProfileId = null;
    if (canAccessBusinessProfileId) {
        if (String(canAccessBusinessProfileId).trim() === '' || canAccessBusinessProfileId === 'null' || canAccessBusinessProfileId === undefined) {
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

    const existingShareConditions = {
        ownerClientId,
        sharedWithClientId: sharedWithClient.id,
        canAccessBusinessProfileId: effectiveBusinessProfileId
    };
    if (canAccessPersonalProfile && !effectiveBusinessProfileId) {
        existingShareConditions.canAccessPersonalProfile = true;
    }

    const existingShare = await SharedAccess.findOne({ where: existingShareConditions, transaction: t });
    if (existingShare) {
        let profileDesc = canAccessPersonalProfile ? "pessoal" : (effectiveBusinessProfileId ? `de negócio ID ${effectiveBusinessProfileId}` : "específico");
        const error = new Error(`O acesso ao perfil ${profileDesc} já foi compartilhado com este usuário.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    // Credenciais para o REGISTRO SharedAccess
    let saEmailToSaveForSharedAccessRecord = null;
    if (sharedAccessEmail && String(sharedAccessEmail).trim() !== '') { // Email do formulário
        saEmailToSaveForSharedAccessRecord = sharedAccessEmail.toLowerCase().trim();
        const existingSharedAccessByEmail = await SharedAccess.findOne({ where: { sharedAccessEmail: saEmailToSaveForSharedAccessRecord }, transaction: t });
        if (existingSharedAccessByEmail) {
            const error = new Error(`O "Email de Login para este Acesso" (${sharedAccessEmail}) já está em uso em outro compartilhamento.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    let saPhoneToSaveForSharedAccessRecord = null;
    if (sharedAccessPhone && String(sharedAccessPhone).trim() !== '') { // Telefone do formulário
        saPhoneToSaveForSharedAccessRecord = sharedAccessPhone.replace(/\D/g, '');
        const existingSharedAccessByPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneToSaveForSharedAccessRecord }, transaction: t });
        if (existingSharedAccessByPhone) {
            const error = new Error(`O "Telefone para WhatsApp deste Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    if (!saEmailToSaveForSharedAccessRecord && !saPhoneToSaveForSharedAccessRecord) {
        const error = new Error('É obrigatório fornecer um Email ou um Telefone para WhatsApp para identificar este acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    let saPasswordHashToSave = null; // Para o SharedAccess
    if (sharedAccessPassword) {
        saPasswordHashToSave = sharedAccessPassword; // Hook do SharedAccess vai hashear
    } else { // Senha é obrigatória para o SharedAccess
        const error = new Error('Senha é obrigatória para o acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const newSharedAccessRecordData = {
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: effectiveBusinessProfileId,
      sharedAccessEmail: saEmailToSaveForSharedAccessRecord,
      sharedAccessPhone: saPhoneToSaveForSharedAccessRecord,
      sharedAccessPasswordHash: saPasswordHashToSave, // Senha para o SharedAccess
      status: 'Ativo',
    };

    const newSharedAccess = await SharedAccess.create(newSharedAccessRecordData, { transaction: t });

    await t.commit();
    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id} (Client principal: ${sharedWithClient.email}/${sharedWithClient.phone}). SharedAccess ID: ${newSharedAccess.id}. Creds SA: Email=${newSharedAccess.sharedAccessEmail}, Tel=${newSharedAccess.sharedAccessPhone}`);

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

// ... (getSharedAccessesByOwner, getSharedAccessesForUser, updateSharedAccess, revokeAccess permanecem os mesmos)
async function getSharedAccessesByOwner(ownerClientId, queryParams = {}) {
    try {
        const { page = 1, limit = 10, status } = queryParams;
        const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const whereConditions = { ownerClientId };
        if (status) whereConditions.status = status;

        const { count, rows } = await SharedAccess.findAndCountAll({
            where: whereConditions,
            include: [
                { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'] }
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
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'] }
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
      //sharedWithClientName, // Não é campo do SharedAccess
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
            if (saEmailLower) {
                const existingSharedEmail = await SharedAccess.findOne({ where: { sharedAccessEmail: saEmailLower, id: {[Op.ne]: sharedAccessId } }, transaction: t });
                if (existingSharedEmail) {
                    const error = new Error(`O "Email para Login deste Acesso" (${sharedAccessEmail}) já está em uso.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            filteredUpdateData.sharedAccessEmail = saEmailLower === '' ? null : saEmailLower;
        }
    }

    if (sharedAccessPhone !== undefined) {
        const saPhoneNorm = sharedAccessPhone ? sharedAccessPhone.replace(/\D/g, '') : null;
        if (saPhoneNorm !== sharedAccess.sharedAccessPhone) {
            if (saPhoneNorm) {
                const existingSharedPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneNorm, id: {[Op.ne]: sharedAccessId } }, transaction: t });
                if (existingSharedPhone) {
                    const error = new Error(`O "Telefone WhatsApp para este Acesso" (${sharedAccessPhone}) já está em uso.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            filteredUpdateData.sharedAccessPhone = saPhoneNorm === '' ? null : saPhoneNorm;
        }
    }

    if (sharedAccessPassword) {
        filteredUpdateData.sharedAccessPasswordHash = sharedAccessPassword;
    }

    if (canAccessPersonalProfile !== undefined) {
        filteredUpdateData.canAccessPersonalProfile = !!canAccessPersonalProfile;
    }
    if (canAccessBusinessProfileId !== undefined) {
        filteredUpdateData.canAccessBusinessProfileId = (canAccessBusinessProfileId === null || String(canAccessBusinessProfileId).trim() === '') ? null : parseInt(canAccessBusinessProfileId,10);
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

    if (filteredUpdateData.hasOwnProperty('sharedAccessPasswordHash') && filteredUpdateData.sharedAccessPasswordHash) {
        if (!finalSharedAccessEmail && !finalSharedAccessPhone) {
            await t.rollback(); 
            const error = new Error('Não é possível definir uma senha para o acesso compartilhado sem um Email ou Telefone específico para este acesso.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }


    if (Object.keys(filteredUpdateData).length === 0) {
        await t.rollback();
        logger.info(`Nenhum campo válido para atualizar para SharedAccess ID ${sharedAccessId}.`);
        return sharedAccess.toJSON();
    }

    await sharedAccess.update(filteredUpdateData, { transaction: t });
    await t.commit();
    logger.info(`Acesso compartilhado ID ${sharedAccessId} atualizado.`);
    return SharedAccess.findByPk(sharedAccessId, {
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
            { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'] }
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

module.exports = {
  grantAccess,
  getSharedAccessesByOwner,
  getSharedAccessesForUser,
  updateSharedAccess,
  revokeAccess,
};
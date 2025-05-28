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
    // Ao criar, a senha é obrigatória se um email/telefone específico para o acesso for fornecido
    if ((sharedAccessEmail || sharedAccessPhone) && !sharedAccessPassword) {
        const error = new Error('Senha para o acesso compartilhado é obrigatória ao definir um email ou telefone específico para o acesso.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }


    const ownerClient = await Client.findByPk(ownerClientId, { transaction: t });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    let sharedWithClient;
    const identifierForClientLookup = sharedAccessEmail ? sharedAccessEmail.toLowerCase() : sharedAccessPhone.replace(/\D/g, '');
    const isEmailForLookup = !!sharedAccessEmail;

    if (isEmailForLookup) {
        sharedWithClient = await Client.findOne({ where: { email: identifierForClientLookup }, transaction: t });
    } else {
        sharedWithClient = await Client.findOne({ where: { phone: identifierForClientLookup }, transaction: t });
    }

    if (!sharedWithClient) {
        const newClientDataForSharedWith = {
            name: sharedWithClientName || (isEmailForLookup ? identifierForClientLookup.split('@')[0] : identifierForClientLookup),
            status: 'Ativo',
        };
        if (isEmailForLookup) newClientDataForSharedWith.email = identifierForClientLookup;
        else newClientDataForSharedWith.phone = identifierForClientLookup;

        if (newClientDataForSharedWith.email) {
            const existingByEmail = await Client.findOne({ where: { email: newClientDataForSharedWith.email }, transaction: t });
            if (existingByEmail) {
                 const error = new Error(`O email ${newClientDataForSharedWith.email} já está registrado por outro usuário. Peça para o convidado usar seu login principal ou forneça um email/telefone diferente para este acesso.`);
                 error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        if (newClientDataForSharedWith.phone) {
            const existingByPhone = await Client.findOne({ where: { phone: newClientDataForSharedWith.phone }, transaction: t });
            if (existingByPhone) {
                const error = new Error(`O telefone ${newClientDataForSharedWith.phone} já está registrado por outro usuário. Peça para o convidado usar seu login principal ou forneça um email/telefone diferente para este acesso.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        sharedWithClient = await Client.create(newClientDataForSharedWith, { transaction: t });
        logger.info(`Novo Client (ID ${sharedWithClient.id}) criado para receber acesso compartilhado (identificado por: ${identifierForClientLookup}).`);
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
        const error = new Error(`O acesso ao perfil ${profileDesc} já foi compartilhado com o usuário identificado por "${identifierForClientLookup}".`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    let saEmailToSave = null;
    if (sharedAccessEmail && String(sharedAccessEmail).trim() !== '') {
        saEmailToSave = sharedAccessEmail.toLowerCase().trim();
        const existingSharedAccessByEmail = await SharedAccess.findOne({ where: { sharedAccessEmail: saEmailToSave }, transaction: t });
        if (existingSharedAccessByEmail) {
            const error = new Error(`O "Email para Login deste Acesso" (${sharedAccessEmail}) já está em uso em outro compartilhamento.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    let saPhoneToSave = null;
    if (sharedAccessPhone && String(sharedAccessPhone).trim() !== '') {
        saPhoneToSave = sharedAccessPhone.replace(/\D/g, '');
        const existingSharedAccessByPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneToSave }, transaction: t });
        if (existingSharedAccessByPhone) {
            const error = new Error(`O "Telefone para WhatsApp deste Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    if (!saEmailToSave && !saPhoneToSave) {
        const error = new Error('É obrigatório fornecer um Email ou um Telefone para WhatsApp específico para este acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    // Senha é obrigatória SE um email ou telefone específico para o acesso foi fornecido
    let saPasswordHashToSave = null;
    if (sharedAccessPassword) { // O hook vai hashear
        saPasswordHashToSave = sharedAccessPassword;
    } else if (saEmailToSave || saPhoneToSave) { // Se tem email/tel de acesso, senha é obrigatória
        const error = new Error('Senha é obrigatória ao definir um email ou telefone específico para o acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }


    const newSharedAccessRecordData = {
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: effectiveBusinessProfileId,
      sharedAccessEmail: saEmailToSave,
      sharedAccessPhone: saPhoneToSave,
      sharedAccessPasswordHash: saPasswordHashToSave,
      status: 'Ativo',
    };

    const newSharedAccess = await SharedAccess.create(newSharedAccessRecordData, { transaction: t });

    await t.commit();
    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id}. SharedAccess ID: ${newSharedAccess.id}. Email de acesso: ${newSharedAccess.sharedAccessEmail}, Tel WhatsApp de acesso: ${newSharedAccess.sharedAccessPhone}`);

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
      sharedWithClientName,
      sharedAccessEmail,
      sharedAccessPhone,
      sharedAccessPassword,
      canAccessPersonalProfile,
      canAccessBusinessProfileId,
      status
    } = updateData;

    const filteredUpdateData = {};
    let requiresRevalidation = false;

    // Apelido não é um campo do modelo SharedAccess, então ignoramos sharedWithClientName para update direto no SharedAccess
    // Ele é usado para nomear o Client se for criado.

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
            await t.rollback(); // << Adicionado rollback
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

// CORREÇÃO: Mover module.exports para o final do arquivo
module.exports = {
  grantAccess,
  getSharedAccessesByOwner,
  getSharedAccessesForUser,
  updateSharedAccess,
  revokeAccess,
};
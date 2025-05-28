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
    if (!sharedAccessPassword) { // Senha sempre obrigatória ao criar um novo SharedAccess
        const error = new Error('Senha para o acesso compartilhado é obrigatória.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const ownerClient = await Client.findByPk(ownerClientId, { transaction: t });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    let sharedWithClient;
    // Tenta encontrar o Client primeiro pelo email (se fornecido), depois pelo telefone (se fornecido)
    // Isso ajuda se o usuário já existe com um dos identificadores.
    if (sharedAccessEmail) {
        sharedWithClient = await Client.findOne({ where: { email: sharedAccessEmail.toLowerCase() }, transaction: t });
    }
    if (!sharedWithClient && sharedAccessPhone) {
        sharedWithClient = await Client.findOne({ where: { phone: sharedAccessPhone.replace(/\D/g, '') }, transaction: t });
    }

    if (!sharedWithClient) {
        // Cria um novo Client se não encontrado por nenhum dos identificadores
        const newClientDataForSharedWith = {
            name: sharedWithClientName || (sharedAccessEmail ? sharedAccessEmail.split('@')[0] : sharedAccessPhone.replace(/\D/g, '')),
            status: 'Ativo',
            phone: null, // Inicializa como null
            email: null  // Inicializa como null
        };

        // Preenche email e telefone e valida unicidade
        if (sharedAccessEmail) {
            const emailToCreate = sharedAccessEmail.toLowerCase().trim();
            const existingByEmail = await Client.findOne({ where: { email: emailToCreate }, transaction: t });
            if (existingByEmail) {
                 const error = new Error(`O email ${emailToCreate} já está registrado por outro usuário. Peça para o convidado usar seu login principal ou forneça um email diferente para este acesso.`);
                 error.statusCode = 409; error.status = 'fail'; throw error;
            }
            newClientDataForSharedWith.email = emailToCreate;
        }

        if (sharedAccessPhone) {
            const phoneToCreate = sharedAccessPhone.replace(/\D/g, '');
            // Client.phone é NOT NULL, então precisa ter um valor se formos criar
            if (!phoneToCreate) { // Deveria ter sido pego pela validação inicial, mas segurança extra
                const error = new Error('Telefone para WhatsApp do convidado é inválido ou não fornecido, e é necessário para criar um novo Client.');
                error.statusCode = 400; error.status = 'fail'; throw error;
            }
            const existingByPhone = await Client.findOne({ where: { phone: phoneToCreate }, transaction: t });
            if (existingByPhone) {
                const error = new Error(`O telefone ${phoneToCreate} já está registrado por outro usuário. Peça para o convidado usar seu login principal ou forneça um telefone diferente para este acesso.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
            newClientDataForSharedWith.phone = phoneToCreate;
        }
        
        // Modelo Client exige 'phone'. Se 'sharedAccessPhone' não foi fornecido, mas 'sharedAccessEmail' foi,
        // e estamos criando um novo Client, precisamos de um 'phone'.
        // A lógica atual do modal do frontend torna 'sharedAccessPhone' obrigatório, então isso não deve ser um problema.
        // Se 'sharedAccessEmail' também for obrigatório no modal junto com 'sharedAccessPhone', melhor ainda.
        // O erro atual indica que 'phone' não pode ser null. Vamos garantir que ele seja pego do 'sharedAccessPhone'.
        if (!newClientDataForSharedWith.phone && sharedAccessPhone) { // Caso a lógica acima não pegue
             newClientDataForSharedWith.phone = sharedAccessPhone.replace(/\D/g, '');
        }
        if (!newClientDataForSharedWith.phone) { // Se AINDA não tem telefone, e é um novo Client, isso é um erro.
            const error = new Error('Telefone é obrigatório para criar uma nova conta de usuário convidado.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }


        sharedWithClient = await Client.create(newClientDataForSharedWith, { transaction: t });
        logger.info(`Novo Client (ID ${sharedWithClient.id}) criado para receber acesso compartilhado (identificado por: ${sharedAccessEmail || sharedAccessPhone}).`);
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
        const error = new Error(`O acesso ao perfil ${profileDesc} já foi compartilhado com o usuário (${sharedAccessEmail || sharedAccessPhone}).`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    let saEmailToSave = null;
    if (sharedAccessEmail && String(sharedAccessEmail).trim() !== '') {
        saEmailToSave = sharedAccessEmail.toLowerCase().trim();
        const existingSharedAccessByEmail = await SharedAccess.findOne({ where: { sharedAccessEmail: saEmailToSave }, transaction: t });
        if (existingSharedAccessByEmail) {
            const error = new Error(`O "Email de Login para este Acesso" (${sharedAccessEmail}) já está em uso em outro compartilhamento.`);
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
    
    let saPasswordHashToSave = null;
    if (sharedAccessPassword) {
        saPasswordHashToSave = sharedAccessPassword; // Hook vai hashear
    } else { // Senha é obrigatória para o acesso compartilhado
        const error = new Error('Senha é obrigatória para o acesso compartilhado.');
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
    if (!error.statusCode) error.statusCode = 500; // Erros não tratados explicitamente
    throw error;
  }
}

// ... (resto do arquivo sharedAccess.service.js - getSharedAccessesByOwner, etc. - permanece o mesmo)
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
      sharedWithClientName, // Este é o apelido
      sharedAccessEmail,    // Email ESPECÍFICO para ESTE acesso
      sharedAccessPhone,    // Telefone WhatsApp ESPECÍFICO para ESTE acesso
      sharedAccessPassword, // Nova senha ESPECÍFICA para ESTE acesso
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
        await t.rollback(); // << Mudança: rollback se nada para atualizar
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
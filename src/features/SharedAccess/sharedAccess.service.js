// src/features/SharedAccess/sharedAccess.service.js
const { SharedAccess, Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

async function grantAccess(ownerClientId, grantData) {
  const t = await sequelize.transaction();
  try {
    const {
      sharedWithEmail, sharedWithPhone,
      sharedWithClientName, // Apelido para UI, não nome principal do Client
      sharedAccessPassword,
      sharedAccessSpecificPhone, // Telefone para este acesso
      sharedAccessEmail: specificSharedAccessEmail, // Email específico para este acesso, vindo do grantData
      canAccessPersonalProfile,
      canAccessBusinessProfileId
    } = grantData;

    if (!sharedWithEmail && !sharedWithPhone) {
        const error = new Error('É necessário fornecer o email ou telefone do usuário para compartilhar o acesso.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const ownerClient = await Client.findByPk(ownerClientId, { transaction: t });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    let sharedWithClient;
    if (sharedWithEmail) {
        sharedWithClient = await Client.findOne({ where: { email: sharedWithEmail.toLowerCase() }, transaction: t });
    } else if (sharedWithPhone) {
        sharedWithClient = await Client.findOne({ where: { phone: sharedWithPhone.replace(/\D/g, '') }, transaction: t });
    }

    if (!sharedWithClient) {
        const newClientData = {};
        if (sharedWithEmail) newClientData.email = sharedWithEmail.toLowerCase();
        if (sharedWithPhone) newClientData.phone = sharedWithPhone.replace(/\D/g, '');
        newClientData.name = sharedWithClientName || (sharedWithEmail ? sharedWithEmail.split('@')[0] : sharedWithPhone);
        newClientData.status = 'Ativo';

        if (newClientData.email) {
            const existingByEmail = await Client.findOne({ where: { email: newClientData.email }, transaction: t });
            if (existingByEmail) {
                 const error = new Error(`O email ${newClientData.email} já está registrado por outro usuário.`);
                 error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        if (newClientData.phone) {
            const existingByPhone = await Client.findOne({ where: { phone: newClientData.phone }, transaction: t });
            if (existingByPhone) {
                const error = new Error(`O telefone ${newClientData.phone} já está registrado por outro usuário.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        sharedWithClient = await Client.create(newClientData, { transaction: t });
        logger.info(`Novo Client (ID ${sharedWithClient.id}) criado para receber acesso compartilhado.`);
    }

    if (sharedWithClient.id === ownerClientId) {
        const error = new Error('Você não pode compartilhar o acesso consigo mesmo.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    let effectiveBusinessProfileId = null;
    if (canAccessBusinessProfileId) {
        if (String(canAccessBusinessProfileId).trim() === '' || canAccessBusinessProfileId === 'null') {
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
        // canAccessBusinessProfileId já é null se effectiveBusinessProfileId for null
    }

    const existingShare = await SharedAccess.findOne({ where: existingShareConditions, transaction: t });
    if (existingShare) {
        let profileDesc = canAccessPersonalProfile ? "pessoal" : (effectiveBusinessProfileId ? `de negócio ID ${effectiveBusinessProfileId}` : "específico");
        const error = new Error(`O acesso ao perfil ${profileDesc} já foi compartilhado com ${sharedWithClient.email || sharedWithClient.phone}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    const specificAccessCredentials = {
        sharedAccessEmail: null, // Garante que começa como null
        sharedAccessPhone: null, // Garante que começa como null
        sharedAccessPasswordHash: null
    };

    // Usa specificSharedAccessEmail do grantData se existir
    if (specificSharedAccessEmail && String(specificSharedAccessEmail).trim() !== '') {
        const saEmailLower = specificSharedAccessEmail.toLowerCase().trim();
        const existingSharedEmail = await SharedAccess.findOne({ where: { sharedAccessEmail: saEmailLower }, transaction: t });
        if (existingSharedEmail) {
            const error = new Error(`O email de acesso compartilhado "${specificSharedAccessEmail}" já está em uso.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        specificAccessCredentials.sharedAccessEmail = saEmailLower;
    }

    if (sharedAccessSpecificPhone && String(sharedAccessSpecificPhone).trim() !== '') {
        const saPhoneNorm = sharedAccessSpecificPhone.replace(/\D/g, '');
        const existingSharedPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneNorm }, transaction: t });
        if (existingSharedPhone) {
            const error = new Error(`O telefone de acesso compartilhado "${sharedAccessSpecificPhone}" já está em uso.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        specificAccessCredentials.sharedAccessPhone = saPhoneNorm;
    }

    // Senha é obrigatória apenas se um email OU telefone específico para o acesso for fornecido
    if ((specificAccessCredentials.sharedAccessEmail || specificAccessCredentials.sharedAccessPhone)) {
        if (!sharedAccessPassword) {
            const error = new Error('Senha é obrigatória se um email ou telefone específico para o acesso compartilhado for fornecido.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        specificAccessCredentials.sharedAccessPasswordHash = sharedAccessPassword;
    } else if (sharedAccessPassword) {
        // Se senha foi fornecida mas nem email nem telefone específico para o acesso, isso é um erro de lógica/UI.
        // O usuário compartilhado usaria suas próprias credenciais (email/senha do Client principal)
        // e a autorização seria verificada pela tabela SharedAccess.
        // Neste modelo, estamos permitindo credenciais separadas para o acesso.
        logger.warn("[SERVICE GRANT ACCESS] Senha fornecida para acesso compartilhado, mas nem email nem telefone específico para o acesso foram definidos. A senha não será usada para login direto neste compartilhamento a menos que um identificador (email/tel) seja fornecido para ele.");
        // Para o modelo atual (com sharedAccessEmail/Phone/PasswordHash opcionais no SharedAccess),
        // podemos deixar passar ou lançar um erro se a UI não deveria permitir isso.
        // Por ora, se não há sharedAccessEmail/Phone, sharedAccessPasswordHash não terá como ser usado.
        // O hook vai hashear, mas o campo será null se não tiver email/phone específico
    }


    const newSharedAccess = await SharedAccess.create({
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: effectiveBusinessProfileId,
      sharedAccessEmail: specificAccessCredentials.sharedAccessEmail, // Passando o valor correto
      sharedAccessPasswordHash: specificAccessCredentials.sharedAccessPasswordHash,
      sharedAccessPhone: specificAccessCredentials.sharedAccessPhone,
      status: 'Ativo',
    }, { transaction: t });

    await t.commit();
    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id}. SharedAccess ID: ${newSharedAccess.id}`);
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

// ... (o resto do sharedAccess.service.js permanece o mesmo) ...
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

    const allowedUpdates = ['canAccessPersonalProfile', 'canAccessBusinessProfileId', 'status', 'sharedAccessSpecificPhone', 'sharedAccessPassword']; // Adicionado sharedAccessSpecificPhone e sharedAccessPassword
    const filteredUpdateData = {};
    let requiresRevalidation = false;

    for (const key of allowedUpdates) {
      if (updateData.hasOwnProperty(key)) {
        if (key === 'canAccessBusinessProfileId') {
            filteredUpdateData[key] = (updateData[key] === null || updateData[key] === undefined || String(updateData[key]).trim() === '') ? null : parseInt(updateData[key],10);
            requiresRevalidation = true;
        } else if (key === 'sharedAccessPassword' && updateData[key]) { // Se a senha está sendo atualizada
            filteredUpdateData.sharedAccessPasswordHash = updateData[key]; // O hook fará o hash
        } else if (key !== 'sharedAccessPassword') { // Não adiciona sharedAccessPassword diretamente
            filteredUpdateData[key] = updateData[key];
        }
      }
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
    // Validação de unicidade para sharedAccessSpecificPhone se estiver sendo alterado
    if (filteredUpdateData.hasOwnProperty('sharedAccessSpecificPhone')) {
        if (filteredUpdateData.sharedAccessSpecificPhone && String(filteredUpdateData.sharedAccessSpecificPhone).trim() !== '') {
            const saPhoneNorm = String(filteredUpdateData.sharedAccessSpecificPhone).replace(/\D/g, '');
            const existingSharedPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneNorm, id: {[Op.ne]: sharedAccessId } }, transaction: t });
            if (existingSharedPhone) {
                const error = new Error(`O telefone de acesso compartilhado "${filteredUpdateData.sharedAccessSpecificPhone}" já está em uso por outro compartilhamento.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
            filteredUpdateData.sharedAccessPhone = saPhoneNorm; // Usa a chave correta do modelo
        } else {
            filteredUpdateData.sharedAccessPhone = null; // Define como null se enviado vazio
        }
        delete filteredUpdateData.sharedAccessSpecificPhone; // Remove a chave temporária
    }


    if (Object.keys(filteredUpdateData).length === 0) {
        await t.rollback();
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
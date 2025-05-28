// src/features/SharedAccess/sharedAccess.service.js
const { SharedAccess, Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

async function grantAccess(ownerClientId, grantData) {
  const t = await sequelize.transaction();
  try {
    const {
      sharedWithEmail, sharedWithPhone, // Identificadores do usuário que receberá o acesso
      sharedAccessPassword, // Senha para ESTE acesso compartilhado (se login for por email/tel compartilhado)
      sharedAccessSpecificPhone, // Telefone específico para ESTE acesso compartilhado (WhatsApp)
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

    // Encontrar ou criar o Client que receberá o acesso
    let sharedWithClient;
    if (sharedWithEmail) {
        sharedWithClient = await Client.findOne({ where: { email: sharedWithEmail.toLowerCase() }, transaction: t });
    } else if (sharedWithPhone) {
        sharedWithClient = await Client.findOne({ where: { phone: sharedWithPhone.replace(/\D/g, '') }, transaction: t });
    }

    if (!sharedWithClient) {
        // Se não encontrar, cria um Client básico. O nome pode ser o email/phone por enquanto.
        // Ou pode exigir que o usuário convidado já tenha uma conta MAP (mesmo gratuita).
        // Por agora, vamos criar um Client básico.
        const newClientData = {};
        if (sharedWithEmail) newClientData.email = sharedWithEmail.toLowerCase();
        if (sharedWithPhone) newClientData.phone = sharedWithPhone.replace(/\D/g, '');
        newClientData.name = grantData.sharedWithClientName || (sharedWithEmail ? sharedWithEmail.split('@')[0] : sharedWithPhone); // Nome temporário
        newClientData.status = 'Ativo'; // Cliente convidado começa ativo

        // Verifica se o telefone/email do novo Client já não existe.
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

    // Verificar se o perfil de negócio (se fornecido) pertence ao ownerClient
    if (canAccessBusinessProfileId) {
        const businessProfile = await FinancialAccount.findOne({
            where: { id: canAccessBusinessProfileId, clientId: ownerClientId, accountType: { [Op.in]: ['PJ', 'MEI'] } },
            transaction: t
        });
        if (!businessProfile) {
            const error = new Error(`Perfil de negócio ID ${canAccessBusinessProfileId} não encontrado ou não pertence ao cliente proprietário, ou não é PJ/MEI.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
    } else if (canAccessBusinessProfileId === '' || canAccessBusinessProfileId === undefined) {
        grantData.canAccessBusinessProfileId = null; // Garante que seja null se não fornecido
    }


    // Verificar se já existe um compartilhamento para este perfil de negócio com este usuário
    const existingShareConditions = {
        ownerClientId,
        sharedWithClientId: sharedWithClient.id,
        // Se for acesso pessoal, canAccessBusinessProfileId é null
        // Se for acesso de negócio, canAccessBusinessProfileId tem valor
        canAccessBusinessProfileId: grantData.canAccessBusinessProfileId
    };
    if (grantData.canAccessPersonalProfile && !grantData.canAccessBusinessProfileId) {
        existingShareConditions.canAccessPersonalProfile = true;
        existingShareConditions.canAccessBusinessProfileId = null; // Garante
    }

    const existingShare = await SharedAccess.findOne({ where: existingShareConditions, transaction: t });
    if (existingShare) {
        let profileDesc = grantData.canAccessPersonalProfile ? "pessoal" : `de negócio ID ${grantData.canAccessBusinessProfileId}`;
        const error = new Error(`O acesso ao perfil ${profileDesc} já foi compartilhado com ${sharedWithClient.email || sharedWithClient.phone}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    // Validações para credenciais de acesso compartilhado (sharedAccessEmail/Phone)
    const specificAccessCredentials = {};
    if (grantData.sharedAccessEmail) {
        const saEmailLower = grantData.sharedAccessEmail.toLowerCase();
        const existingSharedEmail = await SharedAccess.findOne({ where: { sharedAccessEmail: saEmailLower }, transaction: t });
        if (existingSharedEmail) {
            const error = new Error(`O email de acesso compartilhado "${grantData.sharedAccessEmail}" já está em uso.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        specificAccessCredentials.sharedAccessEmail = saEmailLower;
    }
    if (sharedAccessSpecificPhone) {
        const saPhoneNorm = sharedAccessSpecificPhone.replace(/\D/g, '');
        const existingSharedPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneNorm }, transaction: t });
        if (existingSharedPhone) {
            const error = new Error(`O telefone de acesso compartilhado "${sharedAccessSpecificPhone}" já está em uso.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        specificAccessCredentials.sharedAccessPhone = saPhoneNorm;
    }

    if ((specificAccessCredentials.sharedAccessEmail || specificAccessCredentials.sharedAccessPhone) && !sharedAccessPassword) {
        const error = new Error('Senha é obrigatória se um email ou telefone específico para o acesso compartilhado for fornecido.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (sharedAccessPassword) {
        specificAccessCredentials.sharedAccessPasswordHash = sharedAccessPassword; // Hook fará o hash
    }


    const newSharedAccess = await SharedAccess.create({
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: grantData.canAccessBusinessProfileId, // Já validado
      ...specificAccessCredentials, // Email, senha, telefone específicos do acesso
      status: 'Ativo', // Ou 'Pendente' se precisar de confirmação do convidado
    }, { transaction: t });

    await t.commit();
    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id}. SharedAccess ID: ${newSharedAccess.id}`);
    // Retornar com dados dos clientes para UI
    return SharedAccess.findByPk(newSharedAccess.id, {
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email'] },
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
        // Validação se ownerClientId existe pode ser feita aqui ou presumir que veio de um token válido
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

    // Campos que podem ser atualizados pelo dono
    const allowedUpdates = ['canAccessPersonalProfile', 'canAccessBusinessProfileId', 'status'];
    const filteredUpdateData = {};
    let requiresRevalidation = false;

    for (const key of allowedUpdates) {
      if (updateData.hasOwnProperty(key)) {
        filteredUpdateData[key] = updateData[key];
        if (key === 'canAccessBusinessProfileId') requiresRevalidation = true;
      }
    }
    // Se canAccessBusinessProfileId for string vazia ou undefined, converter para null
    if (filteredUpdateData.hasOwnProperty('canAccessBusinessProfileId') && 
        (filteredUpdateData.canAccessBusinessProfileId === '' || filteredUpdateData.canAccessBusinessProfileId === undefined)) {
        filteredUpdateData.canAccessBusinessProfileId = null;
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

    if (Object.keys(filteredUpdateData).length === 0) {
        await t.rollback(); // Nenhum campo válido para atualizar
        return sharedAccess.toJSON();
    }

    await sharedAccess.update(filteredUpdateData, { transaction: t });
    await t.commit();
    logger.info(`Acesso compartilhado ID ${sharedAccessId} atualizado.`);
    return SharedAccess.findByPk(sharedAccessId, { // Recarrega para incluir associações
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email'] },
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
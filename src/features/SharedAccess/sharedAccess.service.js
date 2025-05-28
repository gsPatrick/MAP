// src/features/SharedAccess/sharedAccess.service.js
const { SharedAccess, Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs'); // Para hashear a senha do acesso compartilhado

async function grantAccess(ownerClientId, grantData) {
  const t = await sequelize.transaction();
  try {
    const {
      // Campos enviados pelo frontend MODIFICADO:
      sharedAccessEmail,         // Email para ESTE acesso compartilhado
      sharedAccessPhone,         // Telefone WhatsApp para ESTE acesso compartilhado
      sharedAccessPassword,      // Senha para ESTE acesso compartilhado
      sharedWithClientName,      // Apelido dado pelo dono ao convidado para este compartilhamento
      canAccessPersonalProfile,
      canAccessBusinessProfileId
    } = grantData;

    // Validação de entrada
    if (!sharedAccessEmail && !sharedAccessPhone) {
        const error = new Error('É necessário fornecer o Email ou o Telefone para WhatsApp para este acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!sharedAccessPassword && !editingAccessUser) { // Senha obrigatória ao criar
        const error = new Error('Senha para o acesso compartilhado é obrigatória.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }


    const ownerClient = await Client.findByPk(ownerClientId, { transaction: t });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    // Encontrar ou criar o Client que efetivamente receberá o acesso (sharedWithClientId)
    // O backend precisa de um Client real para vincular o sharedWithClientId.
    // Usaremos o sharedAccessEmail ou sharedAccessPhone (que são para o acesso)
    // para tentar encontrar/criar este Client "convidado".
    let sharedWithClient;
    const identifierForClientLookup = sharedAccessEmail ? sharedAccessEmail.toLowerCase() : sharedAccessPhone.replace(/\D/g, '');
    const isEmailForLookup = !!sharedAccessEmail;

    if (isEmailForLookup) {
        sharedWithClient = await Client.findOne({ where: { email: identifierForClientLookup }, transaction: t });
    } else {
        sharedWithClient = await Client.findOne({ where: { phone: identifierForClientLookup }, transaction: t });
    }

    if (!sharedWithClient) {
        // Cria um Client básico se não existir. O nome pode ser o apelido ou o email/phone.
        const newClientDataForSharedWith = {
            name: sharedWithClientName || (isEmailForLookup ? identifierForClientLookup.split('@')[0] : identifierForClientLookup),
            status: 'Ativo', // Cliente convidado começa ativo
        };
        if (isEmailForLookup) newClientDataForSharedWith.email = identifierForClientLookup;
        else newClientDataForSharedWith.phone = identifierForClientLookup;
        
        // Define uma senha padrão ou placeholder para este Client convidado,
        // já que ele pode querer logar na plataforma com sua própria conta Client no futuro.
        // Esta senha NÃO é a `sharedAccessPassword`.
        // O ideal seria um fluxo de "ativar conta" para ele definir a própria senha principal.
        // Por agora, se criarmos um Client, ele não terá senha principal definida aqui.
        // newClientDataForSharedWith.passwordHash = 'senha_placeholder_precisa_ser_definida_pelo_usuario';


        // Verificar se o email/telefone JÁ NÃO ESTÁ EM USO por OUTRO client, caso a busca acima falhe
        // (Ex: busca por email, não acha, mas o telefone fornecido já existe)
        if (isEmailForLookup && sharedAccessPhone) { // Se o primário foi email, mas telefone também foi dado
            const phoneForNewClient = sharedAccessPhone.replace(/\D/g, '');
            const existingByPhone = await Client.findOne({ where: { phone: phoneForNewClient }, transaction: t });
            if (existingByPhone) {
                const error = new Error(`O telefone ${sharedAccessPhone} já está registrado por outro usuário. Não é possível criar o usuário convidado com este telefone.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
            newClientDataForSharedWith.phone = phoneForNewClient;
        } else if (!isEmailForLookup && sharedAccessEmail) { // Se o primário foi telefone, mas email também foi dado
             const emailForNewClient = sharedAccessEmail.toLowerCase();
             const existingByEmail = await Client.findOne({ where: { email: emailForNewClient }, transaction: t });
             if (existingByEmail) {
                 const error = new Error(`O email ${sharedAccessEmail} já está registrado por outro usuário. Não é possível criar o usuário convidado com este email.`);
                 error.statusCode = 409; error.status = 'fail'; throw error;
             }
            newClientDataForSharedWith.email = emailForNewClient;
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
    }

    const existingShare = await SharedAccess.findOne({ where: existingShareConditions, transaction: t });
    if (existingShare) {
        let profileDesc = canAccessPersonalProfile ? "pessoal" : (effectiveBusinessProfileId ? `de negócio ID ${effectiveBusinessProfileId}` : "específico");
        const error = new Error(`O acesso ao perfil ${profileDesc} já foi compartilhado com o usuário identificado por "${identifierForClientLookup}".`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    // Validação de unicidade para os campos de acesso compartilhado (sharedAccessEmail/Phone)
    // Estes são os campos que o convidado USARÁ para este acesso.
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
    
    // Se nem email nem telefone específico para o acesso foram fornecidos, ERRO, pois precisa de um identificador para o acesso.
    if (!saEmailToSave && !saPhoneToSave) {
        const error = new Error('É obrigatório fornecer um Email ou um Telefone para WhatsApp específico para este acesso compartilhado.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const newSharedAccessRecordData = {
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: effectiveBusinessProfileId,
      sharedAccessEmail: saEmailToSave,
      sharedAccessPhone: saPhoneToSave,
      sharedAccessPasswordHash: sharedAccessPassword, // O hook vai hashear
      status: 'Ativo',
    };

    const newSharedAccess = await SharedAccess.create(newSharedAccessRecordData, { transaction: t });

    await t.commit();
    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id} (identificado por ${identifierForClientLookup}). SharedAccess ID: ${newSharedAccess.id}. Email de acesso: ${newSharedAccess.sharedAccessEmail}, Tel WhatsApp de acesso: ${newSharedAccess.sharedAccessPhone}`);
    
    return SharedAccess.findByPk(newSharedAccess.id, {
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] }, // Retorna os dados do Client vinculado
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
      // Campos que podem ser atualizados pelo dono via UI:
      sharedWithClientName, // Apelido (não afeta o Client, mas pode ser um campo no SharedAccess se desejado)
      sharedAccessEmail,    // Email ESPECÍFICO para ESTE acesso
      sharedAccessPhone,    // Telefone WhatsApp ESPECÍFICO para ESTE acesso
      sharedAccessPassword, // Nova senha ESPECÍFICA para ESTE acesso
      canAccessPersonalProfile,
      canAccessBusinessProfileId,
      status // Ativo, Inativo
    } = updateData;

    const filteredUpdateData = {};
    let requiresRevalidation = false;

    if (sharedWithClientName !== undefined) {
        // Se você decidir adicionar um campo `apelido` ao modelo SharedAccess, atualize aqui.
        // Por ora, este campo não existe no modelo SharedAccess.
        // filteredUpdateData.apelido = sharedWithClientName;
        logger.info(`[UpdateSharedAccess] Apelido "${sharedWithClientName}" recebido, mas não há campo no modelo SharedAccess para ele.`);
    }

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

    if (sharedAccessPassword) { // Se uma nova senha foi fornecida
        filteredUpdateData.sharedAccessPasswordHash = sharedAccessPassword; // Hook fará o hash
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
    // Garante que se não houver sharedAccessEmail nem sharedAccessPhone, a senha também seja nula
    // ou que pelo menos um identificador exista se uma senha for definida.
    const finalSharedAccessEmail = filteredUpdateData.hasOwnProperty('sharedAccessEmail') ? filteredUpdateData.sharedAccessEmail : sharedAccess.sharedAccessEmail;
    const finalSharedAccessPhone = filteredUpdateData.hasOwnProperty('sharedAccessPhone') ? filteredUpdateData.sharedAccessPhone : sharedAccess.sharedAccessPhone;

    if (filteredUpdateData.hasOwnProperty('sharedAccessPasswordHash') && filteredUpdateData.sharedAccessPasswordHash) {
        if (!finalSharedAccessEmail && !finalSharedAccessPhone) {
            const error = new Error('Não é possível definir uma senha para o acesso compartilhado sem um Email ou Telefone específico para este acesso.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    } else if (!filteredUpdateData.hasOwnProperty('sharedAccessPasswordHash') && sharedAccess.sharedAccessPasswordHash) {
        // Se a senha não está sendo alterada, mas o email/telefone estão sendo removidos,
        // a senha existente se torna "inutilizável" para login direto por essas creds.
        if (!finalSharedAccessEmail && !finalSharedAccessPhone) {
            logger.warn(`Acesso Compartilhado ID ${sharedAccessId} ficará sem email/telefone específico, mas ainda tem um hash de senha. O login por essas creds pode falhar.`);
            // Opcional: setar sharedAccessPasswordHash para null aqui se ambos email/tel do acesso forem null.
            // filteredUpdateData.sharedAccessPasswordHash = null;
        }
    }


    if (Object.keys(filteredUpdateData).length === 0) {
        await t.rollback();
        logger.info(`Nenhum campo válido para atualizar para SharedAccess ID ${sharedAccessId}.`);
        return sharedAccess.toJSON(); // Retorna o original se nada mudou
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
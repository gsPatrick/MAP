// src/features/ClientAuth/clientAuth.service.js
const { Client, Subscription, Plan, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { generateToken } = require('../../utils/authUtils');
const { Op } = require('sequelize');
const subscriptionService = require('../Subscription/subscription.service');

async function setClientCredentials(phone, password, name = null, email = null) {
  const t = await sequelize.transaction();
  try {
    if (!phone || !password) {
      await t.rollback();
      const error = new Error('Telefone e nova senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (password.length < 6) {
      await t.rollback();
      const error = new Error('A senha deve ter pelo menos 6 caracteres.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const normalizedPhone = phone.replace(/\D/g, '');
    let client = await Client.findOne({ where: { phone: normalizedPhone }, transaction: t });

    if (!client) {
      await t.rollback();
      const error = new Error('Cliente não encontrado com este número de telefone. O registro inicial deve ocorrer via WhatsApp ou outro canal designado.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const updateData = { passwordHash: password }; 

    if (email) {
      const lowerEmail = email.toLowerCase();
      const existingEmailClient = await Client.findOne({
        where: {
          email: lowerEmail,
          id: { [Op.ne]: client.id } 
        },
        transaction: t
      });
      if (existingEmailClient) {
        await t.rollback();
        const error = new Error('Este endereço de email já está em uso por outro cliente.');
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
      updateData.email = lowerEmail;
    }

    if (name && name.trim() !== "" && name !== client.name) { // Verifica se o nome é diferente e não vazio
        updateData.name = name;
    }

    await client.update(updateData, { transaction: t });
    await t.commit();
    
    logger.info(`Credenciais (senha e/ou email/nome) atualizadas para o Cliente ${client.phone}.`);
    // Recarregar o cliente para garantir que todos os hooks (se houver) e o defaultScope sejam aplicados.
    const reloadedClient = await Client.findByPk(client.id);
    return reloadedClient.toJSON(); 
  } catch (error) {
    await t.rollback(); 
    logger.error(`Erro ao definir credenciais para cliente ${phone}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function loginClient(identifier, password) {
  try {
    if (!identifier || !password) {
      const error = new Error('Identificador (email/telefone) e senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const normalizedIdentifier = identifier.replace(/\D/g, '');
    const isEmail = identifier.includes('@');
    const whereCondition = isEmail
      ? { email: identifier.toLowerCase() }
      : { phone: normalizedIdentifier };

    const client = await Client.scope('withPassword').findOne({ where: whereCondition });

    if (!client) {
      const error = new Error('Credenciais inválidas (cliente não encontrado).');
      error.statusCode = 401; error.status = 'fail'; throw error;
    }
    if (!client.passwordHash) {
        const error = new Error('Este cliente ainda não configurou uma senha para acesso web. Utilize a opção "Esqueci minha senha" ou "Configurar acesso".');
        error.statusCode = 403; error.status = 'fail'; throw error;
    }
    if (client.status === 'Bloqueado' || client.status === 'Inativo') {
        const error = new Error(`Acesso negado. Status do cliente: ${client.status}. Entre em contato com o suporte.`);
        error.statusCode = 403; error.status = 'fail'; throw error;
    }

    // VERIFICAR PLANO ATIVO (baseado no client.accessLevel e client.accessExpiresAt)
    let hasActivePaidAccess = false;
    if (client.accessLevel && client.accessLevel !== 'gratuito') {
        if (client.accessLevel.startsWith('vitalicio_')) {
            hasActivePaidAccess = true;
        } else if (client.accessExpiresAt) {
            const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
            const today = new Date(); today.setUTCHours(0,0,0,0);
            if (expiryDate >= today) {
                hasActivePaidAccess = true;
            }
        }
    }

    if (!hasActivePaidAccess && client.status !== 'Aguardando Pagamento') {
        logger.warn(`[AUTH CLIENT] Cliente ${client.id} (${client.phone || client.email}) tentou logar sem plano ativo/válido (accessLevel: ${client.accessLevel}, expiresAt: ${client.accessExpiresAt}).`);
        const error = new Error('Nenhum plano ativo encontrado. Acesse nosso site para adquirir um plano e liberar seu acesso.');
        error.statusCode = 403;
        error.status = 'fail_subscription';
        throw error;
    }

    const isPasswordMatch = await client.isValidPassword(password);
    if (!isPasswordMatch) {
      const error = new Error('Credenciais inválidas (senha incorreta).');
      error.statusCode = 401; error.status = 'fail'; throw error;
    }

    const tokenPayload = {
        id: client.id,
        phone: client.phone,
        email: client.email,
    };
    const token = generateToken(tokenPayload, 'client');

    const clientResponse = client.toJSON(); // Já aplica defaultScope

    const financialAccounts = await FinancialAccount.findAll({
        where: { clientId: client.id, isActive: true },
        attributes: ['id', 'accountName', 'accountType', 'isDefault'],
        order: [['isDefault', 'DESC'], ['accountName', 'ASC']]
    });

    logger.info(`Login bem-sucedido para o Cliente: ${client.phone || client.email}`);
    return {
        client: clientResponse, // accessLevel e accessExpiresAt já estão no clientResponse
        token,
        financialAccounts: financialAccounts.map(acc => acc.toJSON()),
        // O subscriptionService.getActiveSubscription poderia ser usado aqui se quiséssemos detalhes do plano da tabela Subscription,
        // mas para a verificação de acesso, os campos do Client são suficientes se bem gerenciados.
    };

  } catch (error) {
    logger.error(`Erro no login do Cliente (${identifier}): ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getClientProfile(clientId) {
    try {
        const client = await Client.findByPk(clientId); // defaultScope já remove passwordHash
        if (!client) {
            return null;
        }
        const clientResponse = client.toJSON();

        const financialAccounts = await FinancialAccount.findAll({
            where: { clientId: client.id, isActive: true },
            attributes: ['id', 'accountName', 'accountType', 'isDefault'],
            order: [['isDefault', 'DESC'], ['accountName', 'ASC']]
        });
        
        // Para o perfil, é bom retornar o estado da assinatura da tabela Subscription também, se houver
        const activeDbSubscription = await subscriptionService.getActiveSubscription(client.id);

        return {
            client: clientResponse, // Contém accessLevel e accessExpiresAt do próprio cliente
            financialAccounts: financialAccounts.map(acc => acc.toJSON()),
            subscription: activeDbSubscription // Detalhes da assinatura ativa do banco, se houver
        };

    } catch (error) {
        logger.error(`Erro ao buscar perfil do cliente ID ${clientId}: ${error.message}`, { error });
        throw new Error(`Erro ao buscar perfil do cliente.`);
    }
}


async function updateClientProfile(clientId, updateData) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.scope('withPassword').findByPk(clientId, { transaction: t });
    if (!client) {
      await t.rollback();
      const error = new Error('Cliente não encontrado.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const dataToUpdate = {};

    // Verificar senha atual se for alterar email ou senha
    if ((updateData.newPassword || (updateData.email && updateData.email !== client.email)) && !updateData.currentPassword) {
        await t.rollback();
        const error = new Error('Senha atual é obrigatória para alterar email ou senha.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    if (updateData.currentPassword) {
        const isCurrentPasswordMatch = await client.isValidPassword(updateData.currentPassword);
        if (!isCurrentPasswordMatch) {
            await t.rollback();
            const error = new Error('Senha atual incorreta.');
            error.statusCode = 401; error.status = 'fail'; throw error;
        }
    }

    // Atualizar nome
    if (updateData.name && updateData.name !== client.name) {
      dataToUpdate.name = updateData.name;
    }

    // Atualizar telefone
    if (updateData.phone && updateData.phone !== client.phone) {
        const normalizedPhone = updateData.phone.replace(/\D/g, '');
        // Verificar unicidade do telefone se ele for alterado
        const existingPhoneClient = await Client.findOne({
            where: { phone: normalizedPhone, id: { [Op.ne]: client.id } },
            transaction: t
        });
        if (existingPhoneClient) {
            await t.rollback();
            const error = new Error('Este número de telefone já está em uso por outro cliente.');
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        dataToUpdate.phone = normalizedPhone;
    }


    // Atualizar email (se a senha atual foi validada ou não é necessária para esta alteração)
    if (updateData.email && updateData.email !== client.email) {
      const lowerEmail = updateData.email.toLowerCase();
      const existingEmailClient = await Client.findOne({
        where: { email: lowerEmail, id: { [Op.ne]: client.id } },
        transaction: t
      });
      if (existingEmailClient) {
        await t.rollback();
        const error = new Error('Este endereço de email já está em uso por outro cliente.');
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
      dataToUpdate.email = lowerEmail;
    }

    // Atualizar senha (se a senha atual foi validada)
    if (updateData.newPassword) {
      if (updateData.newPassword.length < 6) {
        await t.rollback();
        const error = new Error('A nova senha deve ter pelo menos 6 caracteres.');
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
      // O hook beforeUpdate do modelo Client fará o hash
      dataToUpdate.passwordHash = updateData.newPassword;
    }
    
    if (Object.keys(dataToUpdate).length === 0) {
        await t.commit(); // Commit mesmo que nada mude para liberar a transação
        logger.info(`Nenhuma alteração de perfil para o Cliente ID ${clientId}.`);
        // Retornar o cliente sem o hash da senha
        const clientCurrentData = client.toJSON();
        delete clientCurrentData.passwordHash;
        return { client: clientCurrentData };
    }

    await client.update(dataToUpdate, { transaction: t });
    await t.commit();
    
    logger.info(`Perfil do Cliente ID ${clientId} atualizado com sucesso.`);
    // Recarregar para aplicar defaultScope e retornar
    const reloadedClient = await Client.findByPk(client.id); 
    return { client: reloadedClient.toJSON() };

  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao atualizar perfil do Cliente ID ${clientId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  setClientCredentials,
  loginClient,
  updateClientProfile,
  getClientProfile,
};
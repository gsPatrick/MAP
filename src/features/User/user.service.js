// src/features/User/user.service.js
const { User } = require('../../database');
const logger = require('../../utils/logger');
const { generateToken, comparePasswords } = require('../../utils/authUtils');
const { Op } = require('sequelize');


async function createUser(userData) {
  try {
    const { email, name, password, role } = userData;
    if (!email || !name || !password) {
      const error = new Error('Nome, email e senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const existingUser = await User.findOne({ where: { email: email } });
    if (existingUser) {
      const error = new Error('Email já cadastrado.');
      error.statusCode = 409; error.status = 'fail'; throw error;
    }

    // A senha será hasheada pelo hook beforeCreate do modelo User
    const newUser = await User.create({ name, email, passwordHash: password, role, isActive: true });
    
    // Retorna o usuário sem o hash da senha (o defaultScope já faz isso, mas para garantir)
    const userResponse = newUser.toJSON();
    delete userResponse.passwordHash;

    logger.info(`Usuário admin criado: ${userResponse.email}`);
    return userResponse;
  } catch (error) {
    logger.error(`Erro ao criar usuário admin: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function loginUser(email, password) {
  try {
    if (!email || !password) {
      const error = new Error('Email e senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    // Usar o escopo 'withPassword' para buscar o hash
    const user = await User.scope('withPassword').findOne({ where: { email: email } });
    if (!user) {
      const error = new Error('Credenciais inválidas (usuário não encontrado).');
      error.statusCode = 401; error.status = 'fail'; throw error;
    }
    if (!user.isActive) {
        const error = new Error('Este usuário está inativo.');
        error.statusCode = 403; error.status = 'fail'; throw error;
    }

    const isPasswordMatch = await user.isValidPassword(password); // Usa o método do modelo
    if (!isPasswordMatch) {
      const error = new Error('Credenciais inválidas (senha incorreta).');
      error.statusCode = 401; error.status = 'fail'; throw error;
    }

    const tokenPayload = { id: user.id, email: user.email, role: user.role, name: user.name };
    const token = generateToken(tokenPayload);

    const userResponse = user.toJSON();
    delete userResponse.passwordHash; // Garantir que não retorne o hash

    logger.info(`Login bem-sucedido para o usuário admin: ${email}`);
    return { user: userResponse, token };

  } catch (error) {
    logger.error(`Erro no login para ${email}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500; // Erro genérico
    throw error;
  }
}


async function getUserById(userId) {
  try {
    // defaultScope já exclui passwordHash
    const user = await User.findByPk(userId);
    if (!user) return null;
    return user.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar usuário admin por ID ${userId}: ${error.message}`, { error });
    throw new Error(`Erro ao buscar usuário admin.`);
  }
}

async function getAllUsers(queryParams = {}) {
  try {
    const { page = 1, limit = 10, role, isActive, search } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = {};

    if (role) whereConditions.role = role;
    if (isActive !== undefined) whereConditions.isActive = (isActive === 'true' || isActive === true);
    if (search) {
        whereConditions[Op.or] = [
            { name: { [Op.iLike]: `%${search}%` } },
            { email: { [Op.iLike]: `%${search}%` } },
        ];
    }

    // defaultScope já exclui passwordHash
    const { count, rows } = await User.findAndCountAll({
      where: whereConditions,
      limit: parseInt(limit, 10),
      offset: offset,
      order: [['name', 'ASC']],
    });
    return {
        totalItems: count,
        totalPages: Math.ceil(count / parseInt(limit, 10)),
        currentPage: parseInt(page, 10),
        users: rows.map(u => u.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar usuários admin: ${error.message}`, { error });
    throw new Error(`Erro ao listar usuários admin.`);
  }
}

async function updateUser(userId, updateData) {
  const t = await sequelize.transaction();
  try {
    const user = await User.findByPk(userId, { transaction: t });
    if (!user) { await t.rollback(); return null; }

    const { name, email, password, role, isActive } = updateData;
    const dataToUpdate = {};

    if (name !== undefined) dataToUpdate.name = name;
    if (role !== undefined) dataToUpdate.role = role;
    if (isActive !== undefined) dataToUpdate.isActive = isActive;
    if (email && email !== user.email) {
        const existingEmail = await User.findOne({where: {email, id: {[Op.ne]: userId}}, transaction: t});
        if(existingEmail){
            const error = new Error('O novo email fornecido já está em uso.');
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        dataToUpdate.email = email;
    }
    if (password) { // Se uma nova senha for fornecida
        dataToUpdate.passwordHash = password; // O hook beforeUpdate fará o hash
    }

    if(Object.keys(dataToUpdate).length === 0) {
        await t.rollback();
        return user.toJSON(); // Retorna o usuário original se nada foi alterado
    }

    await user.update(dataToUpdate, { transaction: t });
    await t.commit();
    logger.info(`Usuário admin ID ${userId} atualizado.`);
    return user.reload().then(u => u.toJSON()); // Recarrega para pegar dados atualizados (sem hash)
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar usuário admin ID ${userId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteUser(userId) {
  try {
    const user = await User.findByPk(userId);
    if (!user) return false;
    await user.destroy();
    logger.info(`Usuário admin ID ${userId} excluído.`);
    return true;
  } catch (error) {
    logger.error(`Erro ao excluir usuário admin ID ${userId}: ${error.message}`, { error });
    throw new Error(`Erro ao excluir usuário admin.`);
  }
}

async function getUsersForDebug() {
  try {
    // Usa o escopo 'withPassword' para forçar a inclusão do hash da senha
    const users = await User.scope('withPassword').findAll({
      order: [['id', 'ASC']],
    });

    // Mapeia os resultados para incluir o hash da senha e um campo 'plano'
    const usersWithDetails = users.map(user => {
      const userJSON = user.toJSON();
      return {
        id: userJSON.id,
        name: userJSON.name,
        email: userJSON.email,
        senha_hash: userJSON.passwordHash, // Retornando o hash da senha
        role: userJSON.role,
        isActive: userJSON.isActive,
        plano: userJSON.plano || 'premium_teste' // Adiciona o campo plano
      };
    });

    logger.warn('Executada função de debug getUsersForDebug que expõe senhas hasheadas.');
    return usersWithDetails;
  } catch (error) {
    logger.error(`Erro na função de debug getUsersForDebug: ${error.message}`, { error });
    throw new Error(`Erro ao buscar usuários para debug.`);
  }
}


module.exports = {
  createUser,
  loginUser,
  getUserById,
  getAllUsers,
  updateUser,
  deleteUser,
  getUsersForDebug
};
// src/features/User/user.controller.js
const userService = require('./user.service');
const logger = require('../../utils/logger');

async function createUser(req, res, next) {
  try {
    const { name, email, password, role } = req.body;
    // Adicionar validação de schema aqui (Joi, express-validator)
    if (!name || !email || !password) {
      const error = new Error('Nome, email e senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const newUser = await userService.createUser({ name, email, password, role });
    res.status(201).json({ status: 'success', data: newUser });
  } catch (error) {
    next(error);
  }
}

async function loginUser(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      const error = new Error('Email e senha são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const loginResult = await userService.loginUser(email, password);
    res.status(200).json({ status: 'success', data: loginResult }); // Retorna user e token
  } catch (error) {
    next(error);
  }
}

async function getCurrentUser(req, res, next) {
    // req.user é populado pelo middleware authenticateToken
    if (req.user) {
        // Opcional: buscar novamente do banco para garantir dados mais recentes,
        // mas req.user já deve ser suficiente se o token não for muito antigo.
        // const user = await userService.getUserById(req.user.id);
        // if(!user) { /* ... erro 401 ... */ }
        res.status(200).json({ status: 'success', data: req.user });
    } else {
        const error = new Error('Nenhum usuário autenticado encontrado.');
        error.statusCode = 401; error.status = 'fail';
        next(error);
    }
}


async function getAllUsers(req, res, next) {
  try {
    const result = await userService.getAllUsers(req.query);
    res.status(200).json({ status: 'success', ...result });
  } catch (error) { next(error); }
}

async function getUserById(req, res, next) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) { /* ... erro 400 ... */ }
    const user = await userService.getUserById(userId);
    if (!user) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: user });
  } catch (error) { next(error); }
}

async function updateUser(req, res, next) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) { /* ... erro 400 ... */ }
    if (Object.keys(req.body).length === 0) { /* ... erro 400 ... */ }
    // Somente admin pode mudar role de outros, ou usuário pode mudar seus próprios dados (exceto role)
    // Adicionar lógica de permissão aqui se necessário
    // Ex: if (req.user.id !== userId && req.user.role !== 'admin' && req.body.role) { /* erro 403 */ }
    const updatedUser = await userService.updateUser(userId, req.body);
    if (!updatedUser) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: updatedUser });
  } catch (error) { next(error); }
}

async function deleteUser(req, res, next) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) { /* ... erro 400 ... */ }
    // Adicionar lógica: admin não pode deletar a si mesmo se for o único admin?
    // if(req.user.id === userId && req.user.role === 'admin') { /* ... verificar se há outros admins ...*/}
    const success = await userService.deleteUser(userId);
    if (!success) { /* ... erro 404 ... */ }
    res.status(204).send();
  } catch (error) { next(error); }
}

module.exports = {
  createUser,
  loginUser,
  getCurrentUser, // Para obter dados do usuário logado
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
};
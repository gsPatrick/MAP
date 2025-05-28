// src/features/ClientAuth/clientAuth.controller.js
const clientAuthService = require('./clientAuth.service');
const logger = require('../../utils/logger');

async function setCredentials(req, res, next) {
  try {
    const { phone, password, name, email } = req.body;
    if (!phone || !password) {
        const error = new Error('Telefone e senha são obrigatórios no corpo da requisição.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const client = await clientAuthService.setClientCredentials(phone, password, name, email);
    res.status(200).json({ status: 'success', message: 'Credenciais definidas/atualizadas com sucesso.', data: client });
  } catch (error) {
    next(error);
  }
}

async function login(req, res, next) {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
        const error = new Error('Identificador (email/telefone) e senha são obrigatórios.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const loginResult = await clientAuthService.loginClient(identifier, password);
    res.status(200).json({ status: 'success', data: loginResult });
  } catch (error) {
    next(error);
  }
}

async function getCurrentClientProfile(req, res, next) {
    try {
        // req.client é o usuário logado (pode ser o sharedWithClient ou o dono direto)
        // req.sharedAccessContext contém infos se for um acesso compartilhado
        const profileData = await clientAuthService.getClientProfile(req.client.id, req.sharedAccessContext);
        if (!profileData) {
            const error = new Error('Perfil do cliente não encontrado.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
        }
        res.status(200).json({ status: 'success', data: profileData });
    } catch (error) {
        next(error);
    }
}

module.exports = {
  setCredentials,
  login,
  getCurrentClientProfile,
};
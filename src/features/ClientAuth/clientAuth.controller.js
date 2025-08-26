// src/features/ClientAuth/clientAuth.controller.js
const clientAuthService = require('./clientAuth.service');
const logger = require('../../utils/logger');

// <<< NOVO CONTROLLER PARA CADASTRO >>>
async function register(req, res, next) {
    try {
        const registerResult = await clientAuthService.registerClient(req.body);
        // O serviço já retorna o token, então o cliente pode prosseguir direto para o pagamento
        res.status(201).json({ status: 'success', data: registerResult });
    } catch (error) {
        next(error);
    }
}

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
        if (!req.client || req.client.id === undefined) {
            const error = new Error('Falha na autenticação: dados do cliente não encontrados.');
            error.statusCode = 500; 
            error.status = 'error';
            return next(error);
        }

        const profileData = await clientAuthService.getClientProfile(req.client, req.sharedAccessContext);

        if (!profileData) {
            const error = new Error('Perfil do cliente não pôde ser carregado.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
        }
        res.status(200).json({ status: 'success', data: profileData });
    } catch (error) {
        next(error);
    }
}

async function updateCalendarPreferences(req, res, next) {
  try {
    const clientId = req.client.id;
    const { googleCalendarColorIdPF, googleCalendarColorIdPJ } = req.body;

    const updatedClient = await clientAuthService.updateClientCalendarPreferences(
      clientId,
      googleCalendarColorIdPF,
      googleCalendarColorIdPJ
    );
    res.status(200).json({ status: 'success', data: updatedClient });
  } catch (error) {
    next(error);
  }
}

async function updateMyProfile(req, res, next) {
  try {
    const clientId = req.client.id;
    const updateData = req.body;

    if (Object.keys(updateData).length === 0) {
        const error = new Error('Nenhum dado fornecido para atualização.');
        error.statusCode = 400; error.status = 'fail';
        return next(error);
    }

    const result = await clientAuthService.updateClientProfile(clientId, updateData);
    res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  register, // <<< EXPORTA O NOVO CONTROLLER
  setCredentials,
  login,
  getCurrentClientProfile,
  updateCalendarPreferences,
  updateMyProfile
};
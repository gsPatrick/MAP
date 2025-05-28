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
        logger.debug('[CLIENT AUTH CTRL - /me] Iniciando getCurrentClientProfile.');
        logger.debug('[CLIENT AUTH CTRL - /me] Conteúdo de req.client ANTES de chamar o serviço:', req.client); // Log do objeto completo
        logger.debug('[CLIENT AUTH CTRL - /me] req.client.id ANTES de chamar o serviço:', req.client ? req.client.id : 'req.client é undefined');
        logger.debug('[CLIENT AUTH CTRL - /me] Conteúdo de req.sharedAccessContext ANTES de chamar o serviço:', req.sharedAccessContext);

        if (!req.client || req.client.id === undefined) {
            logger.error('[CLIENT AUTH CTRL - /me] ERRO CRÍTICO: req.client ou req.client.id está undefined ANTES de chamar clientAuthService.getClientProfile.');
            const error = new Error('Falha na autenticação ao obter perfil: dados do cliente não encontrados no request após autenticação.');
            error.statusCode = 500; 
            error.status = 'error';
            return next(error); // Importante retornar aqui
        }

        const profileData = await clientAuthService.getClientProfile(req.client, req.sharedAccessContext);

        if (!profileData) {
            // O serviço getClientProfile agora deve lançar erro se o clientToFetchId não for encontrado,
            // então este 'if' pode não ser atingido se o erro já foi lançado lá.
            logger.warn(`[CLIENT AUTH CTRL - /me] clientAuthService.getClientProfile retornou null/undefined para req.client.id: ${req.client.id}`);
            const error = new Error('Perfil do cliente não pôde ser carregado ou não encontrado.');
            error.statusCode = 404; error.status = 'fail'; return next(error);
        }
        res.status(200).json({ status: 'success', data: profileData });
    } catch (error) {
        logger.error(`[CLIENT AUTH CTRL - /me] Exceção capturada em getCurrentClientProfile: ${error.message}`, { stack: error.stack });
        next(error);
    }
}

module.exports = {
  setCredentials,
  login,
  getCurrentClientProfile,
};
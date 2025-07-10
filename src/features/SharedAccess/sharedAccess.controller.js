// src/features/SharedAccess/sharedAccess.controller.js
const sharedAccessService = require('./sharedAccess.service');
const logger = require('../../utils/logger');

async function grantAccess(req, res, next) {
    try {
        const ownerClientId = req.client.id;
        const grantData = req.body;

        // CORREÇÃO: Apenas o telefone do WhatsApp é obrigatório para o proprietário.
        // O email e senha do acesso compartilhado não são mais fornecidos pelo proprietário,
        // mas sim configurados pelo convidado no onboarding se ele for um novo usuário.
        if (!grantData.sharedAccessPhone) {
             const error = new Error('O "Telefone WhatsApp para este Acesso" é obrigatório.');
             error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        
        // A senha e o email do acesso compartilhado NÃO SÃO MAIS OBRIGATÓRIOS AQUI,
        // pois serão definidos ou utilizados do login principal do convidado.
        // As validações removidas:
        // if (!(grantData.sharedAccessEmail || grantData.sharedAccessPhone)) { ... }
        // if (!grantData.sharedAccessPassword) { ... }
        
        // Validação se canAccessPersonalProfile ou canAccessBusinessProfileId foi fornecido
        if (grantData.canAccessPersonalProfile === undefined && grantData.canAccessBusinessProfileId === undefined) {
            const error = new Error('Pelo menos um tipo de perfil (pessoal ou de negócio) deve ser especificado para o compartilhamento.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }

        // O service 'grantAccess' agora espera 'sharedAccessPhone' e o usará
        // para identificar/criar o Client convidado e vincular o SharedAccess.
        // 'sharedAccessEmail' e 'sharedAccessPassword' não serão passados pelo controller
        // se o dono não os fornecer (eles serão nulos no SharedAccess record e o login será sempre pelo Client principal).
        const newSharedAccess = await sharedAccessService.grantAccess(ownerClientId, grantData);
        res.status(201).json({ status: 'success', data: newSharedAccess });
    } catch (error) {
        next(error);
    }
}

async function getMyOwnedShares(req, res, next) {
    try {
        const ownerClientId = req.client.id;
        const result = await sharedAccessService.getSharedAccessesByOwner(ownerClientId, req.query);
        res.status(200).json({ status: 'success', ...result });
    } catch (error) {
        next(error);
    }
}

async function getSharesForMe(req, res, next) {
    try {
        const sharedWithClientId = req.client.id;
        const result = await sharedAccessService.getSharedAccessesForUser(sharedWithClientId, req.query);
        res.status(200).json({ status: 'success', ...result });
    } catch (error) {
        next(error);
    }
}

async function updateSharedAccess(req, res, next) {
    try {
        const ownerClientId = req.client.id;
        const sharedAccessId = parseInt(req.params.sharedAccessId, 10);
        if (isNaN(sharedAccessId)) {
            const error = new Error('ID do acesso compartilhado inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        if (Object.keys(req.body).length === 0) {
            const error = new Error('Nenhum dado fornecido para atualização.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        const updatedSharedAccess = await sharedAccessService.updateSharedAccess(ownerClientId, sharedAccessId, req.body);
        res.status(200).json({ status: 'success', data: updatedSharedAccess });
    } catch (error) {
        next(error);
    }
}

async function revokeAccess(req, res, next) {
    try {
        const ownerClientId = req.client.id;
        const sharedAccessId = parseInt(req.params.sharedAccessId, 10);
        if (isNaN(sharedAccessId)) {
            const error = new Error('ID do acesso compartilhado inválido.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        await sharedAccessService.revokeAccess(ownerClientId, sharedAccessId);
        res.status(204).send();
    } catch (error) {
        next(error);
    }
}

module.exports = {
    grantAccess,
    getMyOwnedShares,
    getSharesForMe,
    updateSharedAccess,
    revokeAccess,
};
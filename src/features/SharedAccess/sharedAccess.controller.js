// src/features/SharedAccess/sharedAccess.controller.js
const sharedAccessService = require('./sharedAccess.service');
const logger = require('../../utils/logger');

async function grantAccess(req, res, next) {
    try {
        // O ownerClientId vem do usuário autenticado (req.client.id)
        const ownerClientId = req.client.id;
        const grantData = req.body;
        // Validação do corpo da requisição (sharedWithEmail/Phone, etc.)
        if (!(grantData.sharedWithEmail || grantData.sharedWithPhone)) {
             const error = new Error('Email ou telefone do usuário convidado é obrigatório.');
             error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        // Validação se canAccessPersonalProfile ou canAccessBusinessProfileId foi fornecido
        if (grantData.canAccessPersonalProfile === undefined && grantData.canAccessBusinessProfileId === undefined) {
            const error = new Error('Pelo menos um tipo de perfil (pessoal ou de negócio) deve ser especificado para o compartilhamento.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }

        const newSharedAccess = await sharedAccessService.grantAccess(ownerClientId, grantData);
        res.status(201).json({ status: 'success', data: newSharedAccess });
    } catch (error) {
        next(error);
    }
}

async function getMyOwnedShares(req, res, next) { // Para o dono ver quem ele compartilhou
    try {
        const ownerClientId = req.client.id; // ID do cliente logado (dono)
        const result = await sharedAccessService.getSharedAccessesByOwner(ownerClientId, req.query);
        res.status(200).json({ status: 'success', ...result });
    } catch (error) {
        next(error);
    }
}

async function getSharesForMe(req, res, next) { // Para o usuário ver quem compartilhou com ele
    try {
        const sharedWithClientId = req.client.id; // ID do cliente logado (que recebeu o share)
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
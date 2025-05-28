// src/features/SharedAccess/sharedAccess.controller.js
const sharedAccessService = require('./sharedAccess.service');
const logger = require('../../utils/logger');

async function grantAccess(req, res, next) {
    try {
        const ownerClientId = req.client.id;
        const grantData = req.body;

        // CORREÇÃO: Usar as chaves que o frontend envia para identificar o convidado
        // e para as credenciais específicas do acesso.
        if (!(grantData.sharedAccessEmail || grantData.sharedAccessPhone)) {
             const error = new Error('O "Email de Login para este Acesso" ou o "Telefone WhatsApp para este Acesso" é obrigatório.');
             error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        // A senha também é obrigatória ao criar
        if (!grantData.sharedAccessPassword) {
            const error = new Error('A "Senha para este Acesso" é obrigatória.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }
        // Validação se canAccessPersonalProfile ou canAccessBusinessProfileId foi fornecido
        if (grantData.canAccessPersonalProfile === undefined && grantData.canAccessBusinessProfileId === undefined) {
            // Se nenhum foi definido explicitamente, podemos assumir um default ou erro
            // Para ser mais explícito, vamos exigir que pelo menos um seja definido via frontend (Radio buttons)
            const error = new Error('Pelo menos um tipo de perfil (pessoal ou de negócio) deve ser especificado para o compartilhamento.');
            error.statusCode = 400; error.status = 'fail'; return next(error);
        }


        // O service 'grantAccess' já espera 'sharedAccessEmail', 'sharedAccessPhone', 'sharedAccessPassword'
        // e os usará tanto para o registro SharedAccess quanto para identificar/criar o Client convidado.
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
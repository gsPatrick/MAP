// src/features/SharedAccess/sharedAccess.routes.js
const { Router } = require('express');
const sharedAccessController = require('./sharedAccess.controller');
// O authenticateClientToken já é aplicado no routes/index.js antes de montar estas rotas

const router = Router();

// Cliente logado (req.client.id) concede acesso a outro usuário
router.post('/grant', sharedAccessController.grantAccess);

// Cliente logado (req.client.id) lista os acessos que ELE concedeu
router.get('/my-shares', sharedAccessController.getMyOwnedShares);

// Cliente logado (req.client.id) lista os acessos que FORAM concedidos A ELE
router.get('/shared-with-me', sharedAccessController.getSharesForMe);

// Cliente logado (req.client.id como owner) atualiza um acesso específico que ele concedeu
router.put('/my-shares/:sharedAccessId', sharedAccessController.updateSharedAccess);

// Cliente logado (req.client.id como owner) revoga um acesso específico que ele concedeu
router.delete('/my-shares/:sharedAccessId', sharedAccessController.revokeAccess);

module.exports = router;
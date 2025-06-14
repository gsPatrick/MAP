// src/features/Affiliate/affiliate.routes.js
const { Router } = require('express');
const affiliateController = require('./affiliate.controller');

const router = Router();

// Rota para o cliente logado buscar seu próprio dashboard de afiliado
router.get('/dashboard', affiliateController.getAffiliateDashboard);

// No futuro, outras rotas de afiliado (como saque, etc.) podem ser adicionadas aqui.

module.exports = router;
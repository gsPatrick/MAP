// src/features/Affiliate/affiliate.routes.js
const { Router } = require('express');
const affiliateController = require('./affiliate.controller');

const router = Router();

// Rota para o cliente logado buscar seu próprio dashboard de afiliado
router.get('/dashboard', affiliateController.getAffiliateDashboard);

// <<< NOVA ROTA PARA O HISTÓRICO DE INDICAÇÕES >>>
router.get('/referrals', affiliateController.getAffiliateReferrals);

module.exports = router;
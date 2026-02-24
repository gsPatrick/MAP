// src/features/Affiliate/affiliate.routes.js
const { Router } = require('express');
const affiliateController = require('./affiliate.controller');

const router = Router();

// Rota para o cliente logado buscar seu próprio dashboard de afiliado
router.get('/dashboard', affiliateController.getAffiliateDashboard);

// Rota para o histórico de indicações
router.get('/referrals', affiliateController.getAffiliateReferrals);

// Rota para o ranking de afiliados
router.get('/ranking', affiliateController.getRanking);

// Rota para atualizar o slug personalizado
router.put('/update-slug', affiliateController.updateSlug);

// Rota PÚBLICA para registrar cliques (pode ser chamada sem auth)
router.post('/click/:identifier', affiliateController.trackClick);

module.exports = router;
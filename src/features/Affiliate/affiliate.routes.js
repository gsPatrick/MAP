// src/features/Affiliate/affiliate.routes.js
const { Router } = require('express');
const affiliateController = require('./affiliate.controller');

const router = Router();

// Rota para o cliente logado buscar seu próprio dashboard de afiliado
router.get('/dashboard', affiliateController.getAffiliateDashboard);

// Rota para o histórico de indicações
router.get('/referrals', affiliateController.getAffiliateReferrals);

// Histórico de comissões por período (hoje/semana/mês/ano)
router.get('/commissions', affiliateController.getAffiliateCommissions);

// Comissões em aberto (ainda não sacadas)
router.get('/open-commissions', affiliateController.getOpenCommissions);

// Saque: solicitar (zera saldo -> vai pro histórico) e listar histórico de saques
router.post('/request-payout', affiliateController.requestPayout);
router.get('/payouts', affiliateController.getPayouts);

// Rota para o ranking de afiliados
router.get('/ranking', affiliateController.getRanking);

// Rota para atualizar o slug personalizado
router.put('/update-slug', affiliateController.updateSlug);

// Rota PÚBLICA para registrar cliques (pode ser chamada sem auth)
router.post('/click/:identifier', affiliateController.trackClick);

module.exports = router;
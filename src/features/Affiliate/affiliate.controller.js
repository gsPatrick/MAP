// src/features/Affiliate/affiliate.controller.js
const affiliateService = require('./affiliate.service');

async function getAffiliateDashboard(req, res, next) {
    try {
        const affiliateClientId = req.client.id;
        const dashboardData = await affiliateService.getAffiliateDashboard(affiliateClientId);
        res.status(200).json({ status: 'success', data: dashboardData });
    } catch (error) {
        next(error);
    }
}

// <<< NOVO CONTROLLER PARA O HISTÓRICO DE INDICAÇÕES >>>
async function getAffiliateReferrals(req, res, next) {
    try {
        const affiliateClientId = req.client.id;
        const referralsHistory = await affiliateService.getAffiliateReferralsHistory(affiliateClientId);
        res.status(200).json({ status: 'success', data: referralsHistory });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    getAffiliateDashboard,
    getAffiliateReferrals, // <<< EXPORTAR NOVO CONTROLLER
};
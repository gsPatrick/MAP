// src/features/Affiliate/affiliate.controller.js
const affiliateService = require('./affiliate.service');

async function getAffiliateDashboard(req, res, next) {
    try {
        // O ID do cliente vem do token de autenticação, que o middleware já validou
        const affiliateClientId = req.client.id;
        const dashboardData = await affiliateService.getAffiliateDashboard(affiliateClientId);
        res.status(200).json({ status: 'success', data: dashboardData });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    getAffiliateDashboard,
};
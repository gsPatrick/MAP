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

async function getAffiliateReferrals(req, res, next) {
    try {
        const affiliateClientId = req.client.id;
        const referralsHistory = await affiliateService.getAffiliateReferralsHistory(affiliateClientId);
        res.status(200).json({ status: 'success', data: referralsHistory });
    } catch (error) {
        next(error);
    }
}

async function getAffiliateCommissions(req, res, next) {
    try {
        const affiliateClientId = req.client.id;
        const { period, dateStart, dateEnd } = req.query;
        const data = await affiliateService.getAffiliateCommissions(affiliateClientId, { period, dateStart, dateEnd });
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
}

async function getOpenCommissions(req, res, next) {
    try {
        const data = await affiliateService.getOpenCommissions(req.client.id);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
}

async function getLeads(req, res, next) {
    try {
        const data = await affiliateService.getAffiliateLeads(req.client.id);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
}

async function requestPayout(req, res, next) {
    try {
        const affiliateClientId = req.client.id;
        const payout = await affiliateService.requestPayout(affiliateClientId);
        res.status(200).json({ status: 'success', data: payout });
    } catch (error) {
        next(error);
    }
}

async function getPayouts(req, res, next) {
    try {
        const affiliateClientId = req.client.id;
        const payouts = await affiliateService.getAffiliatePayouts(affiliateClientId);
        res.status(200).json({ status: 'success', data: payouts });
    } catch (error) {
        next(error);
    }
}

async function trackClick(req, res, next) {
    try {
        const { identifier } = req.params;
        await affiliateService.trackClick(identifier);
        res.status(200).json({ status: 'success', message: 'Clique registrado.' });
    } catch (error) {
        next(error);
    }
}

async function getRanking(req, res, next) {
    try {
        const ranking = await affiliateService.getAffiliateRanking();
        res.status(200).json({ status: 'success', data: ranking });
    } catch (error) {
        next(error);
    }
}

async function updateSlug(req, res, next) {
    try {
        const clientId = req.client.id;
        const { slug } = req.body;
        await affiliateService.updateAffiliateSlug(clientId, slug);
        res.status(200).json({ status: 'success', message: 'Link personalizado atualizado com sucesso.' });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    getAffiliateDashboard,
    getAffiliateReferrals,
    getAffiliateCommissions,
    getOpenCommissions,
    getLeads,
    requestPayout,
    getPayouts,
    trackClick,
    getRanking,
    updateSlug
};
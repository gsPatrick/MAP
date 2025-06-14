// src/features/Affiliate/affiliate.service.js
const { Client, AffiliateLedger, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

/**
 * Obtém o dashboard de afiliado para um cliente.
 * @param {number} affiliateClientId - ID do cliente afiliado.
 * @returns {Promise<object>} Dados do dashboard.
 */
async function getAffiliateDashboard(affiliateClientId) {
  try {
    // 1. Busca os dados principais do afiliado
    const affiliate = await Client.findByPk(affiliateClientId, {
      attributes: ['id', 'name', 'balance', 'affiliateCode', 'asaasPayoutPixKey']
    });

    if (!affiliate) {
      throw { statusCode: 404, message: 'Afiliado não encontrado.' };
    }

    // 2. Conta o número total de clientes indicados por ele
    const totalReferrals = await Client.count({
      where: { referredByClientId: affiliateClientId }
    });

    // 3. Soma o total de comissões ganhas (histórico completo)
    const totalEarnedResult = await AffiliateLedger.findOne({
      attributes: [[sequelize.fn('SUM', sequelize.col('commissionAmount')), 'total']],
      where: { affiliateClientId: affiliateClientId },
      raw: true,
    });
    const totalEarned = parseFloat(totalEarnedResult.total) || 0;

    // 4. Monta o objeto de resposta do dashboard
    const dashboardData = {
      summary: affiliate.toJSON(),
      totalReferrals: totalReferrals,
      totalEarned: totalEarned,
      // Você pode adicionar mais dados aqui no futuro, como o extrato (ledger)
    };

    logger.info(`[AffiliateService] Dashboard para afiliado ID ${affiliateClientId} gerado com sucesso.`);
    return dashboardData;

  } catch (error) {
    logger.error(`[AffiliateService] Erro ao buscar dashboard do afiliado ID ${affiliateClientId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  getAffiliateDashboard,
};
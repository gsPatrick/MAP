// <<<< CORREÇÃO: Removida a importação do AffiliateLedger >>>>
const { Client, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

/**
 * Obtém o dashboard de afiliado para um cliente.
 * @param {number} affiliateClientId - ID do cliente afiliado.
 * @returns {Promise<object>} Dados do dashboard.
 */
async function getAffiliateDashboard(affiliateClientId) {
  try {
    // 1. Busca os dados principais do afiliado, incluindo o saldo
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

    // 3. O total ganho é simplesmente o saldo atual, na abordagem simples.
    // Não precisamos somar de um extrato.
    const totalEarned = parseFloat(affiliate.balance) || 0;

    // 4. Monta o objeto de resposta do dashboard
    const dashboardData = {
      summary: affiliate.toJSON(),
      totalReferrals: totalReferrals,
      totalEarned: totalEarned, // O total ganho é o saldo atual
    };

    logger.info(`[AffiliateService] Dashboard para afiliado ID ${affiliateClientId} gerado com sucesso.`);
    return dashboardData;

  } catch (error) {
    logger.error(`[AffiliateService] Erro ao buscar dashboard do afiliado ID ${affiliateClientId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

// ... (outras funções que você possa ter, como updatePayoutInfo e requestWithdrawal) ...

module.exports = {
  getAffiliateDashboard,
  // ... outros exports ...
};
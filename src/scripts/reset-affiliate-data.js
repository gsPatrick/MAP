#!/usr/bin/env node
/**
 * Zera todos os dados operacionais do programa de afiliados.
 *
 * Remove:
 *   - affiliate_commissions (ledger de comissões)
 *   - affiliate_payouts (saques)
 *   - affiliate_clicks (cliques no link)
 *
 * Reseta em clients:
 *   - referredByClientId, affiliateCode, affiliateSlug
 *   - balance, asaasPayoutPixKey, affiliateLinkClicks
 *
 * NÃO altera:
 *   - plans.affiliateCommissionValue (configuração de valor por plano)
 *   - clientes, assinaturas ou demais dados financeiros
 *
 * Uso:
 *   node src/scripts/reset-affiliate-data.js              # dry-run (só mostra contagens)
 *   node src/scripts/reset-affiliate-data.js --dry-run
 *   node src/scripts/reset-affiliate-data.js --confirm    # executa de verdade
 */
require('dotenv').config();

const { Op } = require('sequelize');
const {
  sequelize,
  Client,
  AffiliateCommission,
  AffiliatePayout,
  AffiliateClick,
} = require('../database');

async function countAffiliateState() {
  const [
    commissions,
    payouts,
    clicks,
    clientsWithReferrer,
    clientsWithCode,
    clientsWithSlug,
    clientsWithBalance,
    clientsWithPixKey,
    totalClicksCounter,
  ] = await Promise.all([
    AffiliateCommission.count(),
    AffiliatePayout.count(),
    AffiliateClick.count(),
    Client.count({ where: { referredByClientId: { [Op.ne]: null } } }),
    Client.count({ where: { affiliateCode: { [Op.ne]: null } } }),
    Client.count({ where: { affiliateSlug: { [Op.ne]: null } } }),
    Client.count({ where: { balance: { [Op.gt]: 0 } } }),
    Client.count({ where: { asaasPayoutPixKey: { [Op.ne]: null } } }),
    Client.sum('affiliateLinkClicks'),
  ]);

  return {
    commissions,
    payouts,
    clicks,
    clientsWithReferrer,
    clientsWithCode,
    clientsWithSlug,
    clientsWithBalance,
    clientsWithPixKey,
    totalClicksCounter: totalClicksCounter || 0,
  };
}

function printSummary(label, stats) {
  console.log(`\n[reset-affiliates] ${label}`);
  console.log(`  Comissões (affiliate_commissions):     ${stats.commissions}`);
  console.log(`  Saques (affiliate_payouts):            ${stats.payouts}`);
  console.log(`  Cliques (affiliate_clicks):            ${stats.clicks}`);
  console.log(`  Clientes com indicador (referredBy):   ${stats.clientsWithReferrer}`);
  console.log(`  Clientes com affiliateCode:            ${stats.clientsWithCode}`);
  console.log(`  Clientes com affiliateSlug:            ${stats.clientsWithSlug}`);
  console.log(`  Clientes com saldo > 0:                ${stats.clientsWithBalance}`);
  console.log(`  Clientes com chave PIX de saque:       ${stats.clientsWithPixKey}`);
  console.log(`  Soma affiliateLinkClicks em clients:   ${stats.totalClicksCounter}`);
}

async function resetAffiliateData({ dryRun }) {
  await sequelize.authenticate();

  const before = await countAffiliateState();
  printSummary('Estado atual', before);

  const hasData = before.commissions > 0
    || before.payouts > 0
    || before.clicks > 0
    || before.clientsWithReferrer > 0
    || before.clientsWithCode > 0
    || before.clientsWithSlug > 0
    || before.clientsWithBalance > 0
    || before.clientsWithPixKey > 0
    || before.totalClicksCounter > 0;

  if (!hasData) {
    console.log('\n[reset-affiliates] Nada para zerar. Programa de afiliados já está limpo.');
    return { before, after: before, dryRun };
  }

  if (dryRun) {
    console.log('\n[reset-affiliates] DRY-RUN — nenhuma alteração feita.');
    console.log('[reset-affiliates] Para executar de verdade: node src/scripts/reset-affiliate-data.js --confirm');
    return { before, after: before, dryRun };
  }

  const transaction = await sequelize.transaction();
  try {
    const deletedCommissions = await AffiliateCommission.destroy({
      where: {},
      transaction,
    });
    const deletedPayouts = await AffiliatePayout.destroy({
      where: {},
      transaction,
    });
    const deletedClicks = await AffiliateClick.destroy({
      where: {},
      transaction,
    });

    const [updatedClients] = await Client.update(
      {
        referredByClientId: null,
        affiliateCode: null,
        affiliateSlug: null,
        balance: 0,
        asaasPayoutPixKey: null,
        affiliateLinkClicks: 0,
      },
      { where: {}, transaction }
    );

    await transaction.commit();

    console.log('\n[reset-affiliates] Execução concluída:');
    console.log(`  Comissões removidas:  ${deletedCommissions}`);
    console.log(`  Saques removidos:     ${deletedPayouts}`);
    console.log(`  Cliques removidos:    ${deletedClicks}`);
    console.log(`  Clientes atualizados: ${updatedClients}`);

    const after = await countAffiliateState();
    printSummary('Estado após reset', after);

    return {
      before,
      after,
      dryRun,
      deleted: {
        commissions: deletedCommissions,
        payouts: deletedPayouts,
        clicks: deletedClicks,
        clientsUpdated: updatedClients,
      },
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const dryRun = !confirm || process.argv.includes('--dry-run');

  try {
    const result = await resetAffiliateData({ dryRun });
    console.log('\nRESET_AFFILIATES_JSON_START');
    console.log(JSON.stringify(result, null, 2));
    console.log('RESET_AFFILIATES_JSON_END');
    process.exit(0);
  } catch (err) {
    console.error('[reset-affiliates] Erro:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    try { await sequelize.close(); } catch (_) { /* ignore */ }
  }
}

main();

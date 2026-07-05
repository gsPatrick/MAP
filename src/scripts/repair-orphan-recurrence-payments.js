#!/usr/bin/env node
/**
 * Repara recorrências vencidas que já têm gasto avulso equivalente registrado.
 *
 * Uso:
 *   node src/scripts/repair-orphan-recurrence-payments.js
 *   node src/scripts/repair-orphan-recurrence-payments.js --dry-run
 */
require('dotenv').config();

const paymentResolution = require('../features/Financial/paymentResolution.service');
const { sequelize } = require('../database');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  try {
    await sequelize.authenticate();
    console.log(`[repair] Iniciando reparo de recorrências órfãs${dryRun ? ' (dry-run)' : ''}...`);
    const result = await paymentResolution.repairAllOrphanRecurrencePayments({ dryRun });
    console.log(`[repair] Regras analisadas: ${result.totalRules}`);
    console.log(`[repair] Reparadas: ${result.repaired.length}`);
    console.log(`[repair] Ignoradas: ${result.skipped.length}`);
    if (result.repaired.length) {
      console.log('\nReparos:');
      result.repaired.forEach((r) => {
        console.log(`  - regra #${r.ruleId} "${r.ruleDescription}" ← tx #${r.transactionId} (${r.action})`);
      });
    }
    console.log('\nREPAIR_JSON_START');
    console.log(JSON.stringify(result, null, 2));
    console.log('REPAIR_JSON_END');
    process.exit(0);
  } catch (err) {
    console.error('[repair] Erro:', err.message);
    process.exit(1);
  } finally {
    try { await sequelize.close(); } catch (_) { /* ignore */ }
  }
}

main();

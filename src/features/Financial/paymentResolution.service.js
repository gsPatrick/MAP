/**
 * Resolve e liquida pagamentos de contas pendentes / recorrências com busca fuzzy.
 * Cobre casos como "paguei a Amanda" vs "Pagamento de salário da colaboradora Amanda"
 * e gastos avulsos já registrados que deveriam dar baixa na recorrência.
 */
const { Op } = require('sequelize');
const {
  FinancialAccount,
  FinancialTransaction,
  RecurringTransactionRule,
} = require('../../database');
const logger = require('../../utils/logger');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');

const STOP_WORDS = new Set([
  'pagamento', 'de', 'da', 'do', 'das', 'dos', 'a', 'o', 'e', 'em', 'no', 'na', 'para',
  'conta', 'salario', 'salário', 'colaboradora', 'colaborador', 'mensal', 'fixo',
]);

const MIN_SCORE_AUTO = 4;

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function fmtDate(d) {
  if (!d) return null;
  return String(d).split('T')[0];
}

function valuesMatch(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(parseFloat(a) - parseFloat(b)) < 0.02;
}

function extractTokens(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function scoreCandidate(userText, candidateText, userValue, candidateValue, extras = {}) {
  const userTokens = extractTokens(userText);
  const candTokens = extractTokens(candidateText);
  const shared = userTokens.filter((t) => candTokens.includes(t));
  let score = shared.length * 2;

  if (valuesMatch(userValue, candidateValue)) score += 3;
  if (extras.overdue) score += 2;
  if (extras.preferredAccountId && extras.accountId === extras.preferredAccountId) score += 1;

  return { score, sharedTokens: shared };
}

async function getActiveAccountIdsForClient(clientId) {
  const accounts = await FinancialAccount.findAll({
    where: { clientId, isActive: true },
    attributes: ['id'],
  });
  return accounts.map((a) => a.id);
}

/**
 * @returns {Promise<Array<object>>} candidatos ordenados por score
 */
async function findPaymentTargets({
  clientId,
  accountIds = null,
  description,
  value = null,
  type = 'Saída',
  preferredAccountId = null,
  includeFutureRules = false,
}) {
  const ids = accountIds && accountIds.length
    ? accountIds
    : await getActiveAccountIdsForClient(clientId);

  if (!ids.length) return [];

  const today = todayStr();
  const candidates = [];

  const pendingWhere = {
    financialAccountId: { [Op.in]: ids },
    isPayableOrReceivable: true,
    isPaidOrReceived: false,
    type,
  };
  if (value != null) pendingWhere.value = parseFloat(value);

  const pendingTxs = await FinancialTransaction.findAll({
    where: pendingWhere,
    order: [['dueDate', 'ASC']],
    limit: 20,
  });

  for (const tx of pendingTxs) {
    const { score, sharedTokens } = scoreCandidate(
      description, tx.description, value, tx.value,
      { overdue: tx.dueDate && fmtDate(tx.dueDate) <= today, preferredAccountId, accountId: tx.financialAccountId }
    );
    if (score >= 2 || sharedTokens.length > 0) {
      candidates.push({
        kind: 'pending_transaction',
        id: tx.id,
        financialAccountId: tx.financialAccountId,
        description: tx.description,
        value: parseFloat(tx.value),
        dueDate: fmtDate(tx.dueDate),
        score,
        sharedTokens,
      });
    }
  }

  const ruleWhere = {
    financialAccountId: { [Op.in]: ids },
    isActive: true,
    type,
  };
  if (!includeFutureRules) {
    ruleWhere.nextDueDate = { [Op.lte]: today };
  }

  const rules = await RecurringTransactionRule.findAll({
    where: ruleWhere,
    order: [['nextDueDate', 'ASC']],
    limit: 30,
  });

  for (const rule of rules) {
    const { score, sharedTokens } = scoreCandidate(
      description, rule.description, value, rule.value,
      {
        overdue: rule.nextDueDate && fmtDate(rule.nextDueDate) <= today,
        preferredAccountId,
        accountId: rule.financialAccountId,
      }
    );
    if (score >= 2 || sharedTokens.length > 0) {
      candidates.push({
        kind: 'recurrence',
        id: rule.id,
        financialAccountId: rule.financialAccountId,
        description: rule.description,
        value: parseFloat(rule.value),
        nextDueDate: fmtDate(rule.nextDueDate),
        score,
        sharedTokens,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

async function findBestPaymentTarget(options) {
  const candidates = await findPaymentTargets(options);
  if (!candidates.length) return null;

  const best = candidates[0];
  if (best.score < MIN_SCORE_AUTO) return null;

  const second = candidates[1];
  if (second && second.score >= MIN_SCORE_AUTO && second.score >= best.score - 1) {
    logger.warn(`[PaymentResolution] Match ambíguo para "${options.description}": "${best.description}" (${best.score}) vs "${second.description}" (${second.score})`);
    return null;
  }

  return best;
}

/**
 * Verifica se a recorrência já foi paga no ciclo atual (tx vinculada ou gasto avulso equivalente).
 */
async function isRecurrenceSettledForCurrentCycle(rule, accountIds) {
  const dueDate = fmtDate(rule.nextDueDate);
  if (!dueDate) return false;

  const due = new Date(`${dueDate}T12:00:00Z`);
  const windowStart = new Date(due);
  windowStart.setUTCDate(windowStart.getUTCDate() - 45);
  const windowEnd = new Date(due);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 15);
  const startStr = windowStart.toISOString().split('T')[0];
  const endStr = windowEnd.toISOString().split('T')[0];

  const linkedPaid = await FinancialTransaction.findOne({
    where: {
      recurringTransactionRuleId: rule.id,
      isPaidOrReceived: true,
      paymentDate: { [Op.between]: [startStr, endStr] },
    },
  });
  if (linkedPaid) return true;

  const orphanCandidates = await FinancialTransaction.findAll({
    where: {
      financialAccountId: { [Op.in]: accountIds },
      type: rule.type,
      isPaidOrReceived: true,
      isPayableOrReceivable: false,
      recurringTransactionRuleId: null,
      transactionDate: { [Op.between]: [startStr, endStr] },
      value: rule.value,
    },
    limit: 10,
  });

  for (const tx of orphanCandidates) {
    const { score } = scoreCandidate(tx.description, rule.description, tx.value, rule.value);
    if (score >= MIN_SCORE_AUTO) return true;
  }

  return false;
}

async function filterRecurrencesAlreadyPaid(rules, accountIds) {
  const filtered = [];
  for (const rule of rules) {
    const settled = await isRecurrenceSettledForCurrentCycle(rule, accountIds);
    if (!settled) filtered.push(rule);
  }
  return filtered;
}

async function settlePaymentTarget(target, paymentDate, options = {}) {
  const { existingTransactionId = null, linkExistingTx = true } = options;

  if (target.kind === 'pending_transaction') {
    return financialServiceMarkById(target.financialAccountId, target.id, paymentDate);
  }

  if (target.kind === 'recurrence') {
    return recurringTransactionService.advanceRecurringRuleAfterExternalPayment(
      target.financialAccountId,
      target.id,
      paymentDate,
      { existingTransactionId, linkExistingTx }
    );
  }

  throw new Error('Tipo de alvo de pagamento desconhecido.');
}

async function financialServiceMarkById(financialAccountId, transactionId, paymentDate) {
  const financialService = require('./financial.service');
  return financialService.markAsPaidOrReceived(financialAccountId, transactionId, paymentDate);
}

/**
 * Tenta liquidar conta/recorrência a partir de descrição (MARK).
 */
async function settleByDescription({
  clientId,
  accountIds,
  preferredAccountId,
  description,
  value = null,
  type = 'Saída',
  paymentDate = null,
}) {
  const payDate = paymentDate || todayStr();
  const target = await findBestPaymentTarget({
    clientId,
    accountIds,
    preferredAccountId,
    description,
    value,
    type,
  });

  if (!target) {
    const err = new Error(`Nenhuma transação pendente encontrada com descrição similar a "${description}"${value != null ? ` e valor ${value}` : ''}.`);
    err.statusCode = 404;
    err.status = 'fail';
    throw err;
  }

  const result = await settlePaymentTarget(target, payDate);
  return { target, result };
}

/**
 * Após CREATE de gasto/receita já pago, tenta dar baixa na recorrência/conta correspondente.
 */
async function trySettleAfterCreate({
  clientId,
  preferredAccountId,
  transaction,
}) {
  if (!transaction || !transaction.isPaidOrReceived) return null;
  if (transaction.isPayableOrReceivable) return null;
  if (transaction.recurringTransactionRuleId) return null;

  const accountIds = await getActiveAccountIdsForClient(clientId);
  const target = await findBestPaymentTarget({
    clientId,
    accountIds,
    preferredAccountId,
    description: transaction.description,
    value: parseFloat(transaction.value),
    type: transaction.type,
  });

  if (!target) return null;

  const paymentDate = fmtDate(transaction.paymentDate || transaction.transactionDate);
  const result = await settlePaymentTarget(target, paymentDate, {
    existingTransactionId: transaction.id,
    linkExistingTx: true,
  });

  logger.info(`[PaymentResolution] Baixa automática após CREATE tx ${transaction.id} → ${target.kind} #${target.id}`);
  return { target, result };
}

/**
 * Repara recorrências vencidas com gasto avulso equivalente já registrado (todos os clientes).
 */
async function repairAllOrphanRecurrencePayments({ dryRun = false } = {}) {
  const today = todayStr();
  const rules = await RecurringTransactionRule.findAll({
    where: { isActive: true, nextDueDate: { [Op.lte]: today } },
    include: [{ model: FinancialAccount, as: 'financialAccount', attributes: ['id', 'clientId', 'accountName'] }],
    order: [['nextDueDate', 'ASC']],
  });

  const repaired = [];
  const skipped = [];

  for (const rule of rules) {
    const clientId = rule.financialAccount?.clientId;
    if (!clientId) {
      skipped.push({ ruleId: rule.id, reason: 'sem clientId' });
      continue;
    }

    const accountIds = await getActiveAccountIdsForClient(clientId);

    const dueDate = fmtDate(rule.nextDueDate);
    const due = new Date(`${dueDate}T12:00:00Z`);
    const windowStart = new Date(due);
    windowStart.setUTCDate(windowStart.getUTCDate() - 45);
    const windowEnd = new Date(due);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 15);

    const linkedPaid = await FinancialTransaction.findOne({
      where: {
        recurringTransactionRuleId: rule.id,
        isPaidOrReceived: true,
        paymentDate: {
          [Op.between]: [
            windowStart.toISOString().split('T')[0],
            windowEnd.toISOString().split('T')[0],
          ],
        },
      },
    });
    if (linkedPaid) {
      skipped.push({ ruleId: rule.id, reason: 'already_linked_paid' });
      continue;
    }

    const orphan = await findOrphanExpenseForRule(rule, accountIds);
    if (!orphan) {
      skipped.push({ ruleId: rule.id, reason: 'no_matching_orphan' });
      continue;
    }

    if (!dryRun) {
      await recurringTransactionService.advanceRecurringRuleAfterExternalPayment(
        rule.financialAccountId,
        rule.id,
        fmtDate(orphan.paymentDate || orphan.transactionDate),
        { existingTransactionId: orphan.id, linkExistingTx: true }
      );
    }

    repaired.push({
      ruleId: rule.id,
      ruleDescription: rule.description,
      clientId,
      accountName: rule.financialAccount?.accountName,
      transactionId: orphan.id,
      transactionDescription: orphan.description,
      action: dryRun ? 'would_repair' : 'repaired',
    });
  }

  return { repaired, skipped, totalRules: rules.length };
}

async function findOrphanExpenseForRule(rule, accountIds) {
  const dueDate = fmtDate(rule.nextDueDate);
  if (!dueDate) return null;

  const due = new Date(`${dueDate}T12:00:00Z`);
  const windowStart = new Date(due);
  windowStart.setUTCDate(windowStart.getUTCDate() - 45);
  const windowEnd = new Date(due);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 15);
  const startStr = windowStart.toISOString().split('T')[0];
  const endStr = windowEnd.toISOString().split('T')[0];

  const orphans = await FinancialTransaction.findAll({
    where: {
      financialAccountId: { [Op.in]: accountIds },
      type: rule.type,
      isPaidOrReceived: true,
      isPayableOrReceivable: false,
      recurringTransactionRuleId: null,
      transactionDate: { [Op.between]: [startStr, endStr] },
      value: rule.value,
    },
    order: [['transactionDate', 'DESC']],
    limit: 20,
  });

  let best = null;
  let bestScore = 0;
  for (const tx of orphans) {
    const { score } = scoreCandidate(tx.description, rule.description, tx.value, rule.value, {
      overdue: true,
    });
    if (score >= MIN_SCORE_AUTO && score > bestScore) {
      best = tx;
      bestScore = score;
    }
  }
  return best;
}

module.exports = {
  extractTokens,
  scoreCandidate,
  findPaymentTargets,
  findBestPaymentTarget,
  isRecurrenceSettledForCurrentCycle,
  filterRecurrencesAlreadyPaid,
  settleByDescription,
  trySettleAfterCreate,
  repairAllOrphanRecurrencePayments,
  getActiveAccountIdsForClient,
};

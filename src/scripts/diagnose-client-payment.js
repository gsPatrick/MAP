#!/usr/bin/env node
/**
 * Diagnóstico de pagamentos / recorrências de um cliente.
 *
 * Uso (no servidor, com .env de produção):
 *   NODE_ENV=production node src/scripts/diagnose-client-payment.js --client Daniele
 *   NODE_ENV=production node src/scripts/diagnose-client-payment.js --client Daniele --term amanda
 *   NODE_ENV=production node src/scripts/diagnose-client-payment.js --client-id 42 --term amanda
 *   NODE_ENV=production node src/scripts/diagnose-client-payment.js --account "Gastos puro luxo" --term amanda
 *   NODE_ENV=production node src/scripts/diagnose-client-payment.js --global-term amanda --value 1700
 *
 * Cole a saída JSON (bloco DIAGNOSTIC_JSON) no chat para análise.
 */
require('dotenv').config();

const { Op } = require('sequelize');
const {
  sequelize,
  Client,
  FinancialAccount,
  RecurringTransactionRule,
  FinancialTransaction,
} = require('../database');

function parseArgs(argv) {
  const args = {
    client: null,
    clientId: null,
    account: null,
    phone: null,
    term: 'amanda',
    markDescription: 'Pagamento da Amanda',
    globalTerm: null,
    value: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--client' && argv[i + 1]) { args.client = argv[++i]; continue; }
    if (a === '--client-id' && argv[i + 1]) { args.clientId = parseInt(argv[++i], 10); continue; }
    if (a === '--account' && argv[i + 1]) { args.account = argv[++i]; continue; }
    if (a === '--phone' && argv[i + 1]) { args.phone = argv[++i]; continue; }
    if (a === '--term' && argv[i + 1]) { args.term = argv[++i]; continue; }
    if (a === '--global-term' && argv[i + 1]) { args.globalTerm = argv[++i]; continue; }
    if (a === '--mark-description' && argv[i + 1]) { args.markDescription = argv[++i]; continue; }
    if (a === '--value' && argv[i + 1]) { args.value = parseFloat(argv[++i]); continue; }
    if (!a.startsWith('--') && !args.client) args.client = a;
  }
  return args;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function fmtDate(d) {
  if (!d) return null;
  return String(d).split('T')[0];
}

function fmtMoney(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

function extractTokens(text) {
  const stop = new Set([
    'pagamento', 'de', 'da', 'do', 'das', 'dos', 'a', 'o', 'e', 'em', 'no', 'na',
    'conta', 'salario', 'salário', 'colaboradora', 'colaborador',
  ]);
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !stop.has(t));
}

function scoreMatch(userText, candidateText, userValue, candidateValue) {
  const userTokens = extractTokens(userText);
  const candTokens = extractTokens(candidateText);
  let score = 0;
  const shared = userTokens.filter((t) => candTokens.includes(t));
  score += shared.length * 2;
  if (userValue != null && candidateValue != null) {
    const diff = Math.abs(parseFloat(userValue) - parseFloat(candidateValue));
    if (diff < 0.02) score += 3;
  }
  return { score, sharedTokens: shared };
}

function analyzeIssue({ rules, transactions, markDescription, term, today }) {
  const findings = [];
  const termLower = term.toLowerCase();

  const relatedRules = rules.filter((r) => r.description.toLowerCase().includes(termLower));
  const relatedTxs = transactions.filter((t) => t.description.toLowerCase().includes(termLower));

  const overdueRules = relatedRules.filter((r) => r.isActive && r.nextDueDate && r.nextDueDate <= today);
  const orphanPaidExpenses = relatedTxs.filter(
    (t) => !t.isPayableOrReceivable && t.isPaidOrReceived && !t.recurringTransactionRuleId
  );
  const pendingBills = relatedTxs.filter(
    (t) => t.isPayableOrReceivable && !t.isPaidOrReceived
  );
  const paidLinkedToRule = relatedTxs.filter(
    (t) => t.recurringTransactionRuleId && t.isPaidOrReceived
  );

  if (overdueRules.length > 0 && orphanPaidExpenses.length > 0) {
    findings.push({
      code: 'ORPHAN_EXPENSE_WITH_OVERDUE_RECURRENCE',
      severity: 'high',
      message: 'Existe saída avulsa já paga, mas recorrência ainda com vencimento em dia passado/hoje (briefing continua cobrando).',
    });
  }

  if (overdueRules.length > 0 && pendingBills.length === 0 && orphanPaidExpenses.length === 0) {
    findings.push({
      code: 'OVERDUE_RECURRENCE_NO_PENDING_TX',
      severity: 'medium',
      message: 'Recorrência vencida sem conta pendente gerada (job pode não ter rodado ou pagamento adiantado não avançou nextDueDate).',
    });
  }

  const markWouldFindPending = pendingBills.some((t) =>
    t.description.toLowerCase().includes(markDescription.toLowerCase())
  );
  const markWouldFindRule = relatedRules.some((r) =>
    r.description.toLowerCase().includes(markDescription.toLowerCase())
  );

  if (!markWouldFindPending && !markWouldFindRule && (overdueRules.length > 0 || orphanPaidExpenses.length > 0)) {
    findings.push({
      code: 'MARK_SUBSTRING_MISMATCH',
      severity: 'high',
      message: `Busca MARK "%${markDescription}%" não encontra recorrência/conta (descrição real é diferente).`,
      markDescriptionTried: markDescription,
      actualDescriptions: [
        ...relatedRules.map((r) => r.description),
        ...relatedTxs.map((t) => t.description),
      ],
    });
  }

  if (relatedRules.length > 1) {
    findings.push({
      code: 'DUPLICATE_RECURRENCE_RULES',
      severity: 'medium',
      message: 'Mais de uma recorrência com o mesmo termo de busca.',
    });
  }

  return {
    findings,
    summary: {
      relatedRulesCount: relatedRules.length,
      relatedTransactionsCount: relatedTxs.length,
      overdueActiveRules: overdueRules.length,
      orphanPaidExpenses: orphanPaidExpenses.length,
      pendingBills: pendingBills.length,
      paidLinkedToRule: paidLinkedToRule.length,
      markWouldFindPending,
      markWouldFindRule,
    },
    relatedRules,
    relatedTransactions: relatedTxs,
  };
}

async function runGlobalDiscovery(args, today) {
  const term = args.globalTerm;
  const txWhere = { description: { [Op.iLike]: `%${term}%` } };
  const ruleWhere = { description: { [Op.iLike]: `%${term}%` } };
  if (args.value != null && !Number.isNaN(args.value)) {
    txWhere.value = args.value;
    ruleWhere.value = args.value;
  }

  const [txs, rules] = await Promise.all([
    FinancialTransaction.findAll({
      where: txWhere,
      order: [['transactionDate', 'DESC']],
      limit: 30,
    }),
    RecurringTransactionRule.findAll({
      where: ruleWhere,
      order: [['nextDueDate', 'ASC']],
      limit: 30,
    }),
  ]);

  const accountIds = [...new Set([
    ...txs.map((t) => t.financialAccountId),
    ...rules.map((r) => r.financialAccountId),
  ])];
  const accounts = accountIds.length
    ? await FinancialAccount.findAll({
      where: { id: { [Op.in]: accountIds } },
      include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }],
    })
    : [];

  const accountById = Object.fromEntries(accounts.map((a) => [a.id, a]));

  const matches = [];
  for (const t of txs) {
    const acc = accountById[t.financialAccountId];
    matches.push({
      kind: 'transaction',
      id: t.id,
      description: t.description,
      value: fmtMoney(t.value),
      transactionDate: fmtDate(t.transactionDate),
      clientId: acc?.clientId,
      clientName: acc?.ownerClient?.name,
      accountName: acc?.accountName,
      isPayableOrReceivable: t.isPayableOrReceivable,
      isPaidOrReceived: t.isPaidOrReceived,
      recurringTransactionRuleId: t.recurringTransactionRuleId,
    });
  }
  for (const r of rules) {
    const acc = accountById[r.financialAccountId];
    matches.push({
      kind: 'recurrence',
      id: r.id,
      description: r.description,
      value: fmtMoney(r.value),
      nextDueDate: fmtDate(r.nextDueDate),
      clientId: acc?.clientId,
      clientName: acc?.ownerClient?.name,
      accountName: acc?.accountName,
      isActive: r.isActive,
      overdue: r.isActive && fmtDate(r.nextDueDate) <= today,
    });
  }

  return { term, value: args.value, matches };
}

async function main() {
  const args = parseArgs(process.argv);
  const today = todayStr();

  const report = {
    generatedAt: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: process.env.DB_NAME_PROD || process.env.DB_NAME || '(default)',
    search: args,
    clients: [],
    accounts: [],
    recurringRules: [],
    transactions: [],
    globalDiscovery: null,
    markSimulation: null,
    fuzzyMatchSimulation: null,
    analysis: null,
    error: null,
  };

  try {
    await sequelize.authenticate();
    console.log(`[diagnose] Conectado ao banco (${report.environment}). Hoje: ${today}\n`);

    // Modo descoberta global (acha cliente/conta pelo termo ou valor no banco inteiro)
    if (args.globalTerm) {
      report.globalDiscovery = await runGlobalDiscovery(args, today);
      printReport(report);
      process.exit(report.globalDiscovery.matches.length ? 0 : 1);
    }

    let clients = [];
    let accounts = [];

    if (args.account) {
      accounts = await FinancialAccount.findAll({
        where: { accountName: { [Op.iLike]: `%${args.account}%` }, isActive: true },
        order: [['id', 'ASC']],
        limit: 20,
      });
      if (!accounts.length) {
        report.error = `Nenhuma conta ativa encontrada com nome parecido a "${args.account}".`;
        printReport(report);
        process.exit(1);
      }
      const ownerIds = [...new Set(accounts.map((a) => a.clientId))];
      clients = await Client.findAll({ where: { id: { [Op.in]: ownerIds } } });
    } else if (args.clientId) {
      clients = await Client.findAll({ where: { id: args.clientId } });
    } else if (args.phone) {
      clients = await Client.findAll({
        where: { phone: { [Op.iLike]: `%${args.phone.replace(/\D/g, '')}%` } },
        limit: 5,
      });
    } else if (args.client) {
      clients = await Client.findAll({
        where: {
          [Op.or]: [
            { name: { [Op.iLike]: `%${args.client}%` } },
            { phone: { [Op.iLike]: `%${args.client}%` } },
          ],
        },
        limit: 10,
      });
    } else {
      report.error = 'Informe --client, --client-id, --phone, --account ou --global-term.';
      printReport(report);
      process.exit(1);
    }

    if (!clients.length) {
      report.error = `Nenhum cliente encontrado (${JSON.stringify(args)}).`;
      printReport(report);
      process.exit(1);
    }

    report.clients = clients.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      status: c.status,
      accessLevel: c.accessLevel,
      accessExpiresAt: fmtDate(c.accessExpiresAt),
      firstName: (c.name || '').trim().split(/\s+/)[0] || null,
    }));

    const clientIds = clients.map((c) => c.id);
    if (!accounts.length) {
      accounts = await FinancialAccount.findAll({
        where: { clientId: { [Op.in]: clientIds }, isActive: true },
        order: [['clientId', 'ASC'], ['id', 'ASC']],
      });
    }

    report.accounts = accounts.map((a) => ({
      id: a.id,
      clientId: a.clientId,
      clientName: clients.find((c) => c.id === a.clientId)?.name?.trim(),
      accountName: a.accountName,
      accountType: a.accountType,
      isDefault: a.isDefault,
    }));

    const accountIds = accounts.map((a) => a.id);
    if (!accountIds.length) {
      report.error = 'Cliente(s) encontrado(s), mas sem contas financeiras ativas.';
      printReport(report);
      process.exit(1);
    }

    const rules = await RecurringTransactionRule.findAll({
      where: { financialAccountId: { [Op.in]: accountIds } },
      order: [['nextDueDate', 'ASC']],
    });

    report.recurringRules = rules.map((r) => ({
      id: r.id,
      financialAccountId: r.financialAccountId,
      accountName: accounts.find((a) => a.id === r.financialAccountId)?.accountName,
      description: r.description,
      type: r.type,
      value: fmtMoney(r.value),
      frequency: r.frequency,
      nextDueDate: fmtDate(r.nextDueDate),
      lastGeneratedDate: fmtDate(r.lastGeneratedDate),
      isActive: r.isActive,
      isPayableOrReceivable: r.isPayableOrReceivable,
      overdue: r.isActive && fmtDate(r.nextDueDate) <= today,
    }));

    const txs = await FinancialTransaction.findAll({
      where: { financialAccountId: { [Op.in]: accountIds } },
      order: [['transactionDate', 'DESC'], ['id', 'DESC']],
      limit: 200,
    });

    report.transactions = txs.map((t) => ({
      id: t.id,
      financialAccountId: t.financialAccountId,
      accountName: accounts.find((a) => a.id === t.financialAccountId)?.accountName,
      description: t.description,
      type: t.type,
      value: fmtMoney(t.value),
      transactionDate: fmtDate(t.transactionDate),
      dueDate: fmtDate(t.dueDate),
      isPayableOrReceivable: t.isPayableOrReceivable,
      isPaidOrReceived: t.isPaidOrReceived,
      paymentDate: fmtDate(t.paymentDate),
      recurringTransactionRuleId: t.recurringTransactionRuleId,
    }));

    // Simula busca MARK atual (substring)
    const markPending = await FinancialTransaction.findAll({
      where: {
        financialAccountId: { [Op.in]: accountIds },
        description: { [Op.iLike]: `%${args.markDescription}%` },
        isPayableOrReceivable: true,
        isPaidOrReceived: false,
      },
      order: [['dueDate', 'ASC']],
      limit: 5,
    });

    const markRules = await RecurringTransactionRule.findAll({
      where: {
        financialAccountId: { [Op.in]: accountIds },
        isActive: true,
        description: { [Op.iLike]: `%${args.markDescription}%` },
      },
      limit: 5,
    });

    report.markSimulation = {
      descriptionTried: args.markDescription,
      pendingMatches: markPending.map((t) => ({ id: t.id, description: t.description, value: fmtMoney(t.value), dueDate: fmtDate(t.dueDate) })),
      recurrenceMatches: markRules.map((r) => ({ id: r.id, description: r.description, value: fmtMoney(r.value), nextDueDate: fmtDate(r.nextDueDate) })),
      wouldSucceed: markPending.length > 0 || markRules.length > 0,
    };

    // Simula match fuzzy (proposta de correção)
    const activeDueRules = rules.filter((r) => r.isActive && fmtDate(r.nextDueDate) <= today);
    const fuzzyCandidates = activeDueRules.map((r) => {
      const { score, sharedTokens } = scoreMatch(args.markDescription, r.description, null, r.value);
      return {
        kind: 'recurrence',
        id: r.id,
        description: r.description,
        value: fmtMoney(r.value),
        nextDueDate: fmtDate(r.nextDueDate),
        score,
        sharedTokens,
      };
    }).filter((c) => c.score >= 2).sort((a, b) => b.score - a.score);

    report.fuzzyMatchSimulation = {
      descriptionTried: args.markDescription,
      bestCandidates: fuzzyCandidates.slice(0, 5),
      wouldSucceed: fuzzyCandidates.length > 0 && fuzzyCandidates[0].score >= 4,
    };

    report.analysis = analyzeIssue({
      rules: report.recurringRules,
      transactions: report.transactions,
      markDescription: args.markDescription,
      term: args.term,
      today,
    });

    printReport(report);
    process.exit(report.analysis.findings.some((f) => f.severity === 'high') ? 2 : 0);
  } catch (err) {
    report.error = err.message;
    printReport(report);
    process.exit(1);
  } finally {
    try { await sequelize.close(); } catch (_) { /* ignore */ }
  }
}

function printReport(report) {
  console.log('========== DIAGNÓSTICO PAGAMENTO / RECORRÊNCIA ==========\n');

  if (report.error) {
    console.log('ERRO:', report.error, '\n');
  }

  console.log('Clientes:', report.clients.length);
  report.clients.forEach((c) => {
    const fn = c.firstName ? ` (bot chama: "${c.firstName}")` : '';
    console.log(`  - [${c.id}] ${c.name}${fn} | ${c.phone || 'sem telefone'} | ${c.status}`);
  });

  if (report.globalDiscovery) {
    console.log('\n--- DESCOBERTA GLOBAL ---');
    console.log(`Termo: "${report.globalDiscovery.term}" | matches: ${report.globalDiscovery.matches.length}`);
    report.globalDiscovery.matches.slice(0, 20).forEach((m) => {
      console.log(`  - [${m.kind}] cliente#${m.clientId} ${m.clientName} | conta "${m.accountName}" | ${m.description} | R$ ${m.value}`);
    });
  }

  console.log('\nContas ativas:', report.accounts.length);
  report.accounts.forEach((a) => {
    console.log(`  - [${a.id}] cliente#${a.clientId} ${a.clientName || '?'} | ${a.accountName} (${a.accountType})${a.isDefault ? ' [default]' : ''}`);
  });

  if (report.clients.length > 1) {
    console.log('\nDica: várias clientes batem na busca. Se o resultado misturar contas, refine com:');
    console.log('  --client-id <id>   (ex.: --client-id 33 para Daniele Aguiar assinante avancado_anual)');
  }

  const term = (report.search.term || '').toLowerCase();
  const filteredRules = report.recurringRules.filter((r) => r.description.toLowerCase().includes(term));
  const filteredTxs = report.transactions.filter((t) => t.description.toLowerCase().includes(term));

  console.log(`\nRecorrências (termo "${report.search.term}"):`, filteredRules.length);
  filteredRules.forEach((r) => {
    console.log(`  - [${r.id}] ${r.description} | R$ ${r.value} | nextDue: ${r.nextDueDate} | ativa: ${r.isActive}${r.overdue ? ' ⚠️ VENCIDA' : ''}`);
  });

  console.log(`\nTransações (termo "${report.search.term}", últimas 200 gerais):`, filteredTxs.length);
  filteredTxs.slice(0, 15).forEach((t) => {
    const flags = [
      t.isPayableOrReceivable ? 'conta' : 'avulsa',
      t.isPaidOrReceived ? 'paga' : 'pendente',
      t.recurringTransactionRuleId ? `regra#${t.recurringTransactionRuleId}` : 'sem-regra',
    ].join(', ');
    console.log(`  - [${t.id}] ${t.transactionDate} | ${t.description} | R$ ${t.value} | ${flags}`);
  });

  if (report.markSimulation) {
    console.log('\n--- Simulação MARK (busca atual) ---');
    console.log(`Descrição testada: "${report.markSimulation.descriptionTried}"`);
    console.log(`Contas pendentes encontradas: ${report.markSimulation.pendingMatches.length}`);
    report.markSimulation.pendingMatches.forEach((t) => console.log(`    * ${t.description} (R$ ${t.value})`));
    console.log(`Recorrências encontradas: ${report.markSimulation.recurrenceMatches.length}`);
    report.markSimulation.recurrenceMatches.forEach((r) => console.log(`    * ${r.description} (R$ ${r.value})`));
    console.log(`MARK teria sucesso? ${report.markSimulation.wouldSucceed ? 'SIM' : 'NÃO ❌'}`);
  }

  if (report.fuzzyMatchSimulation) {
    console.log('\n--- Simulação fuzzy (correção proposta) ---');
    report.fuzzyMatchSimulation.bestCandidates.forEach((c) => {
      console.log(`  score ${c.score} | ${c.description} | tokens: ${c.sharedTokens.join(', ') || '-'}`);
    });
    console.log(`Fuzzy teria sucesso? ${report.fuzzyMatchSimulation.wouldSucceed ? 'SIM' : 'NÃO'}`);
  }

  if (report.analysis?.findings?.length) {
    console.log('\n--- ACHADOS ---');
    report.analysis.findings.forEach((f) => {
      console.log(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
    });
  } else if (report.analysis) {
    console.log('\n--- ACHADOS ---');
    console.log('  Nenhum problema óbvio detectado para o termo informado.');
  }

  console.log('\n========== COLE ESTE JSON NO CHAT ==========');
  console.log('DIAGNOSTIC_JSON_START');
  console.log(JSON.stringify(report, null, 2));
  console.log('DIAGNOSTIC_JSON_END');
}

main();

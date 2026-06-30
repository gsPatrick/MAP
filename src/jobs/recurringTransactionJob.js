// src/jobs/recurringTransactionJob.js
const cron = require('node-cron');
const { RecurringTransactionRule, FinancialAccount, FinancialTransaction, UserPreference, Client, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { calculateNextDueDate } = require('../utils/dateUtils');
const financialService = require('../features/Financial/financial.service');
const { sendWhatsappMessage, sendButtonListMessage } = require('../services/whatsappService');
// Importando formatadores para consistência
const { formatCurrency, formatDate } = require('../utils/formatters');


async function processRecurringTransactions() {
  logger.info('[JOB RECORRÊNCIA] Iniciando verificação de transações recorrentes...');

  // --- CHECK GLOBAL SWITCH ---
  const systemService = require('../features/System/system.service');
  const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
  if (!isEnabled) {
    logger.warn('[JOB RECORRÊNCIA] Job abortado: Global switch OFF.');
    return;
  }
  // ---------------------------

  const today = new Date().toISOString().split('T')[0];

  try {
    const rulesToProcess = await RecurringTransactionRule.findAll({
      where: {
        isActive: true,
        nextDueDate: { [Op.lte]: today },
        [Op.or]: [
          { endDate: null },
          { endDate: { [Op.gte]: today } }
        ]
      },
      // VERSÃO NOVA E SEGURA
      include: [{
        model: FinancialAccount,
        as: 'financialAccount',
        where: { isActive: true },
        include: [{
          model: Client,
          as: 'ownerClient',
          // --- INÍCIO DA MODIFICAÇÃO: ADICIONA FILTRO DE ASSINATURA ATIVA ---
          where: {
            status: 'Ativo',
            [Op.or]: [
              { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
              { accessExpiresAt: { [Op.gte]: today } }
            ]
          },
          required: true // Garante que só traga regras de clientes com assinatura ativa
          // --- FIM DA MODIFICAÇÃO ---
        }]
      }],
      order: [['nextDueDate', 'ASC']],
    });

    if (rulesToProcess.length === 0) {
      logger.info('[JOB RECORRÊNCIA] Nenhuma regra de recorrência para processar hoje.');
      return;
    }

    logger.info(`[JOB RECORRÊNCIA] ${rulesToProcess.length} regras encontradas para processar.`);

    for (const rule of rulesToProcess) {
      const ruleProcessingTransaction = await sequelize.transaction();
      try {
        const currentRule = await RecurringTransactionRule.findByPk(rule.id, {
          transaction: ruleProcessingTransaction,
          lock: ruleProcessingTransaction.LOCK.UPDATE,
          include: [{
            model: FinancialAccount,
            as: 'financialAccount',
            include: [{ model: Client, as: 'ownerClient' }]
          }]
        });

        if (!currentRule || !currentRule.isActive || new Date(currentRule.nextDueDate).toISOString().split('T')[0] > today ||
          (currentRule.endDate && new Date(currentRule.nextDueDate) > new Date(currentRule.endDate)) ||
          !currentRule.financialAccount || !currentRule.financialAccount.isActive) {
          logger.info(`[JOB RECORRÊNCIA] Regra ID ${rule.id} não aplicável ou processada. Pulando.`);
          await ruleProcessingTransaction.commit();
          continue;
        }

        const client = currentRule.financialAccount.ownerClient;
        const financialAccount = currentRule.financialAccount;
        const clientFirstName = client?.name ? client.name.split(' ')[0] : 'você';

        // TODAS as recorrências agora GERAM a conta (a pagar/receber). Para contas
        // a pagar/receber ela nasce PENDENTE (isPaidOrReceived=false) e o lembrete
        // interativo "pagou? / ainda não" é enviado pelo job de cobrança
        // (remindUnpaidBills) — no vencimento e a cada X dias até ser quitada.
        await financialService.createTransaction(currentRule.financialAccountId, {
          description: currentRule.description,
          type: currentRule.type,
          value: currentRule.value,
          financialCategoryId: currentRule.financialCategoryId,
          transactionDate: currentRule.nextDueDate,
          isPayableOrReceivable: currentRule.isPayableOrReceivable,
          dueDate: currentRule.nextDueDate,
          isPaidOrReceived: currentRule.isPayableOrReceivable ? false : true,
          paymentMethod: currentRule.paymentMethod || 'Pix',
          notes: `Gerado automaticamente: ${currentRule.notes || ''} (Regra ID ${currentRule.id})`,
          recurringTransactionRuleId: currentRule.id,
        }, { transaction: ruleProcessingTransaction });
        logger.info(`[JOB RECORRÊNCIA] Conta gerada para regra ID ${currentRule.id} ("${currentRule.description}") em ${currentRule.nextDueDate} (cliente ${client?.name || 'N/A'}).`);

        const oldNextDueDate = currentRule.nextDueDate;
        const newNextDueDate = calculateNextDueDate(
          currentRule.startDate,
          currentRule.frequency,
          currentRule.interval,
          currentRule.dayOfMonth,
          currentRule.dayOfWeek,
          oldNextDueDate
        );

        if (newNextDueDate && (!currentRule.endDate || new Date(newNextDueDate) <= new Date(currentRule.endDate))) {
          await currentRule.update({
            lastGeneratedDate: oldNextDueDate,
            nextDueDate: newNextDueDate
          }, { transaction: ruleProcessingTransaction });
          logger.info(`[JOB RECORRÊNCIA] Regra ID ${currentRule.id} atualizada. Próximo vencimento: ${newNextDueDate}.`);
        } else {
          await currentRule.update({ isActive: false, lastGeneratedDate: oldNextDueDate, nextDueDate: null }, { transaction: ruleProcessingTransaction });
          logger.info(`[JOB RECORRÊNCIA] Regra ID ${currentRule.id} ("${currentRule.description}") finalizada/expirada. Regra desativada.`);
        }
        await ruleProcessingTransaction.commit();
      } catch (ruleError) {
        await ruleProcessingTransaction.rollback();
        logger.error(`[JOB RECORRÊNCIA] Erro ao processar regra ID ${rule.id} ("${rule.description}"): ${ruleError.message}`, { stack: ruleError.stack });
      }
    }
    logger.info('[JOB RECORRÊNCIA] Processamento de transações recorrentes finalizado.');
  } catch (error) {
    logger.error('[JOB RECORRÊNCIA] Erro geral no job:', { message: error.message, stack: error.stack });
  }
}

/**
 * Realinha (silenciosamente) regras de recorrência ATRASADAS: avança o
 * nextDueDate para a próxima ocorrência a partir de hoje, SEM gerar as
 * transações dos períodos perdidos. Usado para corrigir o acúmulo causado
 * pelo período em que o job não rodou (switch global estava off).
 */
async function realignOverdueRecurringRules() {
  const today = new Date().toISOString().split('T')[0];
  logger.info('[REALINHAR RECORRÊNCIA] Iniciando realinhamento de regras atrasadas...');
  let realigned = 0, deactivated = 0, errors = 0;
  try {
    const overdue = await RecurringTransactionRule.findAll({
      where: { isActive: true, nextDueDate: { [Op.lt]: today } },
    });
    if (overdue.length === 0) {
      logger.info('[REALINHAR RECORRÊNCIA] Nenhuma regra atrasada para realinhar.');
      return { realigned, deactivated, errors };
    }
    for (const rule of overdue) {
      try {
        let nd = rule.nextDueDate;
        let guard = 0;
        while (nd && new Date(nd) < new Date(today) && guard < 1200) {
          nd = calculateNextDueDate(rule.startDate, rule.frequency, rule.interval, rule.dayOfMonth, rule.dayOfWeek, nd);
          guard++;
        }
        if (!nd) { errors++; continue; }
        if (rule.endDate && new Date(nd) > new Date(rule.endDate)) {
          // Passou da data final: desativa. nextDueDate é NOT NULL, então mantém
          // a data calculada (regra inativa de qualquer forma).
          await rule.update({ isActive: false, nextDueDate: nd });
          deactivated++;
        } else {
          await rule.update({ nextDueDate: nd });
          realigned++;
        }
      } catch (e) {
        errors++;
        logger.error(`[REALINHAR RECORRÊNCIA] Erro na regra ID ${rule.id}: ${e.message}`);
      }
    }
    logger.info(`[REALINHAR RECORRÊNCIA] Concluído. Realinhadas: ${realigned}, desativadas (após endDate): ${deactivated}, erros: ${errors}.`);
  } catch (error) {
    logger.error(`[REALINHAR RECORRÊNCIA] Erro geral: ${error.message}`, { stack: error.stack });
  }
  return { realigned, deactivated, errors };
}

// A cada quantos dias re-perguntamos "pagou?" para uma conta ainda em aberto.
const PAYMENT_REMINDER_INTERVAL_DAYS = 3;

/**
 * Cobrança interativa de contas a pagar no vencimento e a cada N dias DEPOIS,
 * até serem marcadas como pagas. Envia botões "✅ Paguei" / "⏳ Ainda não".
 */
async function remindUnpaidBills() {
  logger.info('[JOB COBRANÇA] Verificando contas a pagar no vencimento/atrasadas...');
  const todayStr = new Date().toISOString().split('T')[0];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PAYMENT_REMINDER_INTERVAL_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  try {
    const bills = await FinancialTransaction.findAll({
      where: {
        isPayableOrReceivable: true,
        isPaidOrReceived: false,
        type: 'Saída',
        dueDate: { [Op.lte]: todayStr }, // vence hoje ou já venceu
        [Op.or]: [
          { lastPaymentReminderAt: null },
          { lastPaymentReminderAt: { [Op.lte]: cutoffStr } },
        ],
      },
      include: [{
        model: FinancialAccount, as: 'financialAccount', required: true,
        include: [{
          model: Client, as: 'ownerClient', required: true,
          where: {
            status: 'Ativo',
            [Op.or]: [
              { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
              { accessExpiresAt: { [Op.gte]: todayStr } },
            ],
          },
        }],
      }],
      limit: 500,
    });

    if (bills.length === 0) {
      logger.info('[JOB COBRANÇA] Nenhuma conta a cobrar hoje.');
      return;
    }
    logger.info(`[JOB COBRANÇA] ${bills.length} conta(s) a cobrar.`);

    for (const bill of bills) {
      try {
        const client = bill.financialAccount.ownerClient;
        if (!client || !client.phone) continue;
        const firstName = client.name ? client.name.split(' ')[0] : 'você';
        const venceu = String(bill.dueDate) < todayStr;
        const quando = venceu ? `venceu em *${formatDate(bill.dueDate)}*` : `vence *hoje*`;
        const message =
          `Oi, ${firstName}! 🧾\n\n` +
          `A conta *${bill.description}* (${formatCurrency(bill.value)}) ${quando}.\n` +
          `🏦 Conta: ${bill.financialAccount.accountName}\n\n` +
          `Já pagou?`;

        await sendButtonListMessage(client.phone, message, [
          { id: `billpaid:${bill.financialAccountId}:${bill.id}`, label: '✅ Paguei' },
          { id: `billnot:${bill.id}`, label: '⏳ Ainda não' },
        ], 'Conta a pagar', 'Responder', { immediate: true });

        await bill.update({ lastPaymentReminderAt: todayStr });
        logger.info(`[JOB COBRANÇA] Cobrança enviada (tx ${bill.id}) para ${client.phone}.`);
      } catch (e) {
        logger.error(`[JOB COBRANÇA] Erro na conta ${bill.id}: ${e.message}`);
      }
    }
  } catch (error) {
    logger.error(`[JOB COBRANÇA] Erro geral: ${error.message}`, { error });
  }
}

function startRecurringTransactionJob(preferences, models) { // Mudança aqui para receber prefs e models
  const schedule = preferences?.recurringJobSchedule || '0 4 * * *';
  if (cron.validate(schedule)) {
    logger.info(`[JOB RECORRÊNCIA] Agendado para: ${schedule}`);
    cron.schedule(schedule, processRecurringTransactions, {
      timezone: process.env.TZ || "America/Sao_Paulo",
    });
  } else {
    logger.error(`[JOB RECORRÊNCIA] Schedule cron inválido nas preferências: ${schedule}. Usando default '0 4 * * *'.`);
    cron.schedule('0 4 * * *', processRecurringTransactions, { timezone: process.env.TZ || "America/Sao_Paulo" });
  }

  // Cobrança interativa de contas (no vencimento e a cada N dias depois). 7h, após
  // o job de recorrência (4h) ter gerado as contas do dia.
  const billSchedule = '0 7 * * *';
  logger.info(`[JOB COBRANÇA] Agendado para: ${billSchedule}`);
  cron.schedule(billSchedule, remindUnpaidBills, { timezone: process.env.TZ || "America/Sao_Paulo" });
}

// Removida a lógica de busca de preferências daqui, pois ela é passada como argumento.
// A função agora recebe as preferências para configurar o job.
startRecurringTransactionJob.realignOverdueRecurringRules = realignOverdueRecurringRules;
startRecurringTransactionJob.processRecurringTransactions = processRecurringTransactions;
startRecurringTransactionJob.remindUnpaidBills = remindUnpaidBills;
module.exports = startRecurringTransactionJob;
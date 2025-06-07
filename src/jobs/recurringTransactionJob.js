// src/jobs/recurringTransactionJob.js
const cron = require('node-cron');
const { RecurringTransactionRule, FinancialAccount, UserPreference, Client, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { calculateNextDueDate } = require('../utils/dateUtils');
const financialService = require('../features/Financial/financial.service');
const { sendWhatsappMessage } = require('../services/whatsappService');
// Importando formatadores para consistência
const { formatCurrency, formatDate } = require('../utils/formatters');


async function processRecurringTransactions() {
  logger.info('[JOB RECORRÊNCIA - DIÁRIO] Iniciando verificação de transações recorrentes de baixa frequência...');
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const rulesToProcess = await RecurringTransactionRule.findAll({
      where: {
        isActive: true,
        nextDueDate: { [Op.lte]: new Date() }, // Compara com a data e hora atual
        // <<< MUDANÇA CRÍTICA: Ignora as regras de alta frequência >>>
        frequency: {
            [Op.notIn]: ['minutely', 'hourly']
        },
        [Op.or]: [
            { endDate: null },
            { endDate: { [Op.gte]: new Date() } }
        ]
      },
      include: [{
        model: FinancialAccount,
        as: 'financialAccount',
        where: { isActive: true },
        include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
      }],
      order: [['nextDueDate', 'ASC']],
    });

    if (rulesToProcess.length === 0) {
      logger.info('[JOB RECORRÊNCIA - DIÁRIO] Nenhuma regra de baixa frequência para processar.');
      return;
    }

    logger.info(`[JOB RECORRÊNCIA - DIÁRIO] ${rulesToProcess.length} regras encontradas para processar.`);

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

        if (!currentRule || !currentRule.isActive || currentRule.nextDueDate > new Date() || 
            (currentRule.endDate && currentRule.nextDueDate > currentRule.endDate) ||
            !currentRule.financialAccount || !currentRule.financialAccount.isActive) {
            logger.info(`[JOB RECORRÊNCIA - DIÁRIO] Regra ID ${rule.id} não aplicável ou já processada. Pulando.`);
            await ruleProcessingTransaction.commit();
            continue;
        }

        const client = currentRule.financialAccount.ownerClient;
        const financialAccount = currentRule.financialAccount;
        const clientFirstName = client?.name ? client.name.split(' ')[0] : 'você';

        if (currentRule.autoCreateTransaction) {
          await financialService.createTransaction(currentRule.financialAccountId, {
            description: currentRule.description,
            type: currentRule.type,
            value: currentRule.value,
            financialCategoryId: currentRule.financialCategoryId,
            transactionDate: currentRule.nextDueDate,
            isPayableOrReceivable: currentRule.isPayableOrReceivable,
            dueDate: currentRule.nextDueDate,
            isPaidOrReceived: false,
            paymentMethod: currentRule.paymentMethod,
            notes: `Gerado automaticamente: ${currentRule.notes || ''} (Regra ID ${currentRule.id})`,
            recurringTransactionRuleId: currentRule.id,
          }, { transaction: ruleProcessingTransaction });

          logger.info(`[JOB RECORRÊNCIA - DIÁRIO] Transação criada para regra ID ${currentRule.id} ("${currentRule.description}") na FinancialAccount "${financialAccount.accountName}" em ${currentRule.nextDueDate}.`);
        } else {
          if (client && client.phone) {
            const intro = `Oi, ${clientFirstName}! Passando pra te lembrar da sua conta recorrente que vence hoje! 🤓`;
            const body = `📜 *Descrição:* ${currentRule.description}\n` +
                         `💰 *Valor:* ${formatCurrency(currentRule.value)} (${currentRule.type})\n` +
                         `🗓️ *Vencimento:* ${formatDate(currentRule.nextDueDate)}\n` +
                         `🏦 *Conta:* ${financialAccount.accountName}`;
            const footer = "Não se esqueça de registrar o pagamento quando fizer, ok? 😉";
            const message = `${intro}\n\n${body}\n\n${footer}`;

            await sendWhatsappMessage(client.phone, message);
            logger.info(`[JOB RECORRÊNCIA - DIÁRIO] Lembrete enviado para regra ID ${currentRule.id} para Cliente ${client.name} (${client.phone}).`);
          } else {
            logger.warn(`[JOB RECORRÊNCIA - DIÁRIO] Cliente ou telefone não encontrado para lembrete da regra ID ${currentRule.id}.`);
          }
        }

        const oldNextDueDate = currentRule.nextDueDate;
        const newNextDueDate = calculateNextDueDate(
          currentRule.startDate,
          currentRule.frequency,
          currentRule.interval,
          currentRule.dayOfMonth,
          currentRule.dayOfWeek,
          oldNextDueDate
        );

        if (newNextDueDate && (!currentRule.endDate || newNextDueDate <= newNextDueDate.endDate)) {
          await currentRule.update({
            lastGeneratedDate: oldNextDueDate,
            nextDueDate: newNextDueDate
          }, { transaction: ruleProcessingTransaction });
          logger.info(`[JOB RECORRÊNCIA - DIÁRIO] Regra ID ${currentRule.id} atualizada. Próximo vencimento: ${newNextDueDate}.`);
        } else {
          await currentRule.update({ isActive: false, lastGeneratedDate: oldNextDueDate, nextDueDate: null }, { transaction: ruleProcessingTransaction });
          logger.info(`[JOB RECORRÊNCIA - DIÁRIO] Regra ID ${currentRule.id} ("${currentRule.description}") finalizada/expirada. Regra desativada.`);
        }
        await ruleProcessingTransaction.commit();
      } catch (ruleError) {
        await ruleProcessingTransaction.rollback();
        logger.error(`[JOB RECORRÊNCIA - DIÁRIO] Erro ao processar regra ID ${rule.id} ("${rule.description}"): ${ruleError.message}`, { stack: ruleError.stack });
      }
    }
    logger.info('[JOB RECORRÊNCIA - DIÁRIO] Processamento de transações recorrentes finalizado.');
  } catch (error) {
    logger.error('[JOB RECORRÊNCIA - DIÁRIO] Erro geral no job:', { message: error.message, stack: error.stack });
  }
}

function startRecurringTransactionJob(preferences, models) {
  const schedule = preferences?.recurringJobSchedule || '0 4 * * *';
  if (cron.validate(schedule)) {
    logger.info(`[JOB RECORRÊNCIA - DIÁRIO] Agendado para: ${schedule}`);
    cron.schedule(schedule, processRecurringTransactions, {
      timezone: process.env.TZ || "America/Sao_Paulo",
    });
  } else {
    logger.error(`[JOB RECORRÊNCIA - DIÁRIO] Schedule cron inválido nas preferências: ${schedule}. Usando default '0 4 * * *'.`);
    cron.schedule('0 4 * * *', processRecurringTransactions, { timezone: process.env.TZ || "America/Sao_Paulo" });
  }
}

module.exports = startRecurringTransactionJob;
// src/jobs/highFrequencyRecurringJob.js
const cron = require('node-cron');
const { RecurringTransactionRule, FinancialAccount, Client, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { calculateNextDueDate } = require('../utils/dateUtils');
const financialService = require('../features/Financial/financial.service');

async function processHighFrequencyRules() {
  logger.info('[JOB RECORRÊNCIA - ALTA FREQ] Iniciando verificação...');
  
  try {
    const rulesToProcess = await RecurringTransactionRule.findAll({
      where: {
        isActive: true,
        nextDueDate: { [Op.lte]: new Date() }, // Regras cujo vencimento é agora ou já passou
        frequency: { [Op.in]: ['minutely', 'hourly'] }, // Apenas as de alta frequência
        [Op.or]: [
            { endDate: null },
            { endDate: { [Op.gte]: new Date() } }
        ]
      },
      include: [{ model: FinancialAccount, as: 'financialAccount', where: { isActive: true } }],
      order: [['nextDueDate', 'ASC']],
    });

    if (rulesToProcess.length === 0) {
      return; // Silencioso para não poluir os logs a cada minuto
    }

    logger.info(`[JOB RECORRÊNCIA - ALTA FREQ] ${rulesToProcess.length} regras de alta frequência encontradas para processar.`);

    for (const rule of rulesToProcess) {
      // Usar transação para garantir que a regra seja processada atomicamente
      const ruleProcessingTransaction = await sequelize.transaction();
      try {
        const currentRule = await RecurringTransactionRule.findByPk(rule.id, {
            transaction: ruleProcessingTransaction,
            lock: ruleProcessingTransaction.LOCK.UPDATE,
        });

        // Dupla checagem para evitar race conditions se o job demorar mais de 1 minuto
        if (!currentRule || !currentRule.isActive || currentRule.nextDueDate > new Date()) {
            await ruleProcessingTransaction.commit(); // A regra já foi processada por outra instância
            continue;
        }

        // Para alta frequência, assumimos que a transação é sempre criada, não notificada.
        // Se a notificação fosse necessária, a lógica do outro job seria copiada aqui.
        if (currentRule.autoCreateTransaction) {
            await financialService.createTransaction(currentRule.financialAccountId, {
                description: currentRule.description,
                type: currentRule.type,
                value: currentRule.value,
                financialCategoryId: currentRule.financialCategoryId,
                transactionDate: currentRule.nextDueDate,
                isPayableOrReceivable: false, // Transações de alta frequência são diretas
                recurringTransactionRuleId: currentRule.id,
            }, { transaction: ruleProcessingTransaction });
        } else {
            logger.warn(`[JOB RECORRÊNCIA - ALTA FREQ] Regra ID ${rule.id} é de alta frequência mas 'autoCreateTransaction' é falso. Nenhuma ação tomada.`);
        }

        const oldNextDueDate = currentRule.nextDueDate;
        const newNextDueDate = calculateNextDueDate(
            currentRule.startDate, currentRule.frequency, currentRule.interval,
            null, null, oldNextDueDate // dia do mês/semana não se aplicam
        );

        if (newNextDueDate && (!currentRule.endDate || newNextDueDate <= currentRule.endDate)) {
            await currentRule.update({ lastGeneratedDate: oldNextDueDate, nextDueDate: newNextDueDate }, { transaction: ruleProcessingTransaction });
        } else {
            await currentRule.update({ isActive: false, lastGeneratedDate: oldNextDueDate, nextDueDate: null }, { transaction: ruleProcessingTransaction });
            logger.info(`[JOB RECORRÊNCIA - ALTA FREQ] Regra ID ${currentRule.id} finalizada/expirada e desativada.`);
        }
        await ruleProcessingTransaction.commit();

      } catch (ruleError) {
        await ruleProcessingTransaction.rollback();
        logger.error(`[JOB RECORRÊNCIA - ALTA FREQ] Erro ao processar regra ID ${rule.id}: ${ruleError.message}`);
      }
    }
  } catch (error) {
    logger.error('[JOB RECORRÊNCIA - ALTA FREQ] Erro geral no job:', { message: error.message, stack: error.stack });
  }
}

function startHighFrequencyRecurringJob(preferences, models) {
  const schedule = preferences?.highFrequencyRecurringJobSchedule || '*/1 * * * *'; // A cada minuto
  if (cron.validate(schedule)) {
    logger.info(`[JOB RECORRÊNCIA - ALTA FREQ] Agendado para: ${schedule}`);
    cron.schedule(schedule, processHighFrequencyRules, {
      timezone: process.env.TZ || "America/Sao_Paulo",
    });
  } else {
    logger.error(`[JOB RECORRÊNCIA - ALTA FREQ] Schedule cron inválido: ${schedule}. Usando default '*/1 * * * *'.`);
    cron.schedule('*/1 * * * *', processHighFrequencyRules, { timezone: process.env.TZ || "America/Sao_Paulo" });
  }
}

module.exports = startHighFrequencyRecurringJob;
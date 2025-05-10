// src/jobs/recurringTransactionJob.js
const cron = require('node-cron');
const { RecurringTransactionRule, FinancialAccount, UserPreference, Client, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { calculateNextDueDate } = require('../utils/dateUtils');
const financialService = require('../features/Financial/financial.service');
const { sendWhatsappMessage } = require('../services/whatsappService');

async function processRecurringTransactions() {
  logger.info('[JOB RECORRÊNCIA] Iniciando verificação de transações recorrentes...');
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
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
      include: [{
        model: FinancialAccount,
        as: 'financialAccount',
        where: { isActive: true },
        include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
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
          }, { transaction: ruleProcessingTransaction });

          logger.info(`[JOB RECORRÊNCIA] Transação criada para regra ID ${currentRule.id} ("${currentRule.description}") na FinancialAccount "${financialAccount.accountName}" em ${currentRule.nextDueDate}.`);
        } else {
          if (client && client.phone) {
            const message = `🔔 LEMBRETE RECORRENTE (${financialAccount.accountName}) 🔔\n\n` +
                            `Lembrete para "${currentRule.description}"\n` +
                            `Valor: R$ ${parseFloat(currentRule.value).toFixed(2)}\n` +
                            `Tipo: ${currentRule.type}\n` +
                            `Vencimento: ${new Date(currentRule.nextDueDate).toLocaleDateString('pt-BR')}`;
            await sendWhatsappMessage(client.phone, message);
            logger.info(`[JOB RECORRÊNCIA] Lembrete enviado para regra ID ${currentRule.id} para Cliente ${client.name} (${client.phone}).`);
          } else {
            logger.warn(`[JOB RECORRÊNCIA] Cliente ou telefone não encontrado para lembrete da regra ID ${currentRule.id}.`);
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

function startRecurringTransactionJob() {
  UserPreference.findOne({ order: [['id', 'ASC']] })
    .then(preferences => {
      const schedule = preferences?.recurringJobSchedule || '0 4 * * *'; // Ex: 4 da manhã por padrão
      if (cron.validate(schedule)) {
        logger.info(`[JOB RECORRÊNCIA] Agendado para: ${schedule}`);
        cron.schedule(schedule, processRecurringTransactions, {
          timezone: process.env.TZ || "America/Sao_Paulo",
        });
      } else {
        logger.error(`[JOB RECORRÊNCIA] Schedule cron inválido nas preferências: ${schedule}. Usando default '0 4 * * *'.`);
        cron.schedule('0 4 * * *', processRecurringTransactions, { timezone: process.env.TZ || "America/Sao_Paulo" });
      }
    })
    .catch(error => {
        logger.error('[JOB RECORRÊNCIA] Erro ao buscar preferências para agendar job. Usando default. Detalhes:', error);
        cron.schedule('0 4 * * *', processRecurringTransactions, { timezone: process.env.TZ || "America/Sao_Paulo" });
    });
}

module.exports = startRecurringTransactionJob;
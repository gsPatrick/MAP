// src/jobs/morningBriefingJob.js
const cron = require('node-cron');
const { Client, FinancialAccount, FinancialTransaction, RecurringTransactionRule, Appointment, DailyChecklist, ChecklistItem } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const hydrationService = require('../features/Hydration/hydration.service');
const aiModelService = require('../services/aiModelService');

/**
 * Busca dados e envia o resumo matinal para todos os clientes elegíveis.
 */
async function processAndSendBriefings() {
  logger.info('[JOB BRIEFING MATINAL] Iniciando verificação de resumos diários...');

  // --- CHECK GLOBAL SWITCH ---
  const systemService = require('../features/System/system.service');
  const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
  if (!isEnabled) {
    logger.warn('[JOB BRIEFING MATINAL] Job abortado: Processamento global de automações está DESLIGADO.');
    return;
  }
  // ---------------------------

  try {
    const today = new Date();
    const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));
    const endOfDay = new Date(new Date().setHours(23, 59, 59, 999));
    const todayDateString = startOfDay.toISOString().split('T')[0];

    // <<< INÍCIO DA MODIFICAÇÃO >>>
    // A query agora filtra clientes com assinatura ativa.
    const activeClients = await Client.findAll({
      where: {
        status: 'Ativo',
        phone: { [Op.ne]: null },
        [Op.or]: [
          { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
          { accessExpiresAt: { [Op.gte]: todayDateString } }
        ]
      },
    });
    // <<< FIM DA MODIFICAÇÃO >>>

    if (activeClients.length === 0) {
      logger.info('[JOB BRIEFING MATINAL] Nenhum cliente com assinatura ativa encontrado para enviar o resumo.');
      return;
    }

    logger.info(`[JOB BRIEFING MATINAL] ${activeClients.length} clientes encontrados para processar.`);

    for (const client of activeClients) {
      try {
        const clientAccounts = await client.getFinancialAccounts({ where: { isActive: true } });
        if (clientAccounts.length === 0) continue;

        const accountIds = clientAccounts.map(acc => acc.id);

        const mainAccountForChecklist = clientAccounts.find(acc => acc.isDefault) || clientAccounts[0];

        // --- BUSCA DE DADOS FINANCEIROS E DE AGENDA (EXISTENTE) ---
        const pendingTransactions = await FinancialTransaction.findAll({
          where: {
            financialAccountId: { [Op.in]: accountIds },
            isPayableOrReceivable: true,
            isPaidOrReceived: false,
            dueDate: todayDateString,
          },
          include: [{ model: FinancialAccount, as: 'financialAccount', attributes: ['accountName'] }],
          order: [['value', 'DESC']],
        });

        const appointments = await Appointment.findAll({
          where: {
            financialAccountId: { [Op.in]: accountIds },
            status: { [Op.in]: ['Scheduled', 'Confirmed'] },
            eventDateTime: { [Op.between]: [startOfDay, endOfDay] },
          },
          include: [{ model: FinancialAccount, as: 'financialAccount', attributes: ['accountName'] }],
          order: [['eventDateTime', 'ASC']],
        });

        // Recorrências com vencimento HOJE (baseado na própria regra, não na
        // transação gerada) — assim o briefing menciona a recorrência de forma
        // confiável no dia do vencimento, independe do job de geração já ter rodado.
        const recurringItems = await RecurringTransactionRule.findAll({
          where: {
            financialAccountId: { [Op.in]: accountIds },
            isActive: true,
            nextDueDate: todayDateString,
          },
          include: [{ model: FinancialAccount, as: 'financialAccount', attributes: ['accountName'] }],
          order: [['value', 'DESC']],
        });

        // --- LÓGICA DE CHECKLIST MODIFICADA ---
        let checklistData = null;
        if (mainAccountForChecklist) {
          const checklist = await DailyChecklist.findOne({
            where: { financialAccountId: mainAccountForChecklist.id, date: todayDateString },
            include: [{ model: ChecklistItem, as: 'items', order: [['createdAt', 'ASC']] }]
          });
          checklistData = {
            accountName: mainAccountForChecklist.accountName,
            items: checklist ? checklist.items.map(item => item.toJSON()) : []
          };
        }

        // Ação proativa de hidratação
        await hydrationService.logWaterIntake(client.id, 250, 'Registrado automaticamente pelo briefing matinal');

        const clientFirstName = client.name ? client.name.split(' ')[0] : 'você';

        const briefingData = {
          clientName: clientFirstName,
          pendingTransactions,
          appointments,
          recurringItems,
          checklistData,
        };

        const briefingMessage = await aiModelService.generateMorningBriefingMessage(briefingData);

        await sendWhatsappMessage(client.phone, briefingMessage);
        logger.info(`[JOB BRIEFING MATINAL] Resumo do dia com conselhos gerado por IA e enviado para ${client.name}.`);

      } catch (clientError) {
        logger.error(`[JOB BRIEFING MATINAL] Erro ao processar ou enviar para cliente ${client.id}:`, clientError);
      }
    }
    logger.info('[JOB BRIEFING MATINAL] Processamento de resumos diários finalizado.');
  } catch (error) {
    logger.error('[JOB BRIEFING MATINAL] Erro geral no job:', { message: error.message, stack: error.stack });
  }
}

/**
 * Inicia o agendamento do job.
 */
function startMorningBriefingJob(preferences) {
  const schedule = '0 8 * * *'; // Todo dia às 8:00 da manhã

  logger.info(`[JOB BRIEFING MATINAL] Agendado para rodar diariamente às 8h (schedule: ${schedule})`);

  cron.schedule(schedule, processAndSendBriefings, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startMorningBriefingJob;
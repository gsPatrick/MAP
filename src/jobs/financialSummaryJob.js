// src/jobs/financialSummaryJob.js
const cron = require('node-cron');
const { UserPreference, FinancialAccount, Client } = require('../database');
const financialService = require('../features/Financial/financial.service');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const formatter = require('../features/WhatsappHandler/response.formatter');
const checklistService = require('../features/Checklist/checklist.service');
const { Op } = require('sequelize');

async function sendFinancialSummariesForPeriod(period) {
  logger.info(`[JOB RESUMO FINANCEIRO] Iniciando geração de resumos (${period})...`);

  // <<< CHECK GLOBAL SWITCH REMOVED FOR CORE FUNCTIONALITY >>>
  // const systemService = require('../features/System/system.service');
  // const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
  // if (!isEnabled) {
  //   logger.warn(`[JOB RESUMO FINANCEIRO] Job (${period}) abortado: Global switch OFF.`);
  //   return;
  // }
  // ---------------------------

  try {
    const adminPhoneNumber = process.env.ADMIN_PHONE_FOR_SUMMARIES;
    const todayDateString = new Date().toISOString().split('T')[0];

    const activeFinancialAccounts = await FinancialAccount.findAll({
      where: { isActive: true },
      include: [{
        model: Client,
        as: 'ownerClient',
        attributes: ['id', 'name', 'phone', 'status', 'accessLevel', 'accessExpiresAt'],
        where: {
          status: 'Ativo',
          [Op.or]: [
            { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
            { accessExpiresAt: { [Op.gte]: todayDateString } }
          ]
        }
      }]
    });

    if (activeFinancialAccounts.length === 0) {
      logger.info('[JOB RESUMO FINANCEIRO] Nenhuma conta financeira ativa de clientes com plano ativo para gerar resumo.');
      return;
    }

    // <<< INÍCIO DA MODIFICAÇÃO: Agrupar contas por cliente >>>
    const accountsByClient = new Map();
    for (const account of activeFinancialAccounts) {
      const client = account.ownerClient;
      if (!client || !client.id) continue;

      if (!accountsByClient.has(client.id)) {
        accountsByClient.set(client.id, { clientInfo: client.toJSON(), accounts: [] });
      }
      accountsByClient.get(client.id).accounts.push(account);
    }
    // <<< FIM DA MODIFICAÇÃO: Agrupar contas por cliente >>>

    // <<< INÍCIO DA MODIFICAÇÃO: Loop por cliente, não por conta >>>
    for (const [clientId, clientData] of accountsByClient.entries()) {
      const { clientInfo, accounts } = clientData;
      let summarySections = [];

      try {
        const clientPhone = clientInfo.phone;
        const clientName = clientInfo.name ? clientInfo.name.split(' ')[0] : 'você';
        const targetPhone = clientPhone || adminPhoneNumber;

        if (!targetPhone) {
          logger.warn(`[JOB RESUMO FINANCEIRO] Sem destinatário para resumo do cliente ${clientInfo.name}.`);
          continue;
        }

        // Loop interno para gerar o resumo de cada conta do cliente
        for (const account of accounts) {
          const summary = await financialService.getFinancialSummary(account.id, { period });
          const accountHeader = `*Resumo da Conta: ${account.accountName}*`;
          const body = formatter.formatFinancialSummaryDataStructure(summary);
          summarySections.push(`${accountHeader}\n${body}`);

          // <<< NOVO: Se for mensal, gera e envia o PDF >>>
          if (period === 'monthly') {
            try {
              const now = new Date();
              // Se o job rodar no dia 1, gera o relatório do mês anterior. 
              // Se rodar em outro dia, gera o do mês atual.
              let reportMonth = now.getMonth() + 1;
              let reportYear = now.getFullYear();

              if (now.getDate() <= 5) { // Provavelmente querendo o do mês que fechou
                const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                reportMonth = lastMonth.getMonth() + 1;
                reportYear = lastMonth.getFullYear();
              }

              const { publicUrl, fileName } = await financialService.generateMonthlyReportPdf(account.id, reportMonth, reportYear);
              await require('../services/whatsappService').sendWhatsappDocument(targetPhone, publicUrl, fileName);
              logger.info(`[JOB RESUMO FINANCEIRO] PDF Mensal enviado para ${targetPhone} (Conta: ${account.accountName})`);
            } catch (pdfError) {
              logger.error(`[JOB RESUMO FINANCEIRO] Erro ao gerar/enviar PDF mensal para conta ${account.id}:`, pdfError);
            }
          }
        }

        // Adiciona o checklist apenas uma vez por cliente
        const mainAccountForChecklist = accounts.find(acc => acc.isDefault) || accounts[0];
        let checklistSummaryText = '';
        if (period === 'daily' && mainAccountForChecklist) {
          const checklist = await checklistService.getChecklistByDate(mainAccountForChecklist.id, todayDateString);
          if (checklist && checklist.items && checklist.items.length > 0) {
            const pendingItems = checklist.items.filter(item => !item.completed);
            if (pendingItems.length > 0) {
              checklistSummaryText += `\n\n---\n\n📋 *Checklist do Dia (Pendências na conta ${mainAccountForChecklist.accountName}):*\n`;
              pendingItems.forEach(item => {
                checklistSummaryText += `> 📝 ${item.text}\n`;
              });
            }
          }
        }

        // Monta a mensagem final consolidada
        const intro = `Oi, ${clientName}! ☀️ Que tal um cafezinho e o resumo do seu dia?`;
        const finalBody = summarySections.join('\n\n─────────────────────\n');
        const footer = "Para ver mais detalhes, acesse a plataforma! 😉";
        const message = `${intro}\n\n${finalBody}${checklistSummaryText}\n\n${footer}`;

        await sendWhatsappMessage(targetPhone, message);
        logger.info(`[JOB RESUMO FINANCEIRO] Resumo ${period} consolidado para ${accounts.length} conta(s) do cliente ${clientInfo.name} (ID: ${clientId}) enviado para ${targetPhone}.`);

      } catch (clientError) {
        logger.error(`[JOB RESUMO FINANCEIRO] Erro ao gerar/enviar resumo ${period} para cliente ${clientInfo.name} (ID: ${clientId}):`, { message: clientError.message, stack: clientError.stack });
      }
    }
    // <<< FIM DA MODIFICAÇÃO: Loop por cliente >>>

    logger.info(`[JOB RESUMO FINANCEIRO] Finalizada geração de resumos (${period}).`);
  } catch (error) {
    logger.error(`[JOB RESUMO FINANCEIRO] Erro geral ao gerar/enviar resumos (${period}):`, { message: error.message, stack: error.stack });
  }
}

function startFinancialSummaryJobs() {
  UserPreference.findOne({ order: [['id', 'ASC']] }).then(preferences => {
    if (!preferences) {
      logger.warn('[JOB RESUMO FINANCEIRO] Preferências não encontradas, jobs de resumo não agendados.');
      return;
    }

    if (preferences.dailySummaryTime) {
      const [hD, mD] = preferences.dailySummaryTime.split(':');
      const scheduleDaily = `${mD} ${hD} * * *`;
      if (cron.validate(scheduleDaily)) {
        logger.info(`[JOB RESUMO FINANCEIRO] Resumo Diário agendado para: ${scheduleDaily}`);
        cron.schedule(scheduleDaily, () => sendFinancialSummariesForPeriod('daily'), { timezone: process.env.TZ || "America/Sao_Paulo" });
      } else { logger.error(`[JOB RESUMO FINANCEIRO] Schedule Diário inválido: ${scheduleDaily}`); }
    }

    if (preferences.weeklySummaryTime && preferences.weeklySummaryDayOfWeek !== null && preferences.weeklySummaryDayOfWeek >= 0) {
      const [hW, mW] = preferences.weeklySummaryTime.split(':');
      const scheduleWeekly = `${mW} ${hW} * * ${preferences.weeklySummaryDayOfWeek}`;
      if (cron.validate(scheduleWeekly)) {
        logger.info(`[JOB RESUMO FINANCEIRO] Resumo Semanal agendado para: ${scheduleWeekly}`);
        cron.schedule(scheduleWeekly, () => sendFinancialSummariesForPeriod('weekly'), { timezone: process.env.TZ || "America/Sao_Paulo" });
      } else { logger.error(`[JOB RESUMO FINANCEIRO] Schedule Semanal inválido: ${scheduleWeekly}`); }
    }

    if (preferences.monthlyReportTime && preferences.monthlyReportDayOfMonth) {
      const [hM, mM] = preferences.monthlyReportTime.split(':');
      const scheduleMonthly = `${mM} ${hM} ${preferences.monthlyReportDayOfMonth} * *`;
      if (cron.validate(scheduleMonthly)) {
        logger.info(`[JOB RESUMO FINANCEIRO] Resumo Mensal agendado para: ${scheduleMonthly}`);
        cron.schedule(scheduleMonthly, () => sendFinancialSummariesForPeriod('monthly'), { timezone: process.env.TZ || "America/Sao_Paulo" });
      } else { logger.error(`[JOB RESUMO FINANCEIRO] Schedule Mensal inválido: ${scheduleMonthly}`); }
    }

  }).catch(error => {
    logger.error('[JOB RESUMO FINANCEIRO] Erro ao buscar preferências para agendar jobs de resumo:', { error });
  });
}

module.exports = startFinancialSummaryJobs;
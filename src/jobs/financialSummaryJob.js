// src/jobs/financialSummaryJob.js
const cron = require('node-cron');
const { UserPreference, FinancialAccount, Client } = require('../database');
const financialService = require('../features/Financial/financial.service');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const formatter = require('../features/WhatsappHandler/response.formatter'); // Importa o formatador

async function sendFinancialSummariesForPeriod(period) {
  logger.info(`[JOB RESUMO FINANCEIRO] Iniciando geração de resumos (${period})...`);
  
  try {
    const adminPhoneNumber = process.env.ADMIN_PHONE_FOR_SUMMARIES;

    const activeFinancialAccounts = await FinancialAccount.findAll({
        where: { isActive: true },
        include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
    });

    if (activeFinancialAccounts.length === 0) {
        logger.info('[JOB RESUMO FINANCEIRO] Nenhuma conta financeira ativa para gerar resumo.');
        return;
    }

    for (const account of activeFinancialAccounts) {
        try {
            const clientPhone = account.ownerClient?.phone;
            const clientName = account.ownerClient?.name ? account.ownerClient.name.split(' ')[0] : 'você';
            const targetPhone = clientPhone || adminPhoneNumber;

            if (!targetPhone) {
                logger.warn(`[JOB RESUMO FINANCEIRO] Sem destinatário para resumo da conta ${account.accountName}.`);
                continue;
            }

            // O serviço agora retorna o objeto completo
            const summary = await financialService.getFinancialSummary(account.id, { period });
            
            let introMessageTemplate;
            switch (period) {
                case 'daily':
                    introMessageTemplate = "Oi, {clientName}! ☀️ Que tal um cafezinho e o resumo do seu dia na conta *{accountName}*?";
                    break;
                case 'weekly':
                    introMessageTemplate = "E aí, {clientName}? 🚀 Fim de semana chegando! Hora de conferir o balanço da sua semana na conta *{accountName}*.";
                    break;
                case 'monthly':
                    introMessageTemplate = "Olá, {clientName}! 🗓️ Mês novo, vida nova! Vamos dar uma olhada em como foi o último mês na sua conta *{accountName}*?";
                    break;
                default:
                    introMessageTemplate = "Olá, {clientName}, aqui está o resumo da sua conta *{accountName}*:"
            }

            const intro = introMessageTemplate.replace('{clientName}', clientName).replace('{accountName}', account.accountName);

            // <<< A MÁGICA ACONTECE AQUI >>>
            // Usamos o novo formatador para criar o corpo da mensagem.
            const body = formatter.formatFinancialSummaryDataStructure(summary);

            const footer = "Para ver mais detalhes, acesse a plataforma! 😉";

            const message = `${intro}\n\n${body}\n\n${footer}`;

            await sendWhatsappMessage(targetPhone, message);
            logger.info(`[JOB RESUMO FINANCEIRO] Resumo ${period} para conta ${account.accountName} (ID: ${account.id}) enviado para ${targetPhone}.`);

        } catch (accountError) {
            logger.error(`[JOB RESUMO FINANCEIRO] Erro ao gerar/enviar resumo ${period} para conta ${account.accountName} (ID: ${account.id}):`, { message: accountError.message, stack: accountError.stack });
        }
    }
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

    if (preferences.weeklySummaryTime && preferences.weeklySummaryDayOfWeek !== null && preferences.weeklySummaryDayOfWeek >=0) {
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
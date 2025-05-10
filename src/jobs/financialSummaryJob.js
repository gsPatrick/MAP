// src/jobs/financialSummaryJob.js
const cron = require('node-cron');
const { UserPreference, FinancialAccount, Client } = require('../database');
const financialService = require('../features/Financial/financial.service');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

async function sendFinancialSummariesForPeriod(period) {
  logger.info(`[JOB RESUMO FINANCEIRO] Iniciando geração de resumos (${period})...`);
  
  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    const adminPhoneNumber = process.env.ADMIN_PHONE_FOR_SUMMARIES;

    const activeFinancialAccounts = await FinancialAccount.findAll({
        where: { isActive: true },
        include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
    });

    if (activeFinancialAccounts.length === 0) {
        logger.info('[JOB RESUMO FINANCEIRO] Nenhuma conta financeira ativa para gerar resumo.');
        return;
    }

    let dateStart, dateEndFilter;
    const todayForCalc = new Date(new Date().toISOString().slice(0,10) + 'T00:00:00Z'); // Hoje em UTC para consistência
    let titlePeriod;

    switch (period) {
      case 'daily':
        dateStart = new Date(todayForCalc);
        dateStart.setUTCDate(todayForCalc.getUTCDate() - 1); // Dia anterior completo
        dateEndFilter = new Date(dateStart); 
        dateEndFilter.setUTCHours(23,59,59,999);
        titlePeriod = `Diário (${dateStart.toLocaleDateString('pt-BR', {timeZone: 'UTC'})})`;
        break;
      case 'weekly':
        dateEndFilter = new Date(todayForCalc); 
        dateEndFilter.setUTCDate(todayForCalc.getUTCDate() - 1); // Até o final do dia anterior
        dateEndFilter.setUTCHours(23,59,59,999);
        dateStart = new Date(dateEndFilter);
        dateStart.setUTCDate(dateEndFilter.getUTCDate() - 6); // Últimos 7 dias
        dateStart.setUTCHours(0,0,0,0);
        titlePeriod = `Semanal (${dateStart.toLocaleDateString('pt-BR', {timeZone: 'UTC'})} - ${dateEndFilter.toLocaleDateString('pt-BR', {timeZone: 'UTC'})})`;
        break;
      case 'monthly':
        dateEndFilter = new Date(todayForCalc.getUTCFullYear(), todayForCalc.getUTCMonth(), 0); // Último dia do mês anterior
        dateStart = new Date(dateEndFilter.getUTCFullYear(), dateEndFilter.getUTCMonth(), 1); // Primeiro dia do mês anterior
        titlePeriod = `Mensal (${dateStart.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })})`;
        break;
      default:
        logger.error(`[JOB RESUMO FINANCEIRO] Período inválido: ${period}`);
        return;
    }

    for (const account of activeFinancialAccounts) {
        try {
            const clientPhone = account.ownerClient?.phone;
            const targetPhone = clientPhone || adminPhoneNumber; // Envia para cliente ou admin

            if (!targetPhone) {
                logger.warn(`[JOB RESUMO FINANCEIRO] Sem destinatário para resumo da conta ${account.accountName}.`);
                continue;
            }

            const summary = await financialService.getFinancialSummary(account.id, {
                dateStart: dateStart.toISOString().split('T')[0],
                dateEnd: dateEndFilter.toISOString().split('T')[0]
            });

            let message = `📊 RESUMO FINANCEIRO ${titlePeriod.toUpperCase()} (${account.accountName}) 📊\n\n`;
            message += `Entradas Efetivadas: R$ ${summary.totalEntradas.toFixed(2)}\n`;
            message += `Saídas Efetivadas: R$ ${summary.totalSaidas.toFixed(2)}\n`;
            message += `*Saldo do Período: R$ ${summary.saldoEfetivado.toFixed(2)}*\n\n`;
            message += `Contas a Receber (Pendentes): R$ ${summary.totalAReceberPendente.toFixed(2)}\n`;
            message += `Contas a Pagar (Pendentes): R$ ${summary.totalAPagarPendente.toFixed(2)}\n`;

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
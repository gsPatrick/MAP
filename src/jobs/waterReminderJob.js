// src/jobs/waterReminderJob.js
const cron = require('node-cron');
const { Client, WaterIntakeLog } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage, sendButtonListMessage } = require('../services/whatsappService');
const hydrationService = require('../features/Hydration/hydration.service');
const systemService = require('../features/System/system.service');

async function formatWaterReminderMessage(log, clientName) {
  const todaysLogs = await hydrationService.getTodaysLogsByClient(log.clientId);
  const prefs = await systemService.getSystemPreferences();

  const totalCompleted = todaysLogs.filter(l => l.status === 'completed').reduce((sum, l) => sum + l.amount, 0);
  const goal = prefs.dailyGoalMl || 2000;
  const percentage = goal > 0 ? Math.round((totalCompleted / goal) * 100) : 0;

  const scheduledTimeFormatted = log.scheduledTime.substring(0, 5);

  let introMessage = "";
  if (log.status === 'pending') {
    introMessage = `Olá, ${clientName}! 👋 É a sua hora de se hidratar agora, às *${scheduledTimeFormatted}*! 💧`;
  } else if (log.status === 'notified') {
    introMessage = `Psiu, ${clientName}! 😉 Ainda te esperando para seu copo d'água das *${scheduledTimeFormatted}*! ⏳`;
  }

  let message = `${introMessage}\n\n`;
  message += `Sua dose agora: *${log.amount}ml*\n`;
  message += `Progresso do dia: *${totalCompleted}ml* de *${goal}ml* (${percentage}%)\n\n`;

  if (percentage >= 100) {
    message += `Parabéns, meta batida! 🎉 Continue se hidratando para manter a energia!`;
  } else {
    const remaining = goal - totalCompleted;
    message += `Faltam *${remaining}ml* para atingir sua meta diária. Vamos lá! 💪`;
  }

  return message;
}

async function checkAndSendWaterReminder() {
  // <<< CHECK GLOBAL SWITCH REMOVED FOR CORE FUNCTIONALITY >>>
  // const systemService = require('../features/System/system.service'); // Requiring conditionally or at top if safe. Using inside to be safe against circles.
  // const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
  // if (!isEnabled) {
  //   // logger.debug('[JOB ÁGUA] Job abortado: Global switch OFF.'); // Descomente para debugar se quiser, mas pode floodar log
  //   return;
  // }
  // ---------------------------

  try {
    const now = new Date();
    const currentTime = now.toTimeString().split(' ')[0];
    const nowInTimezone = new Date(now.toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" }));
    const todayDateString = nowInTimezone.toISOString().split('T')[0];

    // <<< INÍCIO DA MODIFICAÇÃO >>>
    // A query agora junta com Client e filtra por assinatura ativa.
    const clientFilter = {
      status: 'Ativo',
      [Op.or]: [
        { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
        { accessExpiresAt: { [Op.gte]: todayDateString } }
      ]
    };

    const pendingLogs = await WaterIntakeLog.findAll({
      where: {
        intakeDate: todayDateString,
        status: 'pending',
        scheduledTime: { [Op.lte]: currentTime },
      },
      include: [{
        model: Client,
        as: 'client',
        where: clientFilter,
        attributes: ['id', 'phone', 'name'],
        required: true
      }]
    });

    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const notifiedLogsToResend = await WaterIntakeLog.findAll({
      where: {
        intakeDate: todayDateString,
        status: 'notified',
        updatedAt: { [Op.lte]: fiveMinutesAgo },
      },
      include: [{
        model: Client,
        as: 'client',
        where: clientFilter,
        attributes: ['id', 'phone', 'name'],
        required: true
      }]
    });
    // <<< FIM DA MODIFICAÇÃO >>>

    const logsToProcess = [...pendingLogs, ...notifiedLogsToResend];

    if (logsToProcess.length === 0) {
      return;
    }

    logger.info(`[JOB ÁGUA] Encontrados ${logsToProcess.length} logs de hidratação para processar ou reenviar.`);

    for (const log of logsToProcess) {
      if (log.client && log.client.phone) {
        const clientName = log.client.name ? log.client.name.split(' ')[0] : 'pessoa incrível';
        const reminderText = await formatWaterReminderMessage(log, clientName);

        const buttons = [
          { id: `water_intake:bebi:${log.id}`, label: 'Bebi! ✅' },
          { id: `water_intake:nao_bebi:${log.id}`, label: 'Ainda não ❌' },
        ];

        logger.info(`[JOB ÁGUA] Enviando/Reenviando lembrete para ${log.client.name} (ID do Log: ${log.id}).`);
        const sent = await sendButtonListMessage(log.client.phone, reminderText, buttons);

        if (sent) {
          await log.update({ status: 'notified' });
          logger.info(`[JOB ÁGUA] Lembrete para o cliente ${log.client.name} enviado/reenviado (Log ID: ${log.id}) e status marcado como 'notified'.`);
        } else {
          logger.error(`[JOB ÁGUA] Falha ao enviar/reenviar lembrete para o cliente ${log.client.name} (Log ID: ${log.id}).`);
        }
      } else {
        logger.warn(`[JOB ÁGUA] Log ID ${log.id} não pôde ser processado pois o cliente associado não tem telefone.`);
        if (log.status === 'pending') {
          await log.update({ status: 'failed' });
        }
      }
    }
  } catch (error) {
    logger.error('[JOB ÁGUA] Erro no job de lembrete de água:', { message: error.message, stack: error.stack });
  }
}

function startWaterReminderJob(preferences) {
  const schedule = preferences?.waterReminderJobSchedule || '*/1 * * * *';

  logger.info(`[JOB ÁGUA] Agendado para verificar e reenviar lembretes (schedule: ${schedule})`);

  cron.schedule(schedule, checkAndSendWaterReminder, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startWaterReminderJob;
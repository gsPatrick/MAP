// src/jobs/waterReminderJob.js
const cron = require('node-cron');
const { Client, WaterIntakeLog } = require('../database');
const { Op } = require('sequelize');
const logger =require('../utils/logger');
const { sendWhatsappMessage, sendButtonListMessage } = require('../services/whatsappService');
const hydrationService = require('../features/Hydration/hydration.service'); // Importar o serviço de hidratação
const systemService = require('../features/System/system.service'); // Importar o serviço de sistema

// Função para formatar a mensagem de lembrete de água com detalhes
async function formatWaterReminderMessage(log, clientName) {
  const todaysLogs = await hydrationService.getTodaysLogsByClient(log.clientId);
  const prefs = await systemService.getSystemPreferences(); // Assumindo preferências globais, ou buscar por client.id se forem individuais

  const totalCompleted = todaysLogs.filter(l => l.status === 'completed').reduce((sum, l) => sum + l.amount, 0);
  const goal = prefs.dailyGoalMl || 2000; // Usar a meta definida ou padrão
  const percentage = goal > 0 ? Math.round((totalCompleted / goal) * 100) : 0;

  const scheduledTimeFormatted = log.scheduledTime.substring(0, 5); // HH:MM
  
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
  try {
    const now = new Date();
    const currentTime = now.toTimeString().split(' ')[0]; // Formato HH:MM:SS

    // Converte 'now' para o fuso horário configurado antes de formatar para DATEONLY
    const nowInTimezone = new Date(now.toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
    const todayDateString = nowInTimezone.toISOString().split('T')[0];

    // 1. Busca todos os LOGS que estão PENDENTES para hoje e cujo horário agendado já passou
    const pendingLogs = await WaterIntakeLog.findAll({
      where: {
        intakeDate: todayDateString,
        status: 'pending',
        scheduledTime: {
          [Op.lte]: currentTime,
        },
      },
      include: [{
        model: Client,
        as: 'client',
        where: { status: 'Ativo' },
        attributes: ['id', 'phone', 'name'],
        required: true
      }]
    });

    // 2. Busca logs que foram 'notified' (lembrete enviado) há mais de 5 minutos e não foram 'completed'
    // Esta é a lógica que garante o atraso de 5 minutos para os *reenvios*.
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutos atrás
    const notifiedLogsToResend = await WaterIntakeLog.findAll({
      where: {
        intakeDate: todayDateString,
        status: 'notified', 
        updatedAt: { 
            [Op.lte]: fiveMinutesAgo, // Só considera logs cujo 'notified' foi há 5 minutos ou mais.
        },
      },
      include: [{
        model: Client,
        as: 'client',
        where: { status: 'Ativo' },
        attributes: ['id', 'phone', 'name'],
        required: true
      }]
    });

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
          // Marca o log como 'notified' para indicar que a mensagem foi enviada/reenviada
          // O `updatedAt` será atualizado automaticamente, servindo como timestamp para reenvio.
          await log.update({ status: 'notified' }); 
          logger.info(`[JOB ÁGUA] Lembrete para o cliente ${log.client.name} enviado/reenviado (Log ID: ${log.id}) e status marcado como 'notified'.`);
        } else {
          logger.error(`[JOB ÁGUA] Falha ao enviar/reenviar lembrete para o cliente ${log.client.name} (Log ID: ${log.id}). O log permanece como 'notified' ou 'pending'.`);
        }
      } else {
          logger.warn(`[JOB ÁGUA] Log ID ${log.id} não pôde ser processado pois o cliente associado não tem telefone. Marcando como falho se não foi notificado.`);
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
  // Agenda para verificar a cada 1 minuto para poder reenviar lembretes a cada 5 minutos
  const schedule = preferences?.waterReminderJobSchedule || '*/1 * * * *'; 
  
  logger.info(`[JOB ÁGUA] Agendado para verificar e reenviar lembretes (schedule: ${schedule})`);
  
  cron.schedule(schedule, checkAndSendWaterReminder, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startWaterReminderJob;
// src/jobs/appointmentReminderJob.js
const cron = require('node-cron');
const appointmentService = require('../features/Appointment/appointment.service');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const { sequelize } = require('../database');
// Importando formatadores para consistência
const { formatDate, formatTime, formatCurrency } = require('../utils/formatters');

// Helper de formatação local para evitar dependência circular com whatsapp.service
function formatAppointmentReminder(appointment, clientName) {
    if (!appointment) return "Dados do compromisso não disponíveis.";
    
    let data = `💼 *Título:* ${appointment.title || 'N/A'}\n`;
    data += `🗓️ *Data:* ${formatDate(appointment.eventDateTime)}\n`;
    data += `⏰ *Horário:* ${formatTime(appointment.eventDateTime)}\n`;

    if (appointment.durationMinutes) {
        const endTime = new Date(new Date(appointment.eventDateTime).getTime() + appointment.durationMinutes * 60000);
        data += `🏁 *Término Estimado:* ${formatTime(endTime)}\n`;
    }
    if (appointment.location) {
        data += `📍 *Local:* ${appointment.location}\n`;
    }
    if (appointment.associatedValue && appointment.associatedTransactionType) {
        data += `💰 *Valor Associado:* ${formatCurrency(appointment.associatedValue)} (${appointment.associatedTransactionType})\n`;
    }
    if (appointment.businessClients && appointment.businessClients.length > 0) {
        data += `👥 *Com:* ${appointment.businessClients.map(c => c.name).join(', ')}\n`;
    }
    if (appointment.notes) {
        data += `🗒️ *Observações:* ${appointment.notes}\n`;
    }
    return data.trim();
}

async function sendAppointmentReminders() {
  logger.info('[JOB LEMBRETE COMPROMISSO] Verificando compromissos...');
  try {
    const appointmentsToRemind = await appointmentService.getAppointmentsNeedingReminder(null);

    if (appointmentsToRemind.length === 0) {
      return;
    }
    logger.info(`[JOB LEMBRETE COMPROMISSO] ${appointmentsToRemind.length} compromissos encontrados para lembrar.`);

    for (const app of appointmentsToRemind) {
      try {
        const currentAppointmentCheck = await appointmentService.getAppointmentById(app.financialAccount?.id, app.id);
        if(!currentAppointmentCheck || currentAppointmentCheck.reminderSentTimestamp || !currentAppointmentCheck.reminderEnabled ||
           (currentAppointmentCheck.status !== 'Scheduled' && currentAppointmentCheck.status !== 'Confirmed')){
            logger.info(`[JOB LEMBRETE COMPROMISSO] Compromisso ID ${app.id} não precisa mais de lembrete (status: ${currentAppointmentCheck?.status}, sent: ${currentAppointmentCheck?.reminderSentTimestamp}). Pulando.`);
            continue;
        }

        const clientPhone = app.financialAccount?.ownerClient?.phone;
        const clientFirstName = app.financialAccount?.ownerClient?.name?.split(' ')[0] || 'Você';
        const accountName = app.financialAccount?.accountName || 'Sua Conta';

        if (!clientPhone) {
          logger.warn(`[JOB LEMBRETE COMPROMISSO] Compromisso ID ${app.id} (Conta: ${accountName}) não possui cliente com telefone. Marcando como enviado.`);
          await appointmentService.markReminderAsSent(app.id);
          continue;
        }

        // Construção da nova mensagem
        const intro = `Oi, ${clientFirstName}! Passando para te dar um toque sobre seu compromisso na conta *${accountName}* que está chegando! 😉`;
        const body = formatAppointmentReminder(app, clientFirstName);
        const footer = `Qualquer coisa, me avise! Tenha um ótimo compromisso! ✨`;
        const message = `${intro}\n\n${body}\n\n${footer}`;

        const sentSuccessfully = await sendWhatsappMessage(clientPhone, message);
        if (sentSuccessfully) {
            logger.info(`[JOB LEMBRETE COMPROMISSO] Lembrete para "${app.title}" (Conta: ${accountName}) enviado para Cliente ${clientFirstName} (${clientPhone})`);
            await appointmentService.markReminderAsSent(app.id);
        } else {
            logger.error(`[JOB LEMBRETE COMPROMISSO] Falha ao enviar lembrete via WhatsApp para compromisso ID ${app.id}.`);
        }
      } catch (sendError) {
        logger.error(`[JOB LEMBRETE COMPROMISSO] Erro ao processar/enviar lembrete para compromisso ID ${app.id}:`, { message: sendError.message, stack: sendError.stack });
      }
    }
     logger.info('[JOB LEMBRETE COMPROMISSO] Verificação de compromissos concluída.');
  } catch (error) {
    logger.error('[JOB LEMBRETE COMPROMISSO] Erro geral:', { message: error.message, stack: error.stack });
  }
}


function startAppointmentReminderJob(preferences, models) {
  const schedule = preferences?.appointmentReminderJobSchedule || '*/5 * * * *';

  if (cron.validate(schedule)) {
    logger.info(`[JOB LEMBRETE COMPROMISSO] Agendado para rodar: ${schedule}`);
    cron.schedule(schedule, sendAppointmentReminders, {
      timezone: process.env.TZ || "America/Sao_Paulo",
    });
  } else {
    logger.error(`[JOB LEMBRETE COMPROMISSO] Schedule cron inválido nas preferências: ${schedule}. Usando default '*/5 * * * *'.`);
    cron.schedule('*/5 * * * *', sendAppointmentReminders, { timezone: process.env.TZ || "America/Sao_Paulo" });
  }
}

module.exports = startAppointmentReminderJob;
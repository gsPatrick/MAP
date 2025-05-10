// src/jobs/appointmentReminderJob.js
const cron = require('node-cron');
const appointmentService = require('../features/Appointment/appointment.service');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const { UserPreference, sequelize } = require('../database'); // sequelize para transações

async function sendAppointmentReminders() {
  logger.info('[JOB LEMBRETE COMPROMISSO] Verificando compromissos...');
  try {
    const appointmentsToRemind = await appointmentService.getAppointmentsNeedingReminder(null);

    if (appointmentsToRemind.length === 0) {
      return;
    }
    logger.info(`[JOB LEMBRETE COMPROMISSO] ${appointmentsToRemind.length} compromissos encontrados para lembrar.`);

    for (const app of appointmentsToRemind) {
      const processingTransaction = await sequelize.transaction();
      try {
        // Re-check dentro da transação para evitar race conditions
        const currentAppointmentCheck = await appointmentService.getAppointmentById(app.financialAccountId, app.id); // Usa o service
        if(!currentAppointmentCheck || currentAppointmentCheck.reminderSentTimestamp || !currentAppointmentCheck.reminderEnabled || 
           (currentAppointmentCheck.status !== 'Scheduled' && currentAppointmentCheck.status !== 'Confirmed')){
            logger.info(`[JOB LEMBRETE COMPROMISSO] Compromisso ID ${app.id} não precisa mais de lembrete (status: ${currentAppointmentCheck?.status}, sent: ${currentAppointmentCheck?.reminderSentTimestamp}). Pulando.`);
            await processingTransaction.commit();
            continue;
        }

        const clientPhone = app.financialAccount?.ownerClient?.phone;
        const clientName = app.financialAccount?.ownerClient?.name?.split(' ')[0] || 'Você';
        const accountName = app.financialAccount?.accountName || 'Sua Conta';

        if (!clientPhone) {
          logger.warn(`[JOB LEMBRETE COMPROMISSO] Compromisso ID ${app.id} (Conta: ${accountName}) não possui cliente com telefone.`);
          await appointmentService.markReminderAsSent(app.id); // Marca como enviado para não tentar de novo
          await processingTransaction.commit();
          continue;
        }

        const eventDate = new Date(app.eventDateTime).toLocaleDateString('pt-BR', { timeZone: process.env.TZ || 'America/Sao_Paulo' });
        const eventTime = new Date(app.eventDateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' });
        
        let message = `🔔 LEMBRETE DE COMPROMISSO (${accountName}) 🔔\n\n`;
        message += `Olá ${clientName}!\n`;
        message += `Lembrete para: *${app.title}*\n`;
        message += `Data: ${eventDate} às ${eventTime}\n`;
        if (app.location) message += `Local: ${app.location}\n`;
        message += `\nAté breve!`;

        const sentSuccessfully = await sendWhatsappMessage(clientPhone, message);
        if (sentSuccessfully) {
            logger.info(`[JOB LEMBRETE COMPROMISSO] Lembrete para "${app.title}" (Conta: ${accountName}) enviado para Cliente ${clientName} (${clientPhone})`);
            await appointmentService.markReminderAsSent(app.id);
        } else {
            logger.error(`[JOB LEMBRETE COMPROMISSO] Falha ao enviar lembrete via WhatsApp para compromisso ID ${app.id}.`);
        }
        await processingTransaction.commit();
      } catch (sendError) {
        await processingTransaction.rollback();
        logger.error(`[JOB LEMBRETE COMPROMISSO] Erro ao processar/enviar lembrete para compromisso ID ${app.id}:`, { message: sendError.message, stack: sendError.stack });
      }
    }
  } catch (error) {
    logger.error('[JOB LEMBRETE COMPROMISSO] Erro geral:', { message: error.message, stack: error.stack });
  }
}

function startAppointmentReminderJob() {
  UserPreference.findOne({ order: [['id', 'ASC']] })
    .then(preferences => {
        const schedule = preferences?.appointmentReminderJobSchedule || '*/5 * * * *'; // A cada 5 minutos por padrão
        if (cron.validate(schedule)) {
            logger.info(`[JOB LEMBRETE COMPROMISSO] Agendado para rodar: ${schedule}`);
            cron.schedule(schedule, sendAppointmentReminders, {
            timezone: process.env.TZ || "America/Sao_Paulo",
            });
        } else {
            logger.error(`[JOB LEMBRETE COMPROMISSO] Schedule cron inválido: ${schedule}. Usando default '*/5 * * * *'.`);
            cron.schedule('*/5 * * * *', sendAppointmentReminders, { timezone: process.env.TZ || "America/Sao_Paulo" });
        }
    }).catch(error => {
        logger.error('[JOB LEMBRETE COMPROMISSO] Erro ao buscar prefs. Usando default. Detalhes:', error);
        cron.schedule('*/5 * * * *', sendAppointmentReminders, { timezone: process.env.TZ || "America/Sao_Paulo" });
    });
}

module.exports = startAppointmentReminderJob;
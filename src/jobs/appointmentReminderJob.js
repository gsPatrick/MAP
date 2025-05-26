// src/jobs/appointmentReminderJob.js
const cron = require('node-cron');
const appointmentService = require('../features/Appointment/appointment.service');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const { sequelize } = require('../database'); // Mantém sequelize se necessário para transações ou outros usos no job execution logic

async function sendAppointmentReminders() {
  // A lógica interna que *executa* o job (enviar lembretes)
  // pode precisar do modelo UserPreference em tempo de execução para pegar configs mais recentes
  // ou para buscar clientes. Pode re-importar UserPreference aqui DENTRO se necessário.
  // Ex: const { UserPreference } = require('../database');

  logger.info('[JOB LEMBRETE COMPROMISSO] Verificando compromissos...');
  try {
    // O appointmentService já lida com acesso a DB e inclui associações necessárias
    const appointmentsToRemind = await appointmentService.getAppointmentsNeedingReminder(null);

    if (appointmentsToRemind.length === 0) {
      // logger.debug('[JOB LEMBRETE COMPROMISSO] Nenhuma compromisso encontrado precisando de lembrete.');
      return;
    }
    logger.info(`[JOB LEMBRETE COMPROMISSO] ${appointmentsToRemind.length} compromissos encontrados para lembrar.`);

    for (const app of appointmentsToRemind) {
      const transaction = await sequelize.transaction(); // Exemplo: se o service precisasse de transação externa
      try {
        // Re-check dentro da transação se o service usar transaction parameter
        // No entanto, appointmentService.markReminderAsSent já tem logic interna
        const currentAppointmentCheck = await appointmentService.getAppointmentById(app.financialAccount?.id, app.id); // Usa o service, passando financialAccountId
        if(!currentAppointmentCheck || currentAppointmentCheck.reminderSentTimestamp || !currentAppointmentCheck.reminderEnabled ||
           (currentAppointmentCheck.status !== 'Scheduled' && currentAppointmentCheck.status !== 'Confirmed')){
            logger.info(`[JOB LEMBRETE COMPROMISSO] Compromisso ID ${app.id} não precisa mais de lembrete (status: ${currentAppointmentCheck?.status}, sent: ${currentAppointmentCheck?.reminderSentTimestamp}). Pulando.`);
            // if (transaction) await transaction.commit();
            continue;
        }

        const clientPhone = app.financialAccount?.ownerClient?.phone;
        const clientName = app.financialAccount?.ownerClient?.name?.split(' ')[0] || 'Você';
        const accountName = app.financialAccount?.accountName || 'Sua Conta';

        if (!clientPhone) {
          logger.warn(`[JOB LEMBRETE COMPROMISSO] Compromisso ID ${app.id} (Conta: ${accountName}) não possui cliente com telefone. Marcando como enviado.`);
          await appointmentService.markReminderAsSent(app.id); // Marca como enviado para não tentar de novo
          // if (transaction) await transaction.commit();
          continue;
        }

        const eventDate = new Date(app.eventDateTime).toLocaleDateString('pt-BR', { timeZone: process.env.TZ || 'America/Sao_Paulo' });
        const eventTime = new Date(app.eventDateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' });

        let message = `🔔 LEMBRETE DE COMPROMISSO (${accountName}) 🔔\n\n`;
        message += `Olá ${clientName}!\n`;
        message += `Lembrete para: *${app.title}*\n`;
        message += `Data: ${eventDate} às ${eventTime}\n`;
        if (app.location) message += `Local: ${app.location}\n`;

        // Incluir Business Clients associados se a conta for PJ/MEI
        if (app.businessClients && app.businessClients.length > 0 && ['PJ', 'MEI'].includes(app.financialAccount?.accountType)) {
             message += `\nCom: `;
             message += app.businessClients.map(bc => bc.name).join(', ');
             message += `\n`;
         }

        message += `\nAté breve!`;

        const sentSuccessfully = await sendWhatsappMessage(clientPhone, message);
        if (sentSuccessfully) {
            logger.info(`[JOB LEMBRETE COMPROMISSO] Lembrete para "${app.title}" (Conta: ${accountName}) enviado para Cliente ${clientName} (${clientPhone})`);
            await appointmentService.markReminderAsSent(app.id); // Mark as sent AFTER successful send attempt
        } else {
            logger.error(`[JOB LEMBRETE COMPROMISSO] Falha ao enviar lembrete via WhatsApp para compromisso ID ${app.id}.`);
            // Decide if you want to retry later or mark as sent anyway
        }
        // if (transaction) await transaction.commit();
      } catch (sendError) {
        // if (transaction) await transaction.rollback();
        logger.error(`[JOB LEMBRETE COMPROMISSO] Erro ao processar/enviar lembrete para compromisso ID ${app.id}:`, { message: sendError.message, stack: sendError.stack });
      }
    }
     logger.info('[JOB LEMBRETE COMPROMISSO] Verificação de compromissos concluída.');
  } catch (error) {
    logger.error('[JOB LEMBRETE COMPROMISSO] Erro geral:', { message: error.message, stack: error.stack });
  }
}


// Modifica a função start para receber preferências e modelos
function startAppointmentReminderJob(preferences, models) { // <-- RECEBE preferences e models
  // Remove a chamada UserPreference.findOne() daqui
  // Usa as preferências passadas
  const schedule = preferences?.appointmentReminderJobSchedule || '*/5 * * * *';

  if (cron.validate(schedule)) {
    logger.info(`[JOB LEMBRETE COMPROMISSO] Agendado para rodar: ${schedule}`);
    // Agenda a função principal de lógica do job
    cron.schedule(schedule, sendAppointmentReminders, {
      timezone: process.env.TZ || "America/Sao_Paulo",
    });
  } else {
    logger.error(`[JOB LEMBRETE COMPROMISSO] Schedule cron inválido nas preferências: ${schedule}. Usando default '*/5 * * * *'.`);
    cron.schedule('*/5 * * * *', sendAppointmentReminders, { timezone: process.env.TZ || "America/Sao_Paulo" });
  }
  // O bloco .catch que lidava com o erro do findOne() não é mais necessário aqui
}

module.exports = startAppointmentReminderJob;
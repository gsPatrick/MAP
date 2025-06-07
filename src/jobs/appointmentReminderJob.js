// src/jobs/appointmentReminderJob.js
const cron = require('node-cron');
const { sequelize } = require('../database');
const appointmentService = require('../features/Appointment/appointment.service');
const financialService = require('../features/Financial/financial.service'); // <<< NOVO IMPORT
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const { formatDate, formatTime, formatCurrency } = require('../utils/formatters');

// --- Função para enviar lembretes (lógica existente) ---
async function sendAppointmentReminders() {
  logger.info('[JOB APPT] Verificando lembretes de compromissos...');
  try {
    const appointmentsToRemind = await appointmentService.getAppointmentsNeedingReminder(null);

    if (appointmentsToRemind.length === 0) {
      return;
    }
    logger.info(`[JOB APPT] ${appointmentsToRemind.length} compromissos encontrados para lembrar.`);

    for (const app of appointmentsToRemind) {
      try {
        const currentAppointmentCheck = await appointmentService.getAppointmentById(app.financialAccount?.id, app.id);
        if(!currentAppointmentCheck || currentAppointmentCheck.reminderSentTimestamp || !currentAppointmentCheck.reminderEnabled ||
           (currentAppointmentCheck.status !== 'Scheduled' && currentAppointmentCheck.status !== 'Confirmed')){
            logger.info(`[JOB APPT] Lembrete para compromisso ID ${app.id} não é mais necessário. Pulando.`);
            continue;
        }

        const clientPhone = app.financialAccount?.ownerClient?.phone;
        const clientFirstName = app.financialAccount?.ownerClient?.name?.split(' ')[0] || 'Você';
        const accountName = app.financialAccount?.accountName || 'Sua Conta';

        if (!clientPhone) {
          logger.warn(`[JOB APPT] Lembrete para compromisso ID ${app.id} não enviado (cliente sem telefone). Marcando como enviado.`);
          await appointmentService.markReminderAsSent(app.id);
          continue;
        }

        const intro = `Oi, ${clientFirstName}! Passando para te dar um toque sobre seu compromisso na conta *${accountName}* que está chegando! 😉`;
        const body = `💼 *Título:* ${app.title || 'N/A'}\n` +
                     `🗓️ *Data:* ${formatDate(app.eventDateTime)}\n` +
                     `⏰ *Horário:* ${formatTime(app.eventDateTime)}`;
        const footer = `Qualquer coisa, me avise! Tenha um ótimo compromisso! ✨`;
        const message = `${intro}\n\n${body}\n\n${footer}`;

        const sentSuccessfully = await sendWhatsappMessage(clientPhone, message);
        if (sentSuccessfully) {
            logger.info(`[JOB APPT] Lembrete para "${app.title}" enviado para Cliente ${clientFirstName} (${clientPhone})`);
            await appointmentService.markReminderAsSent(app.id);
        } else {
            logger.error(`[JOB APPT] Falha ao enviar lembrete via WhatsApp para compromisso ID ${app.id}.`);
        }
      } catch (sendError) {
        logger.error(`[JOB APPT] Erro ao processar/enviar lembrete para compromisso ID ${app.id}:`, { message: sendError.message, stack: sendError.stack });
      }
    }
  } catch (error) {
    logger.error('[JOB APPT] Erro na função de envio de lembretes:', { message: error.message, stack: error.stack });
  }
}

// --- Função para converter compromissos em transações (nova lógica) ---
async function convertDueAppointmentsToTransactions() {
    logger.info('[JOB APPT] Verificando compromissos para converter em transações...');
    try {
        const appointmentsToProcess = await appointmentService.getAppointmentsDueForTransactionCreation();

        if (appointmentsToProcess.length === 0) {
            return;
        }
    
        for (const appt of appointmentsToProcess) {
          const t = await sequelize.transaction();
          try {
            const transactionData = {
              description: appt.title,
              type: appt.associatedTransactionType,
              value: appt.associatedValue,
              financialCategoryId: null,
              transactionDate: appt.eventDateTime.toISOString().split('T')[0],
              isPayableOrReceivable: false,
              isPaidOrReceived: true,
              paymentDate: appt.eventDateTime.toISOString().split('T')[0],
              notes: `Gerado a partir do compromisso ID ${appt.id}. ${appt.notes || ''}`.trim(),
            };
    
            const newTransaction = await financialService.createTransaction(
              appt.financialAccountId,
              transactionData,
              { transaction: t }
            );
    
            await appointmentService.markAsTransactionGenerated(appt, newTransaction.id, t);
            
            await t.commit();
            logger.info(`[JOB APPT] Transação ID ${newTransaction.id} criada para o compromisso ID ${appt.id} ("${appt.title}").`);
    
          } catch (error) {
            await t.rollback();
            logger.error(`[JOB APPT] Erro ao processar compromisso ID ${appt.id} para transação: ${error.message}`, { appt });
          }
        }

    } catch(error) {
        logger.error('[JOB APPT] Erro na função de conversão para transações:', { message: error.message, stack: error.stack });
    }
}


// --- Função principal do JOB que chama as duas tarefas ---
async function processAllAppointmentTasks() {
    logger.info('[JOB APPT] Iniciando ciclo de processamento de compromissos...');
    await sendAppointmentReminders();
    await convertDueAppointmentsToTransactions();
    logger.info('[JOB APPT] Ciclo de processamento de compromissos finalizado.');
}


function startAppointmentReminderJob(preferences, models) {
  const schedule = preferences?.appointmentReminderJobSchedule || '*/2 * * * *'; // Reduzido para 2 min para mais precisão

  if (cron.validate(schedule)) {
    logger.info(`[JOB APPT] Job unificado de compromissos agendado para rodar: ${schedule}`);
    cron.schedule(schedule, processAllAppointmentTasks, {
      timezone: process.env.TZ || "America/Sao_Paulo",
    });
  } else {
    logger.error(`[JOB APPT] Schedule cron inválido nas preferências: ${schedule}. Usando default '*/2 * * * *'.`);
    cron.schedule('*/2 * * * *', processAllAppointmentTasks, { timezone: process.env.TZ || "America/Sao_Paulo" });
  }
}

module.exports = startAppointmentReminderJob;
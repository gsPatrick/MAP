// src/jobs/waterReminderJob.js
const cron = require('node-cron');
const { UserPreference, Client, WaterIntakeLog } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const dayjs = require('dayjs');

const waterMessages = [
  "💧 Hora de se hidratar! Um copo d'água agora pode fazer maravilhas pelo seu dia. Já registrei aqui pra você! 😉",
  "Tem sede? Seu corpo agradece por mais um gole d'água! 💧 Já marquei como consumido, continue assim!",
  "Lembrete amigável: beba água! 💧 Manter-se hidratado é essencial. Registrei este copo para te ajudar a bater a meta!",
  "Pausa para a água! 💧 Mantenha sua energia e foco nas alturas. Marquei este consumo para você, saúde!",
  "Seu lembrete de hidratação chegou! 💧 Beba um copo d'água e não se preocupe, já anotei no seu progresso."
];
function getRandomWaterMessage() { return waterMessages[Math.floor(Math.random() * waterMessages.length)]; }

async function checkAndSendWaterReminder() {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const now = new Date();
    const currentTime = now.toTimeString().split(' ')[0]; // Formato HH:MM:SS

    // Busca todos os logs que estão PENDENTES para hoje,
    // cujo horário agendado já passou ou é o minuto atual.
    const logsToProcess = await WaterIntakeLog.findAll({
      where: {
        intakeDate: today,
        status: 'pending', // Apenas os que o usuário ainda não marcou
        scheduledTime: {
          [Op.lte]: currentTime,
        },
      },
      include: [{
        model: Client,
        as: 'client',
        attributes: ['id', 'phone'], // Pega o ID e o telefone do cliente
        required: true // Garante que só venham logs de clientes existentes
      }]
    });

    if (logsToProcess.length === 0) {
      // Nenhum log pendente para notificar no momento.
      return;
    }

    logger.info(`[JOB ÁGUA] Encontrados ${logsToProcess.length} logs de hidratação pendentes para processar.`);

    for (const log of logsToProcess) {
      if (log.client && log.client.phone) {
        const message = getRandomWaterMessage();
        
        // Envia a notificação via WhatsApp
        const sent = await sendWhatsappMessage(log.client.phone, message);
        
        if (sent) {
          // Se a mensagem foi enviada com sucesso, atualiza o log.
          // O status muda para 'completed' e a data de conclusão é registrada.
          await log.update({ 
            status: 'completed',
            completedAt: new Date(),
            notifiedAt: new Date() // Também registra que a notificação foi enviada
          });
          logger.info(`[JOB ÁGUA] Lembrete para o horário ${log.scheduledTime} enviado para o cliente ID ${log.clientId} e log marcado como 'completed'.`);
        } else {
          logger.error(`[JOB ÁGUA] Falha ao enviar lembrete para o cliente ID ${log.clientId}. O log permanece como 'pending'.`);
        }
      }
    }
  } catch (error) {
    logger.error('[JOB ÁGUA] Erro no job de lembrete de água:', { message: error.message, stack: error.stack });
  }
}

function startWaterReminderJob(preferences, models) {
  // O schedule padrão é a cada 2 minutos. Pode ser ajustado nas preferências do sistema.
  const schedule = preferences?.waterReminderJobSchedule || '*/2 * * * *';
  
  logger.info(`[JOB ÁGUA] Agendado para verificar a necessidade de envio (schedule: ${schedule} no fuso ${process.env.TZ || "America/Sao_Paulo"})`);
  
  cron.schedule(schedule, checkAndSendWaterReminder, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startWaterReminderJob;
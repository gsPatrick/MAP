// src/jobs/waterReminderJob.js
const cron = require('node-cron');
const { Client, WaterIntakeLog } = require('../database');
const { Op } = require('sequelize');
const logger =require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

// Array de mensagens para variar os lembretes
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
    const now = new Date();
    const currentTime = now.toTimeString().split(' ')[0]; // Formato HH:MM:SS
    const todayDateString = now.toISOString().split('T')[0];

    // 1. Busca todos os LOGS que estão PENDENTES para hoje,
    //    cujo horário agendado já passou ou é o minuto atual.
    const logsToProcess = await WaterIntakeLog.findAll({
      where: {
        intakeDate: todayDateString,
        status: 'pending',
        scheduledTime: {
          [Op.lte]: currentTime,
        },
      },
      include: [{ // 2. Inclui os dados do cliente para pegar o telefone
        model: Client,
        as: 'client',
        where: { status: 'Ativo' },
        attributes: ['id', 'phone', 'name'],
        required: true // Garante que só venham logs de clientes existentes e ativos
      }]
    });

    if (logsToProcess.length === 0) {
      // Nenhum log pendente para notificar no momento. Isso é normal.
      return;
    }

    logger.info(`[JOB ÁGUA] Encontrados ${logsToProcess.length} logs de hidratação pendentes para processar.`);

    for (const log of logsToProcess) {
      if (log.client && log.client.phone) {
        const message = getRandomWaterMessage();
        
        // 3. Envia a notificação via WhatsApp DIRETAMENTE PARA O CLIENTE
        const sent = await sendWhatsappMessage(log.client.phone, message);
        
        if (sent) {
          // 4. Se a mensagem foi enviada, atualiza o log. ISSO QUEBRA O LOOP!
          // O status muda para 'completed' e a data de conclusão é registrada.
          await log.update({ 
            status: 'completed',
            completedAt: new Date(),
            notifiedAt: new Date()
          });
          logger.info(`[JOB ÁGUA] Lembrete para o horário ${log.scheduledTime} enviado para o cliente ${log.client.name} e log marcado como 'completed'.`);
        } else {
          logger.error(`[JOB ÁGUA] Falha ao enviar lembrete para o cliente ${log.client.name}. O log permanece como 'pending' para nova tentativa.`);
        }
      } else {
          // Caso o log exista mas o cliente não tenha telefone (pouco provável com a query acima)
          logger.warn(`[JOB ÁGUA] Log ID ${log.id} não pôde ser processado pois o cliente associado não tem telefone. Marcando como falho para evitar loops.`);
          await log.update({ status: 'failed' });
      }
    }
  } catch (error) {
    logger.error('[JOB ÁGUA] Erro no job de lembrete de água:', { message: error.message, stack: error.stack });
  }
}

function startWaterReminderJob(preferences) {
  const schedule = preferences?.waterReminderJobSchedule || '*/2 * * * *';
  
  logger.info(`[JOB ÁGUA] Agendado para verificar lembretes individuais (schedule: ${schedule})`);
  
  cron.schedule(schedule, checkAndSendWaterReminder, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startWaterReminderJob;
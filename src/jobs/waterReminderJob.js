// src/jobs/waterReminderJob.js
const cron = require('node-cron');
const { UserPreference } = require('../database');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

const waterMessages = [
  "💧 Hora de se hidratar! Um copo d'água agora pode fazer maravilhas.",
  "Tem sede? Seu corpo agradece por mais um gole d'água! 💧",
  "Lembrete amigável: beba água! 💧 Manter-se hidratado é essencial.",
  "Pausa para a água! 💧 Mantenha sua energia e foco bebendo água regularmente.",
  "Seu lembrete de hidratação chegou! 💧 Beba um copo d'água."
];
function getRandomWaterMessage() { return waterMessages[Math.floor(Math.random() * waterMessages.length)]; }

/**
 * Calcula o próximo horário ideal para o lembrete de água com base no último envio e nas preferências.
 * @param {Date | null} lastSentTimestampObj - Objeto Date do último envio, já no fuso da aplicação.
 * @param {object} preferences - Objeto de preferências do usuário.
 * @param {Date} nowInAppTimeZone - Objeto Date da data/hora atual no fuso da aplicação.
 * @param {Date} startTimeTodayInAppTimeZone - Objeto Date do horário de início dos lembretes hoje, no fuso da aplicação.
 * @returns {Date | null} - Próximo horário de lembrete ou null se não aplicável.
 */
function calculateNextWaterReminderTime(lastSentTimestampObj, preferences, nowInAppTimeZone, startTimeTodayInAppTimeZone) {
    if (!preferences.waterReminderFrequencyType || preferences.waterReminderFrequencyType === 'disabled') {
        return null;
    }

    let intervalMinutes;
    switch (preferences.waterReminderFrequencyType) {
        case '2h': intervalMinutes = 120; break;
        case '3h': intervalMinutes = 180; break;
        case 'custom':
            intervalMinutes = preferences.waterReminderCustomIntervalMinutes;
            if (!intervalMinutes || intervalMinutes < 1) { // Mínimo de 1 minuto para intervalo customizado
                logger.warn(`[JOB ÁGUA] Intervalo customizado inválido: ${intervalMinutes}.`);
                return null;
            }
            break;
        default:
            logger.warn(`[JOB ÁGUA] Frequência de lembrete de água desconhecida: ${preferences.waterReminderFrequencyType}.`);
            return null;
    }

    let baseTimeForCalc;
    if (lastSentTimestampObj) {
        // Se o último envio foi antes do horário de início de hoje, considera o início de hoje como base para o primeiro lembrete do dia.
        if (lastSentTimestampObj < startTimeTodayInAppTimeZone) {
            baseTimeForCalc = new Date(startTimeTodayInAppTimeZone.getTime() - intervalMinutes * 60000); // Para que o primeiro slot seja o startTimeToday
        } else {
            baseTimeForCalc = lastSentTimestampObj;
        }
    } else {
        // Se nunca foi enviado, ou se o último envio foi num dia anterior,
        // o "último envio" virtual para cálculo é o horário de início de hoje menos um intervalo,
        // para que o primeiro lembrete candidato seja o próprio horário de início.
        baseTimeForCalc = new Date(startTimeTodayInAppTimeZone.getTime() - intervalMinutes * 60000);
    }
    
    const nextReminderTime = new Date(baseTimeForCalc.getTime() + intervalMinutes * 60000);

    // Garante que o próximo lembrete não seja antes do horário de início de hoje
    if (nextReminderTime < startTimeTodayInAppTimeZone) {
        return startTimeTodayInAppTimeZone;
    }

    return nextReminderTime;
}

async function checkAndSendWaterReminder() {
  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (!preferences || !preferences.enableWaterReminder || preferences.waterReminderFrequencyType === 'disabled' || !preferences.waterReminderStartTime || !preferences.waterReminderEndTime) {
      // logger.debug('[JOB ÁGUA] Lembrete de água desabilitado ou configuração incompleta (sem startTime/endTime).');
      return;
    }

    const appTimeZone = process.env.TZ || "America/Sao_Paulo";
    const nowInAppTimeZone = new Date(new Date().toLocaleString("en-US", { timeZone: appTimeZone }));

    const [startHour, startMinute] = preferences.waterReminderStartTime.split(':').map(Number);
    const [endHour, endMinute] = preferences.waterReminderEndTime.split(':').map(Number);

    const startTimeTodayInAppTimeZone = new Date(nowInAppTimeZone);
    startTimeTodayInAppTimeZone.setHours(startHour, startMinute, 0, 0);

    const endTimeTodayInAppTimeZone = new Date(nowInAppTimeZone);
    endTimeTodayInAppTimeZone.setHours(endHour, endMinute, 0, 0);

    // Se a hora atual estiver fora da janela de lembretes, não faz nada
    if (nowInAppTimeZone < startTimeTodayInAppTimeZone || nowInAppTimeZone > endTimeTodayInAppTimeZone) {
      // logger.debug(`[JOB ÁGUA] Fora da janela de horário (${preferences.waterReminderStartTime} - ${preferences.waterReminderEndTime}). Atual: ${nowInAppTimeZone.toLocaleTimeString([], {timeZone: appTimeZone, hour: '2-digit', minute:'2-digit'})}`);
      return;
    }

    const lastSentTimestampObj = preferences.lastWaterReminderSentTimestamp 
        ? new Date(new Date(preferences.lastWaterReminderSentTimestamp).toLocaleString("en-US", { timeZone: appTimeZone })) 
        : null;
    
    // Evita envios múltiplos se o job rodar mais rápido que 1 minuto (ou o menor intervalo prático)
    // Se já enviou neste mesmo minuto, não envia de novo.
    if (lastSentTimestampObj && 
        lastSentTimestampObj.getFullYear() === nowInAppTimeZone.getFullYear() &&
        lastSentTimestampObj.getMonth() === nowInAppTimeZone.getMonth() &&
        lastSentTimestampObj.getDate() === nowInAppTimeZone.getDate() &&
        lastSentTimestampObj.getHours() === nowInAppTimeZone.getHours() &&
        lastSentTimestampObj.getMinutes() === nowInAppTimeZone.getMinutes()) {
        // logger.debug('[JOB ÁGUA] Lembrete já enviado neste minuto. Aguardando.');
        return;
    }


    const nextIdealReminderTime = calculateNextWaterReminderTime(lastSentTimestampObj, preferences, nowInAppTimeZone, startTimeTodayInAppTimeZone);

    if (!nextIdealReminderTime) {
        logger.warn('[JOB ÁGUA] Não foi possível calcular o próximo horário ideal de lembrete (verifique a configuração de frequência).');
        return;
    }
    
    // logger.debug(`[JOB ÁGUA] Now: ${nowInAppTimeZone.toISOString()}, NextIdeal: ${nextIdealReminderTime.toISOString()}, LastSent: ${lastSentTimestampObj ? lastSentTimestampObj.toISOString() : 'NUNCA'}, StartToday: ${startTimeTodayInAppTimeZone.toISOString()}, EndToday: ${endTimeTodayInAppTimeZone.toISOString()}`);

    // Condição de envio:
    // 1. A hora atual é igual ou posterior ao próximo horário ideal de lembrete.
    // 2. O próximo horário ideal de lembrete está DENTRO da janela de fim de hoje.
    if (nowInAppTimeZone >= nextIdealReminderTime && nextIdealReminderTime <= endTimeTodayInAppTimeZone) {
      const message = getRandomWaterMessage();
      logger.info(`[JOB ÁGUA] Horário ideal (${nextIdealReminderTime.toLocaleTimeString([], {timeZone: appTimeZone, hour: '2-digit', minute:'2-digit'})}) alcançado/passado. Enviando lembrete: "${message}"`);
      
      const adminPhone = process.env.ADMIN_PHONE_FOR_WATER_REMINDER; // Assumindo que o lembrete é para o admin/sistema
      if (adminPhone) {
          const sent = await sendWhatsappMessage(adminPhone, message);
          if(sent) {
            logger.info(`[JOB ÁGUA] Enviado para admin ${adminPhone}.`);
            // Atualiza o timestamp do último envio para AGORA (no fuso da aplicação).
            await preferences.update({ lastWaterReminderSentTimestamp: nowInAppTimeZone });
            logger.info(`[JOB ÁGUA] lastWaterReminderSentTimestamp atualizado para ${nowInAppTimeZone.toISOString()}.`);
          } else {
            logger.error(`[JOB ÁGUA] Falha ao enviar lembrete para admin ${adminPhone}. Timestamp não atualizado.`);
          }
      } else {
          logger.warn('[JOB ÁGUA] ADMIN_PHONE_FOR_WATER_REMINDER não configurado. Lembrete não enviado, timestamp não atualizado.');
      }
    } else {
        // logger.debug(`[JOB ÁGUA] Próximo horário ideal de lembrete (${nextIdealReminderTime.toLocaleTimeString([], {timeZone: appTimeZone, hour: '2-digit', minute:'2-digit'})}) ainda não alcançado ou fora da janela de hoje.`);
    }

  } catch (error) {
    logger.error('[JOB ÁGUA] Erro no job de lembrete de água:', { message: error.message, stack: error.stack });
  }
}

function startWaterReminderJob() {
  const schedule = '*/2 * * * *'; // A cada 2 minutos. Ajuste se necessário.
                                 // Uma frequência menor (ex: */1) aumenta a precisão, mas também a carga.
                                 // Uma frequência maior (ex: */5) pode ter um pequeno "delay" no primeiro lembrete do dia ou após uma pausa.
  
  logger.info(`[JOB ÁGUA] Agendado para verificar a necessidade de envio (schedule: ${schedule} no fuso ${process.env.TZ || "America/Sao_Paulo"})`);
  
  cron.schedule(schedule, checkAndSendWaterReminder, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });

  // Para fins de teste imediato ao iniciar (opcional):
  // setTimeout(checkAndSendWaterReminder, 7000); // Ex: 7 segundos após o início
}

module.exports = startWaterReminderJob;
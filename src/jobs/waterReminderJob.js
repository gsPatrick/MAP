// src/jobs/waterReminderJob.js
const cron = require('node-cron');
const { UserPreference } = require('../database');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

const waterMessages = [
  "💧 Hora de se hidratar! Um copo d'água agora pode fazer maravilhas pelo seu dia.",
  "Tem sede? Seu corpo agradece por mais um gole d'água! 💧 Vamos lá?",
  "Lembrete amigável: beba água! 💧 Manter-se hidratado é essencial para sua produtividade e bem-estar.",
  "Pausa para a água! 💧 Mantenha sua energia e foco nas alturas bebendo água regularmente.",
  "Seu lembrete de hidratação chegou! 💧 Beba um copo d'água e sinta a diferença.",
  "Psiu... é a sua pausa para a hidratação! 💧 Um copo de água agora, por favor!",
  "Seu corpo está pedindo H₂O! Que tal um copo agora mesmo? 💧✨",
  "Não se esqueça do seu superpoder secreto: a hidratação! 💧 Beba um pouco de água.",
  "Alerta de bem-estar: seu corpo precisa de água! 💧 Um pequeno gole, um grande benefício."
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
            if (!intervalMinutes || intervalMinutes < 1) {
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
        if (lastSentTimestampObj < startTimeTodayInAppTimeZone) {
            baseTimeForCalc = new Date(startTimeTodayInAppTimeZone.getTime() - intervalMinutes * 60000);
        } else {
            baseTimeForCalc = lastSentTimestampObj;
        }
    } else {
        baseTimeForCalc = new Date(startTimeTodayInAppTimeZone.getTime() - intervalMinutes * 60000);
    }
    
    const nextReminderTime = new Date(baseTimeForCalc.getTime() + intervalMinutes * 60000);

    if (nextReminderTime < startTimeTodayInAppTimeZone) {
        return startTimeTodayInAppTimeZone;
    }

    return nextReminderTime;
}

async function checkAndSendWaterReminder() {
  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (!preferences || !preferences.enableWaterReminder || preferences.waterReminderFrequencyType === 'disabled' || !preferences.waterReminderStartTime || !preferences.waterReminderEndTime) {
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

    if (nowInAppTimeZone < startTimeTodayInAppTimeZone || nowInAppTimeZone > endTimeTodayInAppTimeZone) {
      return;
    }

    const lastSentTimestampObj = preferences.lastWaterReminderSentTimestamp 
        ? new Date(new Date(preferences.lastWaterReminderSentTimestamp).toLocaleString("en-US", { timeZone: appTimeZone })) 
        : null;
    
    if (lastSentTimestampObj && 
        lastSentTimestampObj.getFullYear() === nowInAppTimeZone.getFullYear() &&
        lastSentTimestampObj.getMonth() === nowInAppTimeZone.getMonth() &&
        lastSentTimestampObj.getDate() === nowInAppTimeZone.getDate() &&
        lastSentTimestampObj.getHours() === nowInAppTimeZone.getHours() &&
        lastSentTimestampObj.getMinutes() === nowInAppTimeZone.getMinutes()) {
        return;
    }


    const nextIdealReminderTime = calculateNextWaterReminderTime(lastSentTimestampObj, preferences, nowInAppTimeZone, startTimeTodayInAppTimeZone);

    if (!nextIdealReminderTime) {
        logger.warn('[JOB ÁGUA] Não foi possível calcular o próximo horário ideal de lembrete (verifique a configuração de frequência).');
        return;
    }
    
    if (nowInAppTimeZone >= nextIdealReminderTime && nextIdealReminderTime <= endTimeTodayInAppTimeZone) {
      const message = getRandomWaterMessage();
      logger.info(`[JOB ÁGUA] Horário ideal (${nextIdealReminderTime.toLocaleTimeString([], {timeZone: appTimeZone, hour: '2-digit', minute:'2-digit'})}) alcançado/passado. Enviando lembrete: "${message}"`);
      
      const adminPhone = process.env.ADMIN_PHONE_FOR_WATER_REMINDER;
      if (adminPhone) {
          const sent = await sendWhatsappMessage(adminPhone, message);
          if(sent) {
            logger.info(`[JOB ÁGUA] Enviado para admin ${adminPhone}.`);
            await preferences.update({ lastWaterReminderSentTimestamp: nowInAppTimeZone });
            logger.info(`[JOB ÁGUA] lastWaterReminderSentTimestamp atualizado para ${nowInAppTimeZone.toISOString()}.`);
          } else {
            logger.error(`[JOB ÁGUA] Falha ao enviar lembrete para admin ${adminPhone}. Timestamp não atualizado.`);
          }
      } else {
          logger.warn('[JOB ÁGUA] ADMIN_PHONE_FOR_WATER_REMINDER não configurado. Lembrete não enviado, timestamp não atualizado.');
      }
    }

  } catch (error) {
    logger.error('[JOB ÁGUA] Erro no job de lembrete de água:', { message: error.message, stack: error.stack });
  }
}

function startWaterReminderJob(preferences, models) { // Modificado para receber prefs
  const schedule = preferences?.waterReminderJobSchedule || '*/2 * * * *';
  
  logger.info(`[JOB ÁGUA] Agendado para verificar a necessidade de envio (schedule: ${schedule} no fuso ${process.env.TZ || "America/Sao_Paulo"})`);
  
  cron.schedule(schedule, checkAndSendWaterReminder, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startWaterReminderJob;
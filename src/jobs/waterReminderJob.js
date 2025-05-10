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

async function sendWaterReminder() {
  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (!preferences || !preferences.enableWaterReminder || preferences.waterReminderFrequencyType === 'disabled') {
      return; // Desabilitado ou sem frequência
    }

    const now = new Date();
    // Ajustar para o fuso horário configurado no .env para comparação correta
    const currentHour = parseInt(now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' }));
    const currentMinute = now.getMinutes();
    
    const [startHour, startMinute] = preferences.waterReminderStartTime ? preferences.waterReminderStartTime.split(':').map(Number) : [0,0];
    const [endHour, endMinute] = preferences.waterReminderEndTime ? preferences.waterReminderEndTime.split(':').map(Number) : [23,59];

    const inTimeWindow = (currentHour > startHour || (currentHour === startHour && currentMinute >= startMinute)) &&
                         (currentHour < endHour || (currentHour === endHour && currentMinute <= endMinute));

    if (!inTimeWindow) {
      // logger.debug(`[JOB ÁGUA] Fora do horário (${startHour}:${startMinute} - ${endHour}:${endMinute}). Atual: ${currentHour}:${currentMinute}`);
      return;
    }

    const message = getRandomWaterMessage();
    logger.info(`[JOB ÁGUA - ${currentHour}:${String(currentMinute).padStart(2,'0')}] Lembrete: "${message}"`);
    
    const adminPhone = process.env.ADMIN_PHONE_FOR_WATER_REMINDER;
    if (adminPhone) {
        const sent = await sendWhatsappMessage(adminPhone, message);
        if(sent) logger.info(`[JOB ÁGUA] Enviado para admin ${adminPhone}.`);
    } else {
        logger.warn('[JOB ÁGUA] ADMIN_PHONE_FOR_WATER_REMINDER não configurado.');
    }

  } catch (error) {
    logger.error('[JOB ÁGUA] Erro:', { message: error.message, stack: error.stack });
  }
}

function startWaterReminderJob() {
  UserPreference.findOne({ order: [['id', 'ASC']] }).then(preferences => {
    if (!preferences || !preferences.enableWaterReminder || preferences.waterReminderFrequencyType === 'disabled') {
      logger.info('[JOB ÁGUA] Desabilitado nas preferências.');
      return;
    }
    let schedule;
    let freqDesc;
    switch (preferences.waterReminderFrequencyType) {
      case '2h': schedule = `0 */2 * * *`; freqDesc="a cada 2h"; break; // Minuto 0, a cada 2 horas
      case '3h': schedule = `0 */3 * * *`; freqDesc="a cada 3h"; break; // Minuto 0, a cada 3 horas
      case 'custom':
        if (preferences.waterReminderCustomIntervalMinutes && preferences.waterReminderCustomIntervalMinutes >= 1) {
          const interval = preferences.waterReminderCustomIntervalMinutes;
          if (interval < 60) schedule = `*/${interval} * * * *`; // A cada X minutos
          else schedule = `0 */${Math.floor(interval/60)} * * *`; // A cada X horas (aproximado ao minuto 0)
          freqDesc = `custom (${interval} min)`;
        } else { logger.error('[JOB ÁGUA] Frequência customizada inválida.'); return; }
        break;
      default: logger.error('[JOB ÁGUA] Frequência desconhecida.'); return;
    }

    if (cron.validate(schedule)) {
      logger.info(`[JOB ÁGUA] Agendado para: ${schedule} (${freqDesc})`);
      cron.schedule(schedule, sendWaterReminder, { timezone: process.env.TZ || "America/Sao_Paulo" });
    } else {
      logger.error(`[JOB ÁGUA] Schedule inválido: ${schedule}`);
    }
  }).catch(error => {
    logger.error('[JOB ÁGUA] Erro ao buscar prefs:', { error });
  });
}

module.exports = startWaterReminderJob;
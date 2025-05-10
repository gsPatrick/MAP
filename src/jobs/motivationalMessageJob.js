// src/jobs/motivationalMessageJob.js
const cron = require('node-cron');
const { UserPreference, MotivationalPhrase, sequelize } = require('../database'); // sequelize para order.random()
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

async function sendDailyMotivation() {
  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (!preferences || !preferences.enableMotivationMessage) {
      logger.info('[JOB MOTIVAÇÃO] Desabilitado nas preferências.');
      return;
    }

    const phraseRecord = await MotivationalPhrase.findOne({
        where: { isActive: true },
        order: sequelize.random(), // Busca uma frase aleatória (específico do dialect, funciona no PostgreSQL)
                                   // Para outros DBs, pode ser necessário: order: [[sequelize.fn('RANDOM')]] ou similar
    });

    if (!phraseRecord) {
      logger.warn('[JOB MOTIVAÇÃO] Nenhuma frase motivacional ativa encontrada.');
      return;
    }
    const phrase = phraseRecord.text;
    logger.info(`[JOB MOTIVAÇÃO] Frase do dia: "${phrase}"`);

    const adminPhone = process.env.ADMIN_PHONE_FOR_MOTIVATION;
    if (adminPhone) {
        const sent = await sendWhatsappMessage(adminPhone, phrase);
        if (sent) logger.info(`[JOB MOTIVAÇÃO] Enviada para admin ${adminPhone}.`);
    } else {
        logger.warn('[JOB MOTIVAÇÃO] ADMIN_PHONE_FOR_MOTIVATION não configurado. Mensagem não enviada.');
    }
  } catch (error) {
    logger.error('[JOB MOTIVAÇÃO] Erro:', { message: error.message, stack: error.stack });
  }
}

function startMotivationalMessageJob() {
  UserPreference.findOne({ order: [['id', 'ASC']] }).then(preferences => {
    if (!preferences || !preferences.enableMotivationMessage) {
      logger.info('[JOB MOTIVAÇÃO] Job desabilitado nas preferências.');
      return;
    }
    const time = preferences.motivationMessageTime || '08:00:00';
    const [hour, minute] = time.split(':');
    const schedule = `${minute} ${hour} * * *`;
    if (cron.validate(schedule)) {
      logger.info(`[JOB MOTIVAÇÃO] Agendado para: ${schedule}`);
      cron.schedule(schedule, sendDailyMotivation, { timezone: process.env.TZ || "America/Sao_Paulo" });
    } else {
      logger.error(`[JOB MOTIVAÇÃO] Schedule inválido: ${schedule}. Usando 08:00.`);
      cron.schedule('0 8 * * *', sendDailyMotivation, { timezone: process.env.TZ || "America/Sao_Paulo" });
    }
  }).catch(error => {
    logger.error('[JOB MOTIVAÇÃO] Erro ao buscar prefs. Usando 08:00. Detalhes:', error);
    cron.schedule('0 8 * * *', sendDailyMotivation, { timezone: process.env.TZ || "America/Sao_Paulo" });
  });
}

module.exports = startMotivationalMessageJob;
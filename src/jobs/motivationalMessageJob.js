// src/jobs/motivationalMessageJob.js
const cron = require('node-cron');
const { UserPreference, MotivationalPhrase, sequelize } = require('../database');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

async function checkAndSendDailyMotivation() {
  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] }); // Assume uma única linha de preferências globais
    
    if (!preferences) {
        logger.warn('[JOB MOTIVAÇÃO] Preferências do sistema não encontradas. Job não pode rodar.');
        return;
    }

    if (!preferences.enableMotivationMessage || !preferences.motivationMessageTime) {
      // logger.debug('[JOB MOTIVAÇÃO] Mensagem motivacional desabilitada ou sem horário configurado nas preferências.');
      return;
    }

    // Garantir que estamos trabalhando com o fuso horário correto da aplicação (process.env.TZ)
    // para todas as comparações de data e hora.
    const appTimeZone = process.env.TZ || "America/Sao_Paulo";

    // Data e hora atuais no fuso da aplicação
    const nowInAppTimeZone = new Date(new Date().toLocaleString("en-US", { timeZone: appTimeZone }));
    const todayDateStringInAppTimeZone = nowInAppTimeZone.toISOString().split('T')[0]; // YYYY-MM-DD de hoje no fuso da app

    // Se já enviou hoje (comparando datas no mesmo fuso), não faz nada
    if (preferences.lastMotivationalMessageSentDate === todayDateStringInAppTimeZone) {
      // logger.debug(`[JOB MOTIVAÇÃO] Mensagem motivacional para ${todayDateStringInAppTimeZone} já enviada.`);
      return;
    }

    const [targetHour, targetMinute] = preferences.motivationMessageTime.split(':').map(Number);
    
    // Cria um objeto Date para o horário alvo de hoje, no fuso da aplicação
    const targetTimeTodayInAppTimeZone = new Date(nowInAppTimeZone);
    targetTimeTodayInAppTimeZone.setHours(targetHour, targetMinute, 0, 0);


    // Verifica se a hora atual (no fuso da app) já passou ou é igual à hora alvo de hoje (no fuso da app)
    // E se a mensagem de hoje ainda não foi enviada
    if (nowInAppTimeZone >= targetTimeTodayInAppTimeZone) {
      logger.info(`[JOB MOTIVAÇÃO] Horário alvo (${preferences.motivationMessageTime} no fuso ${appTimeZone}) alcançado/passado para ${todayDateStringInAppTimeZone}. Tentando enviar.`);

      const phraseRecord = await MotivationalPhrase.findOne({
        where: { isActive: true },
        order: sequelize.random(), // Para PostgreSQL. Para outros DBs: [[sequelize.fn('RANDOM')]]
      });

      if (!phraseRecord) {
        logger.warn('[JOB MOTIVAÇÃO] Nenhuma frase motivacional ativa encontrada.');
        return;
      }
      const phrase = phraseRecord.text;
      logger.info(`[JOB MOTIVAÇÃO] Frase do dia para ${todayDateStringInAppTimeZone}: "${phrase}"`);

      const adminPhone = process.env.ADMIN_PHONE_FOR_MOTIVATION;
      if (adminPhone) {
        const sent = await sendWhatsappMessage(adminPhone, phrase);
        if (sent) {
          logger.info(`[JOB MOTIVAÇÃO] Enviada para admin ${adminPhone}.`);
          // Atualiza a data do último envio para a data de hoje no fuso da aplicação
          await preferences.update({ lastMotivationalMessageSentDate: todayDateStringInAppTimeZone });
          logger.info(`[JOB MOTIVAÇÃO] lastMotivationalMessageSentDate atualizado para ${todayDateStringInAppTimeZone}.`);
        } else {
          logger.error(`[JOB MOTIVAÇÃO] Falha ao enviar mensagem para admin ${adminPhone}. lastMotivationalMessageSentDate não atualizado.`);
        }
      } else {
        logger.warn('[JOB MOTIVAÇÃO] ADMIN_PHONE_FOR_MOTIVATION não configurado. Mensagem não enviada, lastMotivationalMessageSentDate não atualizado.');
      }
    } else {
      // logger.debug(`[JOB MOTIVAÇÃO] Horário alvo (${preferences.motivationMessageTime} no fuso ${appTimeZone}) para ${todayDateStringInAppTimeZone} ainda não alcançado.`);
    }
  } catch (error) {
    logger.error('[JOB MOTIVAÇÃO] Erro ao verificar e enviar mensagem motivacional:', { message: error.message, stack: error.stack });
  }
}

function startMotivationalMessageJob() {
  // O job agora vai rodar com mais frequência para verificar se a mensagem do dia precisa ser enviada.
  // A cada 1 minuto. Ajuste conforme necessidade.
  const schedule = '*/1 * * * *'; 
  // Você pode tornar isso mais espaçado, como '*/5 * * * *' (a cada 5 minutos) ou '*/15 * * * *' (a cada 15 minutos)
  // se o envio exato no minuto não for super crítico e para economizar algumas execuções.
  
  logger.info(`[JOB MOTIVAÇÃO] Agendado para verificar a necessidade de envio (schedule: ${schedule} no fuso ${process.env.TZ || "America/Sao_Paulo"})`);
  
  cron.schedule(schedule, checkAndSendDailyMotivation, {
    timezone: process.env.TZ || "America/Sao_Paulo", // Importante para o cron disparar no fuso correto
  });

  // Para fins de teste imediato ao iniciar, você pode chamar a função uma vez:
  // setTimeout(checkAndSendDailyMotivation, 5000); // Ex: 5 segundos após o início
}

module.exports = startMotivationalMessageJob;
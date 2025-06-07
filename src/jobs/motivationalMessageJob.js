// src/jobs/motivationalMessageJob.js
const cron = require('node-cron');
const { MotivationalPhrase, Client, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

// Função para formatar a hora atual para 'HH:MM:00'
function getCurrentScheduledTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}:00`;
}

async function checkAndSendDailyMotivation() {
  try {
    const currentTime = getCurrentScheduledTime(); // Ex: "13:00:00"
    const todayDateString = new Date().toISOString().split('T')[0]; // Ex: "2023-10-27"

    // 1. Busca todos os clientes que:
    //    - Querem receber a mensagem.
    //    - Agendaram para o horário ATUAL.
    //    - Ainda não receberam a mensagem HOJE.
    const clientsToSend = await Client.findAll({
      where: {
        wantsMotivationMessage: true,
        status: 'Ativo',
        phone: { [Op.ne]: null },
        motivationMessageTime: currentTime,
        [Op.or]: [
          { lastMotivationSentDate: null },
          { lastMotivationSentDate: { [Op.lt]: todayDateString } }
        ]
      },
      attributes: ['id', 'name', 'phone']
    });

    if (clientsToSend.length === 0) {
      // Nenhum cliente agendado para este exato minuto. Isso é normal.
      return;
    }

    logger.info(`[JOB MOTIVAÇÃO] Encontrados ${clientsToSend.length} clientes agendados para ${currentTime}.`);

    // 2. Pega UMA frase motivacional para enviar para este grupo de clientes
    const phraseRecord = await MotivationalPhrase.findOne({
      where: { isActive: true },
      order: sequelize.random(),
    });

    if (!phraseRecord) {
      logger.warn('[JOB MOTIVAÇÃO] Nenhuma frase motivacional ativa encontrada. Abortando envio.');
      return;
    }

    const phrase = phraseRecord.text;
    logger.info(`[JOB MOTIVAÇÃO] Frase do dia: "${phrase}"`);

    // 3. Envia a mensagem para cada cliente e atualiza seu registro individualmente
    for (const client of clientsToSend) {
      const sent = await sendWhatsappMessage(client.phone, phrase);
      if (sent) {
        // ATUALIZA O CLIENTE INDIVIDUALMENTE
        await client.update({ lastMotivationSentDate: todayDateString });
        logger.info(`[JOB MOTIVAÇÃO] Mensagem enviada e registro atualizado para ${client.name} (${client.phone}).`);
      } else {
        logger.error(`[JOB MOTIVAÇÃO] Falha ao enviar para ${client.name} (${client.phone}). O envio será tentado novamente amanhã.`);
      }
    }
  } catch (error) {
    logger.error('[JOB MOTIVAÇÃO] Erro ao verificar e enviar mensagem motivacional:', { message: error.message, stack: error.stack });
  }
}

function startMotivationalMessageJob() {
  // Roda a cada minuto para verificar se há agendamentos para aquele minuto.
  const schedule = '*/1 * * * *';
  logger.info(`[JOB MOTIVAÇÃO] Agendado para verificar envios individuais a cada minuto (schedule: ${schedule})`);
  
  cron.schedule(schedule, checkAndSendDailyMotivation, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startMotivationalMessageJob;
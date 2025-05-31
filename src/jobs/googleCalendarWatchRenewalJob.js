// src/jobs/googleCalendarWatchRenewalJob.js
const cron = require('node-cron');
const { Client, sequelize } = require('../database'); // Apenas Client e sequelize
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const googleCalendarService = require('../features/GoogleCalendar/googleCalendarService'); // Para watchCalendar e stopWatchingCalendar
const googleAuthService = require('../features/GoogleAuth/googleAuth.service'); // Para getAuthenticatedClient

// Renova canais que expiram nas próximas X horas (ex: 24 horas = 1 dia)
const RENEWAL_THRESHOLD_HOURS = 24;

async function renewExpiringGoogleCalendarWatches() {
  logger.info('[JOB RENOVAÇÃO WATCH] Iniciando verificação de canais de notificação do Google Calendar para renovação...');
  try {
    const now = new Date();
    const thresholdDate = new Date(now.getTime() + RENEWAL_THRESHOLD_HOURS * 60 * 60 * 1000);

    const clientsToRenew = await Client.findAll({
      where: {
        isGoogleCalendarSynced: true,
        googleChannelId: { [Op.ne]: null },
        googleCalendarIdPrincipal: { [Op.ne]: null }, // Precisa do ID do calendário para renovar
        googleChannelExpiryDate: {
          [Op.lte]: thresholdDate, // Canais que expiram dentro do nosso threshold
        },
      },
    });

    if (clientsToRenew.length === 0) {
      logger.info('[JOB RENOVAÇÃO WATCH] Nenhum canal próximo da expiração encontrado para renovar.');
      return;
    }

    logger.info(`[JOB RENOVAÇÃO WATCH] ${clientsToRenew.length} canais encontrados para renovação.`);

    for (const client of clientsToRenew) {
      logger.info(`[JOB RENOVAÇÃO WATCH] Tentando renovar canal para Cliente ID: ${client.id}, Calendário: ${client.googleCalendarIdPrincipal}, Canal Atual: ${client.googleChannelId}, Expira em: ${client.googleChannelExpiryDate}`);
      
      // Primeiro, tenta parar o canal antigo (opcional, mas boa prática se o Google não fizer automaticamente)
      if (client.googleChannelId && client.googleChannelResourceId) {
        await googleCalendarService.stopWatchingCalendar(client.id, client.googleChannelId, client.googleChannelResourceId)
            .catch(err => logger.warn(`[JOB RENOVAÇÃO WATCH] Falha ao parar canal antigo ${client.googleChannelId} para cliente ${client.id} durante renovação: ${err.message}. Prosseguindo com novo watch.`));
      }

      // Tenta registrar um novo canal
      const watchResponse = await googleCalendarService.watchCalendar(client.id, client.googleCalendarIdPrincipal);

      if (watchResponse && watchResponse.id && watchResponse.resourceId) {
        await client.update({
          googleChannelId: watchResponse.id,
          googleChannelResourceId: watchResponse.resourceId,
          googleChannelExpiryDate: watchResponse.expiration ? new Date(parseInt(watchResponse.expiration, 10)) : null,
        });
        logger.info(`[JOB RENOVAÇÃO WATCH] Canal renovado com sucesso para Cliente ID ${client.id}. Novo Channel ID: ${watchResponse.id}, Expira em: ${new Date(parseInt(watchResponse.expiration, 10))}`);
      } else {
        logger.error(`[JOB RENOVAÇÃO WATCH] Falha ao renovar canal para Cliente ID ${client.id}. O cliente pode perder notificações push.`);
        // Considerar enviar notificação ao admin ou ao cliente.
        // Pode ser que o token de acesso/refresh do cliente tenha sido revogado.
        // O getAuthenticatedClient dentro de watchCalendar deve tratar isso e desconectar se necessário.
      }
    }
    logger.info('[JOB RENOVAÇÃO WATCH] Verificação de renovação de canais concluída.');
  } catch (error) {
    logger.error('[JOB RENOVAÇÃO WATCH] Erro geral durante a renovação de canais:', { message: error.message, stack: error.stack });
  }
}

function startGoogleCalendarWatchRenewalJob(preferences, models) { // Recebe preferências e modelos, mas não os usa diretamente agora
  // Roda uma vez por dia, por exemplo, à meia-noite
  const schedule = preferences?.googleWatchRenewalJobSchedule || '0 0 * * *';
  if (cron.validate(schedule)) {
    logger.info(`[JOB RENOVAÇÃO WATCH] Agendado para: ${schedule}`);
    cron.schedule(schedule, renewExpiringGoogleCalendarWatches, {
      timezone: process.env.TZ || "America/Sao_Paulo",
    });
    // Opcional: rodar uma vez ao iniciar para pegar canais já expirados
    // setTimeout(renewExpiringGoogleCalendarWatches, 30000); // Ex: 30 segundos após o início
  } else {
    logger.error(`[JOB RENOVAÇÃO WATCH] Schedule cron inválido: ${schedule}. Usando default '0 0 * * *'.`);
    cron.schedule('0 0 * * *', renewExpiringGoogleCalendarWatches, { timezone: process.env.TZ || "America/Sao_Paulo" });
  }
}

module.exports = startGoogleCalendarWatchRenewalJob;
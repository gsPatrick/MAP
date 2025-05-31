// src/features/GoogleWebhook/googleWebhook.service.js
const { Client, Appointment, FinancialAccount, sequelize } = require('../../database');
const googleCalendarService = require('../GoogleCalendar/googleCalendarService');
const appointmentService = require('../Appointment/appointment.service'); // Para criar/atualizar Appointment
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

async function processNotification(channelId, calendarResourceId, resourceState, notificationBody) {
  try {
    logger.info(`[GoogleWebhookService] Processando: Channel=${channelId}, Calendar=${calendarResourceId}, State=${resourceState}`);

    // Para a notificação 'sync', o clientRecord PODE ainda não ter o channelId atualizado
    // se a notificação chegar antes do commit do controller.
    // No entanto, a busca abaixo ainda é a forma correta de associar uma notificação genérica a um cliente.
    const clientRecord = await Client.findOne({
      where: {
        googleChannelId: channelId,
        // googleCalendarIdPrincipal: calendarResourceId, // O resourceId da notificação é o ID do calendário
        isGoogleCalendarSynced: true,
      },
      include: [
        {
          model: FinancialAccount,
          as: 'financialAccounts',
          where: { isActive: true },
          attributes: ['id', 'accountName', 'accountType', 'isDefault'],
          required: false,
        },
      ],
    });

    if (!clientRecord) {
      // Se for uma notificação 'sync' e não encontramos pelo channelId,
      // é provável que seja a primeira notificação imediatamente após o 'watch'
      // e o BD ainda não foi atualizado com o channelId. Isso é normal para 'sync'.
      if (resourceState === 'sync') {
        logger.info(`[GoogleWebhookService] Notificação 'sync' recebida para ChannelID: ${channelId}. O cliente correspondente pode ainda não ter este channelId registrado no BD se esta é a primeira notificação. Isso é esperado.`);
        // Poderíamos tentar encontrar o cliente de outra forma se soubéssemos qual cliente acabou de se registrar,
        // mas para 'sync', geralmente não há ação de dados necessária, apenas confirmação do canal.
        // O importante é que o channelId está sendo salvo no controller.
        return;
      }
      logger.warn(`[GoogleWebhookService] Cliente não encontrado ou não sincronizado para ChannelID: ${channelId} (State: ${resourceState}). Ignorando.`);
      return;
    }

    // Se chegamos aqui e TEMOS um clientRecord, o channelId já está no BD.

    if (resourceState === 'sync') {
      logger.info(`[GoogleWebhookService] Notificação 'sync' (já registrada no BD) para Cliente ${clientRecord.id}, Canal ${channelId}. Verificando canal...`);
      // Opcional: Disparar uma sincronização inicial completa aqui se googleLastSyncToken for nulo.
      if (!clientRecord.googleLastSyncToken) {
          logger.info(`[GoogleWebhookService] Cliente ${clientRecord.id} não possui googleLastSyncToken. Disparando sincronização inicial...`);
          const initialSyncResults = await googleCalendarService.listGoogleEvents(clientRecord.id, null); // null para forçar listagem completa
          if (initialSyncResults && initialSyncResults.items) {
              logger.info(`[GoogleWebhookService] Sincronização inicial: ${initialSyncResults.items.length} eventos para processar para cliente ${clientRecord.id}.`);
              const defaultPFAccount = clientRecord.financialAccounts.find(fa => fa.accountType === 'PF' && fa.isDefault) ||
                                     clientRecord.financialAccounts.find(fa => fa.accountType === 'PF');
              const pjAccounts = clientRecord.financialAccounts.filter(fa => fa.accountType === 'PJ' || fa.accountType === 'MEI');

              for (const googleEvent of initialSyncResults.items) {
                  if (googleEvent.status === 'cancelled') {
                      await appointmentService.deleteOrCancelAppointmentByGoogleId(googleEvent.id, clientRecord.id);
                  } else {
                      await appointmentService.createOrUpdateAppointmentFromGoogle(googleEvent, clientRecord.id, defaultPFAccount?.id, pjAccounts);
                  }
              }
              logger.info(`[GoogleWebhookService] Sincronização inicial concluída para cliente ${clientRecord.id}.`);
          }
          if (initialSyncResults && initialSyncResults.nextSyncToken) {
              await clientRecord.update({ googleLastSyncToken: initialSyncResults.nextSyncToken });
              logger.info(`[GoogleWebhookService] Primeiro nextSyncToken salvo para cliente ${clientRecord.id}.`);
          }
      }
      return;
    }


    // Lógica para resourceState 'exists' ou 'not_exists' (que pode ser um evento deletado)
    logger.info(`[GoogleWebhookService] Estado '${resourceState}' para Cliente ${clientRecord.id}. Buscando mudanças com syncToken: ${clientRecord.googleLastSyncToken ? clientRecord.googleLastSyncToken.substring(0,10)+'...' : 'NULO (sincronização completa será tentada)'}`);
    const syncResults = await googleCalendarService.listGoogleEvents(clientRecord.id, clientRecord.googleLastSyncToken);

    if (!syncResults) {
      logger.error(`[GoogleWebhookService] Falha ao listar eventos do Google para Cliente ${clientRecord.id}.`);
      // Considerar o que fazer aqui. Talvez tentar desconectar o cliente?
      // Ou apenas logar e esperar o job de renovação de watch.
      return;
    }

    const { items: changedEvents, nextSyncToken } = syncResults;

    if (changedEvents && changedEvents.length > 0) {
      logger.info(`[GoogleWebhookService] ${changedEvents.length} eventos alterados encontrados para Cliente ${clientRecord.id}.`);

      const defaultPFAccount = clientRecord.financialAccounts.find(fa => fa.accountType === 'PF' && fa.isDefault) ||
                               clientRecord.financialAccounts.find(fa => fa.accountType === 'PF');
      const pjAccounts = clientRecord.financialAccounts.filter(fa => fa.accountType === 'PJ' || fa.accountType === 'MEI');

      if (!defaultPFAccount && (!pjAccounts || pjAccounts.length === 0) ) {
        logger.warn(`[GoogleWebhookService] Cliente ${clientRecord.id} não possui contas financeiras (PF ou PJ) ativas para associar eventos.`);
        if (nextSyncToken) {
            await clientRecord.update({ googleLastSyncToken: nextSyncToken });
        }
        return;
      }

      for (const googleEvent of changedEvents) {
        // Se o systemAppointmentId não estiver nas props, é um evento que não gerenciamos ainda
        // ou um que perdeu as props.
        const systemAppointmentIdFromProps = googleEvent.extendedProperties?.private?.systemAppointmentId;

        if (googleEvent.status === 'cancelled') {
          logger.info(`[GoogleWebhookService] Evento Google ID ${googleEvent.id} cancelado. Tentando desvincular/cancelar localmente para Cliente ${clientRecord.id}.`);
          await appointmentService.deleteOrCancelAppointmentByGoogleId(googleEvent.id, clientRecord.id);
        } else if (systemAppointmentIdFromProps || (googleEvent.summary || '').includes('[Pessoal]') || (googleEvent.summary || '').match(/\[.*?\]/)) {
          // Processa se for gerenciado OU se parecer ser um novo evento que queremos importar
          logger.info(`[GoogleWebhookService] Evento Google ID ${googleEvent.id} (status: ${googleEvent.status}) existe/atualizado. Tentando criar/atualizar localmente para Cliente ${clientRecord.id}. Gerenciado: ${!!systemAppointmentIdFromProps}`);
          await appointmentService.createOrUpdateAppointmentFromGoogle(
            googleEvent,
            clientRecord.id,
            defaultPFAccount ? defaultPFAccount.id : null,
            pjAccounts
          );
        } else {
            logger.info(`[GoogleWebhookService] Evento Google ID ${googleEvent.id} (status: ${googleEvent.status}) não parece ser gerenciado pelo sistema e não atende aos critérios de importação (título/cor). Ignorando para Cliente ${clientRecord.id}.`);
        }
      }
    } else {
      logger.info(`[GoogleWebhookService] Nenhuma mudança de evento retornada pelo syncToken para Cliente ${clientRecord.id}.`);
    }

    if (nextSyncToken) {
      await clientRecord.update({ googleLastSyncToken: nextSyncToken });
      logger.info(`[GoogleWebhookService] Próximo syncToken salvo para Cliente ${clientRecord.id}: ${nextSyncToken.substring(0,20)}...`);
    } else if (clientRecord.googleLastSyncToken && (!changedEvents || changedEvents.length === 0)) {
      // Se não veio nextSyncToken, mas tínhamos um antes, E não houve eventos, o syncToken antigo é válido.
      logger.info(`[GoogleWebhookService] Nenhum novo nextSyncToken e nenhum evento alterado. Mantendo syncToken atual para Cliente ${clientRecord.id}.`);
    } else if (!nextSyncToken && changedEvents && changedEvents.length > 0) {
        // Isso é um cenário estranho, muitos eventos mas sem nextSyncToken.
        // Pode significar que a listagem foi completa e não incremental.
        logger.warn(`[GoogleWebhookService] Eventos alterados foram processados, mas nenhum nextSyncToken foi retornado. O próximo sync pode ser completo para Cliente ${clientRecord.id}.`);
        // Para evitar loops de sincronização completa, é melhor limpar o syncToken local se um novo não veio após processar eventos.
        // No entanto, a API do Google DEVERIA retornar um nextSyncToken mesmo após uma listagem completa para iniciar o ciclo incremental.
        // Se isso acontecer, pode ser um bug ou uma condição de erro da API.
        // Por segurança, se não houve nextSyncToken e processamos eventos, limpamos o local para forçar um novo completo.
        // Mas isso só se googleLastSyncToken já existia. Se era a primeira vez, já estaria nulo.
        if (clientRecord.googleLastSyncToken) {
            logger.warn(`[GoogleWebhookService] Limpando googleLastSyncToken para Cliente ${clientRecord.id} pois não houve nextSyncToken após processar ${changedEvents.length} eventos.`);
            await clientRecord.update({ googleLastSyncToken: null });
        }
    }


  } catch (error) {
    logger.error(`[GoogleWebhookService] Erro geral ao processar notificação (Channel: ${channelId}): ${error.message}`, { stack: error.stack });
  }
}

module.exports = {
  processNotification,
};
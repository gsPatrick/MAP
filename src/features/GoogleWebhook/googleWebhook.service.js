// src/features/GoogleWebhook/googleWebhook.service.js
const { Client, Appointment, FinancialAccount, sequelize } = require('../../database');
const googleCalendarService = require('../GoogleCalendar/googleCalendarService');
const appointmentService = require('../Appointment/appointment.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

async function processNotification(channelId, calendarResourceId, resourceState, notificationBody) {
  try {
    logger.info(`[GoogleWebhookService] Processando: Channel=${channelId}, Calendar=${calendarResourceId}, State=${resourceState}`);

    const clientRecord = await Client.findOne({
      where: {
        googleChannelId: channelId,
        googleCalendarIdPrincipal: calendarResourceId,
        isGoogleCalendarSynced: true,
      },
      include: [ // Incluir contas financeiras para determinar o financialAccountId correto
        {
          model: FinancialAccount,
          as: 'financialAccounts',
          where: { isActive: true },
          attributes: ['id', 'accountName', 'accountType', 'isDefault'],
          required: false, // Pode não ter nenhuma, ou pode ser PF/PJ
        },
      ],
    });

    if (!clientRecord) {
      logger.warn(`[GoogleWebhookService] Cliente não encontrado ou não sincronizado para ChannelID: ${channelId}. Ignorando.`);
      return;
    }

    if (resourceState === 'sync') {
      logger.info(`[GoogleWebhookService] Notificação 'sync' para Cliente ${clientRecord.id}. Verificando canal...`);
      // Opcional: verificar se o googleChannelId e expiryDate do cliente precisam ser atualizados
      // se a API de 'watch' retornou novos dados (o Google envia 'sync' ao (re)estabelecer o watch).
      // Poderia chamar googleCalendarService.getChannelDetails(channelId) se tal função existisse.
      return;
    }

    // Para 'exists' ou 'not_exists' (embora not_exists seja mais raro para eventos individuais aqui)
    // Precisamos usar o syncToken para obter as mudanças.

    const syncResults = await googleCalendarService.listGoogleEvents(clientRecord.id, clientRecord.googleLastSyncToken);

    if (!syncResults) {
      logger.error(`[GoogleWebhookService] Falha ao listar eventos do Google para Cliente ${clientRecord.id} usando syncToken.`);
      return;
    }

    const { items: changedEvents, nextSyncToken } = syncResults;

    if (changedEvents && changedEvents.length > 0) {
      logger.info(`[GoogleWebhookService] ${changedEvents.length} eventos alterados encontrados para Cliente ${clientRecord.id}.`);

      const defaultPFAccount = clientRecord.financialAccounts.find(fa => fa.accountType === 'PF' && fa.isDefault) ||
                               clientRecord.financialAccounts.find(fa => fa.accountType === 'PF');
      const pjAccounts = clientRecord.financialAccounts.filter(fa => fa.accountType === 'PJ' || fa.accountType === 'MEI');

      if (!defaultPFAccount && pjAccounts.length === 0) {
        logger.warn(`[GoogleWebhookService] Cliente ${clientRecord.id} não possui contas financeiras (PF ou PJ) ativas. Não é possível importar/sincronizar eventos do Google.`);
        // Salva o syncToken mesmo assim para não reprocessar os mesmos eventos na próxima vez
        if (nextSyncToken) {
            await clientRecord.update({ googleLastSyncToken: nextSyncToken });
        }
        return;
      }


      for (const googleEvent of changedEvents) {
        if (googleEvent.status === 'cancelled') {
          // Evento foi cancelado/deletado no Google
          logger.info(`[GoogleWebhookService] Evento Google ID ${googleEvent.id} cancelado. Tentando desvincular/cancelar localmente para Cliente ${clientRecord.id}.`);
          await appointmentService.deleteOrCancelAppointmentByGoogleId(googleEvent.id, clientRecord.id);
        } else {
          // Evento foi criado ou atualizado no Google
          logger.info(`[GoogleWebhookService] Evento Google ID ${googleEvent.id} (status: ${googleEvent.status}) existe/atualizado. Tentando criar/atualizar localmente para Cliente ${clientRecord.id}.`);
          await appointmentService.createOrUpdateAppointmentFromGoogle(
            googleEvent,
            clientRecord.id,
            defaultPFAccount ? defaultPFAccount.id : null, // Passa ID da conta PF padrão
            pjAccounts // Passa lista de contas PJ
          );
        }
      }
    } else {
      logger.info(`[GoogleWebhookService] Nenhuma mudança de evento retornada pelo syncToken para Cliente ${clientRecord.id}.`);
    }

    // Salvar o nextSyncToken para o cliente, crucial para a próxima notificação
    if (nextSyncToken) {
      await clientRecord.update({ googleLastSyncToken: nextSyncToken });
      logger.info(`[GoogleWebhookService] Próximo syncToken ${nextSyncToken.substring(0,20)}... salvo para Cliente ${clientRecord.id}.`);
    } else if (clientRecord.googleLastSyncToken) {
      // Se não veio nextSyncToken, mas tínhamos um antes, pode ser um reset.
      // Se a lista de eventos estava vazia, o syncToken antigo ainda é válido.
      // Se a lista de eventos NÃO estava vazia mas não veio nextSyncToken, isso é incomum.
      // O Google geralmente retorna um nextSyncToken mesmo que a lista de itens esteja vazia,
      // exceto se o syncToken original se tornou inválido (ex: após muito tempo sem uso),
      // caso em que a API retorna erro 410 e `listGoogleEvents` tentaria uma sincronização completa.
      logger.info(`[GoogleWebhookService] Nenhum novo nextSyncToken retornado. SyncToken atual (${clientRecord.googleLastSyncToken.substring(0,20)}...) mantido para Cliente ${clientRecord.id}.`);
    }


  } catch (error) {
    logger.error(`[GoogleWebhookService] Erro ao processar notificação (Channel: ${channelId}): ${error.message}`, { stack: error.stack });
  }
}

module.exports = {
  processNotification,
};
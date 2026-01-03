// src/jobs/checklistSummaryJob.js
const cron = require('node-cron');
const { DailyChecklist, ChecklistItem, FinancialAccount, Client } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

/**
 * Busca dados e envia o resumo do checklist para contas de negócio elegíveis.
 */
async function sendChecklistSummaries() {
  logger.info('[JOB CHECKLIST] Iniciando verificação de resumos diários de checklist...');

  // <<< CHECK GLOBAL SWITCH REMOVED FOR CORE FUNCTIONALITY >>>
  // const systemService = require('../features/System/system.service');
  // const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
  // if (!isEnabled) {
  //   logger.warn('[JOB CHECKLIST] Job abortado: Global switch OFF.');
  //   return;
  // }
  // ---------------------------

  try {
    const today = new Date().toISOString().split('T')[0];

    // <<< INÍCIO DA MODIFICAÇÃO >>>
    // A query agora junta com Client e filtra por assinatura ativa.
    const checklistsToSummarize = await DailyChecklist.findAll({
      where: {
        date: today,
      },
      include: [
        {
          model: ChecklistItem,
          as: 'items',
          required: true,
        },
        {
          model: FinancialAccount,
          as: 'financialAccount',
          include: [{
            model: Client,
            as: 'ownerClient',
            where: {
              status: 'Ativo',
              phone: { [Op.ne]: null },
              [Op.or]: [
                { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
                { accessExpiresAt: { [Op.gte]: today } }
              ]
            },
            required: true,
          }],
          required: true,
        }
      ]
    });
    // <<< FIM DA MODIFICAÇÃO >>>

    if (checklistsToSummarize.length === 0) {
      logger.info('[JOB CHECKLIST] Nenhum checklist com tarefas encontrado hoje para resumir.');
      return;
    }

    logger.info(`[JOB CHECKLIST] ${checklistsToSummarize.length} checklists encontrados para resumir.`);

    for (const checklist of checklistsToSummarize) {
      const client = checklist.financialAccount.ownerClient;
      const clientFirstName = client.name ? client.name.split(' ')[0] : 'Você';

      const completedItems = checklist.items.filter(item => item.completed);
      const pendingItems = checklist.items.filter(item => !item.completed);
      const totalItems = checklist.items.length;
      const completionRate = totalItems > 0 ? Math.round((completedItems.length / totalItems) * 100) : 0;

      let message = `🏁 *Resumo do seu Checklist de Hoje, ${clientFirstName}!* 🏁\n\n`;

      if (completionRate === 100) {
        message += `🎉 *Parabéns! Você completou 100% das suas tarefas hoje (${totalItems}/${totalItems})!* Que dia produtivo! Você mandou muito bem! 🚀\n`;
      } else if (completionRate >= 70) {
        message += `🏆 *Excelente progresso!* Você concluiu *${completionRate}%* das suas tarefas (${completedItems.length}/${totalItems}). Um ótimo resultado!\n`;
      } else if (completionRate >= 40) {
        message += `👍 *Bom trabalho hoje!* Você finalizou *${completedItems.length} de ${totalItems}* tarefas. Cada passo conta na jornada!\n`;
      } else {
        message += `💪 Todo progresso é progresso! Você concluiu *${completedItems.length} de ${totalItems}* tarefas hoje. Amanhã é um novo dia para avançar ainda mais!\n`;
      }

      if (pendingItems.length > 0) {
        message += `\n*Tarefas que ficaram pendentes:*\n`;
        pendingItems.slice(0, 5).forEach(item => {
          message += `> 📝 ${item.text}\n`;
        });
        message += `\nNão se preocupe, o importante é o aprendizado. Amanhã teremos uma nova oportunidade! ✨`;
      } else {
        message += `\n*Descanso merecido!* Você não deixou nada para trás. Aproveite para relaxar.`;
      }

      message += `\n\nLembre-se: amanhã a lista zera para um novo começo. Para adicionar tarefas a qualquer momento, é só me dizer: *"adicionar tarefa [descrição da tarefa]"*.`;

      try {
        await sendWhatsappMessage(client.phone, message);
        logger.info(`[JOB CHECKLIST] Resumo enviado para ${client.name} (Conta: ${checklist.financialAccount.accountName}).`);
      } catch (sendError) {
        logger.error(`[JOB CHECKLIST] Erro ao enviar resumo para cliente ${client.id}:`, sendError);
      }
    }
    logger.info('[JOB CHECKLIST] Verificação de resumos de checklist concluída.');
  } catch (error) {
    logger.error('[JOB CHECKLIST] Erro geral no job:', { message: error.message, stack: error.stack });
  }
}

/**
 * Inicia o agendamento do job.
 */
function startChecklistSummaryJob() {
  const schedule = '0 22 * * *'; // Todo dia às 22:00

  logger.info(`[JOB CHECKLIST] Agendado para rodar diariamente às 22h (schedule: ${schedule})`);

  cron.schedule(schedule, sendChecklistSummaries, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startChecklistSummaryJob;
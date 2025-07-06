// src/jobs/checklistReminderJob.js
const cron = require('node-cron');
const { DailyChecklist, ChecklistItem, FinancialAccount, Client } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

/**
 * Busca checklists com tarefas pendentes e envia lembretes.
 */
async function sendChecklistReminders() {
  logger.info('[JOB CHECKLIST REMINDER] Iniciando verificação de tarefas pendentes...');
  try {
    const today = new Date().toISOString().split('T')[0];

    // Busca checklists de hoje que tenham itens pendentes
    const checklistsToRemind = await DailyChecklist.findAll({
      where: {
        date: today,
      },
      include: [
        {
          model: ChecklistItem,
          as: 'items',
          where: { completed: false }, // Apenas checklists com itens pendentes
          required: true,
        },
        {
          model: FinancialAccount,
          as: 'financialAccount',
          include: [{
            model: Client,
            as: 'ownerClient',
            where: { status: 'Ativo', phone: { [Op.ne]: null } },
            required: true,
          }],
          required: true,
        }
      ]
    });

    if (checklistsToRemind.length === 0) {
      logger.info('[JOB CHECKLIST REMINDER] Nenhum checklist com tarefas pendentes para lembrar agora.');
      return;
    }

    logger.info(`[JOB CHECKLIST REMINDER] ${checklistsToRemind.length} checklists encontrados para lembrar.`);

    for (const checklist of checklistsToRemind) {
      const client = checklist.financialAccount.ownerClient;
      const clientFirstName = client.name ? client.name.split(' ')[0] : 'Você';

      const pendingItems = checklist.items; // Já vem filtrado da query
      if (pendingItems.length === 0) continue;

      let message = `Olá, ${clientFirstName}! Passando para dar um gás no seu dia! 🚀\n\n`;
      message += `Notei que você ainda tem *${pendingItems.length}* tarefa(s) pendente(s) no seu checklist de hoje. Que tal dar o próximo passo?\n\n`;
      
      const highPriorityItem = pendingItems.find(p => p.priority === 'high');
      if (highPriorityItem) {
        message += `🎯 *Foco na prioridade:* Começar por *"${highPriorityItem.text}"* pode ser uma ótima ideia!\n`;
      } else {
        message += `🎯 Uma sugestão: que tal começar por *"${pendingItems[0].text}"*?\n`;
      }

      message += `\nLembre-se, cada tarefa concluída é uma vitória! Para marcar uma como feita, é só me dizer: *"concluí a tarefa [descrição]"*. Você consegue! 💪`;

      try {
        await sendWhatsappMessage(client.phone, message);
        logger.info(`[JOB CHECKLIST REMINDER] Lembrete enviado para ${client.name} (Conta: ${checklist.financialAccount.accountName}).`);
      } catch (sendError) {
        logger.error(`[JOB CHECKLIST REMINDER] Erro ao enviar lembrete para cliente ${client.id}:`, sendError);
      }
    }
    logger.info('[JOB CHECKLIST REMINDER] Verificação de lembretes de checklist concluída.');
  } catch (error) {
    logger.error('[JOB CHECKLIST REMINDER] Erro geral no job:', { message: error.message, stack: error.stack });
  }
}

/**
 * Inicia o agendamento do job.
 */
function startChecklistReminderJob() {
  // Roda às 11:00 e às 16:00, de segunda a sábado.
  const schedule = '0 11,16 * * 1-6';
  
  logger.info(`[JOB CHECKLIST REMINDER] Agendado para rodar às 11h e 16h, de Seg a Sáb (schedule: ${schedule})`);
  
  cron.schedule(schedule, sendChecklistReminders, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startChecklistReminderJob;
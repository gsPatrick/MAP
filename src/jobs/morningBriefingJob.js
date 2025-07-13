// src/jobs/morningBriefingJob.js
const cron = require('node-cron');
const { Client, FinancialAccount, FinancialTransaction, Appointment, DailyChecklist, ChecklistItem } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const hydrationService = require('../features/Hydration/hydration.service');
const aiModelService = require('../services/aiModelService');

/**
 * Busca dados e envia o resumo matinal para todos os clientes elegíveis.
 */
async function processAndSendBriefings() {
  logger.info('[JOB BRIEFING MATINAL] Iniciando verificação de resumos diários...');
  try {
    const today = new Date();
    const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));
    const endOfDay = new Date(new Date().setHours(23, 59, 59, 999));
    const todayDateString = startOfDay.toISOString().split('T')[0];

    const activeClients = await Client.findAll({
      where: {
        status: 'Ativo',
        phone: { [Op.ne]: null },
      },
    });

    if (activeClients.length === 0) {
      logger.info('[JOB BRIEFING MATINAL] Nenhum cliente ativo encontrado para enviar o resumo.');
      return;
    }

    logger.info(`[JOB BRIEFING MATINAL] ${activeClients.length} clientes encontrados para processar.`);

    for (const client of activeClients) {
      try {
        const clientAccounts = await client.getFinancialAccounts({ where: { isActive: true } });
        if (clientAccounts.length === 0) continue;

        const accountIds = clientAccounts.map(acc => acc.id);
        
        // <<<< INÍCIO DA MUDANÇA >>>>
        // Em vez de buscar uma conta de negócio específica, agora busca a conta padrão do usuário
        // ou, como fallback, a primeira conta ativa encontrada. Isso torna o checklist universal.
        const mainAccountForChecklist = clientAccounts.find(acc => acc.isDefault) || clientAccounts[0];
        // <<<< FIM DA MUDANÇA >>>>

        // --- BUSCA DE DADOS FINANCEIROS E DE AGENDA (EXISTENTE) ---
        const pendingTransactions = await FinancialTransaction.findAll({
          where: {
            financialAccountId: { [Op.in]: accountIds },
            isPayableOrReceivable: true,
            isPaidOrReceived: false,
            dueDate: todayDateString,
          },
          include: [{ model: FinancialAccount, as: 'financialAccount', attributes: ['accountName'] }],
          order: [['value', 'DESC']],
        });

        const appointments = await Appointment.findAll({
          where: {
            financialAccountId: { [Op.in]: accountIds },
            status: { [Op.in]: ['Scheduled', 'Confirmed'] },
            eventDateTime: { [Op.between]: [startOfDay, endOfDay] },
          },
          include: [{ model: FinancialAccount, as: 'financialAccount', attributes: ['accountName'] }],
          order: [['eventDateTime', 'ASC']],
        });
        
        const recurringItems = await FinancialTransaction.findAll({
            where: {
                financialAccountId: { [Op.in]: accountIds },
                recurringTransactionRuleId: { [Op.ne]: null },
                transactionDate: todayDateString,
            },
            include: [{ model: FinancialAccount, as: 'financialAccount', attributes: ['accountName'] }],
            order: [['createdAt', 'DESC']],
        });

        // --- LÓGICA DE CHECKLIST MODIFICADA ---
        let checklistData = null;
        // <<<< INÍCIO DA MUDANÇA >>>>
        // A verificação agora é feita na 'mainAccountForChecklist', que pode ser de qualquer tipo.
        if (mainAccountForChecklist) {
            const checklist = await DailyChecklist.findOne({
                where: { financialAccountId: mainAccountForChecklist.id, date: todayDateString },
                include: [{ model: ChecklistItem, as: 'items', order: [['createdAt', 'ASC']] }] // Ordena as tarefas
            });
            // Estrutura os dados do checklist para enviar à IA
            checklistData = {
                accountName: mainAccountForChecklist.accountName, // Usa o nome da conta principal
                items: checklist ? checklist.items.map(item => item.toJSON()) : [] // Garante que itens seja um array
            };
        }
        // <<<< FIM DA MUDANÇA >>>>

        // Ação proativa de hidratação
        await hydrationService.logWaterIntake(client.id, 250, 'Registrado automaticamente pelo briefing matinal');

        const clientFirstName = client.name ? client.name.split(' ')[0] : 'você';

        const briefingData = {
          clientName: clientFirstName,
          pendingTransactions,
          appointments,
          recurringItems,
          checklistData, // PASSANDO OS DADOS DO CHECKLIST PARA A IA
        };
        
        // A IA agora recebe os dados do checklist e pode incluí-los na mensagem
        const briefingMessage = await aiModelService.generateMorningBriefingMessage(briefingData);

        await sendWhatsappMessage(client.phone, briefingMessage);
        logger.info(`[JOB BRIEFING MATINAL] Resumo do dia com conselhos gerado por IA e enviado para ${client.name}.`);

      } catch (clientError) {
        logger.error(`[JOB BRIEFING MATINAL] Erro ao processar ou enviar para cliente ${client.id}:`, clientError);
      }
    }
    logger.info('[JOB BRIEFING MATINAL] Processamento de resumos diários finalizado.');
  } catch (error) {
    logger.error('[JOB BRIEFING MATINAL] Erro geral no job:', { message: error.message, stack: error.stack });
  }
}

/**
 * Inicia o agendamento do job.
 */
function startMorningBriefingJob(preferences) {
  const schedule = '0 8 * * *'; // Todo dia às 8:00 da manhã
  
  logger.info(`[JOB BRIEFING MATINAL] Agendado para rodar diariamente às 8h (schedule: ${schedule})`);
  
  cron.schedule(schedule, processAndSendBriefings, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startMorningBriefingJob;
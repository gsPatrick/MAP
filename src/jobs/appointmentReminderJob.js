// src/jobs/appointmentReminderJob.js
const cron = require('node-cron');
const appointmentService = require('../features/Appointment/appointment.service');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
const formatter = require('../features/WhatsappHandler/response.formatter');
const aiModelService = require('../services/aiModelService'); // Importado para mensagens criativas
const { Op } = require('sequelize'); // Importar Op para queries complexas

/**
 * Envia lembretes para compromissos de contas de Pessoa Física (PF).
 * Usa a lógica de reminderLeadTimeMinutes.
 */
async function sendPersonalAccountReminders() {
  logger.info('[JOB LEMBRETE - PF] Verificando compromissos de contas pessoais...');
  try {
    const today = new Date().toISOString().split('T')[0];

    // --- INÍCIO DA CORREÇÃO ---

    // 1. Buscar os IDs das contas financeiras PF que pertencem a clientes com assinatura ativa.
    const activePfAccounts = await FinancialAccount.findAll({
      where: {
        accountType: 'PF',
        isActive: true,
      },
      include: [{
        model: Client,
        as: 'ownerClient',
        attributes: [], // Não precisamos dos dados do cliente aqui, apenas da condição
        where: {
          status: 'Ativo',
          [Op.or]: [
            { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
            { accessExpiresAt: { [Op.gte]: today } }
          ]
        },
        required: true // Garante que só venham contas de clientes que atendem ao critério
      }],
      attributes: ['id'] // Seleciona apenas o ID da conta financeira
    });

    if (activePfAccounts.length === 0) {
      logger.info('[JOB LEMBRETE - PF] Nenhuma conta PF de clientes com assinatura ativa encontrada.');
      return;
    }

    // 2. Extrair apenas os IDs para um array de números.
    const activePfAccountIds = activePfAccounts.map(acc => acc.id);
    
    // 3. Chamar o serviço de agendamentos com o array de IDs correto.
    const appointmentsToRemind = await appointmentService.getPFAppointmentsNeedingReminder(activePfAccountIds);

    // --- FIM DA CORREÇÃO ---

    if (appointmentsToRemind.length === 0) {
      // logger.info('[JOB LEMBRETE - PF] Nenhum compromisso de PF precisando de lembrete.');
      return;
    }
    logger.info(`[JOB LEMBRETE - PF] ${appointmentsToRemind.length} compromissos de PF encontrados para lembrar.`);

    for (const app of appointmentsToRemind) {
      try {
        const clientPhone = app.financialAccount?.ownerClient?.phone;
        const clientFirstName = app.financialAccount?.ownerClient?.name?.split(' ')[0] || 'Você';
        const accountName = app.financialAccount?.accountName || 'Sua Conta';

        if (!clientPhone) {
          logger.warn(`[JOB LEMBRETE - PF] Compromisso ID ${app.id} (Conta: ${accountName}) não possui cliente com telefone. Marcando como enviado.`);
          await appointmentService.markReminderAsSent(app.id);
          continue;
        }

        const intro = `Oi, ${clientFirstName}! Passando para te dar um toque sobre seu compromisso na conta *${accountName}* que está chegando! 😉`;
        const body = formatter.formatAppointmentDataStructure(app, true, clientFirstName);
        const footer = `Qualquer coisa, me avise! Tenha um ótimo compromisso! ✨`;
        const message = `${intro}\n\n${body}\n\n${footer}`;

        const sentSuccessfully = await sendWhatsappMessage(clientPhone, message);
        if (sentSuccessfully) {
            logger.info(`[JOB LEMBRETE - PF] Lembrete para "${app.title}" (Conta: ${accountName}) enviado para Cliente ${clientFirstName} (${clientPhone})`);
            await appointmentService.markReminderAsSent(app.id);
        } else {
            logger.error(`[JOB LEMBRETE - PF] Falha ao enviar lembrete via WhatsApp para compromisso ID ${app.id}.`);
        }
      } catch (sendError) {
        logger.error(`[JOB LEMBRETE - PF] Erro ao processar/enviar lembrete para compromisso ID ${app.id}:`, { message: sendError.message, stack: sendError.stack });
      }
    }
     logger.info('[JOB LEMBRETE - PF] Verificação de compromissos pessoais concluída.');
  } catch (error) {
    logger.error('[JOB LEMBRETE - PF] Erro geral:', { message: error.message, stack: error.stack });
  }
}

/**
 * Envia lembretes para compromissos de contas de Negócio (PJ/MEI).
 * Usa a lógica de 24h e 30min antes do evento.
 */
async function sendBusinessAccountReminders() {
    logger.info('[JOB LEMBRETE - PJ/MEI] Verificando compromissos de contas de negócio...');
    // <<< INÍCIO DA MODIFICAÇÃO >>>
    // O filtro de assinatura ativa será passado para as funções do service.
    const today = new Date().toISOString().split('T')[0];
    const clientSubscriptionFilter = {
        status: 'Ativo',
        [Op.or]: [
            { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
            { accessExpiresAt: { [Op.gte]: today } }
        ]
    };
    // <<< FIM DA MODIFICAÇÃO >>>

    // Lembretes de 24 horas
    try {
        const appointments24h = await appointmentService.getPJAppointmentsNeeding24hReminder(clientSubscriptionFilter);
        if (appointments24h.length > 0) {
            logger.info(`[JOB LEMBRETE - PJ/MEI] ${appointments24h.length} compromissos encontrados para lembrete de 24h.`);
            for (const app of appointments24h) {
                const providerName = app.financialAccount.accountName || app.financialAccount.ownerClient.name;
                for (const bClient of app.businessClients) {
                    if (bClient.phone) {
                        const creativeMessage = await aiModelService.generateClientReminderMessage(providerName, bClient.name, app.toJSON(), "24 horas");
                        const formattedDetails = formatter.formatAppointmentDataStructure(app.toJSON(), true);
                        const finalMessage = `${creativeMessage}\n\n${formattedDetails}\n\n---\nLembrete de *${providerName}* via MAP no Controle.`;
                        
                        const sent = await sendWhatsappMessage(bClient.phone, finalMessage);
                        if (sent) {
                            logger.info(`[JOB LEMBRETE - PJ/MEI] Lembrete de 24h para Appt ID ${app.id} enviado para BusinessClient ${bClient.name} (${bClient.phone}).`);
                        }
                    }
                }
                await appointmentService.mark24hReminderAsSent(app.id);
            }
        }
    } catch (error) {
        logger.error('[JOB LEMBRETE - PJ/MEI] Erro ao processar lembretes de 24h:', error);
    }

    // Lembretes de 30 minutos
    try {
        const appointments30min = await appointmentService.getPJAppointmentsNeeding30minReminder(clientSubscriptionFilter);
        if (appointments30min.length > 0) {
            logger.info(`[JOB LEMBRETE - PJ/MEI] ${appointments30min.length} compromissos encontrados para lembrete de 30min.`);
            for (const app of appointments30min) {
                const providerName = app.financialAccount.accountName || app.financialAccount.ownerClient.name;
                for (const bClient of app.businessClients) {
                    if (bClient.phone) {
                        const creativeMessage = await aiModelService.generateClientReminderMessage(providerName, bClient.name, app.toJSON(), "30 minutos");
                        const formattedDetails = formatter.formatAppointmentDataStructure(app.toJSON(), true);
                        const finalMessage = `${creativeMessage}\n\n${formattedDetails}\n\n---\nLembrete de *${providerName}* via MAP no Controle.`;

                        const sent = await sendWhatsappMessage(bClient.phone, finalMessage);
                         if (sent) {
                            logger.info(`[JOB LEMBRETE - PJ/MEI] Lembrete de 30min para Appt ID ${app.id} enviado para BusinessClient ${bClient.name} (${bClient.phone}).`);
                        }
                    }
                }
                await appointmentService.mark30minReminderAsSent(app.id);
            }
        }
    } catch (error) {
        logger.error('[JOB LEMBRETE - PJ/MEI] Erro ao processar lembretes de 30min:', error);
    }
    
    logger.info('[JOB LEMBRETE - PJ/MEI] Verificação de compromissos de negócio concluída.');
}

/**
 * Função principal do Job, que chama as duas lógicas de lembrete.
 */
async function sendAllAppointmentReminders() {
    logger.info('[JOB LEMBRETE - MASTER] Iniciando ciclo de verificação de lembretes...');
    await sendPersonalAccountReminders();
    await sendBusinessAccountReminders();
    logger.info('[JOB LEMBRETE - MASTER] Ciclo de verificação de lembretes finalizado.');
}


/**
 * Inicia o cron job para enviar os lembretes de compromisso.
 * @param {object} preferences - Objeto de preferências do sistema.
 */
function startAppointmentReminderJob(preferences) {
  const schedule = preferences?.appointmentReminderJobSchedule || '*/2 * * * *'; // Aumentei a frequência para melhor precisão

  if (cron.validate(schedule)) {
    logger.info(`[JOB LEMBRETE - MASTER] Agendado para rodar: ${schedule}`);
    cron.schedule(schedule, sendAllAppointmentReminders, {
      timezone: process.env.TZ || "America/Sao_Paulo",
    });
  } else {
    logger.error(`[JOB LEMBRETE - MASTER] Schedule cron inválido nas preferências: ${schedule}. Usando default '*/2 * * * *'.`);
    cron.schedule('*/2 * * * *', sendAllAppointmentReminders, { timezone: process.env.TZ || "America/Sao_Paulo" });
  }
}

module.exports = startAppointmentReminderJob;
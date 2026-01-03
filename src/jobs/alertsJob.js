// src/jobs/alertsJob.js
const cron = require('node-cron');
const { FinancialTransaction, Product, FinancialAccount, Client, UserPreference, RecurringTransactionRule, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
// Importando formatadores para consistência
const { formatCurrency, formatDate } = require('../utils/formatters');

async function checkAndSendAlerts() {
  logger.info('[JOB ALERTAS] Verificando alertas...');

  // <<< CHECK GLOBAL SWITCH REMOVED FOR CORE FUNCTIONALITY >>>
  // const systemService = require('../features/System/system.service');
  // const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
  // if (!isEnabled) {
  //   logger.warn('[JOB ALERTAS] Job abortado: Global switch OFF.');
  //   return;
  // }
  // ---------------------------

  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    const adminPhoneNumberForGlobalAlerts = process.env.ADMIN_PHONE_FOR_ALERTS;

    const activeFinancialAccounts = await FinancialAccount.findAll({
      where: { isActive: true },
      include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
    });

    if (activeFinancialAccounts.length === 0) {
      logger.info('[JOB ALERTAS] Nenhuma conta financeira ativa encontrada.');
      return;
    }

    for (const account of activeFinancialAccounts) {
      const client = account.ownerClient;
      const clientPhone = client?.phone;
      const clientFirstName = client?.name ? client.name.split(' ')[0] : 'você';

      let alertSections = []; // Array para acumular seções de alerta formatadas
      let lowStockProducts; // Declare here to access it later

      // --- 1. Alerta de Contas a Vencer/Vencidas ---
      const today = new Date();
      const leadDays = preferences?.dueAlertLeadDays || 3;
      const NdaysFromNow = new Date(today);
      NdaysFromNow.setDate(today.getDate() + leadDays);

      const upcomingDues = await FinancialTransaction.findAll({
        where: {
          financialAccountId: account.id,
          isPayableOrReceivable: true,
          isPaidOrReceived: false,
          dueDate: {
            [Op.gte]: today.toISOString().split('T')[0],
            [Op.lte]: NdaysFromNow.toISOString().split('T')[0],
          }
        },
        order: [['dueDate', 'ASC']]
      });

      if (upcomingDues.length > 0) {
        let dueAlertSection = `🗓️ *Contas Próximas do Vencimento:*\n`;
        upcomingDues.forEach(due => {
          const formattedDueDate = formatDate(due.dueDate);
          dueAlertSection += `>  💸 ${due.description} (${formatCurrency(due.value)}) vence em *${formattedDueDate}*\n`;
        });
        alertSections.push(dueAlertSection.trim());
      }

      // --- 2. Alerta de Estoque Mínimo (para contas PJ/MEI) ---
      if (['PJ', 'MEI'].includes(account.accountType)) {
        lowStockProducts = await Product.findAll({ // Assign to the outer scoped variable
          where: {
            financialAccountId: account.id,
            isActive: true,
            quantity: { [Op.lte]: sequelize.col('minimumStock') },
            minimumStock: { [Op.gt]: 0 }
          }
        });
        if (lowStockProducts.length > 0) {
          let stockAlertSection = `📦 *Alerta de Estoque Baixo:*\n`;
          lowStockProducts.forEach(p => {
            stockAlertSection += `>  📉 ${p.name}: Apenas *${p.quantity} un.* em estoque (Mínimo: ${p.minimumStock} un.)\n`;
          });
          alertSections.push(stockAlertSection.trim());
        }
      }

      // --- 3. Lembretes Fiscais para MEI/PJ (Exemplo simples para DAS MEI) ---
      if (account.accountType === 'MEI') {
        const dasPaymentDay = 20;
        const currentDay = today.getDate();
        const daysUntilDAS = dasPaymentDay - currentDay;

        if (daysUntilDAS >= 0 && daysUntilDAS <= (preferences?.fiscalAlertLeadDaysMEI || 5)) {
          const dasMonth = today.toLocaleDateString('pt-BR', { month: 'long' });
          let meiAlertSection = `🧾 *Lembrete Fiscal (MEI):*\n`;
          meiAlertSection += `>  📮 O pagamento do *DAS de ${dasMonth}* vence no dia *${dasPaymentDay}*. Fique de olho!\n`;

          const dasRule = await RecurringTransactionRule.findOne({
            where: {
              financialAccountId: account.id,
              description: { [Op.iLike]: `%DAS MEI%${dasMonth}%` },
              isActive: true
            }
          });
          if (!dasRule) {
            meiAlertSection += `>  💡 _Dica: Você pode criar uma recorrência para este pagamento para não esquecer._\n`;
          }
          alertSections.push(meiAlertSection.trim());
        }
      }

      // Enviar alertas acumulados para o cliente desta conta
      if (alertSections.length > 0) {
        const alertTypesFound = [];
        if (upcomingDues.length > 0) alertTypesFound.push('due_dates');
        // Check if lowStockProducts is defined and has items before accessing its length
        if (lowStockProducts && lowStockProducts.length > 0) alertTypesFound.push('low_stock');
        if (account.accountType === 'MEI' && (alertSections.some(s => s.includes("Lembrete Fiscal")))) alertTypesFound.push('fiscal_reminder');

        // Assuming aiModelService is defined elsewhere and imported correctly.
        // For this example, we'll mock it or use a placeholder if it's not part of the provided code.
        const intro = `Olá ${clientFirstName}, aqui estão os alertas para sua conta ${account.accountName}:`; // Placeholder if aiModelService is not available
        // const intro = await aiModelService.generateAlertsIntro(clientFirstName, account.accountName, alertTypesFound);

        const body = alertSections.join('\n\n');
        const footer = `Qualquer coisa, é só me chamar! 😉`;

        const finalMessage = `${intro}\n\n${body}\n\n${footer}`;

        if (clientPhone) {
          await sendWhatsappMessage(clientPhone, finalMessage);
          logger.info(`[JOB ALERTAS] Alertas enviados para Cliente ${client?.name} (${clientPhone}) para a conta ${account.accountName}.`);
        } else if (adminPhoneNumberForGlobalAlerts) {
          logger.warn(`[JOB ALERTAS] Cliente da conta ${account.accountName} sem telefone. Enviando para admin.`);
          await sendWhatsappMessage(adminPhoneNumberForGlobalAlerts, `ALERTAS (Conta Cliente S/ Tel: ${account.accountName}):\n${finalMessage}`);
        } else {
          logger.warn(`[JOB ALERTAS] Alertas gerados para conta ${account.accountName} mas sem destinatário (cliente sem tel e admin não configurado).`);
        }
      }
    } // End of the for loop

    // The extra '}' was here, it has been removed.
    // logger.info should be the last statement inside the try block.
    logger.info('[JOB ALERTAS] Verificação de alertas concluída.');
  } catch (error) {
    logger.error('[JOB ALERTAS] Erro ao verificar/enviar alertas:', { message: error.message, stack: error.stack });
  }
}

function startAlertsJob() {
  UserPreference.findOne({ order: [['id', 'ASC']] })
    .then(preferences => {
      const schedule = preferences?.alertsJobSchedule || '0 9 * * *'; // Todo dia às 09:00 por padrão
      if (cron.validate(schedule)) {
        logger.info(`[JOB ALERTAS] Agendado para: ${schedule}`);
        cron.schedule(schedule, checkAndSendAlerts, {
          timezone: process.env.TZ || "America/Sao_Paulo",
        });
      } else {
        logger.error(`[JOB ALERTAS] Schedule cron inválido: ${schedule}. Usando default '0 9 * * *'.`);
        cron.schedule('0 9 * * *', checkAndSendAlerts, { timezone: process.env.TZ || "America/Sao_Paulo" });
      }
    }).catch(error => {
      logger.error('[JOB ALERTAS] Erro ao buscar prefs. Usando default. Detalhes:', error);
      cron.schedule('0 9 * * *', checkAndSendAlerts, { timezone: process.env.TZ || "America/Sao_Paulo" });
    });
}

module.exports = startAlertsJob;
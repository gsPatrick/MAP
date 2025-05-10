// src/jobs/alertsJob.js
const cron = require('node-cron');
const { FinancialTransaction, Product, FinancialAccount, Client, UserPreference, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

async function checkAndSendAlerts() {
  logger.info('[JOB ALERTAS] Verificando alertas...');
  
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
        let accountAlertsMessages = []; // Array para acumular mensagens de alerta para esta conta

        // --- 1. Alerta de Contas a Vencer/Vencidas ---
        const today = new Date();
        const leadDays = preferences?.dueAlertLeadDays || 3; // Dias de antecedência para alerta
        const NdaysFromNow = new Date(today);
        NdaysFromNow.setDate(today.getDate() + leadDays);

        const upcomingDues = await FinancialTransaction.findAll({
          where: {
            financialAccountId: account.id,
            isPayableOrReceivable: true,
            isPaidOrReceived: false,
            dueDate: {
              [Op.gte]: today.toISOString().split('T')[0], // A partir de hoje
              [Op.lte]: NdaysFromNow.toISOString().split('T')[0], // Até N dias no futuro
            }
          },
          order: [['dueDate', 'ASC']]
        });

        if (upcomingDues.length > 0) {
          let dueAlertMsg = `--- CONTAS A VENCER (Próximos ${leadDays} dias) ---\n`;
          upcomingDues.forEach(due => {
            dueAlertMsg += `- ${due.description} (R$ ${parseFloat(due.value).toFixed(2)}) vence em ${new Date(due.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone: 'UTC'})}\n`; // Adiciona T00:00:00Z para tratar como data local
          });
          accountAlertsMessages.push(dueAlertMsg);
        }

        // --- 2. Alerta de Estoque Mínimo (para contas PJ/MEI) ---
        if (['PJ', 'MEI'].includes(account.accountType)) {
          const lowStockProducts = await Product.findAll({
            where: {
              financialAccountId: account.id,
              isActive: true,
              quantity: { [Op.lte]: sequelize.col('minimumStock') },
              minimumStock: { [Op.gt]: 0 }
            }
          });
          if (lowStockProducts.length > 0) {
            let stockAlertMsg = `--- ESTOQUE MÍNIMO ---\n`;
            lowStockProducts.forEach(p => {
              stockAlertMsg += `- ${p.name}: ${p.quantity} un. (Mín: ${p.minimumStock} un.)\n`;
            });
            accountAlertsMessages.push(stockAlertMsg);
          }
        }
        
        // --- 3. Lembretes Fiscais para MEI/PJ (Exemplo simples para DAS MEI) ---
        if (account.accountType === 'MEI') {
            const dasPaymentDay = 20;
            const currentDay = today.getDate();
            const daysUntilDAS = dasPaymentDay - currentDay;

            // Alerta alguns dias antes ou no dia
            if (daysUntilDAS >= 0 && daysUntilDAS <= (preferences?.fiscalAlertLeadDaysMEI || 5)) {
                const dasMonth = today.toLocaleDateString('pt-BR', {month: 'long'});
                let meiAlertMsg = `--- IMPOSTO MEI ---\n`;
                meiAlertMsg += `- Lembrete: Pagamento do DAS MEI (${dasMonth}) vence dia ${dasPaymentDay}.\n`;
                // Verificar se já existe uma RecurringTransactionRule para o DAS deste mês
                const dasRule = await RecurringTransactionRule.findOne({
                    where: {
                        financialAccountId: account.id,
                        description: {[Op.iLike]: `%DAS MEI%${dasMonth}%`}, // Procura por "DAS MEI Janeiro", por exemplo
                        isActive: true
                    }
                });
                if (!dasRule) {
                    meiAlertMsg += `  (Você pode criar uma recorrência para este pagamento.)\n`;
                }
                accountAlertsMessages.push(meiAlertMsg);
            }
        }
        // TODO: Adicionar lógica mais robusta para outros impostos PJ (pode envolver RecurringTransactionRules com categorias fiscais)

        // Enviar alertas acumulados para o cliente desta conta
        if (accountAlertsMessages.length > 0) {
          const finalMessage = `🔔 ALERTAS PARA CONTA: ${account.accountName} (${account.accountType}) 🔔\n\n` + accountAlertsMessages.join("\n");
          if (clientPhone) {
            await sendWhatsappMessage(clientPhone, finalMessage);
            logger.info(`[JOB ALERTAS] Alertas enviados para Cliente ${client?.name} (${clientPhone}) para a conta ${account.accountName}.`);
          } else if (adminPhoneNumberForGlobalAlerts) { // Fallback para admin se cliente não tem telefone
            logger.warn(`[JOB ALERTAS] Cliente da conta ${account.accountName} sem telefone. Enviando para admin.`);
            await sendWhatsappMessage(adminPhoneNumberForGlobalAlerts, `ALERTAS (Conta Cliente S/ Tel: ${account.accountName}):\n${finalMessage}`);
          } else {
            logger.warn(`[JOB ALERTAS] Alertas gerados para conta ${account.accountName} mas sem destinatário (cliente sem tel e admin não configurado).`);
          }
        }
    } // Fim do loop por FinancialAccounts
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
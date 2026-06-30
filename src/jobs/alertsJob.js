// src/jobs/alertsJob.js
const cron = require('node-cron');
const { FinancialTransaction, Product, FinancialAccount, Client, UserPreference, RecurringTransactionRule, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');
// Importando formatadores para consistência
const { formatCurrency, formatDate } = require('../utils/formatters');
const creditCardService = require('../features/CreditCardManagement/creditCard.service');

async function checkAndSendAlerts() {
  logger.info('[JOB ALERTAS] Verificando alertas...');

  // --- CHECK GLOBAL SWITCH ---
  const systemService = require('../features/System/system.service');
  const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
  if (!isEnabled) {
    logger.warn('[JOB ALERTAS] Job abortado: Global switch OFF.');
    return;
  }
  // ---------------------------

  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    const adminPhoneNumberForGlobalAlerts = process.env.ADMIN_PHONE_FOR_ALERTS;

    // Apenas contas de clientes com assinatura ATIVA (paga ou vitalícia) recebem alertas.
    // Clientes 'gratuito'/expirados não recebem notificações.
    const todayStr = new Date().toISOString().split('T')[0];
    const activeFinancialAccounts = await FinancialAccount.findAll({
      where: { isActive: true },
      include: [{
        model: Client,
        as: 'ownerClient',
        attributes: ['id', 'name', 'phone'],
        required: true,
        where: {
          status: 'Ativo',
          [Op.or]: [
            { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
            { accessExpiresAt: { [Op.gte]: todayStr } }
          ]
        }
      }]
    });

    if (activeFinancialAccounts.length === 0) {
      logger.info('[JOB ALERTAS] Nenhuma conta financeira ativa encontrada.');
      return;
    }

    for (const account of activeFinancialAccounts) {
     try {
      const client = account.ownerClient;
      const clientPhone = client?.phone;
      const clientFirstName = client?.name ? client.name.split(' ')[0] : 'você';

      let alertSections = []; // Array para acumular seções de alerta formatadas
      let lowStockProducts; 
      
      const today = new Date();
      const todayDay = today.getDate();
      const todayMonth = today.getMonth();
      const todayYear = today.getFullYear();

      // --- 1. Alerta de Contas a Vencer/Vencidas ---
      // A variável 'today' já foi declarada acima
      const leadDays = preferences?.dueAlertLeadDays || 3;
      const NdaysFromNow = new Date(today);
      NdaysFromNow.setDate(today.getDate() + leadDays);

      const upcomingDues = await FinancialTransaction.findAll({
        where: {
          financialAccountId: account.id,
          isPayableOrReceivable: true,
          isPaidOrReceived: false,
          dueDate: {
            [Op.gt]: today.toISOString().split('T')[0], // só FUTURAS; o dia do vencimento e as atrasadas ficam com a cobrança interativa (remindUnpaidBills)
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

      // --- 4. Alerta de Cartão de Crédito (Fechamento e Vencimento) ---
      const creditCards = await account.getCreditCards({ where: { isActive: true } });
      if (creditCards.length > 0) {
        for (const card of creditCards) {
          // Check Closing Day
          const closingLead = preferences?.cardClosingAlertLeadDays || 2;
          const closingDate = new Date(todayYear, todayMonth, card.closingDay);
          if (closingDate < today) closingDate.setMonth(closingDate.getMonth() + 1);
          
          const diffClosing = Math.ceil((closingDate - today) / (1000 * 60 * 60 * 24));
          if (diffClosing === closingLead) {
            alertSections.push(`💳 *Fechamento de Fatura (${card.name}):*\n> Falta pouco! Sua fatura fecha em *${closingLead} dias* (dia ${card.closingDay}).`);
          }

          // Check Payment Day
          const paymentLead = preferences?.cardPaymentAlertLeadDays || 3;
          const paymentDate = new Date(todayYear, todayMonth, card.paymentDay);
          if (paymentDate < today) paymentDate.setMonth(paymentDate.getMonth() + 1);
          
          const diffPayment = Math.ceil((paymentDate - today) / (1000 * 60 * 60 * 24));
          if (diffPayment === paymentLead) {
            alertSections.push(`💰 *Vencimento de Fatura (${card.name}):*\n> Lembrete: Sua fatura vence em *${paymentLead} dias* (dia ${card.paymentDay}).`);
          }

          // --- Aviso: MELHOR DIA para compras (dia seguinte ao fechamento) ---
          // Comprar logo após o fechamento joga a compra para a fatura do próximo
          // ciclo -> máximo de prazo para pagar.
          if (todayDay === card.closingDay + 1) {
            alertSections.push(`🛍️ *Melhor dia para comprar (${card.name}):*\n> Hoje é o melhor dia! Compras de agora só entram na fatura que fecha no próximo ciclo (dia ${card.closingDay}) — ou seja, o máximo de prazo pra pagar. 😉`);
          }

          // --- Aviso: PAGAR a fatura no DIA do vencimento (se houver saldo) ---
          if (todayDay === card.paymentDay) {
            try {
              const dueInvoice = await creditCardService.getCreditCardInvoiceDetails(account.id, card.id, { type: 'ultima_fechada' });
              const due = parseFloat(dueInvoice?.totalAmount || 0);
              if (due > 0.009) {
                alertSections.push(`🚨 *Sua fatura vence HOJE (${card.name}):*\n> Falta pagar *${formatCurrency(due)}*. Pague hoje para evitar juros! 💳`);
              }
            } catch (invErr) {
              logger.warn(`[JOB ALERTAS] Falha ao checar fatura vencendo hoje (cartão ${card.id}): ${invErr.message}`);
            }
          }
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
     } catch (accErr) {
       logger.error(`[JOB ALERTAS] Erro ao processar alertas da conta ${account?.accountName} (ID ${account?.id}); continuando: ${accErr.message}`);
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
// src/features/DevTools/devTools.routes.js
const { Router } = require('express');
const devToolsController = require('./devTools.controller');
const logger = require('../../utils/logger'); // Corrigido o caminho do import
const { sendWhatsappMessage } = require('../../services/whatsappService'); // Corrigido o caminho do import
const financialService = require('../Financial/financial.service'); // Corrigido o caminho do import
const { FinancialAccount } = require('../../database'); // Importa o modelo diretamente do database
const { formatCurrency } = require('../../utils/formatters'); // Corrigido o caminho do import

const router = Router();

// --- Rotas de Ferramentas de Desenvolvedor Existentes ---

// Rota para ativar um nível de acesso de teste
router.post('/activate-access-level/:clientId', devToolsController.activateTestAccessLevelController);

// Rota para simular a criação de uma assinatura
router.post('/simulate-subscription/:clientId', devToolsController.simulateSubscriptionController);

// Rota para simular um webhook de pagamento do Asaas
router.post('/simulate-asaas-payment', devToolsController.simulateAsaasPayment);


// --- Nova Rota de Teste para Envio de Resumo ---

/**
 * Endpoint de teste para enviar um resumo financeiro para um número específico.
 * Uso: GET /api/dev-tools/send-summary?phone=552199998888&accountId=1
 */
router.get('/send-summary', async (req, res) => {
    const { phone, accountId } = req.query;

    if (!phone || !accountId) {
        return res.status(400).json({ 
            error: "Parâmetros 'phone' e 'accountId' são obrigatórios.",
            usage: "/api/dev-tools/send-summary?phone=5571XXXXXXXXX&accountId=1"
        });
    }

    logger.info(`[DEVTOOLS ENDPOINT] Iniciando envio de resumo de teste para ${phone}, conta ID ${accountId}`);

    try {
        const account = await FinancialAccount.findByPk(accountId);
        if (!account) {
            return res.status(404).json({ error: `Conta financeira com ID ${accountId} não encontrada.` });
        }

        // Usamos a mesma lógica do job, chamando o serviço com o período 'daily'
        const summary = await financialService.getFinancialSummary(accountId, { period: 'daily' });

        // Montamos a mensagem exatamente como no job
        const clientName = "Usuário de Teste";
        const intro = `Oi, ${clientName}! ☀️ Este é um resumo de teste para o dia de ontem na conta *${account.accountName}*!`;
        
        const body = `*${summary.periodDescription}*\n\n` +
                     `✅ *Entradas:* ${formatCurrency(summary.totalIncome)}\n` +
                     `❌ *Saídas:* ${formatCurrency(summary.totalExpenses)}\n` +
                     `⚖️ *Balanço do Período:* ${formatCurrency(summary.netBalance)}\n\n` +
                     `🗓️ *A Receber (total pendente):* ${formatCurrency(summary.totalToReceivePending)}\n` +
                     `🧾 *A Pagar (total pendente):* ${formatCurrency(summary.totalToPayPending)}`;

        const footer = "Este é um envio de teste. 😉";
        const message = `${intro}\n\n${body}\n\n${footer}`;

        // Envia a mensagem
        await sendWhatsappMessage(phone, message);

        logger.info(`[DEVTOOLS ENDPOINT] Resumo de teste enviado com sucesso para ${phone}.`);
        res.status(200).json({ 
            status: 'success', 
            message: `Resumo de teste enviado para ${phone}.`,
            summaryData: summary 
        });

    } catch (error) {
        logger.error(`[DEVTOOLS ENDPOINT] Erro ao enviar resumo de teste: ${error.message}`, { stack: error.stack });
        res.status(500).json({ error: 'Erro interno ao processar a solicitação.', details: error.message });
    }
});

/**
 * [TEMPORÁRIO] Dispara o BRIEFING MATINAL real (com IA, recorrências do dia e
 * seção "De olho no mês") usando os dados de uma conta e envia a um número.
 * Uso: GET /api/dev-tools/send-briefing?ownerPhone=552198597002&to=5571982862912
 */
router.get('/send-briefing', async (req, res) => {
    const { ownerPhone, to } = req.query;
    if (!ownerPhone) {
        return res.status(400).json({ error: "Parâmetro 'ownerPhone' é obrigatório.", usage: "/api/dev-tools/send-briefing?ownerPhone=55XXXXXXXXXXX&to=55XXXXXXXXXXX" });
    }
    try {
        const { Op } = require('sequelize');
        const { Client, FinancialTransaction, RecurringTransactionRule, Appointment, DailyChecklist, ChecklistItem } = require('../../database');
        const aiModelService = require('../../services/aiModelService');

        const client = await Client.findOne({ where: { phone: ownerPhone } });
        if (!client) return res.status(404).json({ error: `Cliente com telefone ${ownerPhone} não encontrado.` });

        const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));
        const endOfDay = new Date(new Date().setHours(23, 59, 59, 999));
        const todayDateString = startOfDay.toISOString().split('T')[0];
        const pad = (n) => String(n).padStart(2, '0');
        const endOfMonthStr = `${startOfDay.getFullYear()}-${pad(startOfDay.getMonth() + 1)}-${pad(new Date(startOfDay.getFullYear(), startOfDay.getMonth() + 1, 0).getDate())}`;

        const clientAccounts = await client.getFinancialAccounts({ where: { isActive: true } });
        if (clientAccounts.length === 0) return res.status(404).json({ error: 'Cliente sem contas ativas.' });
        const accountIds = clientAccounts.map(a => a.id);
        const mainAccountForChecklist = clientAccounts.find(a => a.isDefault) || clientAccounts[0];
        const incFa = [{ model: FinancialAccount, as: 'financialAccount', attributes: ['accountName'] }];

        const pendingTransactions = await FinancialTransaction.findAll({ where: { financialAccountId: { [Op.in]: accountIds }, isPayableOrReceivable: true, isPaidOrReceived: false, dueDate: todayDateString }, include: incFa, order: [['value', 'DESC']] });
        const appointments = await Appointment.findAll({ where: { financialAccountId: { [Op.in]: accountIds }, status: { [Op.in]: ['Scheduled', 'Confirmed'] }, eventDateTime: { [Op.between]: [startOfDay, endOfDay] } }, include: incFa, order: [['eventDateTime', 'ASC']] });
        const recurringItems = await RecurringTransactionRule.findAll({ where: { financialAccountId: { [Op.in]: accountIds }, isActive: true, nextDueDate: { [Op.lte]: todayDateString } }, include: incFa, order: [['nextDueDate', 'ASC']] });
        const monthlyRecurringItems = await RecurringTransactionRule.findAll({ where: { financialAccountId: { [Op.in]: accountIds }, isActive: true, nextDueDate: { [Op.gt]: todayDateString, [Op.lte]: endOfMonthStr } }, include: incFa, order: [['nextDueDate', 'ASC']] });
        const monthlyPendingTransactions = await FinancialTransaction.findAll({ where: { financialAccountId: { [Op.in]: accountIds }, isPayableOrReceivable: true, isPaidOrReceived: false, dueDate: { [Op.gt]: todayDateString, [Op.lte]: endOfMonthStr } }, include: incFa, order: [['dueDate', 'ASC']] });

        let checklistData = null;
        if (mainAccountForChecklist) {
            const checklist = await DailyChecklist.findOne({ where: { financialAccountId: mainAccountForChecklist.id, date: todayDateString }, include: [{ model: ChecklistItem, as: 'items' }] });
            checklistData = { accountName: mainAccountForChecklist.accountName, items: checklist ? checklist.items.map(i => i.toJSON()) : [] };
        }

        const briefingData = {
            clientName: client.name ? client.name.split(' ')[0] : 'você',
            pendingTransactions, appointments, recurringItems,
            monthlyRecurringItems, monthlyPendingTransactions, checklistData,
        };

        const message = await aiModelService.generateMorningBriefingMessage(briefingData);
        const target = to || client.phone;
        await sendWhatsappMessage(target, message, { force: true });

        res.status(200).json({
            status: 'success', to: target,
            counts: { recorrenciasHoje: recurringItems.length, recorrenciasMes: monthlyRecurringItems.length, contasHoje: pendingTransactions.length, contasMes: monthlyPendingTransactions.length },
            message
        });
    } catch (error) {
        logger.error(`[DEVTOOLS send-briefing] Erro: ${error.message}`, { stack: error.stack });
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
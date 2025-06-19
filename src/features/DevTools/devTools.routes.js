// src/features/DevTools/devTools.routes.js
const { Router } = require('express');
const devToolsController = require('./devTools.controller');
const logger = require('../../utils/logger'); // Corrigido o caminho do import
const { sendWhatsappMessage } = require('../../services/whatsappService'); // Corrigido o caminho do import
const financialService = require('../Financial/financial.service'); // Corrigido o caminho do import
const { FinancialAccount } = require('../../database'); // Importa o modelo diretamente do database
const { formatCurrency } = require('../../utils/formatters'); // Corrigido o caminho do import

const router = Router();

// <<< ADICIONAR ESTA NOVA ROTA >>>
/**
 * Endpoint para criar um novo usuário completo (com conta e plano) para teste.
 * Uso: POST /api/dev-tools/create-full-test-user
 * Body (JSON): { "phone": "...", "email": "...", "password": "...", "name": "...", "accessLevel": "avancado_anual" (opcional) }
 */
router.post('/create-full-test-user', devToolsController.createFullTestUserController);

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
 * Uso: GET /api/dev-tools/send-summary?phone=557182862912&accountId=1
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

router.post('/create-test-client', devToolsController.createTestClient);

module.exports = router;
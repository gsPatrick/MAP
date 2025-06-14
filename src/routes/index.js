// src/routes/index.js
const { Router } = require('express');
const logger = require('../utils/logger');
const { FinancialAccount } = require('../database');
const { authenticateToken, authenticateClientToken, authorizeRole } = require('../middlewares/authMiddleware'); // authenticateToken é para admin

// Importações dos Módulos de Rotas
const userRoutes = require('../features/User/user.routes');
const clientRoutes = require('../features/Client/client.routes');
const clientAuthRoutes = require('../features/ClientAuth/clientAuth.routes');
const financialTransactionRoutes = require('../features/Financial/financial.routes');
const recurringTransactionRoutes = require('../features/RecurringTransaction/recurringTransaction.routes');
const creditCardRoutes = require('../features/CreditCardManagement/creditCard.routes');
const productRoutes = require('../features/Product/product.routes');
const { productStockRouter, globalStockRouter } = require('../features/Stock/stock.routes');
const appointmentRoutes = require('../features/Appointment/appointment.routes');
const systemRoutes = require('../features/System/system.routes');
const whatsappWebhookRoutes = require('../features/WhatsappHandler/whatsapp.routes');
const devToolsRoutes = require('../features/DevTools/devTools.routes');
const financialCategoryRoutes = require('../features/FinancialCategory/financialCategory.routes');
const InteractiveChatRoutes = require('../features/InteractiveChat/interactiveChat.routes');
const kanbanRoutes = require('../features/Kanban/kanban.routes');
const businessClientRoutes = require('../features/BusinessClient/BusinessClient.routes');
const sharedAccessRoutes = require('../features/SharedAccess/sharedAccess.routes');
const hotmartWebhookRoutes = require('../features/WebhookHandler/hotmart.routes');
const googleAuthRoutes = require('../features/GoogleAuth/googleAuth.routes');
const googleWebhookRoutes = require('../features/GoogleWebhook/googleWebhook.routes');
const hydrationRoutes = require('../features/Hydration/hydration.routes');
const asaasWebhookRouter = require('../features/WebhookHandler/asaas.routes'); // <<< ADICIONAR
const adminRoutes = require('../features/Admin/admin.routes');


// >>>>> INÍCIO DA MUDANÇA: Importar o Controller Financeiro <<<<<
const financialController = require('../features/Financial/financial.controller');
// >>>>> FIM DA MUDANÇA <<<<<

const mainApiRouter = Router();

// Rota de Status da API
mainApiRouter.get('/status', (req, res) => res.status(200).json({
    status: 'API Operacional',
    timestamp: new Date(),
    service: 'Assessor Financeiro API V2'
}));

// --- ROTAS PÚBLICAS OU SEMI-PÚBLICAS ---
mainApiRouter.use('/webhooks', hotmartWebhookRoutes);
mainApiRouter.use('/webhooks', asaasWebhookRouter); // <<< USAR (agora a URL será /api/webhooks/asaas)
mainApiRouter.use('/auth', clientAuthRoutes);
mainApiRouter.use('/whatsapp-zapi', whatsappWebhookRoutes);
mainApiRouter.use('/auth/google', googleAuthRoutes);
mainApiRouter.use('/webhooks/google-calendar', googleWebhookRoutes);

// --- ROTAS DE ADMINISTRAÇÃO DO SISTEMA ---
mainApiRouter.use('/users', userRoutes);
mainApiRouter.use('/clients', clientRoutes);
mainApiRouter.use('/system', systemRoutes);
mainApiRouter.use('/dev-tools', devToolsRoutes);
mainApiRouter.use('/chat', InteractiveChatRoutes);
mainApiRouter.use('/shared-access', authenticateClientToken, sharedAccessRoutes);
mainApiRouter.use('/hydration', authenticateClientToken, hydrationRoutes);
mainApiRouter.use('/', adminRoutes); // Adiciona as rotas de admin



// --- Middleware para autorização de acesso à conta financeira ---
async function authorizeFinancialAccountOwnership(req, res, next) {
    try {
        const clientForAuth = req.sharedAccessContext ? { id: req.sharedAccessContext.ownerClientId } : req.client;
        const financialAccountIdFromParams = parseInt(req.params.financialAccountId, 10);

        if (!clientForAuth || !clientForAuth.id) {
            logger.error('[AUTH OWNERSHIP] Middleware chamado sem req.client ou ownerClient válido.');
            return res.status(500).json({ status: 'error', message: 'Erro interno de autenticação.' });
        }
        if (isNaN(financialAccountIdFromParams)) {
            return res.status(400).json({ status: 'fail', message: 'ID da Conta Financeira inválido na rota.' });
        }

        const financialAccount = await FinancialAccount.findOne({
            where: { id: financialAccountIdFromParams, clientId: clientForAuth.id }
        });

        if (!financialAccount) {
            logger.warn(`[AUTH OWNERSHIP] Cliente ${clientForAuth.id} tentou acessar FA ${financialAccountIdFromParams} que não lhe pertence ou não existe.`);
            return res.status(403).json({ status: 'fail', message: 'Acesso negado a esta conta financeira.' });
        }
        if (!financialAccount.isActive) {
            logger.warn(`[AUTH OWNERSHIP] Cliente ${clientForAuth.id} tentou acessar FA ${financialAccountIdFromParams} INATIVA.`);
            return res.status(403).json({ status: 'fail', message: 'Esta conta financeira está inativa.' });
        }
        
        if (req.sharedAccessContext) {
            const { canAccessPersonalProfile, canAccessBusinessProfileId } = req.sharedAccessContext;
            let isAllowedForShared = false;
            if (financialAccount.accountType === 'PF' && canAccessPersonalProfile) {
                isAllowedForShared = true;
            } else if ((financialAccount.accountType === 'PJ' || financialAccount.accountType === 'MEI') && canAccessBusinessProfileId === financialAccount.id) {
                isAllowedForShared = true;
            }
            if (!isAllowedForShared) {
                logger.warn(`[AUTH OWNERSHIP - SHARED] Usuário compartilhado ${req.client.id} tentou acessar FA ${financialAccount.id} (${financialAccount.accountType}) do dono ${clientForAuth.id}, mas não tem permissão para este perfil específico.`);
                return res.status(403).json({ status: 'fail', message: 'Acesso compartilhado negado para este perfil financeiro específico.' });
            }
        }
        
        req.financialAccount = financialAccount.toJSON();
        next();
    } catch (error) {
        logger.error('[AUTH OWNERSHIP] Erro ao verificar propriedade da conta financeira:', { message: error.message, error });
        return res.status(500).json({ status: 'error', message: 'Erro ao verificar permissões da conta.' });
    }
}


// --- ROTAS PARA CLIENTS LOGADOS (com middleware de autorização de conta) ---
const clientFinancialAccountRouter = Router({ mergeParams: true });
clientFinancialAccountRouter.use(authenticateClientToken);
clientFinancialAccountRouter.use(authorizeFinancialAccountOwnership);

// >>>>> INÍCIO DA MUDANÇA: Registrar as rotas de resumo aqui <<<<<
clientFinancialAccountRouter.get('/summary', financialController.getFinancialSummary);
clientFinancialAccountRouter.get('/monthly-trend', financialController.getMonthlyTrend);
clientFinancialAccountRouter.get('/expense-category-summary', financialController.getExpenseCategorySummary);
clientFinancialAccountRouter.get('/income-category-summary', financialController.getIncomeCategorySummary);
// >>>>> FIM DA MUDANÇA <<<<<

// Monta as sub-rotas no clientFinancialAccountRouter
clientFinancialAccountRouter.use('/transactions', financialTransactionRoutes);
clientFinancialAccountRouter.use('/recurring-rules', recurringTransactionRoutes);
clientFinancialAccountRouter.use('/credit-cards', creditCardRoutes);
clientFinancialAccountRouter.use('/products', productRoutes);
clientFinancialAccountRouter.use('/products/:productId/stock', productStockRouter);
clientFinancialAccountRouter.use('/appointments', appointmentRoutes);
clientFinancialAccountRouter.use('/categories', financialCategoryRoutes);
clientFinancialAccountRouter.use('/kanban', kanbanRoutes);
clientFinancialAccountRouter.use('/business-clients', businessClientRoutes);

// Monta o router de conta financeira no router principal da API
mainApiRouter.use('/financial-accounts/:financialAccountId', clientFinancialAccountRouter);

// Rota global de estoque para Clients logados
mainApiRouter.use('/stock', authenticateClientToken, globalStockRouter);

module.exports = mainApiRouter;
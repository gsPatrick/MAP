// src/routes/index.js
const { Router } = require('express');
const logger = require('../utils/logger');
const { FinancialAccount } = require('../database');
// <<< MUDANÇA: Certifique-se de importar authorizeFinancialAccountOwnership aqui >>>
const { authenticateClientToken, authorizeFinancialAccountOwnership } = require('../middlewares/authMiddleware'); // IMPORTANTE!

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
const asaasWebhookRouter = require('../features/WebhookHandler/asaas.routes');
const adminRoutes = require('../features/Admin/admin.routes');
const serviceRoutes = require('../features/Service/service.routes');
const availabilityRoutes = require('../features/Availability/availability.routes');
const publicBookingRoutes = require('../features/PublicBooking/publicBooking.routes');
const financialController = require('../features/Financial/financial.controller');
const affiliateRoutes = require('../features/Affiliate/affiliate.routes');
const systemSupportBotRoutes = require ('../features/SystemSupportBot/systemSupportBot.routes')
const checklistRoutes = require('../features/Checklist/checklist.routes');

const mainApiRouter = Router();

// Rota de Status da API
mainApiRouter.get('/status', (req, res) => res.status(200).json({
    status: 'API Operacional',
    timestamp: new Date(),
    service: 'Assessor Financeiro API V2'
}));

// --- ROTAS PÚBLICAS OU SEMI-PÚBLICAS ---
mainApiRouter.use('/webhooks', hotmartWebhookRoutes);
mainApiRouter.use('/webhooks', asaasWebhookRouter);
mainApiRouter.use('/auth', clientAuthRoutes);
mainApiRouter.use('/whatsapp-zapi', whatsappWebhookRoutes);
mainApiRouter.use('/auth/google', googleAuthRoutes);
mainApiRouter.use('/webhooks/google-calendar', googleWebhookRoutes);
mainApiRouter.use('/public/booking', publicBookingRoutes);
mainApiRouter.use('/system-support-bot', systemSupportBotRoutes);

// --- ROTAS DE ADMINISTRAÇÃO DO SISTEMA ---
mainApiRouter.use('/users', userRoutes);
mainApiRouter.use('/clients', clientRoutes);
mainApiRouter.use('/system', systemRoutes);
mainApiRouter.use('/dev-tools', devToolsRoutes);
mainApiRouter.use('/chat', InteractiveChatRoutes);
mainApiRouter.use('/shared-access', authenticateClientToken, sharedAccessRoutes);
mainApiRouter.use('/hydration', authenticateClientToken, hydrationRoutes);
mainApiRouter.use('/', adminRoutes);
mainApiRouter.use('/affiliate', authenticateClientToken, affiliateRoutes);

// <<< MUDANÇA: MONTAR AS ROTAS DE SERVIÇO E DISPONIBILIDADE AQUI DIRETAMENTE >>>
// Isso garante que as URLs sejam /api/services/:id e /api/availability/:id
mainApiRouter.use('/services', serviceRoutes);
mainApiRouter.use('/availability', availabilityRoutes);


// <<< MUDANÇA: REMOVA A DEFINIÇÃO LOCAL DE authorizeFinancialAccountOwnership AQUI >>>
// OU SE CERTIFIQUE DE QUE ELA ESTÁ REMOVIDA E A IMPORTAÇÃO NO TOPO ESTÁ CORRETA.
// A versão de authMiddleware.js é a que deve ser usada.
/*
// Exemplo de como a função LOCAL PODE APARECER (REMOVER ESTE BLOCO SE ENCONTRAR):
async function authorizeFinancialAccountOwnership(req, res, next) {
    // ... (este código é a versão simplificada que estava causando problemas) ...
}
*/


// --- ROTAS PARA CLIENTS LOGADOS (com middleware de autorização de conta) ---
const clientFinancialAccountRouter = Router({ mergeParams: true });

// Monta as rotas de resumo financeiro
clientFinancialAccountRouter.get('/summary', financialController.getFinancialSummary);
clientFinancialAccountRouter.get('/monthly-trend', financialController.getMonthlyTrend);
clientFinancialAccountRouter.get('/expense-category-summary', financialController.getExpenseCategorySummary);
clientFinancialAccountRouter.get('/income-category-summary', financialController.getIncomeCategorySummary);
clientFinancialAccountRouter.use('/checklists', checklistRoutes);

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
// <<< MUDANÇA: AS LINHAS ABAIXO FORAM MOVIDAS PARA FORA DESTE ROTEADOR ANINHADO >>>
// clientFinancialAccountRouter.use('/services', serviceRoutes);
// clientFinancialAccountRouter.use('/availability-rules', availabilityRoutes);


// Monta o router de conta financeira no router principal da API,
// aplicando os middlewares NA ORDEM CORRETA.
mainApiRouter.use('/financial-accounts/:financialAccountId',
    authenticateClientToken,           // 1. Autentica o token e define req.client
    authorizeFinancialAccountOwnership,  // 2. Autoriza a posse da conta usando req.client (AGORA É A VERSÃO CORRETA IMPORTADA)
    clientFinancialAccountRouter         // 3. Passa para as rotas específicas
);

// Rota global de estoque para Clients logados (não depende de uma financialAccount específica)
mainApiRouter.use('/stock', authenticateClientToken, globalStockRouter);

module.exports = mainApiRouter;
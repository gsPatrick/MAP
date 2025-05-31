// src/routes/index.js
const { Router } = require('express');
const logger = require('../utils/logger');
const { FinancialAccount } = require('../database');
const { authenticateToken, authenticateClientToken, authorizeRole } = require('../middlewares/authMiddleware'); // authenticateToken é para admin

// Caminhos para os módulos de rotas
const userRoutes = require('../features/User/user.routes'); // Admin users
const clientRoutes = require('../features/Client/client.routes'); // Gerenciamento de Clients (contatos) por Admins
const clientAuthRoutes = require('../features/ClientAuth/clientAuth.routes'); // Autenticação de Clients (usuários finais)
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
// ROTAS PARA BUSINESS CLIENTS
const businessClientRoutes = require('../features/BusinessClient/BusinessClient.routes');
const sharedAccessRoutes = require('../features/SharedAccess/sharedAccess.routes'); // <<< NOVA ROTA
const hotmartWebhookRoutes = require('../features/WebhookHandler/hotmart.routes');
const googleAuthRoutes = require('../features/GoogleAuth/googleAuth.routes'); // <<< NOVA ROTA GOOGLE AUTH



const mainApiRouter = Router();

// Rota de Status da API
mainApiRouter.get('/status', (req, res) => res.status(200).json({
    status: 'API Operacional',
    timestamp: new Date(),
    service: 'Assessor Financeiro API V2'
}));

// --- ROTAS PÚBLICAS OU SEMI-PÚBLICAS ---
mainApiRouter.use('/webhooks', hotmartWebhookRoutes); // <<< NOVA LINHA (ou /payment-webhooks)
mainApiRouter.use('/auth', clientAuthRoutes); // Rotas de login e set-credentials para Clients
mainApiRouter.use('/whatsapp-zapi', whatsappWebhookRoutes); // Webhook da Z-API (sem token de app)
mainApiRouter.use('/auth/google', googleAuthRoutes); // <<< ROTAS PARA GOOGLE AUTHENTICATION



// --- ROTAS DE ADMINISTRAÇÃO DO SISTEMA (protegidas para Users com role 'admin') ---
// Aplicar authenticateToken (admin) e authorizeRole(['admin']) aqui
mainApiRouter.use('/users',  userRoutes); // Gerenciamento de Users (admins)
mainApiRouter.use('/clients',  clientRoutes); // Gerenciamento de Clients por Admins
mainApiRouter.use('/system',  systemRoutes); // Configs do sistema, categorias globais, planos
mainApiRouter.use('/dev-tools',  devToolsRoutes); // Ferramentas de desenvolvimento
mainApiRouter.use('/chat', InteractiveChatRoutes); // Rota de chat do site (sem token, mas com autenticação de cliente)
mainApiRouter.use('/shared-access', authenticateClientToken, sharedAccessRoutes); // <<< NOVA ROTA

// --- ROTAS PARA CLIENTS LOGADOS (protegidas para Clients com token válido e assinatura ativa) ---

// Middleware para verificar se o Client logado é o dono da FinancialAccount acessada via URL
// Este middleware já está implementado
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
        
        // Se for um acesso compartilhado, verificar se este perfil específico está permitido
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


const clientFinancialAccountRouter = Router({ mergeParams: true });
clientFinancialAccountRouter.use(authenticateClientToken);
clientFinancialAccountRouter.use(authorizeFinancialAccountOwnership);

// Monta as sub-rotas no clientFinancialAccountRouter
clientFinancialAccountRouter.use('/transactions', financialTransactionRoutes);
clientFinancialAccountRouter.use('/recurring-rules', recurringTransactionRoutes);
clientFinancialAccountRouter.use('/credit-cards', creditCardRoutes);
clientFinancialAccountRouter.use('/products', productRoutes); // productRoutes já espera :financialAccountId
clientFinancialAccountRouter.use('/products/:productId/stock', productStockRouter); // productStockRouter lida com :productId
clientFinancialAccountRouter.use('/appointments', appointmentRoutes);
clientFinancialAccountRouter.use('/categories', financialCategoryRoutes);
clientFinancialAccountRouter.use('/kanban', kanbanRoutes);
// ROTAS DE BUSINESS CLIENTS ANINHADAS SOB FINANCIAL ACCOUNT
clientFinancialAccountRouter.use('/business-clients', businessClientRoutes);


// Monta o router de conta financeira no router principal da API
mainApiRouter.use('/financial-accounts/:financialAccountId', clientFinancialAccountRouter);


// Rota global de estoque para Clients logados (req.client já disponível)
// O controller getStockMovements já espera financialAccountId na query, e a validação de propriedade
// será feita dentro do serviço getStockMovements.
mainApiRouter.use('/stock', authenticateClientToken, globalStockRouter);
// Exemplo: GET /api/stock/movements (o controller getStockMovements pegaria o clientId de req.client.id e usaria o financialAccountId da query para filtrar)

module.exports = mainApiRouter;
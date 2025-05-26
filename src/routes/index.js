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


const mainApiRouter = Router();

// Rota de Status da API
mainApiRouter.get('/status', (req, res) => res.status(200).json({
    status: 'API Operacional',
    timestamp: new Date(),
    service: 'Assessor Financeiro API V2'
}));

// --- ROTAS PÚBLICAS OU SEMI-PÚBLICAS ---
mainApiRouter.use('/auth', clientAuthRoutes); // Rotas de login e set-credentials para Clients
mainApiRouter.use('/whatsapp-zapi', whatsappWebhookRoutes); // Webhook da Z-API (sem token de app)

// --- ROTAS DE ADMINISTRAÇÃO DO SISTEMA (protegidas para Users com role 'admin') ---
// Aplicar authenticateToken (admin) e authorizeRole(['admin']) aqui
mainApiRouter.use('/users',  userRoutes); // Gerenciamento de Users (admins)
mainApiRouter.use('/clients',  clientRoutes); // Gerenciamento de Clients por Admins
mainApiRouter.use('/system',  systemRoutes); // Configs do sistema, categorias globais, planos
mainApiRouter.use('/dev-tools',  devToolsRoutes); // Ferramentas de desenvolvimento
mainApiRouter.use('/chat', InteractiveChatRoutes); // Rota de chat do site (sem token, mas com autenticação de cliente)

// --- ROTAS PARA CLIENTS LOGADOS (protegidas para Clients com token válido e assinatura ativa) ---

// Middleware para verificar se o Client logado é o dono da FinancialAccount acessada via URL
// Este middleware já está implementado
async function authorizeFinancialAccountOwnership(req, res, next) {
    try {
        // req.client é populado pelo authenticateClientToken
        const client = req.client; // Cliente autenticado
        const financialAccountIdFromParams = parseInt(req.params.financialAccountId, 10);
       
        if (!client) { // Should not happen if authenticateClientToken runs first, but safety check
            logger.error('[AUTH OWNERSHIP] Middleware chamado sem req.client.');
            return res.status(500).json({ status: 'error', message: 'Erro interno de autenticação.' });
        }
       
        if (isNaN(financialAccountIdFromParams)) {
            return res.status(400).json({ status: 'fail', message: 'ID da Conta Financeira inválido na rota.' });
        }

        const financialAccount = await FinancialAccount.findOne({
            where: {
                id: financialAccountIdFromParams,
                clientId: client.id // Verifica diretamente a posse
            }
        });

        if (!financialAccount) {
            logger.warn(`[AUTH OWNERSHIP] Cliente ${client.id} tentou acessar FinancialAccount ${financialAccountIdFromParams} que não lhe pertence ou não existe.`);
            return res.status(403).json({ status: 'fail', message: 'Acesso negado a esta conta financeira.' });
        }
        if (!financialAccount.isActive) {
            logger.warn(`[AUTH OWNERSHIP] Cliente ${client.id} tentou acessar FinancialAccount ${financialAccountIdFromParams} INATIVA.`);
            return res.status(403).json({ status: 'fail', message: 'Esta conta financeira está inativa.' });
        }

        req.financialAccount = financialAccount.toJSON(); // Adiciona a conta ao request para uso posterior nos controllers/services
        next();
    } catch (error) {
        logger.error('[AUTH OWNERSHIP] Erro ao verificar propriedade da conta financeira:', { message: error.message, error });
        return res.status(500).json({ status: 'error', message: 'Erro ao verificar permissões da conta.' });
    }
}


// Router específico para rotas que dependem de uma :financialAccountId e pertencem a um Client logado
const clientFinancialAccountRouter = Router({ mergeParams: true }); // mergeParams para herdar :financialAccountId
clientFinancialAccountRouter.use(authenticateClientToken); // 1. Autentica o Client
clientFinancialAccountRouter.use(authorizeFinancialAccountOwnership); // 2. Verifica se ele é dono da :financialAccountId e ativa

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
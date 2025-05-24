// src/routes/index.js
const { Router } = require('express');
const logger = require('../utils/logger'); // <<< ADICIONAR IMPORT DO LOGGER
const { FinancialAccount } = require('../database'); // <<< ADICIONAR IMPORT DO MODELO
const { authenticateToken, authenticateClientToken, authorizeRole } = require('../middlewares/authMiddleware'); // <<< authenticateToken é para admin

// Import das rotas das features
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
const financialCategoryRoutes = require('../features/FinancialCategory/financialCategory.routes'); // <<< NOVO IMPORT

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


// --- ROTAS PARA CLIENTS LOGADOS (protegidas para Clients com token válido e assinatura ativa) ---

// Middleware para verificar se o Client logado é o dono da FinancialAccount acessada via URL
async function authorizeFinancialAccountOwnership(req, res, next) {
    try {
        const financialAccountIdFromParams = parseInt(req.params.financialAccountId, 10);
        if (isNaN(financialAccountIdFromParams)) {
            return res.status(400).json({ status: 'fail', message: 'ID da Conta Financeira inválido na rota.' });
        }

        // req.client é populado pelo authenticateClientToken
        const financialAccount = await FinancialAccount.findOne({
            where: {
                id: financialAccountIdFromParams,
                clientId: req.client.id // Verifica diretamente a posse
            }
        });

        if (!financialAccount) {
            logger.warn(`[AUTH OWNERSHIP] Cliente ${req.client.id} tentou acessar FinancialAccount ${financialAccountIdFromParams} que não lhe pertence ou não existe.`);
            return res.status(403).json({ status: 'fail', message: 'Acesso negado a esta conta financeira.' });
        }
        if (!financialAccount.isActive) {
            logger.warn(`[AUTH OWNERSHIP] Cliente ${req.client.id} tentou acessar FinancialAccount ${financialAccountIdFromParams} INATIVA.`);
            return res.status(403).json({ status: 'fail', message: 'Esta conta financeira está inativa.' });
        }

        req.financialAccount = financialAccount.toJSON(); // Adiciona a conta ao request para uso posterior
        next();
    } catch (error) {
        logger.error('[AUTH OWNERSHIP] Erro ao verificar propriedade da conta financeira:', { message: error.message, error });
        return res.status(500).json({ status: 'error', message: 'Erro ao verificar permissões da conta.' });
    }
}

// Router específico para rotas que dependem de uma :financialAccountId e pertencem a um Client logado
const clientFinancialAccountRouter = Router({ mergeParams: true }); // mergeParams para herdar :financialAccountId
clientFinancialAccountRouter.use(authenticateClientToken); // 1. Autentica o Client
clientFinancialAccountRouter.use(authorizeFinancialAccountOwnership); // 2. Verifica se ele é dono da :financialAccountId

// Monta as sub-rotas no clientFinancialAccountRouter
clientFinancialAccountRouter.use('/transactions', financialTransactionRoutes);
clientFinancialAccountRouter.use('/recurring-rules', recurringTransactionRoutes);
clientFinancialAccountRouter.use('/credit-cards', creditCardRoutes);
clientFinancialAccountRouter.use('/products', productRoutes); // productRoutes já espera :financialAccountId
clientFinancialAccountRouter.use('/products/:productId/stock', productStockRouter); // productStockRouter lida com :productId
clientFinancialAccountRouter.use('/appointments', appointmentRoutes);
clientFinancialAccountRouter.use('/categories', financialCategoryRoutes); // <<< ADICIONADO AQUI


// Monta o router de conta financeira no router principal da API
mainApiRouter.use('/financial-accounts/:financialAccountId', clientFinancialAccountRouter);


// Rota global de estoque para Clients logados
// O controller precisará filtrar pelo req.client.id se financialAccountId não for fornecido na query.
// Se financialAccountId for fornecido na query, precisaria de uma lógica de autorização similar a authorizeFinancialAccountOwnership
// Por simplicidade, se /api/stock é para o CLIENTE ver TODOS os seus estoques, o filtro é interno.
// Se for para admins, proteger com authenticateToken.
mainApiRouter.use('/stock', authenticateClientToken, globalStockRouter);
// Exemplo: GET /api/stock/movements (o controller getStockMovements pegaria o clientId de req.client.id)
//          GET /api/stock/movements?financialAccountId=X (o controller verificaria se X pertence ao req.client.id)


module.exports = mainApiRouter;
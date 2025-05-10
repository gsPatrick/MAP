// src/routes/index.js
const { Router } = require('express');
const userRoutes = require('../features/User/user.routes');
const clientRoutes = require('../features/Client/client.routes');
const financialTransactionRoutes = require('../features/Financial/financial.routes'); // Para transações
const recurringTransactionRoutes = require('../features/RecurringTransaction/recurringTransaction.routes');
const creditCardRoutes = require('../features/CreditCardManagement/creditCard.routes');
const productRoutes = require('../features/Product/product.routes');
const { productStockRouter, globalStockRouter } = require('../features/Stock/stock.routes');
const appointmentRoutes = require('../features/Appointment/appointment.routes');
const systemRoutes = require('../features/System/system.routes');
const whatsappWebhookRoutes = require('../features/WhatsappHandler/whatsapp.routes');
const devToolsRoutes = require('../features/DevTools/devTools.routes');


const mainApiRouter = Router();

// CORREÇÃO AQUI: Use mainApiRouter em vez de router
mainApiRouter.get('/status', (req, res) => res.status(200).json({
    status: 'API Operacional',
    timestamp: new Date(),
    service: 'Assessor Financeiro API'
  }));

mainApiRouter.use('/users', userRoutes);
mainApiRouter.use('/clients', clientRoutes);

// Rotas aninhadas sob /financial-accounts/:financialAccountId
mainApiRouter.use('/financial-accounts/:financialAccountId/transactions', financialTransactionRoutes);
mainApiRouter.use('/financial-accounts/:financialAccountId/recurring-rules', recurringTransactionRoutes);
mainApiRouter.use('/financial-accounts/:financialAccountId/credit-cards', creditCardRoutes);
mainApiRouter.use('/financial-accounts/:financialAccountId/products', productRoutes);
mainApiRouter.use('/financial-accounts/:financialAccountId/products/:productId/stock', productStockRouter);
mainApiRouter.use('/financial-accounts/:financialAccountId/appointments', appointmentRoutes);
mainApiRouter.use('/dev-tools', devToolsRoutes);

mainApiRouter.use('/stock', globalStockRouter);
mainApiRouter.use('/system', systemRoutes);
mainApiRouter.use('/whatsapp-zapi', whatsappWebhookRoutes);

module.exports = mainApiRouter;
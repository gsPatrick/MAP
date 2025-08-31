// src/features/MercadoPago/mercadoPago.routes.js
const { Router } = require('express');
const mercadoPagoController = require('./mercadoPago.controller');
const { identifyClientToken } = require('../../middlewares/authMiddleware');

const publicMercadoPagoRouter = Router();
publicMercadoPagoRouter.post('/webhook', mercadoPagoController.webhook);

const privateMercadoPagoRouter = Router();

// Rota antiga para Checkout Pro (pode ser removida se não for mais usar)
privateMercadoPagoRouter.post('/checkout', identifyClientToken, mercadoPagoController.criarCheckoutAssinatura);

// Rota antiga para processar pagamento de cartão (pode ser removida se for apenas PIX)
privateMercadoPagoRouter.post('/process-payment', identifyClientToken, mercadoPagoController.processarPagamentoBrick);

// <<< NOVA ROTA EXCLUSIVA PARA CRIAR PAGAMENTO PIX >>>
privateMercadoPagoRouter.post('/create-pix-payment', identifyClientToken, mercadoPagoController.criarPagamentoPix);

module.exports = {
  publicMercadoPagoRouter,
  privateMercadoPagoRouter,
};
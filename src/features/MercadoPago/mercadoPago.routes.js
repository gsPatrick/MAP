// src/features/MercadoPago/mercadoPago.routes.js
const { Router } = require('express');
const mercadoPagoController = require('./mercadoPago.controller');
const { identifyClientToken } = require('../../middlewares/authMiddleware');

// Roteador para endpoints PÚBLICOS (webhook)
const publicMercadoPagoRouter = Router();
publicMercadoPagoRouter.post('/webhook', mercadoPagoController.webhook);

// Roteador para endpoints PRIVADOS (requerem token)
const privateMercadoPagoRouter = Router();

// Rota para Checkout Pro (Cartão de Crédito, etc.)
privateMercadoPagoRouter.post('/checkout', identifyClientToken, mercadoPagoController.criarCheckoutAssinatura);

// Rota para pagamento PIX (antiga, via modal/página dedicada)
privateMercadoPagoRouter.post('/create-pix-payment', identifyClientToken, mercadoPagoController.createPixPayment);

// <<< NOVA ROTA PARA PROCESSAR O PAGAMENTO DO PAYMENT BRICK >>>
privateMercadoPagoRouter.post('/process-brick-payment', identifyClientToken, mercadoPagoController.processBrickPayment);


module.exports = {
  publicMercadoPagoRouter,
  privateMercadoPagoRouter,
};
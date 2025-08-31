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

// <<< NOVA ROTA PARA PAGAMENTO PIX >>>
privateMercadoPagoRouter.post('/create-pix-payment', identifyClientToken, mercadoPagoController.createPixPayment);

module.exports = {
  publicMercadoPagoRouter,
  privateMercadoPagoRouter,
};
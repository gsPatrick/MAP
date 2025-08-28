// src/features/MercadoPago/mercadoPago.routes.js
const { Router } = require('express');
const mercadoPagoController = require('./mercadoPago.controller');
// <<< IMPORTA O NOVO MIDDLEWARE >>>
const { identifyClientToken } = require('../../middlewares/authMiddleware');

// Roteador para endpoints PÚBLICOS (webhook)
const publicMercadoPagoRouter = Router();
publicMercadoPagoRouter.post('/webhook', mercadoPagoController.webhook);

// Roteador para endpoints PRIVADOS (requerem token)
const privateMercadoPagoRouter = Router();

// <<< APLICA O NOVO MIDDLEWARE "LIGHT" AQUI >>>
// Este middleware apenas identifica o cliente pelo token, mas NÃO valida a assinatura,
// permitindo que clientes com plano expirado possam gerar um link de pagamento.
privateMercadoPagoRouter.post('/checkout', identifyClientToken, mercadoPagoController.criarCheckoutAssinatura);

module.exports = {
  publicMercadoPagoRouter,
  privateMercadoPagoRouter,
};
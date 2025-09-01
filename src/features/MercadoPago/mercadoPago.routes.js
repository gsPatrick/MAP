// src/features/MercadoPago/mercadoPago.routes.js
const { Router } = require('express');
const mercadoPagoController = require('./mercadoPago.controller');
const { identifyClientToken } = require('../../middlewares/authMiddleware');

// *** ROTEADOR PÚBLICO (sem autenticação) ***
const publicMercadoPagoRouter = Router();

// Webhook do MercadoPago
publicMercadoPagoRouter.post('/webhook', mercadoPagoController.webhook);

// *** ROTEADOR PRIVADO (requer autenticação) ***
const privateMercadoPagoRouter = Router();

// *** ROTAS PRINCIPAIS DO PAYMENT BRICK ***
// Criar preferência de pagamento (para inicializar o brick)
privateMercadoPagoRouter.post(
  '/create-brick-preference', 
  identifyClientToken, 
  mercadoPagoController.createBrickPreference
);

// Processar pagamento do Payment Brick (cartão + PIX)
privateMercadoPagoRouter.post(
  '/process-brick-payment', 
  identifyClientToken, 
  mercadoPagoController.processBrickPayment
);

// Buscar status de um pagamento específico
privateMercadoPagoRouter.get(
  '/payment-status/:paymentId', 
  identifyClientToken, 
  mercadoPagoController.getPaymentStatus
);

// *** ROTAS ANTIGAS/ALTERNATIVAS (manter por compatibilidade) ***
// Checkout Pro (redirect para MercadoPago)
privateMercadoPagoRouter.post(
  '/checkout', 
  identifyClientToken, 
  mercadoPagoController.criarCheckoutAssinatura
);

// PIX standalone (se ainda usar em algum lugar)
privateMercadoPagoRouter.post(
  '/create-pix-payment', 
  identifyClientToken, 
  mercadoPagoController.createPixPayment
);

// Processar pagamento brick (método antigo - manter por compatibilidade)
privateMercadoPagoRouter.post(
  '/process-payment-brick', 
  identifyClientToken, 
  mercadoPagoController.processarPagamentoBrick
);

module.exports = {
  publicMercadoPagoRouter,
  privateMercadoPagoRouter,
};
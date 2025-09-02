// src/features/MercadoPago/mercadoPago.routes.js
const { Router } = require('express');
const mercadoPagoController = require('./mercadoPago.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware');

// --- Roteador Público ---
// Rota que o Mercado Pago vai chamar para nos notificar sobre o status dos pagamentos.
const publicMercadoPagoRouter = Router();
publicMercadoPagoRouter.post('/webhook', mercadoPagoController.webhook);

// --- Roteador Privado ---
// Rotas que o seu frontend vai chamar. Requerem que o cliente esteja logado.
const privateMercadoPagoRouter = Router();

// Aplica o middleware de autenticação para todas as rotas privadas abaixo
privateMercadoPagoRouter.use(authenticateClientToken);

// <<< CORREÇÃO DA ROTA AQUI >>>
// A rota agora é '/checkout' para corresponder à chamada do frontend.
privateMercadoPagoRouter.post(
  '/checkout', 
  mercadoPagoController.createCheckoutProPreference
);

module.exports = {
  publicMercadoPagoRouter,
  privateMercadoPagoRouter,
};
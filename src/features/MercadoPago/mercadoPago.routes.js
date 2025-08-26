// src/features/MercadoPago/mercadoPago.routes.js
const { Router } = require('express');
const mercadoPagoController = require('./mercadoPago.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware');

const router = Router();

// Endpoint PÚBLICO para o Mercado Pago enviar notificações
router.post('/webhook', mercadoPagoController.webhook);

// Endpoint PRIVADO para o cliente logado iniciar um pagamento
router.post('/checkout', authenticateClientToken, mercadoPagoController.criarCheckoutAssinatura);

module.exports = router;
// CÓDIGO ANTERIOR em mercadoPago.routes.js
// const router = Router();
// router.post('/webhook', mercadoPagoController.webhook);
// router.post('/checkout', authenticateClientToken, mercadoPagoController.criarCheckoutAssinatura);
// module.exports = router;


// CÓDIGO CORRIGIDO
// src/features/MercadoPago/mercadoPago.routes.js
const { Router } = require('express');
const mercadoPagoController = require('./mercadoPago.controller');
const { authenticateClientToken } = require('../../middlewares/authMiddleware');

// Roteador para endpoints PÚBLICOS (webhook)
const publicMercadoPagoRouter = Router();
publicMercadoPagoRouter.post('/webhook', mercadoPagoController.webhook);

// Roteador para endpoints PRIVADOS (requerem token)
const privateMercadoPagoRouter = Router();
privateMercadoPagoRouter.post('/checkout', authenticateClientToken, mercadoPagoController.criarCheckoutAssinatura);

module.exports = {
  publicMercadoPagoRouter,
  privateMercadoPagoRouter,
};
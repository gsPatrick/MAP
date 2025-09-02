// src/config/mercadoPago.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas
const mercadopago = require('mercadopago');
const logger = require('../utils/logger');

// 1. Valida se a variável de ambiente obrigatória foi carregada
if (!process.env.MERCADO_PAGO_TOKEN) {
  throw new Error('A variável de ambiente MERCADO_PAGO_TOKEN não está definida.');
}

// Log da configuração (sem expor o token completo)
logger.info('[MP Config] Configurando MercadoPago SDK...');

// 2. Configura a SDK do Mercado Pago com o seu Access Token
mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_TOKEN,
});

logger.info('[MP Config] MercadoPago SDK configurado com sucesso.');

// 3. Exporta a instância configurada
module.exports = mercadopago;
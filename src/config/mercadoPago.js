// src/config/mercadoPago.js
require('dotenv').config();
const mercadopago = require('mercadopago'); // Usando a biblioteca que tem o '.configure'
const logger = require('../utils/logger');

// 1. Valida se a variável de ambiente obrigatória foi carregada
if (!process.env.MERCADO_PAGO_TOKEN) {
  throw new Error('A variável de ambiente MERCADO_PAGO_TOKEN não está definida.');
}

// 2. Configura a SDK do Mercado Pago EXATAMENTE como no Código 02
mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_TOKEN,
});

logger.info('[MP Config] SDK do MercadoPago configurada em modo de compatibilidade (legado).');

// 3. Exporta a instância configurada
module.exports = mercadopago;
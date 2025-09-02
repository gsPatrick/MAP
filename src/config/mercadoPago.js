// src/config/mercadoPago.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const logger = require('../utils/logger');

// 1. Valida se as variáveis obrigatórias foram carregadas
if (!process.env.MERCADO_PAGO_TOKEN) {
  throw new Error('A variável de ambiente MERCADO_PAGO_TOKEN não está definida.');
}

// Log das configurações (sem expor tokens completos)
logger.info('[MP Config] Configurando MercadoPago com a nova SDK:', {
  token: `${process.env.MERCADO_PAGO_TOKEN.substring(0, 10)}...`,
});

// 2. Cria o cliente de configuração com o token do seu arquivo .env
const client = new MercadoPagoConfig({ 
    accessToken: process.env.MERCADO_PAGO_TOKEN,
    options: { timeout: 5000 } // Opcional: define um timeout para as requisições
});

// 3. Exporta um objeto contendo os clientes já inicializados e prontos para uso
module.exports = {
  preference: new Preference(client),
  payment: new Payment(client), // Já exporta o cliente de Pagamento também
};
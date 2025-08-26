// src/config/mercadoPago.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

// 1. Valida se o token foi carregado do ambiente
if (!process.env.MERCADO_PAGO_TOKEN) {
  throw new Error('A variável de ambiente MERCADO_PAGO_TOKEN não está definida.');
}

// 2. Cria o cliente de configuração com o token do seu arquivo .env
const client = new MercadoPagoConfig({ 
    accessToken: process.env.MERCADO_PAGO_TOKEN,
    options: { timeout: 5000 } // Opcional: define um timeout para as requisições
});

// 3. Exporta um objeto contendo os clientes já inicializados
module.exports = {
  preference: new Preference(client),
  payment: new Payment(client), // Já exporta o cliente de Pagamento também
  // Adicione outros clientes aqui se precisar no futuro
};  
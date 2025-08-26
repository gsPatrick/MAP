// CÓDIGO ANTERIOR
// const mercadopago = require("mercadopago");
// mercadopago.configure({
//   access_token: process.env.MERCADO_PAGO_TOKEN,
// });
// module.exports = mercadopago;

// CÓDIGO CORRIGIDO
// src/config/mercadoPago.js
const { MercadoPagoConfig, Preference } = require('mercadopago');

// 1. Cria o cliente de configuração com o seu token de acesso.
const client = new MercadoPagoConfig({ 
    accessToken: "APP_USR-846af928-1fea-40a8-bca7-b027778026c5",
    options: { timeout: 5000 } // Opcional: define um timeout para as requisições
});

// 2. Exporta um objeto contendo o cliente de preferência já inicializado
//    e o cliente de configuração geral para outras possíveis operações.
module.exports = {
  preference: new Preference(client),
  // Adicione outros clientes aqui se precisar (ex: new Payment(client), etc.)
};
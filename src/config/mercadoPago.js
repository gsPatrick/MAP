const mercadopago = require("mercadopago")

mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_TOKEN,
})

module.exports = mercadopago

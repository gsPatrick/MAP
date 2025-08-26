// src/features/MercadoPago/mercadoPago.controller.js
const mercadoPagoService = require('./mercadoPago.service');

const mercadoPagoController = {
  async criarCheckoutAssinatura(req, res, next) {
    try {
      const clientId = req.client.id; // Vem do middleware de autenticação
      const { planId } = req.body;

      if (!planId) {
        return res.status(400).json({ status: 'fail', message: 'O ID do Plano (planId) é obrigatório.' });
      }

      const checkout = await mercadoPagoService.criarPreferenciaAssinatura(clientId, planId);
      res.status(200).json({ status: 'success', data: checkout });
    } catch (error) {
      next(error);
    }
  },

  async webhook(req, res, next) {
    try {
      // O webhook responde imediatamente com 200 OK para o Mercado Pago
      // e processa a lógica em segundo plano.
      res.status(200).send('Webhook recebido.'); 
      await mercadoPagoService.processarWebhook(req.body);
    } catch (error) {
      // A resposta já foi enviada, então apenas logamos o erro.
      // O 'next(error)' não deve ser chamado aqui.
    }
  },
};

module.exports = mercadoPagoController;
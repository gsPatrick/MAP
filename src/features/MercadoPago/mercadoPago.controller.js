// src/features/MercadoPago/mercadoPago.controller.js
const mercadoPagoService = require('./mercadoPago.service');

const mercadoPagoController = {
  // Rota antiga - pode manter ou remover depois
  async criarCheckoutAssinatura(req, res, next) {
    try {
      const clientId = req.client.id;
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

  // Rota antiga - pode manter ou remover depois
  async processarPagamentoBrick(req, res, next) {
    try {
      const clientId = req.client.id;
      const paymentData = req.body;
      if (!paymentData.token || !paymentData.planId || !paymentData.payment_method_id) {
        return res.status(400).json({ status: 'fail', message: 'Dados de pagamento incompletos.' });
      }
      const resultado = await mercadoPagoService.processarPagamentoBrick(clientId, paymentData);
      res.status(201).json({ status: 'success', data: resultado });
    } catch (error) {
      next(error);
    }
  },

  // Webhook
  async webhook(req, res, next) {
    try {
      res.status(200).send('Webhook recebido.'); 
      await mercadoPagoService.processarWebhook(req.body);
    } catch (error) {
      // Apenas loga o erro, pois a resposta já foi enviada
    }
  },

  // Controller para gerar PIX
  async criarPagamentoPix(req, res, next) {
    try {
      const clientId = req.client.id;
      const { planId } = req.body;

      if (!planId) {
        return res.status(400).json({ status: 'fail', message: 'O ID do Plano (planId) é obrigatório.' });
      }

      const pixData = await mercadoPagoService.criarPagamentoPix(clientId, planId);
      res.status(201).json({ status: 'success', data: pixData });
    } catch (error) {
      next(error);
    }
  },
   // <<< NOVO CONTROLLER PARA PIX >>>
  async createPixPayment(req, res, next) {
    try {
      const clientId = req.client.id; // Vem do middleware de autenticação
      const { planId } = req.body;

      if (!planId) {
        return res.status(400).json({ status: 'fail', message: 'O ID do Plano (planId) é obrigatório.' });
      }

      const pixData = await mercadoPagoService.createPixPayment(clientId, planId);
      res.status(200).json({ status: 'success', data: pixData });
    } catch (error) {
      next(error);
    }
  }, 
};

module.exports = mercadoPagoController;

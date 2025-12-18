// src/features/MercadoPago/mercadoPago.controller.js
const mercadoPagoService = require('./mercadoPago.service');
const logger = require('../../utils/logger');

const mercadoPagoController = {
  /**
   * Cria uma preferência de pagamento (Checkout Pro) e retorna a URL de redirecionamento.
   */
  async createCheckoutProPreference(req, res, next) {
    try {
      const clientId = req.client.id;
      const { planId, affiliateCode } = req.body; // Pega o planId e o código de afiliado do corpo da requisição

      if (!planId) {
        return res.status(400).json({ status: 'fail', message: 'O ID do Plano (planId) é obrigatório.' });
      }

      const preference = await mercadoPagoService.createCheckoutProPreference(clientId, planId, affiliateCode);

      // Retorna o objeto de preferência completo, o frontend usará a 'init_point'
      res.status(200).json({ status: 'success', data: preference });

    } catch (error) {
      next(error);
    }
  },
  async createCheckout(req, res, next) {
    try {
      const clientId = req.client.id;
      const { planId, affiliateCode } = req.body;

      if (!planId) {
        return res.status(400).json({ status: 'fail', message: 'O ID do Plano (planId) é obrigatório.' });
      }

      // O nome do método no serviço pode permanecer o mesmo, pois é mais descritivo internamente.
      const preference = await mercadoPagoService.createCheckoutProPreference(clientId, planId, affiliateCode);

      // <<< CORREÇÃO: Retornando a URL diretamente para simplificar o frontend >>>
      res.status(200).json({ status: 'success', data: { checkoutUrl: preference.init_point } });

    } catch (error) {
      next(error);
    }
  },

  /**
   * Recebe e processa as notificações de webhook do Mercado Pago.
   */
  async webhook(req, res, next) {
    try {
      // Loga a notificação recebida
      logger.info('[Webhook Controller] Notificação do Mercado Pago recebida.', { body: req.body, query: req.query });

      // Responde imediatamente com 200 OK para o Mercado Pago não reenviar a notificação
      res.status(200).send('Webhook recebido.');

      // Processa a notificação em segundo plano
      // Passamos o body e o query combinados ou separadamente para lidar com IPN e Webhook
      const notificationData = { ...req.query, ...req.body };
      await mercadoPagoService.processarWebhook(notificationData);

    } catch (error) {
      // Apenas logamos o erro, pois a resposta já foi enviada
      logger.error('[Webhook Controller] Erro não capturado ao processar webhook:', error);
    }
  },
};

module.exports = mercadoPagoController;
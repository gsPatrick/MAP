// src/features/MercadoPago/mercadoPago.controller.js
const mercadoPagoService = require('./mercadoPago.service');
const logger = require('../../utils/logger');

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
      logger.info('[Webhook] Recebido:', JSON.stringify(req.body, null, 2));
      res.status(200).send('Webhook recebido.'); 
      await mercadoPagoService.processarWebhook(req.body);
    } catch (error) {
      logger.error('[Webhook] Erro ao processar:', error);
      // Apenas loga o erro, pois a resposta já foi enviada
    }
  },

  // Controller para gerar PIX (rota antiga)
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

  // Controller para PIX standalone (se ainda usar)
  async createPixPayment(req, res, next) {
    try {
      const clientId = req.client.id;
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

  // *** CONTROLLER PRINCIPAL PARA O PAYMENT BRICK ***
  async processBrickPayment(req, res, next) {
    try {
      const clientId = req.client.id;
      const { planId, ...paymentData } = req.body;

      logger.info(`[Controller] Processando pagamento Brick - Cliente: ${clientId}, Plano: ${planId}`);
      logger.info(`[Controller] Dados do pagamento:`, JSON.stringify(paymentData, null, 2));

      // Validações
      if (!planId) {
        return res.status(400).json({ 
          status: 'fail', 
          message: 'O ID do Plano (planId) é obrigatório.' 
        });
      }

      if (!paymentData || Object.keys(paymentData).length === 0) {
        return res.status(400).json({ 
          status: 'fail', 
          message: 'Dados de pagamento são obrigatórios.' 
        });
      }

      // Validações específicas por tipo de pagamento
      if (paymentData.payment_method_id === 'pix') {
        // PIX precisa apenas do payment_method_id
        if (!paymentData.payment_method_id) {
          return res.status(400).json({ 
            status: 'fail', 
            message: 'Método de pagamento é obrigatório para PIX.' 
          });
        }
      } else {
        // Cartão precisa do token
        if (!paymentData.token && !paymentData.payment_method_id) {
          return res.status(400).json({ 
            status: 'fail', 
            message: 'Token ou método de pagamento é obrigatório para cartão.' 
          });
        }
      }

      const result = await mercadoPagoService.processBrickPayment(clientId, planId, paymentData);
      
      logger.info(`[Controller] Pagamento processado - ID: ${result.id}, Status: ${result.status}`);
      
      res.status(200).json({ 
        status: 'success', 
        data: result 
      });
    } catch (error) {
      logger.error(`[Controller] Erro ao processar pagamento Brick:`, error.message);
      next(error);
    }
  },

  // *** CONTROLLER PARA CRIAR PREFERÊNCIA DO BRICK ***
  async createBrickPreference(req, res, next) {
    try {
      const clientId = req.client.id;
      const { planId } = req.body;
      
      logger.info(`[Controller] Criando preferência Brick - Cliente: ${clientId}, Plano: ${planId}`);
      
      if (!planId) {
        return res.status(400).json({ 
          status: 'fail', 
          message: 'O ID do Plano (planId) é obrigatório.' 
        });
      }

      const preference = await mercadoPagoService.createPaymentPreference(clientId, planId);
      
      logger.info(`[Controller] Preferência criada - ID: ${preference.preferenceId}`);
      
      res.status(200).json({ 
        status: 'success', 
        data: preference 
      });
    } catch (error) {
      logger.error(`[Controller] Erro ao criar preferência Brick:`, error.message);
      next(error);
    }
  },

  // *** NOVO: Controller para buscar status do pagamento ***
  async getPaymentStatus(req, res, next) {
    try {
      const { paymentId } = req.params;
      const clientId = req.client.id;
      
      if (!paymentId) {
        return res.status(400).json({ 
          status: 'fail', 
          message: 'ID do pagamento é obrigatório.' 
        });
      }

      const paymentStatus = await mercadoPagoService.getPaymentStatus(paymentId, clientId);
      
      res.status(200).json({ 
        status: 'success', 
        data: paymentStatus 
      });
    } catch (error) {
      logger.error(`[Controller] Erro ao buscar status do pagamento:`, error.message);
      next(error);
    }
  }
};

module.exports = mercadoPagoController;
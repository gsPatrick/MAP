// src/features/Subscription/subscription.controller.js
const subscriptionService = require('./subscription.service');

const subscriptionController = {
  // Controller para buscar a assinatura ativa do cliente logado
  async getMyActiveSubscription(req, res, next) {
    try {
      // req.client.id é populado pelo middleware de autenticação
      const clientId = req.client.id;
      const activeSubscription = await subscriptionService.getActiveSubscription(clientId);
      
      // Retorna a assinatura ou null se não houver uma ativa
      res.status(200).json({ status: 'success', data: activeSubscription });
    } catch (error) {
      next(error);
    }
  },

  // Controller para listar todas as assinaturas de um cliente
  async getMySubscriptions(req, res, next) {
    try {
        const clientId = req.client.id;
        const subscriptions = await subscriptionService.getClientSubscriptions(clientId);
        res.status(200).json({ status: 'success', data: subscriptions });
    } catch (error) {
        next(error);
    }
  }
};

module.exports = subscriptionController;
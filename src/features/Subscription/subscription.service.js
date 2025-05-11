// src/features/Subscription/subscription.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Cria uma nova assinatura para um cliente (simulação manual).
 * Em um cenário real, isso seria acionado por um webhook da Hotmart.
 * @param {number} clientId
 * @param {number} planId
 * @param {string} startDate YYYY-MM-DD (opcional, default: hoje)
 * @param {string} status 'Ativa', 'Pendente', etc. (opcional, default: 'Ativa')
 * @returns {Promise<object>} A assinatura criada.
 */
async function createSubscription(clientId, planId, startDate = null, status = 'Ativa') {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const plan = await Plan.findByPk(planId, { transaction: t });
    if (!plan || !plan.isActive) {
      const error = new Error(`Plano com ID ${planId} não encontrado ou inativo.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const effectiveStartDate = startDate ? new Date(startDate) : new Date();
    const endDate = new Date(effectiveStartDate);
    endDate.setDate(endDate.getDate() + plan.durationDays);

    const newSubscription = await Subscription.create({
      clientId,
      planId,
      startDate: effectiveStartDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      status: status,
      autoRenew: plan.durationDays > 31 ? true : false,
    }, { transaction: t });

    await t.commit();
    logger.info(`Assinatura ID ${newSubscription.id} criada para Cliente ID ${clientId} com Plano ID ${planId}. Válida até ${newSubscription.endDate}.`);
    return newSubscription.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar assinatura para Cliente ID ${clientId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Verifica se um cliente possui uma assinatura ativa.
 * @param {number} clientId
 * @returns {Promise<object|null>} A assinatura ativa ou null.
 */
async function getActiveSubscription(clientId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const subscription = await Subscription.findOne({
      where: {
        clientId: clientId,
        status: 'Ativa',
        startDate: { [Op.lte]: today },
        endDate: { [Op.gte]: today },
      },
      include: [{ model: Plan, as: 'plan' }],
      order: [['endDate', 'DESC']],
    });

    if (subscription) {
      // logger.info(`Cliente ID ${clientId} possui assinatura ativa (Plano: ${subscription.plan.name}), válida até ${subscription.endDate}.`);
    } else {
      // logger.info(`Cliente ID ${clientId} não possui assinatura ativa.`);
    }
    return subscription ? subscription.toJSON() : null;
  } catch (error) {
    logger.error(`Erro ao verificar assinatura ativa para Cliente ID ${clientId}: ${error.message}`, { error });
    throw error;
  }
}

/**
 * Lista todas as assinaturas de um cliente.
 * @param {number} clientId
 * @returns {Promise<Array<object>>}
 */
async function getClientSubscriptions(clientId) {
    try {
        const subscriptions = await Subscription.findAll({
            where: { clientId },
            include: [{ model: Plan, as: 'plan' }],
            order: [['startDate', 'DESC']]
        });
        return subscriptions.map(sub => sub.toJSON());
    } catch (error) {
        logger.error(`Erro ao listar assinaturas do cliente ID ${clientId}: ${error.message}`, { error });
        throw error;
    }
}

module.exports = {
  createSubscription,
  getActiveSubscription,
  getClientSubscriptions,
};
// src/features/Admin/admin.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const { sendWhatsappMessage } = require('../../services/whatsappService');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');

/**
 * Altera o número de telefone de um cliente. (Função de Admin)
 * @param {number} clientId - ID do cliente a ser alterado.
 * @param {string} newPhoneNumber - O novo número de telefone.
 * @returns {Promise<object>} O objeto do cliente atualizado.
 */
async function changeClientPhoneNumber(clientId, newPhoneNumber) {
    const t = await sequelize.transaction();
    try {
        const client = await Client.findByPk(clientId, { transaction: t });
        if (!client) {
            throw { statusCode: 404, message: 'Cliente não encontrado.' };
        }

        if (!newPhoneNumber || typeof newPhoneNumber !== 'string') {
            throw { statusCode: 400, message: 'O novo número de telefone é obrigatório e deve ser uma string.' };
        }

        const normalizedPhone = normalizePhoneNumberToCanonical(newPhoneNumber);
        if (!normalizedPhone || normalizedPhone.length < 12) {
             throw { statusCode: 400, message: `O número de telefone "${newPhoneNumber}" parece inválido.` };
        }

        const existingClientWithPhone = await Client.findOne({
            where: {
                phone: normalizedPhone,
                id: { [Op.ne]: clientId }
            },
            transaction: t
        });

        if (existingClientWithPhone) {
            throw { statusCode: 409, message: `O número de telefone ${normalizedPhone} já está em uso pelo cliente ID ${existingClientWithPhone.id}.` };
        }

        await client.update({ phone: normalizedPhone }, { transaction: t });
        await t.commit();

        logger.info(`[AdminService] Telefone do cliente ID ${clientId} alterado para ${normalizedPhone} por um administrador.`);
        return client.toJSON();

    } catch (error) {
        await t.rollback();
        logger.error(`[AdminService] Erro ao alterar telefone do cliente ID ${clientId}: ${error.message}`, error);
        throw error;
    }
}

async function getAllPlans(queryParams = {}) {
  try {
    const whereConditions = {};
    if (queryParams.isActive !== undefined) {
      whereConditions.isActive = (queryParams.isActive === 'true' || queryParams.isActive === true);
    }
    const plans = await Plan.findAll({ where: whereConditions, order: [['price', 'ASC']] });
    logger.info(`[AdminService] Listando ${plans.length} planos.`);
    return plans.map(p => p.toJSON());
  } catch (error) {
    logger.error(`[AdminService] Erro ao listar planos: ${error.message}`, error);
    throw new Error('Falha ao listar planos de assinatura.');
  }
}

async function getDashboardMetrics() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const totalClients = await Client.count();
    const activeClients = await Client.count({ where: { status: 'Ativo' } });
    const planCounts = await Client.findAll({
      attributes: ['accessLevel', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['accessLevel'],
      raw: true,
    });
    const expiredClients = await Client.count({
      where: {
        status: 'Ativo',
        accessLevel: { [Op.not]: ['gratuito', 'vitalicio_basico', 'vitalicio_avancado'] },
        accessExpiresAt: { [Op.lt]: today }
      }
    });
    const metrics = { totalClients, activeClients, plans: {}, needsPayment: expiredClients };
    planCounts.forEach(item => {
      metrics.plans[item.accessLevel] = parseInt(item.count, 10);
    });
    const allPlanLevels = ['gratuito', 'basico_mensal', 'basico_anual', 'avancado_mensal', 'avancado_anual', 'vitalicio_basico', 'vitalicio_avancado'];
    allPlanLevels.forEach(level => {
        if (!metrics.plans[level]) {
            metrics.plans[level] = 0;
        }
    });
    logger.info('[AdminService] Métricas do dashboard geradas com sucesso.');
    return metrics;
  } catch (error) {
    logger.error(`[AdminService] Erro ao gerar métricas do dashboard: ${error.message}`, error);
    throw new Error('Falha ao gerar métricas do dashboard.');
  }
}

async function createCustomPlan(planData) {
  try {
    const { name, price, durationDays, tier, affiliateCommissionValue = 0 } = planData;
    if (!name || !price || !durationDays || !tier) {
      throw { statusCode: 400, message: 'Nome, preço, duração e tier são obrigatórios para criar um plano.' };
    }
    const newPlan = await Plan.create({
      name,
      price,
      durationDays,
      tier,
      affiliateCommissionValue,
      isActive: true,
      description: `Plano customizado criado pelo administrador em ${new Date().toLocaleDateString('pt-BR')}`
    });
    logger.info(`[AdminService] Plano customizado "${name}" criado com sucesso.`);
    return newPlan.toJSON();
  } catch (error) {
    logger.error(`[AdminService] Erro ao criar plano customizado: ${error.message}`, error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw { statusCode: 409, message: `Um plano com o nome "${planData.name}" já existe.` };
    }
    throw error;
  }
}

async function changeUserPlan(clientId, planId) {
    const t = await sequelize.transaction();
    try {
        const client = await Client.findByPk(clientId, { transaction: t });
        if (!client) {
            throw { statusCode: 404, message: 'Cliente não encontrado.' };
        }
        const plan = await Plan.findByPk(planId, { transaction: t });
        if (!plan) {
            throw { statusCode: 404, message: 'Plano não encontrado.' };
        }
        await Subscription.update(
            { status: 'Cancelada' },
            { where: { clientId, status: 'Ativa' }, transaction: t }
        );
        const newSubscription = await subscriptionService.createSubscription(
            clientId,
            planId,
            new Date().toISOString().split('T')[0],
            'Ativa',
            null,
            null,
            { transaction: t }
        );
        await t.commit();
        logger.info(`[AdminService] Plano do cliente ID ${clientId} alterado para "${plan.name}" (ID: ${planId}).`);
        return {
            message: 'Plano do cliente alterado com sucesso.',
            newSubscription: newSubscription
        };
    } catch (error) {
        await t.rollback();
        logger.error(`[AdminService] Erro ao alterar plano do cliente ID ${clientId}: ${error.message}`, error);
        throw error;
    }
}

async function sendBroadcastMessage(message) {
  if (!message || message.trim() === '') {
    throw { statusCode: 400, message: 'A mensagem não pode ser vazia.' };
  }
  try {
    const clientsToSend = await Client.findAll({
      where: {
        status: 'Ativo',
        phone: { [Op.ne]: null }
      },
      attributes: ['id', 'phone']
    });
    if (clientsToSend.length === 0) {
      return { message: 'Nenhum cliente ativo com telefone para enviar a mensagem.', sentCount: 0, failedCount: 0 };
    }
    let sentCount = 0;
    let failedCount = 0;
    const promises = [];
    for (const client of clientsToSend) {
      promises.push(
        sendWhatsappMessage(client.phone, message)
          .then(success => {
            if (success) sentCount++;
            else failedCount++;
          })
          .catch(() => failedCount++)
      );
    }
    await Promise.all(promises);
    logger.info(`[AdminService] Transmissão concluída. Enviadas: ${sentCount}, Falhas: ${failedCount}.`);
    return { message: 'Transmissão concluída.', sentCount, failedCount, total: clientsToSend.length };
  } catch (error) {
    logger.error(`[AdminService] Erro ao enviar mensagem em massa: ${error.message}`, error);
    throw new Error('Falha ao enviar transmissão.');
  }
}

async function getAffiliatesDashboard() {
  try {
    const affiliates = await Client.findAll({
      where: {
        [Op.or]: [
          { balance: { [Op.gt]: 0 } },
          { id: { [Op.in]: sequelize.literal(`(SELECT DISTINCT "referredByClientId" FROM "clients" WHERE "referredByClientId" IS NOT NULL)`) } }
        ]
      },
      attributes: ['id', 'name', 'email', 'phone', 'balance', 'affiliateCode'],
      order: [['name', 'ASC']],
    });
    if (affiliates.length === 0) {
      return [];
    }
    const affiliateIds = affiliates.map(a => a.id);
    const allReferrals = await Client.findAll({
        where: { referredByClientId: { [Op.in]: affiliateIds } },
        attributes: ['id', 'name', 'email', 'accessLevel', 'createdAt', 'referredByClientId'],
    });
    const allPlans = await Plan.findAll({ raw: true });
    const planCommissionMap = allPlans.reduce((acc, plan) => {
        const parts = plan.name.toLowerCase().split(' - ')[1]?.split(' ') || [];
        const tier = parts[0] === 'empresarial' ? 'avancado' : 'basico';
        const duration = parts[1];
        const key = `${tier}_${duration}`;
        acc[key] = parseFloat(plan.affiliateCommissionValue) || 0;
        return acc;
    }, {});
    const dashboardData = affiliates.map(affiliate => {
        const myReferrals = allReferrals.filter(r => r.referredByClientId === affiliate.id);
        let totalEarned = 0;
        const ledger = myReferrals.map(ref => {
            const commission = planCommissionMap[ref.accessLevel] || 0;
            totalEarned += commission;
            return {
                id: ref.id,
                createdAt: ref.createdAt,
                referred: { name: ref.name },
                email: ref.email,
                plan: { name: ref.accessLevel.replace(/_/g, ' ') },
                commissionAmount: commission
            };
        });
        return {
            ...affiliate.toJSON(),
            totalReferrals: myReferrals.length,
            totalEarned: totalEarned,
            referrals: ledger,
        };
    });
    return dashboardData;
  } catch (error) {
    logger.error(`[AdminService] Erro ao gerar dashboard de afiliados: ${error.message}`, error);
    throw new Error('Falha ao gerar dashboard de afiliados.');
  }
}

async function updatePlan(planId, updateData) {
  try {
    const plan = await Plan.findByPk(planId);
    if (!plan) {
      throw { statusCode: 404, message: 'Plano não encontrado.' };
    }
    const allowedUpdates = ['name', 'price', 'durationDays', 'tier', 'isActive', 'affiliateCommissionValue'];
    const filteredData = {};
    for (const key of allowedUpdates) {
      if (updateData[key] !== undefined) {
        filteredData[key] = updateData[key];
      }
    }
    if (Object.keys(filteredData).length === 0) {
      return plan.toJSON();
    }
    await plan.update(filteredData);
    logger.info(`[AdminService] Plano ID ${planId} atualizado com sucesso.`);
    return plan.toJSON();
  } catch (error) {
    logger.error(`[AdminService] Erro ao atualizar plano ID ${planId}: ${error.message}`, error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw { statusCode: 409, message: `Um plano com o nome "${updateData.name}" já existe.` };
    }
    throw error;
  }
}

async function clearClientBalance(clientId) {
    const t = await sequelize.transaction();
    try {
        const client = await Client.findByPk(clientId, { transaction: t });
        if (!client) {
            throw { statusCode: 404, message: 'Cliente não encontrado.' };
        }
        if (client.balance === 0) {
            await t.commit();
            logger.info(`[AdminService] Saldo do cliente ID ${clientId} já é zero. Nenhuma ação necessária.`);
            return;
        }
        const oldBalance = client.balance;
        await client.update({ balance: 0 }, { transaction: t });
        logger.info(`[AdminService] Saldo do cliente ID ${clientId} zerado de R$${oldBalance} para R$0.00.`);
        await t.commit();
    } catch (error) {
        await t.rollback();
        logger.error(`[AdminService] Erro ao zerar saldo do cliente ID ${clientId}: ${error.message}`, error);
        throw error;
    }
}

// <<< [CORREÇÃO] A função deleteClientByUser estava faltando aqui, foi adicionada >>>
async function deleteClientByUser(clientId) {
    logger.warn(`[ADMIN SERVICE] Início da solicitação de EXCLUSÃO PERMANENTE para o Cliente ID: ${clientId}.`);
    const t = await sequelize.transaction();
    try {
        const client = await Client.findByPk(clientId, { transaction: t });
        if (!client) {
            await t.rollback();
            throw { statusCode: 404, message: 'Cliente não encontrado para exclusão.' };
        }
        
        await client.destroy({ transaction: t });
        
        await t.commit();
        logger.info(`[ADMIN SERVICE] Cliente ID ${clientId} (${client.name || client.phone}) e todos os dados associados foram excluídos com sucesso por um administrador.`);
        return true;
    } catch (error) {
        await t.rollback();
        logger.error(`[ADMIN SERVICE] Erro CRÍTICO ao excluir cliente ID ${clientId}: ${error.message}`, { error });
        throw error;
    }
}

module.exports = {
  getDashboardMetrics,
  createCustomPlan,
  changeUserPlan,
  sendBroadcastMessage,
  getAffiliatesDashboard,
  getAllPlans,
  updatePlan,
  clearClientBalance,
  changeClientPhoneNumber,
  deleteClientByUser
};
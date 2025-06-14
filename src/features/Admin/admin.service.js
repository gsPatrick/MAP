// src/features/Admin/admin.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const clientService = require('../Client/client.service');
const subscriptionService = require('../Subscription/subscription.service');
const { sendWhatsappMessage } = require('../../services/whatsappService');

/**
 * Obtém estatísticas sobre a distribuição de clientes por plano/status.
 */
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

    const metrics = {
      totalClients,
      activeClients,
      plans: {},
      needsPayment: expiredClients,
    };

    planCounts.forEach(item => {
      metrics.plans[item.accessLevel] = parseInt(item.count, 10);
    });

    // Garante que todos os tipos de plano apareçam, mesmo que com 0 usuários
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

/**
 * Cria um novo plano customizado (presente).
 */
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
      isActive: true, // Planos customizados são criados como ativos
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

/**
 * Altera o plano de um usuário específico.
 */
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

        // Cancela assinaturas ativas antigas do cliente
        await Subscription.update(
            { status: 'Cancelada' },
            { where: { clientId, status: 'Ativa' }, transaction: t }
        );

        // Cria a nova assinatura
        const newSubscription = await subscriptionService.createSubscription(
            clientId,
            planId,
            new Date().toISOString().split('T')[0],
            'Ativa', // A nova assinatura já começa ativa
            null,
            null, // Não registra código de afiliado em trocas de plano manuais
            { transaction: t } // Passa a transação para o serviço
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

/**
 * Envia uma mensagem em massa para todos os clientes ativos com telefone.
 */
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

/**
 * Obtém um dashboard completo sobre o desempenho de todos os afiliados.
 */
async function getAffiliatesDashboard() {
  try {
    const affiliates = await Client.findAll({
      where: {
        // Consideramos afiliado quem tem saldo ou já indicou alguém
        [Op.or]: [
          { balance: { [Op.gt]: 0 } },
          { id: { [Op.in]: sequelize.literal(`(SELECT "referredByClientId" FROM "clients" WHERE "referredByClientId" IS NOT NULL)`) } }
        ]
      },
      attributes: ['id', 'name', 'email', 'phone', 'balance', 'affiliateCode'],
      include: [
        {
          model: Client,
          as: 'referrals', // Precisamos definir essa associação no modelo Client
          attributes: [[sequelize.fn('COUNT', sequelize.col('referrals.id')), 'totalReferrals']],
        }
      ],
      group: ['Client.id'],
      order: [[sequelize.col('balance'), 'DESC']],
      raw: true,
      subQuery: false,
    });

    // O count acima não funciona bem com `group`. Vamos fazer em duas etapas.
    const allAffiliates = await Client.findAll({
      where: {
        [Op.or]: [
          { balance: { [Op.gt]: 0 } },
          { id: { [Op.in]: sequelize.literal(`(SELECT "referredByClientId" FROM "clients" WHERE "referredByClientId" IS NOT NULL)`) } }
        ]
      },
      attributes: ['id', 'name', 'email', 'phone', 'balance', 'affiliateCode'],
      order: [['balance', 'DESC']],
    });

    const affiliateIds = allAffiliates.map(a => a.id);

    const referralsCount = await Client.findAll({
        attributes: ['referredByClientId', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
        where: { referredByClientId: { [Op.in]: affiliateIds } },
        group: ['referredByClientId'],
        raw: true,
    });
    const referralsMap = referralsCount.reduce((acc, item) => {
        acc[item.referredByClientId] = parseInt(item.count, 10);
        return acc;
    }, {});

    const totalCommissionsPaid = await sequelize.query(
        `SELECT "affiliateClientId", SUM("commissionAmount") as "totalEarned" FROM "affiliate_ledger" WHERE "affiliateClientId" IN (:affiliateIds) GROUP BY "affiliateClientId"`,
        { replacements: { affiliateIds }, type: sequelize.QueryTypes.SELECT }
    );
    const commissionsMap = totalCommissionsPaid.reduce((acc, item) => {
        acc[item.affiliateClientId] = parseFloat(item.totalEarned);
        return acc;
    }, {});

    const dashboardData = allAffiliates.map(affiliate => ({
        ...affiliate.toJSON(),
        totalReferrals: referralsMap[affiliate.id] || 0,
        totalEarned: commissionsMap[affiliate.id] || 0,
    }));

    return dashboardData;
  } catch (error) {
    logger.error(`[AdminService] Erro ao gerar dashboard de afiliados: ${error.message}`, error);
    throw new Error('Falha ao gerar dashboard de afiliados.');
  }
}


module.exports = {
  getDashboardMetrics,
  createCustomPlan,
  changeUserPlan,
  sendBroadcastMessage,
  getAffiliatesDashboard,
};
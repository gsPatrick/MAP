// src/features/Admin/admin.service.js
const { Client, Plan, Subscription, FinancialAccount, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const subscriptionService = require('../Subscription/subscription.service');
const { sendWhatsappMessage } = require('../../services/whatsappService');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
const { formatDate } = require('../../utils/formatters');
const onboardingHandler = require('../WhatsappHandler/onboarding.handler'); // Import para o trigger

/**
 * Lista clientes com filtros avançados para o painel de admin.
 * @param {object} queryParams - Parâmetros de consulta (page, limit, search, filter).
 * @returns {Promise<object>} Objeto com lista de clientes e informações de paginação.
 */
async function getAdminClientList(queryParams = {}) {
  try {
    const { page = 1, limit = 10, search, filter = 'all' } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = {};
    const today = new Date().toISOString().split('T')[0];

    if (search) {
      whereConditions[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    // Lógica de filtros
    switch (filter) {
        case 'active':
            whereConditions.status = 'Ativo';
            break;
        case 'expiring_soon':
            const sevenDaysFromNow = new Date();
            sevenDaysFromNow.setDate(new Date().getDate() + 7);
            whereConditions.status = 'Ativo';
            whereConditions.accessExpiresAt = {
                [Op.between]: [today, sevenDaysFromNow.toISOString().split('T')[0]]
            };
            break;
        case 'expired':
            // Pega clientes cujo status não é 'Ativo' E a data de expiração já passou.
            whereConditions.status = { [Op.notIn]: ['Ativo', 'Aguardando Pagamento'] };
            whereConditions.accessExpiresAt = { [Op.lt]: today };
            break;
        default: // 'all'
            break;
    }

    const { count, rows } = await Client.findAndCountAll({
      where: whereConditions,
      attributes: ['id', 'name', 'phone', 'email', 'status', 'accessLevel', 'accessExpiresAt', 'createdAt'],
      limit: parseInt(limit, 10),
      offset: offset,
      order: [['createdAt', 'DESC']],
      distinct: true,
    });

    logger.info(`[AdminService] Listados ${rows.length} clientes para o painel de admin com filtro '${filter}'.`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      clients: rows.map(client => client.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar clientes para o painel de admin: ${error.message}`, { error });
    throw new Error('Erro ao buscar a lista de clientes.');
  }
}

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

/**
 * Lista planos, com opção de filtrar apenas os customizados (criados pelo admin).
 */
async function getAllPlans(queryParams = {}) {
  try {
    const whereConditions = {};
    if (queryParams.isActive !== undefined) {
      whereConditions.isActive = (queryParams.isActive === 'true' || queryParams.isActive === true);
    }
    
    // Novo filtro para planos customizados (não-padrão)
    if (queryParams.isCustom === 'true') {
        const defaultPlanNames = [
            'Plano Básico - Mensal', 
            'Plano Básico - Anual', 
            'Plano Avançado - Mensal', 
            'Plano Avançado - Anual',
            'Plano Vitalício - Básico',
            'Plano Vitalício - Avançado'
        ];
        whereConditions.name = { [Op.notIn]: defaultPlanNames };
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
    if (!name || price === undefined || !durationDays || !tier) {
      throw { statusCode: 400, message: 'Nome, preço, duração e tier são obrigatórios para criar um plano.' };
    }
    const newPlan = await Plan.create({
      name,
      price: parseFloat(price),
      durationDays: parseInt(durationDays),
      tier,
      affiliateCommissionValue: parseFloat(affiliateCommissionValue),
      isActive: true,
      description: `Plano customizado criado pelo administrador em ${new Date().toLocaleDateString('pt-BR')}`
    });
    logger.info(`[AdminService] Plano customizado "${name}" (Preço: ${price}) criado com sucesso.`);
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
 * Altera o plano de um usuário e permite enviar uma mensagem customizada.
 * @param {number} clientId - ID do cliente.
 * @param {number} planId - ID do novo plano.
 * @param {string} [customMessage] - Mensagem opcional para enviar ao cliente.
 */
async function changeUserPlan(clientId, planId, customMessage) {
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
        
        logger.info(`[AdminService] Plano do cliente ID ${clientId} alterado para "${plan.name}".`);

        if (client.phone) {
            try {
                let messageToSend;
                if (customMessage && customMessage.trim() !== '') {
                    messageToSend = customMessage;
                } else {
                    const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
                    let expiryWelcomePart = `Seu acesso agora está garantido até *${formatDate(newSubscription.endDate)}*.`;
                    if (plan.durationDays > 7000) { 
                        expiryWelcomePart = "Você agora tem *acesso vitalício*! 🎉";
                    }
                    messageToSend = `Olá, ${clientName}! ✨\n\nSua assinatura foi atualizada com sucesso para o plano *${plan.name}* pelo nosso suporte.\n\n${expiryWelcomePart}\n\nJá pode começar a usar todos os recursos. Qualquer dúvida, é só me chamar! 😉`;
                }
                
                await sendWhatsappMessage(client.phone, messageToSend);
                logger.info(`[AdminService] Mensagem de confirmação de mudança de plano enviada para ${client.phone}.`);
            } catch (whatsappError) {
                logger.error(`[AdminService] Falha ao enviar mensagem de confirmação para ${client.phone}: ${whatsappError.message}`);
            }
        }

        return {
            message: 'Plano do cliente alterado com sucesso.',
            newSubscription: newSubscription
        };
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`[AdminService] Erro ao alterar plano do cliente ID ${clientId}: ${error.message}`, error);
        throw error;
    }
}

/**
 * Envia uma mensagem em massa com mais opções de filtros.
 * @param {string} message - A mensagem a ser enviada.
 * @param {string} targetGroup - O grupo de destino ('all_active', 'expiring_soon', 'expired').
 * @returns {Promise<object>} Resultado da operação.
 */
async function sendBroadcastMessage(message, targetGroup = 'all_active') {
  if (!message || message.trim() === '') {
    throw { statusCode: 400, message: 'A mensagem não pode ser vazia.' };
  }
  try {
    const whereConditions = { phone: { [Op.ne]: null } };
    const today = new Date().toISOString().split('T')[0];

    switch (targetGroup) {
        case 'all_active':
            whereConditions.status = 'Ativo';
            break;
        case 'expiring_soon':
            const sevenDaysFromNow = new Date();
            sevenDaysFromNow.setDate(new Date().getDate() + 7);

            whereConditions.accessExpiresAt = {
                [Op.between]: [today, sevenDaysFromNow.toISOString().split('T')[0]]
            };
            whereConditions.accessLevel = { [Op.notIn]: ['gratuito', 'vitalicio_basico', 'vitalicio_avancado'] };
            break;
        case 'expired':
            whereConditions.status = { [Op.notIn]: ['Ativo', 'Aguardando Pagamento'] };
            whereConditions.accessExpiresAt = { [Op.lt]: today };
            break;
        default:
            throw { statusCode: 400, message: 'Grupo alvo inválido.' };
    }

    const clientsToSend = await Client.findAll({ where: whereConditions, attributes: ['id', 'phone'] });

    if (clientsToSend.length === 0) {
      return { message: `Nenhum cliente encontrado no grupo '${targetGroup}' para enviar a mensagem.`, sentCount: 0, failedCount: 0 };
    }
    
    let sentCount = 0;
    let failedCount = 0;
    const promises = clientsToSend.map(client =>
        sendWhatsappMessage(client.phone, message)
          .then(success => (success ? sentCount++ : failedCount++))
          .catch(() => failedCount++)
    );
    await Promise.all(promises);

    logger.info(`[AdminService] Transmissão para '${targetGroup}' concluída. Enviadas: ${sentCount}, Falhas: ${failedCount}.`);
    return { message: 'Transmissão concluída.', sentCount, failedCount, total: clientsToSend.length };
  } catch (error) {
    logger.error(`[AdminService] Erro ao enviar mensagem em massa para '${targetGroup}': ${error.message}`, error);
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

/**
 * Cria um novo cliente, conta financeira e assinatura, com mensagem customizada e onboarding proativo.
 * @param {object} clientData - Dados do novo cliente.
 * @returns {Promise<object>} O novo cliente criado.
 */
async function createClientAsAdmin(clientData) {
    const { name, email, phone, password, planId, customMessage } = clientData;
    if (!name || !phone || !password || !planId) {
        throw { statusCode: 400, message: 'Nome, telefone, senha e plano são obrigatórios.' };
    }
    const t = await sequelize.transaction();
    try {
        const normalizedPhone = normalizePhoneNumberToCanonical(phone);
        if (!normalizedPhone) {
            throw { statusCode: 400, message: 'Número de telefone inválido.' };
        }
        const lowerEmail = email ? email.toLowerCase().trim() : null;

        const whereClause = { [Op.or]: [{ phone: normalizedPhone }] };
        if (lowerEmail) {
            whereClause[Op.or].push({ email: lowerEmail });
        }
        const existingClient = await Client.findOne({ where: whereClause, transaction: t });
        if (existingClient) {
            throw { statusCode: 409, message: 'Telefone ou E-mail já cadastrado.' };
        }
        
        const newClient = await Client.create({
            name,
            email: lowerEmail,
            phone: normalizedPhone,
            passwordHash: password, // O hook do model fará a criptografia
            status: 'Aguardando Pagamento',
        }, { transaction: t });

        await FinancialAccount.create({
            clientId: newClient.id,
            accountName: 'Pessoal',
            accountType: 'PF',
            isDefault: true,
        }, { transaction: t });

        // A criação da assinatura já atualiza o status do cliente para 'Ativo'
        await subscriptionService.createSubscription(newClient.id, planId, null, 'Ativa', null, null, { transaction: t });

        await t.commit();
        logger.info(`[AdminService] Novo cliente ID ${newClient.id} criado pelo admin com plano ID ${planId}.`);
        
        // Dispara o onboarding proativo
        if (newClient.phone) {
            const welcomeMsg = customMessage && customMessage.trim() !== '' ? customMessage : null;
            await onboardingHandler.triggerOnboarding(newClient.phone, welcomeMsg);
            logger.info(`[AdminService] Onboarding proativo disparado para ${newClient.phone}.`);
        }

        const clientResponse = await Client.findByPk(newClient.id);
        return clientResponse.toJSON();
    } catch (error) {
        await t.rollback();
        logger.error(`[AdminService] Erro ao criar cliente pelo admin: ${error.message}`, { error });
        throw error;
    }
}

module.exports = {
  getAdminClientList,
  getDashboardMetrics,
  createCustomPlan,
  changeUserPlan,
  sendBroadcastMessage,
  getAffiliatesDashboard,
  getAllPlans,
  updatePlan,
  clearClientBalance,
  changeClientPhoneNumber,
  deleteClientByUser,
  createClientAsAdmin,
};
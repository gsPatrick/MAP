// src/features/Admin/admin.service.js
const { Client, Plan, Subscription, FinancialAccount, AffiliatePayout, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const subscriptionService = require('../Subscription/subscription.service');
const { sendWhatsappMessage, pinWhatsappMessage } = require('../../services/whatsappService');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
const { formatDate } = require('../../utils/formatters');
const onboardingHandler = require('../WhatsappHandler/onboarding.handler'); // Import para o trigger
const affiliateService = require('../Affiliate/affiliate.service'); // Importe o serviço de afiliados
const clientAuthService = require('../ClientAuth/clientAuth.service');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

/**
 * Gera uma senha aleatória legível (sem caracteres ambíguos).
 */
function generateRandomPassword(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

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
        // 'Inativo' (excluídos via soft-delete) ficam de fora.
        whereConditions.status = { [Op.notIn]: ['Ativo', 'Aguardando Pagamento', 'Inativo'] };
        whereConditions.accessExpiresAt = { [Op.lt]: today };
        break;
      default: // 'all' — não mostra clientes inativados (soft-delete)
        whereConditions.status = { [Op.ne]: 'Inativo' };
        break;
    }

    const { count, rows } = await Client.findAndCountAll({
      where: whereConditions,
      attributes: ['id', 'name', 'phone', 'email', 'status', 'accessLevel', 'accessExpiresAt', 'createdAt', 'lastActiveAt', 'lastLoginAt'],
      limit: parseInt(limit, 10),
      offset: offset,
      order: [['createdAt', 'DESC']],
      distinct: true,
    });

    const clientsJson = rows.map(client => client.toJSON());

    // Anexa o PLANO PENDENTE (escolhido no cadastro, ainda não pago) para exibição:
    // enquanto não paga, o accessLevel fica 'inadimplente'/sem plano, mas o plano
    // escolhido vive numa assinatura 'Pendente'.
    try {
      const ids = clientsJson.map(c => c.id);
      if (ids.length > 0) {
        const pendings = await Subscription.findAll({
          where: { clientId: { [Op.in]: ids }, status: 'Pendente' },
          include: ['plan'],
          order: [['createdAt', 'DESC']],
        });
        const byClient = {};
        for (const s of pendings) {
          if (!byClient[s.clientId] && s.plan) byClient[s.clientId] = { id: s.plan.id, name: s.plan.name };
        }
        clientsJson.forEach(c => {
          if (byClient[c.id]) {
            c.pendingPlanId = byClient[c.id].id;
            c.pendingPlanName = byClient[c.id].name;
          }
        });
      }
    } catch (e) {
      logger.warn(`[AdminService] Falha ao anexar plano pendente na listagem: ${e.message}`);
    }

    logger.info(`[AdminService] Listados ${rows.length} clientes para o painel de admin com filtro '${filter}'.`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      clients: clientsJson,
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
        accessLevel: { [Op.not]: ['gratuito', 'inadimplente', 'vitalicio_basico', 'vitalicio_avancado'] },
        accessExpiresAt: { [Op.lt]: today }
      }
    });
    const metrics = { totalClients, activeClients, plans: {}, needsPayment: expiredClients };
    planCounts.forEach(item => {
      metrics.plans[item.accessLevel] = parseInt(item.count, 10);
    });
    const allPlanLevels = ['gratuito', 'inadimplente', 'basico_mensal', 'basico_anual', 'avancado_mensal', 'avancado_anual', 'vitalicio_basico', 'vitalicio_avancado'];
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

    const wasActiveBefore = client.status === 'Ativo' && client.accessExpiresAt && new Date(client.accessExpiresAt) >= new Date();

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
      let messageToSend;
      const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
      let expiryWelcomePart = `Seu acesso agora está garantido até *${formatDate(newSubscription.endDate)}*.`;
      if (plan.durationDays > 7000) {
        expiryWelcomePart = "Você agora tem *acesso vitalício*! 🎉";
      }

      if (customMessage && customMessage.trim() !== '') {
        messageToSend = customMessage;
      } else if (wasActiveBefore) {
        messageToSend = `Olá, ${clientName}! ✨\n\nSua assinatura foi renovada com sucesso para o plano *${plan.name}* pelo nosso suporte.\n\n${expiryWelcomePart}\n\nContinue no controle! Qualquer dúvida, é só me chamar. 😉`;
      } else {
        messageToSend = `Olá, ${clientName}! ✨\n\nSua assinatura do plano *${plan.name}* foi ativada com sucesso pelo nosso suporte.\n\n${expiryWelcomePart}\n\nJá pode começar a usar todos os recursos. Qualquer dúvida, é só me chamar! 😉`;
      }

      await sendWhatsappMessage(client.phone, messageToSend);
      logger.info(`[AdminService] Mensagem de confirmação de mudança de plano enviada para ${client.phone}.`);

      // Se for uma ATIVAÇÃO nova (não renovação), dispara em seguida a 1ª etapa
      // do onboarding (nome/e-mail ou nome do perfil pessoal).
      if (!wasActiveBefore) {
        try {
          await onboardingHandler.triggerOnboarding(client.phone);
        } catch (obErr) {
          logger.warn(`[AdminService] Falha ao iniciar onboarding proativo para ${client.phone}: ${obErr.message}`);
        }
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
        whereConditions.accessLevel = { [Op.notIn]: ['gratuito', 'inadimplente', 'vitalicio_basico', 'vitalicio_avancado'] };
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
    // Busca afiliados que têm saldo ou que já indicaram alguém
    const affiliates = await Client.findAll({
      where: {
        [Op.or]: [
          { balance: { [Op.gt]: 0 } },
          { id: { [Op.in]: sequelize.literal(`(SELECT DISTINCT "referredByClientId" FROM "clients" WHERE "referredByClientId" IS NOT NULL)`) } }
        ]
      },
      attributes: ['id', 'name', 'email', 'phone', 'balance', 'affiliateCode', 'affiliateSlug', 'affiliateLinkClicks'],
      order: [['name', 'ASC']],
    });

    if (affiliates.length === 0) {
      return [];
    }

    const affiliateIds = affiliates.map(a => a.id);

    // Busca todos os indicados de uma vez para otimização
    const allReferrals = await Client.findAll({
      where: { referredByClientId: { [Op.in]: affiliateIds } },
      attributes: ['id', 'name', 'email', 'createdAt', 'referredByClientId'],
      include: [{
        model: Subscription,
        as: 'subscriptions',
        attributes: ['planId', 'status'],
        required: false, // LEFT JOIN
        include: [{
          model: Plan,
          as: 'plan',
          attributes: ['name', 'affiliateCommissionValue']
        }]
      }]
    });

    const dashboardData = affiliates.map(affiliate => {
      const myReferrals = allReferrals.filter(r => r.referredByClientId === affiliate.id);

      let totalEarnedHistorically = 0;
      const detailedReferrals = [];

      myReferrals.forEach(ref => {
        // Encontra a PRIMEIRA assinatura PAGA e ATIVA do indicado
        const firstPaidSubscription = ref.subscriptions
          .filter(sub => sub.status === 'Ativa' && sub.plan && parseFloat(sub.plan.affiliateCommissionValue) > 0)
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0]; // Ordena e pega a mais antiga

        let commissionAmount = 0;
        let planName = 'inadimplente'; // Padrão

        if (firstPaidSubscription) {
          commissionAmount = parseFloat(firstPaidSubscription.plan.affiliateCommissionValue);
          planName = firstPaidSubscription.plan.name;
          totalEarnedHistorically += commissionAmount;
        }

        detailedReferrals.push({
          id: ref.id,
          createdAt: ref.createdAt,
          referred: { name: ref.name },
          email: ref.email,
          plan: { name: planName },
          commissionAmount: commissionAmount
        });
      });

      const activeReferralsCount = myReferrals.filter(ref =>
        ref.subscriptions.some(sub => sub.status === 'Ativa')
      ).length;

      const totalClicks = affiliate.affiliateLinkClicks || 0;
      const conversionRate = totalClicks > 0 ? ((myReferrals.length / totalClicks) * 100).toFixed(2) : 0;

      return {
        ...affiliate.toJSON(),
        totalReferrals: myReferrals.length,
        activeReferrals: activeReferralsCount,
        totalEarned: totalEarnedHistorically,
        totalClicks,
        conversionRate: parseFloat(conversionRate),
        referrals: detailedReferrals.sort((a, b) => b.commissionAmount - a.commissionAmount),
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

/**
 * <<< FUNÇÃO MODIFICADA >>>
 * Zera o saldo de comissão E o histórico de indicados de um cliente afiliado.
 * @param {string|number} clientId - O ID do cliente a ser resetado.
 */
async function clearClientBalance(clientId) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      throw { statusCode: 404, message: 'Cliente não encontrado.' };
    }

    const oldBalance = parseFloat(client.balance);

    // Registra o SAQUE no histórico (status 'Pago') e zera o saldo.
    // NÃO desvincula os indicados (o histórico de indicações é preservado).
    if (oldBalance > 0) {
      await AffiliatePayout.create({
        affiliateClientId: clientId,
        amount: oldBalance,
        pixKey: client.asaasPayoutPixKey || null,
        status: 'Pago',
        paidAt: new Date(),
        notes: 'Pagamento registrado pelo admin',
      }, { transaction: t });
    }
    await client.update({ balance: 0.00 }, { transaction: t });

    await t.commit();

    logger.info(`[AdminService] Saque de afiliado pago: R$${oldBalance.toFixed(2)} para o cliente ID ${clientId} (saldo zerado, indicados preservados).`);

    if (client.phone && oldBalance > 0) {
      const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
      const message = `💰 *Comissão paga!* 💰\n\n` +
        `Olá, ${clientName}! Informamos que o pagamento da sua comissão no valor de *R$${oldBalance.toFixed(2).replace('.', ',')}* foi processado.\n\n` +
        `Seu saldo foi zerado e esse saque está registrado no seu histórico. Continue indicando e ganhando! 🚀`;
      await sendWhatsappMessage(client.phone, message).catch(err => logger.error(`[AdminService] Falha ao notificar pagamento de afiliado para ${client.phone}: ${err.message}`));
    }

  } catch (error) {
    await t.rollback();
    logger.error(`[AdminService] Erro ao zerar saldo e histórico do cliente ID ${clientId}: ${error.message}`, error);
    throw error;
  }
}


async function deleteClientByUser(clientId) {
  logger.warn(`[ADMIN SERVICE] Início da solicitação de EXCLUSÃO (soft-delete) para o Cliente ID: ${clientId}.`);
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      await t.rollback();
      throw { statusCode: 404, message: 'Cliente não encontrado para exclusão.' };
    }

    // Soft-delete: em vez de apagar permanentemente, inativamos o cliente.
    // Efeitos: deixa de aparecer na busca do admin, não recebe mais mensagens
    // do sistema (jobs filtram status 'Ativo') e perde acesso ao painel
    // (requireActiveSubscription bloqueia status 'Inativo'). Os dados ficam preservados.
    await client.update({ status: 'Inativo' }, { transaction: t });

    await t.commit();
    logger.info(`[ADMIN SERVICE] Cliente ID ${clientId} (${client.name || client.phone}) inativado (soft-delete) por um administrador.`);
    return true;
  } catch (error) {
    await t.rollback();
    logger.error(`[ADMIN SERVICE] Erro ao inativar cliente ID ${clientId}: ${error.message}`, { error });
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
  if (!name || !phone || !planId) {
    throw { statusCode: 400, message: 'Nome, telefone e plano são obrigatórios.' };
  }
  // Senha: usa a fornecida (se houver) ou gera uma aleatória. Em ambos os casos
  // a senha em texto é enviada ao cliente por WhatsApp logo após a criação.
  const plainPassword = (password && String(password).trim()) ? String(password).trim() : generateRandomPassword();
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

    const newAffiliateCode = await clientAuthService.generateUniqueAffiliateCode(name);

    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const newClient = await Client.create({
      name,
      email: lowerEmail,
      phone: normalizedPhone,
      passwordHash: hashedPassword,
      status: 'Aguardando Pagamento',
      affiliateCode: newAffiliateCode,
    }, { transaction: t });

    await FinancialAccount.create({
      clientId: newClient.id,
      accountName: 'Pessoal',
      accountType: 'PF',
      isDefault: true,
    }, { transaction: t });

    await subscriptionService.createSubscription(newClient.id, planId, null, 'Ativa', null, null, { transaction: t });

    await t.commit();
    logger.info(`[AdminService] Novo cliente ID ${newClient.id} (Afiliado: ${newAffiliateCode}) criado pelo admin com plano ID ${planId}.`);

    if (newClient.phone) {
      const welcomeMessage = customMessage && customMessage.trim() !== ''
        ? customMessage
        : `Olá, ${name.split(' ')[0]}! Bem-vindo(a) ao MAP no Controle. Sua conta foi ativada com sucesso.`;

      const dashboardUrl = "https://www.map-nocontrole.com.br/login";
      const loginMessage = `Para acessar o painel web, utilize:\n` +
        `🔗 *Link:* ${dashboardUrl}\n` +
        `📧 *E-mail:* ${lowerEmail || 'Não fornecido'}\n` +
        `🔑 *Senha:* ${plainPassword}\n\n` +
        `*Dica de segurança:* Recomendamos que você acesse o painel e troque sua senha.`;

      await sendWhatsappMessage(newClient.phone, welcomeMessage);
      await sendWhatsappMessage(newClient.phone, loginMessage);
      await affiliateService.sendAffiliateLinkNotification(newClient);
      await onboardingHandler.triggerOnboarding(newClient.phone);
      logger.info(`[AdminService] Sequência de mensagens de ativação e onboarding disparada para ${newClient.phone}.`);
    }

    const clientResponse = await Client.findByPk(newClient.id);
    return clientResponse.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`[AdminService] Erro ao criar cliente pelo admin: ${error.message}`, { error });
    throw error;
  }
}

async function getAdminStats() {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const totalUsers = await Client.count();
    const active7d = await Client.count({
      where: {
        lastActiveAt: { [Op.gte]: sevenDaysAgo }
      }
    });

    const inactive15d = await Client.count({
      where: {
        [Op.and]: [
          { lastActiveAt: { [Op.lt]: fifteenDaysAgo } },
          { lastActiveAt: { [Op.gte]: thirtyDaysAgo } }
        ]
      }
    });

    const stagnant30d = await Client.count({
      where: {
        [Op.or]: [
          { lastActiveAt: { [Op.lt]: thirtyDaysAgo } },
          { lastActiveAt: null }
        ]
      }
    });

    return { totalUsers, active7d, inactive15d, stagnant30d };
  } catch (error) {
    logger.error(`[AdminService] Erro ao buscar estatísticas do admin: ${error.message}`, error);
    throw new Error('Falha ao buscar estatísticas do painel admin.');
  }
}
/**
 * Confirma o pagamento de um cliente ATIVANDO o plano que ele JÁ escolheu no
 * cadastro (assinatura 'Pendente'). Não recebe planId — usa o plano pendente.
 * Reaproveita changeUserPlan (cria assinatura Ativa, libera acesso, envia WhatsApp
 * e dispara onboarding).
 */
async function confirmClientPayment(clientId) {
  const { Subscription } = require('../../database');
  const pending = await Subscription.findOne({
    where: { clientId, status: 'Pendente' },
    order: [['createdAt', 'DESC']],
  });
  if (!pending) {
    throw { statusCode: 400, status: 'fail', message: 'Este cliente não tem um plano pendente (escolhido no cadastro) para confirmar. Use "Alterar plano" para definir um manualmente.' };
  }
  const result = await changeUserPlan(clientId, pending.planId);
  // Encerra eventuais pendências remanescentes (já ativamos uma nova assinatura).
  await Subscription.update({ status: 'Cancelada' }, { where: { clientId, status: 'Pendente' } });
  return result;
}

module.exports = {
  getAdminClientList,
  getDashboardMetrics,
  createCustomPlan,
  changeUserPlan,
  confirmClientPayment,
  sendBroadcastMessage,
  getAffiliatesDashboard,
  getAllPlans,
  updatePlan,
  clearClientBalance,
  changeClientPhoneNumber,
  deleteClientByUser,
  createClientAsAdmin,
  getAdminStats,
};
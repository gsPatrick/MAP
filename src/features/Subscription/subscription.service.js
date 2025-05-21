// src/features/Subscription/subscription.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Cria uma nova assinatura para um cliente.
 * Atualiza o accessLevel e accessExpiresAt do Cliente com base no Plano.
 * @param {number} clientId
 * @param {number} planId
 * @param {string} startDate YYYY-MM-DD (opcional, default: hoje)
 * @param {string} status 'Ativa', 'Pendente', etc. (opcional, default: 'Ativa')
 * @param {string} externalSubscriptionId - Opcional: ID da assinatura na plataforma de pagamento
 * @returns {Promise<object>} A assinatura criada.
 */
async function createSubscription(clientId, planId, startDate = null, status = 'Ativa', externalSubscriptionId = null) {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const plan = await Plan.findByPk(planId, { transaction: t });
    if (!plan) {
      const error = new Error(`Plano com ID ${planId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    if (!plan.isActive && status === 'Ativa') { // Permite criar assinatura pendente para plano inativo, mas não ativa
        logger.warn(`[SUBSCRIPTION SERVICE] Tentativa de criar assinatura ATIVA para plano ID ${planId} que está inativo. Verifique o status do plano.`);
        // Poderia lançar erro ou ajustar o status da assinatura para 'Pendente'
        // Por ora, vamos permitir, mas logar. A lógica de ativação real (webhook) confirmaria.
    }

    const effectiveStartDate = startDate ? new Date(startDate) : new Date();
    const endDate = new Date(effectiveStartDate);
    endDate.setDate(endDate.getDate() + plan.durationDays);

    // Determinar o accessLevel do cliente com base no plano
    let clientAccessLevel = 'gratuito'; // Default
    let clientAccessExpiresAt = null;

    // Lógica para definir o accessLevel baseado no nome do plano ou no campo 'tier' do plano
    // Exemplo: Se o nome do plano for "Avançado Anual", o accessLevel será "avancado_anual"
    // Esta lógica assume que o `plan.name` ou `plan.tier` + `plan.durationDays` pode ser usado para determinar o `client.accessLevel`
    const planNameLower = plan.name.toLowerCase();
    const planTier = plan.tier || 'basico'; // Usa tier se existir, senão assume 'basico' por nome

    if (plan.durationDays > 7000) { // Considera "vitalício" para durações muito longas
        clientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
        clientAccessExpiresAt = null;
    } else if (plan.durationDays > 60) { // Anual
        clientAccessLevel = planTier === 'avancado' ? 'avancado_anual' : 'basico_anual';
        clientAccessExpiresAt = endDate.toISOString().split('T')[0];
    } else if (plan.durationDays > 0) { // Mensal (ou outra duração curta)
        clientAccessLevel = planTier === 'avancado' ? 'avancado_mensal' : 'basico_mensal';
        clientAccessExpiresAt = endDate.toISOString().split('T')[0];
    }
    
    // Se o status da nova assinatura for 'Ativa', atualiza o cliente
    if (status === 'Ativa') {
        // Se já existe uma assinatura ativa, idealmente ela seria marcada como 'Expirada' ou 'Cancelada'
        // Aqui, estamos sobrescrevendo o accessLevel. Para uma gestão mais fina,
        // seria necessário verificar assinaturas existentes.
        await client.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: clientAccessExpiresAt,
            status: 'Ativo' // Garante que o cliente está ativo se a assinatura está ativa
        }, { transaction: t });
        logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientId} atualizado para accessLevel: ${clientAccessLevel}, expiresAt: ${clientAccessExpiresAt}`);
    } else if (status === 'Pendente' && client.status === 'Ativo' && client.accessLevel === 'gratuito') {
        // Se o cliente está ativo e gratuito, e uma assinatura pendente é criada,
        // podemos mudar o status do cliente para 'Aguardando Pagamento'.
        await client.update({ status: 'Aguardando Pagamento' }, { transaction: t });
    }


    const newSubscriptionData = {
      clientId,
      planId,
      startDate: effectiveStartDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      status: status,
      autoRenew: plan.durationDays > 31, // Exemplo: renovar automaticamente planos mais longos que mensais
    };
    if (externalSubscriptionId) {
        newSubscriptionData.externalSubscriptionId = externalSubscriptionId;
    }

    const newSubscription = await Subscription.create(newSubscriptionData, { transaction: t });

    await t.commit();
    logger.info(`Assinatura ID ${newSubscription.id} criada para Cliente ID ${clientId} com Plano "${plan.name}" (ID ${planId}). Válida até ${newSubscription.endDate}. Status: ${status}.`);
    return newSubscription.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar assinatura para Cliente ID ${clientId}: ${error.message}`, { error, planId, startDate, status });
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
        status: 'Ativa', // Busca apenas as que estão explicitamente ativas no banco
        startDate: { [Op.lte]: today },
        endDate: { [Op.gte]: today },
      },
      include: [{ model: Plan, as: 'plan' }], // Inclui os detalhes do plano
      order: [['endDate', 'DESC']], // Pega a que expira mais tarde, em caso de sobreposição (raro)
    });

    if (subscription) {
      // logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientId} possui assinatura ativa (Plano: ${subscription.plan.name}), válida até ${subscription.endDate}.`);
    } else {
      // logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientId} não possui assinatura ativa na tabela Subscriptions.`);
    }
    return subscription ? subscription.toJSON() : null;
  } catch (error) {
    logger.error(`[SUBSCRIPTION SERVICE] Erro ao verificar assinatura ativa para Cliente ID ${clientId}: ${error.message}`, { error });
    // Não relança o erro diretamente para não quebrar fluxos que apenas verificam
    // A decisão de bloquear o usuário é do middleware ou do fluxo de negócio.
    return null; 
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
        throw error; // Relança para ser tratado pelo controller
    }
}

/**
 * Atualiza o status de uma assinatura. Usado por webhooks de pagamento.
 * @param {string} externalSubscriptionId - ID da assinatura na plataforma de pagamento.
 * @param {string} newStatus - Novo status ('Ativa', 'Cancelada', 'Expirada', 'Pagamento Falhou').
 * @param {string|null} newEndDate - Opcional: nova data de término se o status for 'Ativa' (renovação).
 * @returns {Promise<object|null>} A assinatura atualizada ou null.
 */
async function updateSubscriptionStatusByExternalId(externalSubscriptionId, newStatus, newEndDate = null) {
    const t = await sequelize.transaction();
    try {
        const subscription = await Subscription.findOne({
            where: { externalSubscriptionId },
            include: [{ model: Client, as: 'client' }, {model: Plan, as: 'plan'}],
            transaction: t
        });

        if (!subscription) {
            logger.warn(`[SUBSCRIPTION SERVICE] Assinatura com ID externo ${externalSubscriptionId} não encontrada para atualização de status.`);
            await t.rollback();
            return null;
        }

        const client = subscription.client;
        const plan = subscription.plan;
        if (!client || !plan) {
            logger.error(`[SUBSCRIPTION SERVICE] Cliente ou Plano não encontrado para a assinatura ${subscription.id}. Dados inconsistentes.`);
            await t.rollback();
            return null; // Ou lançar erro
        }
        
        const updateSubData = { status: newStatus };
        if (newStatus === 'Ativa' && newEndDate) {
            updateSubData.endDate = newEndDate;
            // Recalcular clientAccessLevel e clientAccessExpiresAt com base no plano da assinatura e nova data de fim
            let clientAccessLevel = 'gratuito';
            const planTier = plan.tier || 'basico';

            if (plan.durationDays > 7000) {
                clientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
            } else if (plan.durationDays > 60) {
                clientAccessLevel = planTier === 'avancado' ? 'avancado_anual' : 'basico_anual';
            } else if (plan.durationDays > 0) {
                clientAccessLevel = planTier === 'avancado' ? 'avancado_mensal' : 'basico_mensal';
            }

            await client.update({
                accessLevel: clientAccessLevel,
                accessExpiresAt: newEndDate, // Usa a nova data de término da assinatura
                status: 'Ativo'
            }, { transaction: t });
            logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${client.id} atualizado para accessLevel: ${clientAccessLevel}, expiresAt: ${newEndDate} devido à ativação/renovação da assinatura ${subscription.id}.`);

        } else if (newStatus === 'Cancelada' || newStatus === 'Expirada' || newStatus === 'Pagamento Falhou') {
            // Se esta era a ÚNICA assinatura ativa, reverter o cliente para 'gratuito'
            const otherActiveSubscriptions = await Subscription.count({
                where: {
                    clientId: client.id,
                    status: 'Ativa',
                    id: { [Op.ne]: subscription.id },
                    endDate: { [Op.gte]: new Date().toISOString().split('T')[0] }
                },
                transaction: t
            });

            if (otherActiveSubscriptions === 0) {
                await client.update({
                    accessLevel: 'gratuito',
                    accessExpiresAt: null,
                    // Não mudar o status do cliente para Inativo aqui, a menos que seja a política
                    // Status do cliente pode ser 'Pagamento Falhou' se for esse o caso.
                    status: newStatus === 'Pagamento Falhou' ? 'Pagamento Falhou' : client.status 
                }, { transaction: t });
                logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${client.id} revertido para 'gratuito' pois a assinatura ${subscription.id} foi ${newStatus}.`);
            }
        }

        await subscription.update(updateSubData, { transaction: t });
        await t.commit();
        logger.info(`[SUBSCRIPTION SERVICE] Status da assinatura ID ${subscription.id} (Externo: ${externalSubscriptionId}) atualizado para ${newStatus}.`);
        return subscription.reload({ include: [{ model: Client, as: 'client'}, {model: Plan, as: 'plan'}]}).then(s => s.toJSON());
    } catch (error) {
        await t.rollback();
        logger.error(`[SUBSCRIPTION SERVICE] Erro ao atualizar status da assinatura externa ${externalSubscriptionId}: ${error.message}`, { error });
        throw error;
    }
}


module.exports = {
  createSubscription,
  getActiveSubscription,
  getClientSubscriptions,
  updateSubscriptionStatusByExternalId, // Para webhooks
};
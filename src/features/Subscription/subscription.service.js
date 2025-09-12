// src/features/Subscription/subscription.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService');
const { formatDate, formatCurrency } = require('../../utils/formatters');

async function createSubscription(clientId, planId, startDate = null, status = 'Ativa', externalSubscriptionId = null, affiliateCode = null, options = {}) {
  const t = options.transaction || await sequelize.transaction();
  try {
    const clientInstance = await Client.findByPk(clientId, { transaction: t });
    if (!clientInstance) {
      const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    if (affiliateCode && !clientInstance.referredByClientId) {
      const referrer = await Client.findOne({ 
          where: { 
            affiliateCode: affiliateCode.toUpperCase(),
            id: { [Op.ne]: clientInstance.id }
          }, 
          transaction: t 
      });
      if (referrer) {
        await clientInstance.update({ referredByClientId: referrer.id }, { transaction: t });
        logger.info(`[SubscriptionService] Cliente ID ${clientId} foi indicado pelo afiliado ID ${referrer.id} (código: ${affiliateCode}).`);
      } else {
        logger.warn(`[SubscriptionService] Código de afiliado "${affiliateCode}" inválido ou não encontrado.`);
      }
    }

    const plan = await Plan.findByPk(planId, { transaction: t });
    if (!plan) {
      const error = new Error(`Plano com ID ${planId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const effectiveStartDate = startDate ? new Date(startDate) : new Date();
    const endDate = new Date(effectiveStartDate);
    endDate.setDate(endDate.getDate() + plan.durationDays);

    let clientAccessLevel = 'gratuito';
    let clientAccessExpiresAt = null;
    const planTier = plan.tier || 'basico';

    if (plan.durationDays > 7000) {
        clientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
        clientAccessExpiresAt = null;
    } else if (plan.durationDays > 60) {
        clientAccessLevel = planTier === 'avancado' ? 'avancado_anual' : 'basico_anual';
        clientAccessExpiresAt = endDate.toISOString().split('T')[0];
    } else if (plan.durationDays > 0) {
        clientAccessLevel = planTier === 'avancado' ? 'avancado_mensal' : 'basico_mensal';
        clientAccessExpiresAt = endDate.toISOString().split('T')[0];
    }
    
    // Esta verificação agora é usada apenas para a mensagem de boas-vindas
    const previousPaidSubscriptionsCount = await Subscription.count({
        where: { clientId: clientId, status: 'Ativa' },
        transaction: t
    });

    if (status === 'Ativa') {
        await clientInstance.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: clientAccessExpiresAt,
            status: 'Ativo'
        }, { transaction: t });
    } else if (status === 'Pendente' && clientInstance.status === 'Ativo' && clientInstance.accessLevel === 'gratuito') {
        await clientInstance.update({ status: 'Aguardando Pagamento' }, { transaction: t });
    }

    const newSubscriptionData = {
      clientId,
      planId,
      startDate: effectiveStartDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      status: status,
      autoRenew: plan.durationDays > 31,
    };
    if (externalSubscriptionId) {
        newSubscriptionData.externalSubscriptionId = externalSubscriptionId;
    }

    const newSubscription = await Subscription.create(newSubscriptionData, { transaction: t });

    if (status === 'Ativa') {
        const referredClient = await Client.findByPk(clientId, { transaction: t });
        if (referredClient.referredByClientId && plan.affiliateCommissionValue > 0) {
            const affiliateClient = await Client.findByPk(referredClient.referredByClientId, { transaction: t });
            if (affiliateClient) {
                await affiliateClient.increment('balance', { by: plan.affiliateCommissionValue, transaction: t });
                logger.info(`Comissão de ${formatCurrency(plan.affiliateCommissionValue)} creditada ao afiliado ID ${affiliateClient.id}.`);
            }
        }
    }

    if (!options.transaction) {
      await t.commit(); 
    }

    // A mensagem de boas-vindas foi movida para o 'updateSubscriptionStatusByExternalId'
    // que é chamado pelo webhook, garantindo que a mensagem só seja enviada após a confirmação do pagamento.

    logger.info(`Assinatura ID ${newSubscription.id} criada para Cliente ID ${clientId}. Status: ${status}.`);
    return newSubscription.toJSON();
  } catch (error) {
    if (t && !t.finished && !options.transaction) await t.rollback();
    logger.error(`Erro ao criar assinatura: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

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
    return subscription ? subscription.toJSON() : null;
  } catch (error) {
    logger.error(`[SUBSCRIPTION SERVICE] Erro ao verificar assinatura ativa: ${error.message}`, { error });
    return null; 
  }
}

async function getClientSubscriptions(clientId) {
    try {
        const subscriptions = await Subscription.findAll({
            where: { clientId },
            include: [{ model: Plan, as: 'plan' }],
            order: [['startDate', 'DESC']]
        });
        return subscriptions.map(sub => sub.toJSON());
    } catch (error) {
        logger.error(`Erro ao listar assinaturas do cliente ${clientId}: ${error.message}`, { error });
        throw error;
    }
}

async function updateSubscriptionStatusByExternalId(externalSubscriptionId, newStatus, newEndDate = null, subscriptionId = null) {
    const t = await sequelize.transaction();
    try {
        if (!externalSubscriptionId && !subscriptionId) {
            logger.warn(`[SUBSCRIPTION SERVICE] Tentativa de atualizar status sem um ID externo ou ID de assinatura.`);
            await t.rollback();
            return null;
        }

        const whereClause = subscriptionId 
          ? { id: subscriptionId } 
          : { externalSubscriptionId: externalSubscriptionId };
        
        logger.info(`[SUBSCRIPTION SERVICE] Buscando assinatura por ${subscriptionId ? `ID direto '${subscriptionId}'` : `ID externo '${externalSubscriptionId}'`} para atualização.`);

        const subscription = await Subscription.findOne({
            where: whereClause,
            include: [
                { model: Client, as: 'client' },
                { model: Plan, as: 'plan' }
            ],
            transaction: t
        });

        if (!subscription) {
            logger.warn(`[SUBSCRIPTION SERVICE] Assinatura não encontrada para atualização usando a cláusula:`, whereClause);
            await t.rollback();
            return null;
        }

        const clientInstance = subscription.client;
        const plan = subscription.plan;
        const oldClientStatus = clientInstance.status;
        const oldSubscriptionStatus = subscription.status;

        if (!clientInstance || !plan) {
            logger.error(`[SUBSCRIPTION SERVICE] Dados inconsistentes para a assinatura ${subscription.id}.`);
            await t.rollback();
            return null;
        }

        const updateSubData = { status: newStatus };
        let clientAccessLevel = clientInstance.accessLevel;
        let clientAccessExpiresAt = clientInstance.accessExpiresAt;
        let clientStatus = clientInstance.status;

        if (newStatus === 'Ativa' && oldSubscriptionStatus !== 'Ativa') {
            if (clientInstance.referredByClientId && plan.affiliateCommissionValue > 0) {
                const affiliateClient = await Client.findByPk(clientInstance.referredByClientId, { transaction: t });
                if (affiliateClient) {
                    await affiliateClient.increment('balance', { by: plan.affiliateCommissionValue, transaction: t });
                    logger.info(`Comissão de ${formatCurrency(plan.affiliateCommissionValue)} creditada ao afiliado ID ${affiliateClient.id}.`);
                }
            }

            // --- INÍCIO DA CORREÇÃO ---
            let calculatedEndDate = newEndDate;
            if (!calculatedEndDate) {
                // Se o webhook não fornecer uma data de expiração (renovação), calcula com base na data de hoje
                const effectiveStartDate = new Date();
                const endDate = new Date(effectiveStartDate);
                endDate.setDate(endDate.getDate() + plan.durationDays);
                calculatedEndDate = endDate.toISOString().split('T')[0];
            }
            
            updateSubData.endDate = calculatedEndDate; // GARANTIDO NOT NULL

            const planTier = plan.tier || 'basico';
            
            if (plan.durationDays > 7000) {
              clientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
              clientAccessExpiresAt = null; // Vitalício
            } else { 
                // Para planos anuais e mensais
                clientAccessLevel = planTier === 'avancado' 
                    ? (plan.durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')
                    : (plan.durationDays > 60 ? 'basico_anual' : 'basico_mensal');
                clientAccessExpiresAt = calculatedEndDate; // Usa a data calculada/fornecida
            }
            clientStatus = 'Ativo';
            // --- FIM DA CORREÇÃO ---

        } else if (['Cancelada', 'Expirada', 'Pagamento Falhou'].includes(newStatus)) {
            const otherActiveSubscriptions = await Subscription.count({
                where: { clientId: subscription.clientId, status: 'Ativa', id: {[Op.ne]: subscription.id} }, transaction: t
            });
            if (otherActiveSubscriptions === 0) {
                clientAccessLevel = 'gratuito';
                clientAccessExpiresAt = null;
                // Mantém o status 'Ativo' se o pagamento falhou, mas o plano é rebaixado.
                // Isso evita que o usuário seja bloqueado imediatamente.
                clientStatus = (newStatus === 'Pagamento Falhou') ? 'Pagamento Falhou' : 'Inativo';
            }
        }
        
        await clientInstance.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: clientAccessExpiresAt,
            status: clientStatus
        }, { transaction: t });
        
        await subscription.update(updateSubData, { transaction: t });
        
        await t.commit();
        logger.info(`[SUBSCRIPTION SERVICE] Status da assinatura ID ${subscription.id} atualizado para ${newStatus}.`);

        if (newStatus === 'Ativa' && oldSubscriptionStatus !== 'Ativa' && clientInstance.phone) {
            const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Olá';
            
            const isRenewal = oldClientStatus === 'Inativo' || oldClientStatus === 'Pagamento Falhou';
            
            let welcomeMessage = isRenewal
                ? `Uhuul, que bom te ter de volta, ${clientName}! 🎉\n\nSua assinatura do plano *${plan.name}* foi renovada com sucesso e seu acesso total já está liberado.\n\nContinue no controle! 💪`
                : `Ebaaa, ${clientName}! 🥳\n\nSua assinatura do plano *${plan.name}* foi ativada com sucesso.\n\nSeu acesso está garantido. Para começar, que tal me dizer "oi"?`;
            
            try {
                await sendWhatsappMessage(clientInstance.phone, welcomeMessage);
                logger.info(`[SUBSCRIPTION SERVICE] Mensagem de ${isRenewal ? 'RENOVAÇÃO' : 'ativação'} enviada.`);
            } catch (whatsappError) {
                logger.error(`[SUBSCRIPTION SERVICE] FALHA AO ENVIAR MENSAGEM: ${whatsappError.message}`);
            }
        }
        
        return subscription.reload({ include: ['client', 'plan'] });

    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`[SUBSCRIPTION SERVICE] Erro ao atualizar status da assinatura: ${error.message}`, { error });
        throw error;
    }
}

module.exports = {
  createSubscription,
  getActiveSubscription,
  getClientSubscriptions,
  updateSubscriptionStatusByExternalId,
};
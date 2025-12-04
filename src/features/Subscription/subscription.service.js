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
            externalSubscriptionId: externalSubscriptionId
        };

        const subscription = await Subscription.create(newSubscriptionData, { transaction: t });

        if (!options.transaction) await t.commit();

        logger.info(`[SubscriptionService] Assinatura criada para cliente ${clientId} (Plano: ${planId}, Status: ${status}).`);
        return subscription;

    } catch (error) {
        if (!options.transaction) await t.rollback();
        logger.error(`[SubscriptionService] Erro ao criar assinatura: ${error.message}`, { error });
        throw error;
    }
}

async function getActiveSubscription(clientId) {
    try {
        const subscription = await Subscription.findOne({
            where: { clientId, status: 'Ativa' },
            include: [{ model: Plan, as: 'plan' }],
            order: [['createdAt', 'DESC']]
        });
        return subscription;
    } catch (error) {
        logger.error(`[SubscriptionService] Erro ao buscar assinatura ativa do cliente ${clientId}: ${error.message}`);
        throw error;
    }
}

async function getClientSubscriptions(clientId) {
    try {
        const subscriptions = await Subscription.findAll({
            where: { clientId },
            include: [{ model: Plan, as: 'plan' }],
            order: [['createdAt', 'DESC']]
        });
        return subscriptions;
    } catch (error) {
        logger.error(`[SubscriptionService] Erro ao buscar assinaturas do cliente ${clientId}: ${error.message}`);
        throw error;
    }
}

async function updateSubscriptionStatusByExternalId(externalId, newStatus, options = {}) {
    const t = await sequelize.transaction();
    try {
        const subscription = await Subscription.findOne({
            where: { externalSubscriptionId: externalId },
            include: [{ model: Plan, as: 'plan' }],
            transaction: t
        });

        if (!subscription) {
            throw new Error(`Assinatura com ID externo ${externalId} não encontrada.`);
        }

        const oldSubscriptionStatus = subscription.status;
        const clientInstance = await Client.findByPk(subscription.clientId, { transaction: t });
        const oldClientStatus = clientInstance.status;
        const plan = subscription.plan;

        const updateSubData = { status: newStatus };
        let clientAccessLevel = clientInstance.accessLevel;
        let clientAccessExpiresAt = clientInstance.accessExpiresAt;
        let clientStatus = clientInstance.status;

        if (newStatus === 'Ativa') {
            let calculatedEndDate = subscription.endDate;
            const durationDays = Number(plan.durationDays);

            // Se estava expirada ou cancelada, ou se é uma renovação, recalculamos a data de fim
            if (oldSubscriptionStatus !== 'Ativa' || new Date(subscription.endDate) < new Date()) {
                const effectiveStartDate = new Date();
                const endDate = new Date(effectiveStartDate);
                endDate.setDate(endDate.getDate() + durationDays);
                calculatedEndDate = endDate.toISOString().split('T')[0];
            }

            updateSubData.endDate = calculatedEndDate;

            const planTier = plan.tier || 'basico';
            logger.info(`[SubscriptionService] Atualizando nível de acesso. PlanTier: ${planTier}, DurationDays: ${durationDays}`);

            if (durationDays > 7000) {
                clientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
                clientAccessExpiresAt = null; // Vitalício
            } else {
                // Para planos anuais e mensais
                clientAccessLevel = planTier === 'avancado'
                    ? (durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')
                    : (durationDays > 60 ? 'basico_anual' : 'basico_mensal');
                clientAccessExpiresAt = calculatedEndDate;
            }
            clientStatus = 'Ativo';

            logger.info(`[SubscriptionService] Novo AccessLevel: ${clientAccessLevel}, ExpiresAt: ${clientAccessExpiresAt}`);

        } else if (['Cancelada', 'Expirada', 'Pagamento Falhou'].includes(newStatus)) {
            const otherActiveSubscriptions = await Subscription.count({
                where: { clientId: subscription.clientId, status: 'Ativa', id: { [Op.ne]: subscription.id } }, transaction: t
            });
            if (otherActiveSubscriptions === 0) {
                clientAccessLevel = 'gratuito';
                clientAccessExpiresAt = null;
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
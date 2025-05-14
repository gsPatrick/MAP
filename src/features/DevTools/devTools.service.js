// src/features/DevTools/devTools.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const logger =require('../../utils/logger');

async function activateClientSubscriptionForTesting(clientId, planId = null, daysOverride = null) {
    const t = await sequelize.transaction();
    try {
        const client = await Client.findByPk(clientId, { transaction: t });
        if (!client) {
            throw new Error(`Cliente com ID ${clientId} não encontrado.`);
        }

        let targetPlanId = planId;
        if (!targetPlanId) {
            const defaultPlan = await Plan.findOne({ where: { isActive: true }, order: [['price', 'ASC']], transaction: t });
            if (!defaultPlan) {
                throw new Error('Nenhum plano ativo encontrado para usar como padrão.');
            }
            targetPlanId = defaultPlan.id;
            logger.info(`[DEV-TOOLS] Nenhum planId fornecido para cliente ${clientId}. Usando plano padrão ID: ${targetPlanId}`);
        }

        const plan = await Plan.findByPk(targetPlanId, { transaction: t });
        if (!plan) {
            throw new Error(`Plano com ID ${targetPlanId} não encontrado.`);
        }

        // Cancela assinaturas ativas existentes para este cliente, para evitar duplicidade
        const existingActiveSubscriptions = await Subscription.findAll({
            where: { clientId: clientId, status: 'Ativa' },
            transaction: t
        });

        const todayForCancellation = new Date().toISOString().split('T')[0];
        for (const sub of existingActiveSubscriptions) {
            await sub.update({ status: 'Cancelada', endDate: todayForCancellation }, { transaction: t });
            logger.info(`[DEV-TOOLS] Assinatura ativa anterior (ID: ${sub.id}) para cliente ${clientId} cancelada.`);
        }

        const startDate = new Date();
        const endDate = new Date(startDate);
        const durationDays = daysOverride !== null && daysOverride > 0 ? daysOverride : plan.durationDays;
        endDate.setDate(startDate.getDate() + durationDays);

        const newSubscription = await Subscription.create({
            clientId,
            planId: targetPlanId,
            startDate: startDate.toISOString().split('T')[0],
            endDate: endDate.toISOString().split('T')[0],
            status: 'Ativa',
            autoRenew: plan.durationDays > 31 ? true : false, // Lógica simples de autoRenew
        }, { transaction: t });

        logger.info(`[DEV-TOOLS] Nova assinatura de teste (ID: ${newSubscription.id}) criada para Cliente ID ${clientId} com Plano ID ${targetPlanId}. Válida por ${durationDays} dias, até ${newSubscription.endDate}.`);

        // Se o cliente estava Aguardando Pagamento ou Inativo, atualiza para Ativo.
        if (client.status === 'Aguardando Pagamento' || client.status === 'Pagamento Falhou' || client.status === 'Inativo') {
            await client.update({ status: 'Ativo' }, { transaction: t });
            logger.info(`[DEV-TOOLS] Status do cliente ${clientId} atualizado para Ativo.`);
        }

        await t.commit();
        return { client: client.toJSON(), subscription: newSubscription.toJSON(), plan: plan.toJSON() };

    } catch (error) {
        await t.rollback();
        logger.error(`[DEV-TOOLS] Erro ao ativar assinatura de teste para cliente ${clientId}: ${error.message}`, { error });
        throw error;
    }
}

module.exports = {
    activateClientSubscriptionForTesting,
};
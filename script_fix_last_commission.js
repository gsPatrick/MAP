// script_fix_last_commission.js
/**
 * Este script identifica a última assinatura com indicação que pode ter falhado 
 * na geração de comissão devido ao bug do client.id vs subscription.
 * 
 * Para rodar: node script_fix_last_commission.js
 */
const { Client, Subscription, Plan, sequelize } = require('./src/database');
const affiliateService = require('./src/features/Affiliate/affiliate.service');
const logger = require('./src/utils/logger');
const { Op } = require('sequelize');

async function repair() {
    const transaction = await sequelize.transaction();
    try {
        console.log('--- Iniciando Reparo de Comissão ---');

        // 1. Busca a última assinatura ativa que veio de uma indicação
        const lastSub = await Subscription.findOne({
            where: { status: 'Ativa' },
            include: [
                {
                    model: Client,
                    as: 'client',
                    where: { referredByClientId: { [Op.ne]: null } },
                    required: true
                },
                { model: Plan, as: 'plan' }
            ],
            order: [['createdAt', 'DESC']],
            transaction
        });

        if (!lastSub) {
            console.log('Nenhuma assinatura com indicação encontrada para reparar.');
            await transaction.rollback();
            return;
        }

        console.log(`Candidata a reparo: Sub ID ${lastSub.id} (Cliente: ${lastSub.client.name}, Indicador ID: ${lastSub.client.referredByClientId})`);

        // 2. Chama a lógica de processamento de comissão (com a correção já aplicada ou chamando diretamente)
        // Nota: Como acabamos de salvar o código corrigido, podemos chamar a função do serviço.
        await affiliateService.processNewSubscriptionForAffiliate(lastSub, transaction);

        await transaction.commit();
        console.log('--- Reparo concluído com sucesso! Se a comissão já existia, nada foi alterado. ---');

    } catch (error) {
        if (transaction) await transaction.rollback();
        console.error('Erro durante o reparo:', error);
    } finally {
        process.exit();
    }
}

repair();

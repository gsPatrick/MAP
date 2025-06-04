// src/features/Subscription/subscription.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService');
const { formatDate } = require('../../utils/formatters');

async function createSubscription(clientId, planId, startDate = null, status = 'Ativa', externalSubscriptionId = null) {
  const t = await sequelize.transaction();
  try {
    const clientInstance = await Client.findByPk(clientId, { transaction: t });
    if (!clientInstance) {
      const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
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
    
    // Verifica se o cliente já teve QUALQUER assinatura antes desta
    const previousSubscriptionsCount = await Subscription.count({
        where: { clientId: clientId },
        transaction: t // Importante para consistência na transação
    });

    if (status === 'Ativa') {
        await clientInstance.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: clientAccessExpiresAt,
            status: 'Ativo'
        }, { transaction: t });
        logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientId} atualizado para accessLevel: ${clientAccessLevel}, expiresAt: ${clientAccessExpiresAt}`);
    } else if (status === 'Pendente' && clientInstance.status === 'Ativo' && clientInstance.accessLevel === 'gratuito') {
        await clientInstance.update({ status: 'Aguardando Pagamento' }, { transaction: t });
    }

    const newSubscriptionData = {
      clientId,
      planId,
      startDate: effectiveStartDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      status: status,
      autoRenew: plan.durationDays > 31, // Exemplo
    };
    if (externalSubscriptionId) {
        newSubscriptionData.externalSubscriptionId = externalSubscriptionId;
    }

    const newSubscription = await Subscription.create(newSubscriptionData, { transaction: t });

    await t.commit(); 

    // === LÓGICA DE MENSAGEM DE BOAS-VINDAS (APENAS SE ESTA É A PRIMEIRA ASSINATURA CRIADA PARA O CLIENTE) ===
    if (status === 'Ativa' && clientInstance.phone && previousSubscriptionsCount === 0) {
        const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Cliente';
        const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
        
        let expiryWelcomePart = `Seu acesso está válido até ${formatDate(newSubscription.endDate)}.`;
        if (clientAccessLevel.includes('vitalicio')) {
            expiryWelcomePart = "Você garantiu acesso vitalício!";
        }

        const welcomeMessage = `🎉 Olá ${clientName}! Seja muito bem-vindo(a) ao MAP no Controle!\n\nQue demais que você garantiu seu acesso ao nosso plano *${plan.name}*!\n\n${expiryWelcomePart}\n\nPara começar, que tal me dizer "oi" por aqui para darmos o pontapé inicial na organização? Se preferir, você também já pode acessar nossa plataforma em https://${platformUrl}.\n\nEstou pronto para te ajudar a organizar tudo! 🚀`;
        try {
          await sendWhatsappMessage(clientInstance.phone, welcomeMessage);
          logger.info(`[SUBSCRIPTION SERVICE] Mensagem de boas-vindas (primeira assinatura) enviada para o cliente ID ${clientId} (Plano: ${plan.name}).`);
        } catch (whatsappError) {
          logger.error(`[SUBSCRIPTION SERVICE] Falha ao enviar mensagem de boas-vindas para o cliente ID ${clientId}: ${whatsappError.message}`);
        }
    }
    // === FIM DA LÓGICA DE MENSAGEM DE BOAS-VINDAS ===

    logger.info(`Assinatura ID ${newSubscription.id} criada para Cliente ID ${clientId} com Plano "${plan.name}" (ID ${planId}). Válida até ${newSubscription.endDate}. Status: ${status}.`);
    return newSubscription.toJSON();
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao criar assinatura para Cliente ID ${clientId}: ${error.message}`, { error, planId, startDate, status });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getActiveSubscription(clientId) {
  // ... (código inalterado)
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
    logger.error(`[SUBSCRIPTION SERVICE] Erro ao verificar assinatura ativa para Cliente ID ${clientId}: ${error.message}`, { error });
    return null; 
  }
}

async function getClientSubscriptions(clientId) {
    // ... (código inalterado)
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


async function updateSubscriptionStatusByExternalId(externalSubscriptionId, newStatus, newEndDate = null) {
    const t = await sequelize.transaction();
    try {
        const subscription = await Subscription.findOne({
            where: { externalSubscriptionId },
            include: [
                { model: Client, as: 'client' },
                { model: Plan, as: 'plan' }
            ]
        });

        if (!subscription) {
            logger.warn(`[SUBSCRIPTION SERVICE] Assinatura com ID externo ${externalSubscriptionId} não encontrada para atualização de status.`);
            return null;
        }

        const clientInstance = subscription.client;
        const plan = subscription.plan;

        if (!clientInstance || !plan) {
            logger.error(`[SUBSCRIPTION SERVICE] Cliente ou Plano não encontrado para a assinatura ${subscription.id}. Dados inconsistentes.`);
            return null;
        }
        
        const updateSubData = { status: newStatus };
        let finalClientAccessLevel = clientInstance.accessLevel;
        let finalClientAccessExpiresAt = clientInstance.accessExpiresAt;

        if (newStatus === 'Ativa' && newEndDate) {
            updateSubData.endDate = newEndDate; // Atualiza a data de fim da ASSINATURA
            const planTier = plan.tier || 'basico';

            if (plan.durationDays > 7000) {
                finalClientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
                finalClientAccessExpiresAt = null;
            } else if (plan.durationDays > 0) {
                finalClientAccessLevel = planTier === 'avancado' 
                    ? (plan.durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')
                    : (plan.durationDays > 60 ? 'basico_anual' : 'basico_mensal');
                finalClientAccessExpiresAt = newEndDate;
            }

            await clientInstance.update({
                accessLevel: finalClientAccessLevel,
                accessExpiresAt: finalClientAccessExpiresAt,
                status: 'Ativo'
            }, { transaction: t });
            logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientInstance.id} atualizado para accessLevel: ${finalClientAccessLevel}, expiresAt: ${finalClientAccessExpiresAt} devido à ativação/renovação da assinatura ${subscription.id}.`);

        } else if (['Cancelada', 'Expirada', 'Pagamento Falhou'].includes(newStatus)) {
            const otherActiveSubscriptions = await Subscription.count({
                where: {
                    clientId: clientInstance.id,
                    status: 'Ativa',
                    id: { [Op.ne]: subscription.id },
                    endDate: { [Op.gte]: new Date().toISOString().split('T')[0] }
                },
                transaction: t
            });

            if (otherActiveSubscriptions === 0) {
                finalClientAccessLevel = 'gratuito';
                finalClientAccessExpiresAt = null;
                await clientInstance.update({
                    accessLevel: finalClientAccessLevel,
                    accessExpiresAt: finalClientAccessExpiresAt,
                    status: newStatus === 'Pagamento Falhou' ? 'Pagamento Falhou' : clientInstance.status 
                }, { transaction: t });
                logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientInstance.id} revertido para 'gratuito' pois a assinatura ${subscription.id} foi ${newStatus}.`);
            }
        }

        await subscription.update(updateSubData, { transaction: t });
        await t.commit();

        // === LÓGICA DE MENSAGEM DE RENOVAÇÃO/REATIVAÇÃO SIMPLIFICADA ===
        // Se o novo status é 'Ativa' E esta função foi chamada (o que implica que a assinatura já existia),
        // E o cliente tem telefone, enviamos a mensagem de renovação.
        if (newStatus === 'Ativa' && clientInstance.phone) {
            // Verifica se o cliente tinha ALGUMA assinatura ANTES desta específica ser criada.
            // Se sim, esta ativação é tratada como uma renovação/reativação de um serviço já conhecido.
            const totalSubscriptionsForClient = await Subscription.count({
                 where: { clientId: clientInstance.id }
            });

            // Se o cliente tem mais de uma assinatura OU se esta assinatura não é a primeira que ele já teve
            // (considerando que `createSubscription` lida com a "primeiríssima" mensagem),
            // então esta ativação é uma renovação/reativação.
            // A condição `subscription.id` garante que estamos falando da assinatura que acabou de ser atualizada.
            // E `totalSubscriptionsForClient > 0` (ou `totalSubscriptionsForClient > 1` se a lógica de boas vindas de createSubscription for exata sobre "primeira assinatura")
            // Mas para simplificar: se updateSubscriptionStatusByExternalId é chamado e ativa, é uma continuação.
            
            // Se esta função foi chamada, a assinatura `subscription.id` já existia.
            // Portanto, qualquer ativação aqui é uma "renovação" ou "reativação" do serviço.
            const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Cliente';
            let expiryMessagePart = `Seu acesso agora está garantido até ${formatDate(finalClientAccessExpiresAt)}.`;
            if (finalClientAccessLevel.includes('vitalicio')) {
                expiryMessagePart = "Seu acesso vitalício continua firme e forte!";
            }
            
            const renewalMessage = `🥳 Olá ${clientName}! Boas notícias!\n\nSua assinatura do plano *${plan.name}* foi atualizada com sucesso!\n\n${expiryMessagePart}\n\nAgradecemos por continuar conosco nessa jornada de organização e controle. Vamos juntos a mais um período de sucesso! 💪`;
            try {
                await sendWhatsappMessage(clientInstance.phone, renewalMessage);
                logger.info(`[SUBSCRIPTION SERVICE] Mensagem de atualização/renovação enviada para o cliente ID ${clientInstance.id} (Plano: ${plan.name}).`);
            } catch (whatsappError) {
                logger.error(`[SUBSCRIPTION SERVICE] Falha ao enviar mensagem de atualização/renovação para o cliente ID ${clientInstance.id}: ${whatsappError.message}`);
            }
        }
        // === FIM DA LÓGICA DE MENSAGEM ===

        logger.info(`[SUBSCRIPTION SERVICE] Status da assinatura ID ${subscription.id} (Externo: ${externalSubscriptionId}) atualizado para ${newStatus}.`);
        const reloadedSubscription = await Subscription.findByPk(subscription.id, {
            include: [{ model: Client, as: 'client'}, {model: Plan, as: 'plan'}]
        });
        return reloadedSubscription ? reloadedSubscription.toJSON() : null;

    } catch (error) {
        if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
        logger.error(`[SUBSCRIPTION SERVICE] Erro ao atualizar status da assinatura externa ${externalSubscriptionId}: ${error.message}`, { error });
        throw error;
    }
}

module.exports = {
  createSubscription,
  getActiveSubscription,
  getClientSubscriptions,
  updateSubscriptionStatusByExternalId,
};
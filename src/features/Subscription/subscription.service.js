// src/features/Subscription/subscription.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService'); // <--- ADICIONADO
const { formatDate } = require('../../utils/formatters'); // <--- ADICIONADO

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
    if (!plan.isActive && status === 'Ativa') {
        logger.warn(`[SUBSCRIPTION SERVICE] Tentativa de criar assinatura ATIVA para plano ID ${planId} que está inativo. Verifique o status do plano.`);
    }

    const effectiveStartDate = startDate ? new Date(startDate) : new Date();
    const endDate = new Date(effectiveStartDate);
    endDate.setDate(endDate.getDate() + plan.durationDays);

    let clientAccessLevel = 'gratuito';
    let clientAccessExpiresAt = null;

    const planNameLower = plan.name.toLowerCase();
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
        await client.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: clientAccessExpiresAt,
            status: 'Ativo'
        }, { transaction: t });
        logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientId} atualizado para accessLevel: ${clientAccessLevel}, expiresAt: ${clientAccessExpiresAt}`);
    } else if (status === 'Pendente' && client.status === 'Ativo' && client.accessLevel === 'gratuito') {
        await client.update({ status: 'Aguardando Pagamento' }, { transaction: t });
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

    await t.commit(); // Commit da transação ANTES de enviar notificações

    // === INÍCIO DA LÓGICA DE MENSAGEM DE BOAS-VINDAS ===
    if (status === 'Ativa' && client.phone) {
      // Verificar se o cliente JÁ TEVE alguma assinatura que FOI 'Ativa' ANTES desta.
      // Esta verificação considera que uma assinatura 'Ativa' implica um plano pago ou um trial significativo.
      // Se houver distinção entre planos pagos e gratuitos/trial, essa lógica pode ser refinada
      // verificando o `plan.price` ou um campo `isTrial` no plano/assinatura.
      const previousPaidActiveSubscriptionsCount = await Subscription.count({
        where: {
          clientId: clientId,
          status: 'Ativa',
          id: { [Op.ne]: newSubscription.id }, // Exclui a assinatura que acabamos de criar
          // Adicionar aqui condição para verificar se o plano era pago, se necessário
          // Ex: '$plan.price$': { [Op.gt]: 0 } (requer include: Plan)
        }
      });

      if (previousPaidActiveSubscriptionsCount === 0) {
        const clientName = client.name ? client.name.split(' ')[0] : 'Cliente';
        const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
        const welcomeMessage = `🎉 Olá ${clientName}! Seja muito bem-vindo(a) ao MAP no Controle!\n\nQue demais que você garantiu seu acesso ao nosso plano *${plan.name}*!\n\nSeu acesso está válido até ${formatDate(newSubscription.endDate)}.\n\nPara começar, que tal me dizer "oi" por aqui para darmos o pontapé inicial na organização? Se preferir, você também já pode acessar nossa plataforma em https://${platformUrl}.\n\nEstou pronto para te ajudar a organizar tudo! 🚀`;
        try {
          await sendWhatsappMessage(client.phone, welcomeMessage);
          logger.info(`[SUBSCRIPTION SERVICE] Mensagem de boas-vindas enviada para o cliente ID ${clientId} (Plano: ${plan.name}).`);
        } catch (whatsappError) {
          logger.error(`[SUBSCRIPTION SERVICE] Falha ao enviar mensagem de boas-vindas para o cliente ID ${clientId}: ${whatsappError.message}`);
        }
      }
    }
    // === FIM DA LÓGICA DE MENSAGEM DE BOAS-VINDAS ===

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
        throw error;
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
            // Não colocar transaction: t aqui na busca inicial, para pegar o oldEndDate antes da transação
        });

        if (!subscription) {
            logger.warn(`[SUBSCRIPTION SERVICE] Assinatura com ID externo ${externalSubscriptionId} não encontrada para atualização de status.`);
            // Não precisa de rollback se a transação nem começou
            return null;
        }

        const client = subscription.client;
        const plan = subscription.plan;
        if (!client || !plan) {
            logger.error(`[SUBSCRIPTION SERVICE] Cliente ou Plano não encontrado para a assinatura ${subscription.id}. Dados inconsistentes.`);
            // Não precisa de rollback
            return null;
        }
        
        const oldEndDate = subscription.endDate; // Captura a data de término ANTES da atualização
        const oldStatus = subscription.status; // Captura o status ANTES da atualização

        const updateSubData = { status: newStatus };
        if (newStatus === 'Ativa' && newEndDate) {
            updateSubData.endDate = newEndDate;
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
                accessExpiresAt: newEndDate,
                status: 'Ativo'
            }, { transaction: t }); // A atualização do cliente ocorre DENTRO da transação
            logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${client.id} atualizado para accessLevel: ${clientAccessLevel}, expiresAt: ${newEndDate} devido à ativação/renovação da assinatura ${subscription.id}.`);

        } else if (newStatus === 'Cancelada' || newStatus === 'Expirada' || newStatus === 'Pagamento Falhou') {
            const otherActiveSubscriptions = await Subscription.count({
                where: {
                    clientId: client.id,
                    status: 'Ativa',
                    id: { [Op.ne]: subscription.id },
                    endDate: { [Op.gte]: new Date().toISOString().split('T')[0] }
                },
                transaction: t // Dentro da transação
            });

            if (otherActiveSubscriptions === 0) {
                await client.update({
                    accessLevel: 'gratuito',
                    accessExpiresAt: null,
                    status: newStatus === 'Pagamento Falhou' ? 'Pagamento Falhou' : client.status 
                }, { transaction: t });
                logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${client.id} revertido para 'gratuito' pois a assinatura ${subscription.id} foi ${newStatus}.`);
            }
        }

        await subscription.update(updateSubData, { transaction: t }); // Atualiza a assinatura DENTRO da transação
        await t.commit(); // Commit da transação ANTES de enviar notificações

        // === INÍCIO DA LÓGICA DE MENSAGEM DE RENOVAÇÃO/REATIVAÇÃO ===
        if (newStatus === 'Ativa' && client.phone) {
            // Condição 1: A assinatura já estava ativa e sua data de término foi estendida (renovação pura).
            const isExtensionRenewal = oldStatus === 'Ativa' && newEndDate && oldEndDate && newEndDate > oldEndDate;

            // Condição 2: A assinatura NÃO estava ativa (Expirada, Cancelada, Pendente, etc.) e agora foi (RE)ATIVADA.
            // E não é a *primeira vez absoluta* que o cliente se torna ativo (isso é coberto pelo createSubscription).
            // Para simplificar, consideramos uma reativação se o status antigo não era 'Ativa'.
            const isReactivation = oldStatus !== 'Ativa';
            
            // Evitar enviar mensagem de renovação se a mensagem de boas-vindas já foi/seria enviada
            // (ex: se createSubscription foi chamado com status 'Pendente' e agora está sendo ativada)
            // Uma heurística: se a data de início da assinatura for muito próxima de "agora",
            // e o status antigo não era 'Ativa', é provável que seja a primeira ativação.
            const isLikelyFirstActivationOfThisSubscription = isReactivation && (new Date(subscription.startDate) >= new Date(new Date().setDate(new Date().getDate() - 2)));


            if ((isExtensionRenewal || isReactivation) && !isLikelyFirstActivationOfThisSubscription) {
                const clientName = client.name ? client.name.split(' ')[0] : 'Cliente';
                // subscription.endDate já reflete newEndDate após a atualização
                const messageType = isExtensionRenewal ? 'renovada' : 'reativada';
                const renewalMessage = `🥳 Olá ${clientName}! Boas notícias!\n\nSua assinatura do plano *${plan.name}* foi ${messageType} com sucesso!\n\nSeu acesso agora está garantido até ${formatDate(subscription.endDate)}.\n\nAgradecemos por continuar conosco nessa jornada de organização e controle. Vamos juntos a mais um período de sucesso! 💪`;
                try {
                    await sendWhatsappMessage(client.phone, renewalMessage);
                    logger.info(`[SUBSCRIPTION SERVICE] Mensagem de ${messageType} enviada para o cliente ID ${client.id} (Plano: ${plan.name}).`);
                } catch (whatsappError) {
                    logger.error(`[SUBSCRIPTION SERVICE] Falha ao enviar mensagem de ${messageType} para o cliente ID ${client.id}: ${whatsappError.message}`);
                }
            }
        }
        // === FIM DA LÓGICA DE MENSAGEM DE RENOVAÇÃO/REATIVAÇÃO ===

        logger.info(`[SUBSCRIPTION SERVICE] Status da assinatura ID ${subscription.id} (Externo: ${externalSubscriptionId}) atualizado para ${newStatus}.`);
        const reloadedSubscription = await Subscription.findByPk(subscription.id, {
            include: [{ model: Client, as: 'client'}, {model: Plan, as: 'plan'}]
        });
        return reloadedSubscription ? reloadedSubscription.toJSON() : null;

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
  updateSubscriptionStatusByExternalId,
};
// src/features/Subscription/subscription.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService'); // Importa o serviço de WhatsApp
const { formatDate } = require('../../utils/formatters'); // Importa o formatador de data

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
    const clientInstance = await Client.findByPk(clientId, { transaction: t });
    if (!clientInstance) {
      const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    // Capturar o estado de acesso PAGO do cliente ANTES de qualquer alteração nesta função
    let clientHadActivePaidAccessBeforeThisCreation = false;
    if (clientInstance.accessLevel && clientInstance.accessLevel !== 'gratuito') {
        if (clientInstance.accessLevel.startsWith('vitalicio_')) {
            clientHadActivePaidAccessBeforeThisCreation = true;
        } else if (clientInstance.accessExpiresAt) {
            const expiryDate = new Date(clientInstance.accessExpiresAt + 'T00:00:00Z');
            const today = new Date(); today.setUTCHours(0,0,0,0);
            if (expiryDate >= today) {
                clientHadActivePaidAccessBeforeThisCreation = true;
            }
        }
    }
    logger.debug(`[SUBSCRIPTION SERVICE - createSubscription] Cliente ${clientId} tinha acesso pago ativo ANTES desta criação? ${clientHadActivePaidAccessBeforeThisCreation}`);

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
      autoRenew: plan.durationDays > 31,
    };
    if (externalSubscriptionId) {
        newSubscriptionData.externalSubscriptionId = externalSubscriptionId;
    }

    const newSubscription = await Subscription.create(newSubscriptionData, { transaction: t });

    await t.commit(); 

    // === LÓGICA DE MENSAGEM DE BOAS-VINDAS (APENAS SE O CLIENTE *NÃO TINHA* ACESSO PAGO ATIVO ANTES) ===
    if (status === 'Ativa' && clientInstance.phone && !clientHadActivePaidAccessBeforeThisCreation) {
        const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Cliente';
        const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
        
        let expiryWelcomePart = `Seu acesso está válido até ${formatDate(newSubscription.endDate)}.`;
        if (clientAccessLevel.includes('vitalicio')) {
            expiryWelcomePart = "Você garantiu acesso vitalício!";
        }

        const welcomeMessage = `🎉 Olá ${clientName}! Seja muito bem-vindo(a) ao MAP no Controle!\n\nQue demais que você garantiu seu acesso ao nosso plano *${plan.name}*!\n\n${expiryWelcomePart}\n\nPara começar, que tal me dizer "oi" por aqui para darmos o pontapé inicial na organização? Se preferir, você também já pode acessar nossa plataforma em https://${platformUrl}.\n\nEstou pronto para te ajudar a organizar tudo! 🚀`;
        try {
          await sendWhatsappMessage(clientInstance.phone, welcomeMessage);
          logger.info(`[SUBSCRIPTION SERVICE] Mensagem de boas-vindas enviada para o cliente ID ${clientId} (Plano: ${plan.name}).`);
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
            logger.error(`[SUBSCRIPTION SERVICE] Cliente ou Plano não encontrado para la assinatura ${subscription.id}. Dados inconsistentes.`);
            return null;
        }

        const oldClientAccessLevel = clientInstance.accessLevel;
        const oldClientAccessExpiresAt = clientInstance.accessExpiresAt;
        let clientHadActivePaidAccessBeforeUpdate = false;
        if (oldClientAccessLevel && oldClientAccessLevel !== 'gratuito') {
            if (oldClientAccessLevel.startsWith('vitalicio_')) {
                clientHadActivePaidAccessBeforeUpdate = true;
            } else if (oldClientAccessExpiresAt) {
                const expiryDate = new Date(oldClientAccessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0,0,0,0);
                if (expiryDate >= today) {
                    clientHadActivePaidAccessBeforeUpdate = true;
                }
            }
        }
        logger.debug(`[SUBSCRIPTION SERVICE - updateSubscriptionStatus] Cliente ${clientInstance.id} tinha acesso pago ANTES da atualização? ${clientHadActivePaidAccessBeforeUpdate}. Nível: ${oldClientAccessLevel}, Expira em: ${oldClientAccessExpiresAt}`);
        
        const updateSubData = { status: newStatus };
        let newClientAccessLevel = clientInstance.accessLevel;
        let newClientAccessExpiresAt = clientInstance.accessExpiresAt;

        if (newStatus === 'Ativa' && newEndDate) {
            updateSubData.endDate = newEndDate;
            const planTier = plan.tier || 'basico';
            if (plan.durationDays > 7000) {
                newClientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
                newClientAccessExpiresAt = null;
            } else if (plan.durationDays > 0) {
                newClientAccessLevel = planTier === 'avancado' 
                    ? (plan.durationDays > 60 ? 'avancado_anual' : 'avancado_mensal')
                    : (plan.durationDays > 60 ? 'basico_anual' : 'basico_mensal');
                newClientAccessExpiresAt = newEndDate;
            }

            await clientInstance.update({
                accessLevel: newClientAccessLevel,
                accessExpiresAt: newClientAccessExpiresAt,
                status: 'Ativo'
            }, { transaction: t });
            logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientInstance.id} atualizado para accessLevel: ${newClientAccessLevel}, expiresAt: ${newClientAccessExpiresAt} devido à ativação/renovação da assinatura ${subscription.id}.`);

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
                newClientAccessLevel = 'gratuito';
                newClientAccessExpiresAt = null;
                await clientInstance.update({
                    accessLevel: newClientAccessLevel,
                    accessExpiresAt: newClientAccessExpiresAt,
                    status: newStatus === 'Pagamento Falhou' ? 'Pagamento Falhou' : clientInstance.status 
                }, { transaction: t });
                logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientInstance.id} revertido para 'gratuito' pois a assinatura ${subscription.id} foi ${newStatus}.`);
            }
        }

        await subscription.update(updateSubData, { transaction: t });
        await t.commit();

        let clientNowHasActivePaidAccess = false;
        if (newClientAccessLevel && newClientAccessLevel !== 'gratuito') {
            if (newClientAccessLevel.startsWith('vitalicio_')) {
                clientNowHasActivePaidAccess = true;
            } else if (newClientAccessExpiresAt) {
                const expiryDate = new Date(newClientAccessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0,0,0,0);
                if (expiryDate >= today) {
                    clientNowHasActivePaidAccess = true;
                }
            }
        }
        logger.debug(`[SUBSCRIPTION SERVICE - updateSubscriptionStatus] Cliente ${clientInstance.id} tem acesso pago AGORA? ${clientNowHasActivePaidAccess}. Nível: ${newClientAccessLevel}, Expira em: ${newClientAccessExpiresAt}`);

        if (newStatus === 'Ativa' && clientInstance.phone && clientNowHasActivePaidAccess) {
            const isGenuineRenewal = clientHadActivePaidAccessBeforeUpdate &&
                                    newClientAccessExpiresAt && oldClientAccessExpiresAt &&
                                    new Date(newClientAccessExpiresAt) > new Date(oldClientAccessExpiresAt);

            const isReactivationToPaid = !clientHadActivePaidAccessBeforeUpdate;
            
            const isLikelyFirstGainOfAccessViaThisSubscription = isReactivationToPaid &&
                (new Date(subscription.startDate) >= new Date(new Date().setDate(new Date().getDate() - 2)));


            if (isGenuineRenewal || (isReactivationToPaid && !isLikelyFirstGainOfAccessViaThisSubscription) ) {
                const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Cliente';
                const messageType = isGenuineRenewal ? 'renovada' : 'reativada';
                let expiryMessagePart = `Seu acesso agora está garantido até ${formatDate(newClientAccessExpiresAt)}.`;
                if (newClientAccessLevel.includes('vitalicio')) {
                    expiryMessagePart = "Seu acesso vitalício continua firme e forte!";
                }
                
                const renewalMessage = `🥳 Olá ${clientName}! Boas notícias!\n\nSua assinatura do plano *${plan.name}* foi ${messageType} com sucesso!\n\n${expiryMessagePart}\n\nAgradecemos por continuar conosco nessa jornada de organização e controle. Vamos juntos a mais um período de sucesso! 💪`;
                try {
                    await sendWhatsappMessage(clientInstance.phone, renewalMessage);
                    logger.info(`[SUBSCRIPTION SERVICE] Mensagem de ${messageType} enviada para o cliente ID ${clientInstance.id} (Plano: ${plan.name}).`);
                } catch (whatsappError) {
                    logger.error(`[SUBSCRIPTION SERVICE] Falha ao enviar mensagem de ${messageType} para o cliente ID ${clientInstance.id}: ${whatsappError.message}`);
                }
            } else if (isLikelyFirstGainOfAccessViaThisSubscription) {
                const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Cliente';
                const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
                let expiryWelcomePart = `Seu acesso está válido até ${formatDate(newClientAccessExpiresAt)}.`;
                if (newClientAccessLevel.includes('vitalicio')) {
                    expiryWelcomePart = "Você garantiu acesso vitalício!";
                }

                const welcomeMessage = `🎉 Olá ${clientName}! Seja muito bem-vindo(a) ao MAP no Controle!\n\nSua assinatura do plano *${plan.name}* foi ativada com sucesso!\n\n${expiryWelcomePart}\n\nPara começar, que tal me dizer "oi" por aqui para darmos o pontapé inicial na organização? Se preferir, você também já pode acessar nossa plataforma em https://${platformUrl}.\n\nEstou pronto para te ajudar a organizar tudo! 🚀`;
                try {
                    await sendWhatsappMessage(clientInstance.phone, welcomeMessage);
                    logger.info(`[SUBSCRIPTION SERVICE] Mensagem de BOAS-VINDAS (via ativação de assinatura) enviada para o cliente ID ${clientInstance.id} (Plano: ${plan.name}).`);
                } catch (whatsappError) {
                    logger.error(`[SUBSCRIPTION SERVICE] Falha ao enviar mensagem de BOAS-VINDAS (via ativação) para o cliente ID ${clientInstance.id}: ${whatsappError.message}`);
                }
            }
        }

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
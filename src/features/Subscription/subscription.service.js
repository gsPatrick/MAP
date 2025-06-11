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
    
    const previousSubscriptionsCount = await Subscription.count({
        where: { clientId: clientId },
        transaction: t
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
      autoRenew: plan.durationDays > 31,
    };
    if (externalSubscriptionId) {
        newSubscriptionData.externalSubscriptionId = externalSubscriptionId;
    }

    const newSubscription = await Subscription.create(newSubscriptionData, { transaction: t });

    await t.commit(); 

    // === NOVA LÓGICA DE MENSAGEM DE BOAS-VINDAS (PRIMEIRA ASSINATURA) ===
    if (status === 'Ativa' && clientInstance.phone && previousSubscriptionsCount === 0) {
        const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Cliente';
        const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
        
        let expiryWelcomePart = `Seu acesso está garantido até *${formatDate(newSubscription.endDate)}*.`;
        if (clientAccessLevel.includes('vitalicio')) {
            expiryWelcomePart = "Você agora tem *acesso vitalício*! 🎉";
        }

        const intro = `Ebaaa, ${clientName}! 🚀 Seja muito bem-vindo(a) ao time MAP no Controle!`;
        const body = `Sua assinatura do plano *${plan.name}* foi ativada com sucesso e eu não poderia estar mais feliz em ter você por aqui!\n\n${expiryWelcomePart}`;
        const footer = `Para começarmos, que tal me dizer "oi"? Ou, se preferir, já pode explorar a plataforma em https://${platformUrl}\n\nEstou a postos para te ajudar a organizar tudo! 💪✨`;
        const welcomeMessage = `${intro}\n\n${body}\n\n${footer}`;
        
        try {
          await sendWhatsappMessage(clientInstance.phone, welcomeMessage);
          logger.info(`[SUBSCRIPTION SERVICE] Mensagem de boas-vindas (primeira assinatura) enviada para o cliente ID ${clientId} (Plano: ${plan.name}).`);
        } catch (whatsappError) {
          logger.error(`[SUBSCRIPTION SERVICE] Falha ao enviar mensagem de boas-vindas para o cliente ID ${clientId}: ${whatsappError.message}`);
        }
    }
    // === FIM DA LÓGICA DE MENSAGEM ===

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
            ],
            transaction: t
        });

        if (!subscription) {
            logger.warn(`[SUBSCRIPTION SERVICE] Assinatura com ID externo ${externalSubscriptionId} não encontrada para atualização.`);
            await t.rollback();
            return null;
        }

        const clientInstance = subscription.client;
        const plan = subscription.plan;

        if (!clientInstance || !plan) {
            logger.error(`[SUBSCRIPTION SERVICE] Dados inconsistentes para a assinatura ${subscription.id}. Cliente ou Plano ausente.`);
            await t.rollback();
            return null;
        }

        const oldStatus = subscription.status;
        const updateSubData = { status: newStatus };
        let clientAccessLevel = clientInstance.accessLevel;
        let clientAccessExpiresAt = clientInstance.accessExpiresAt;
        let clientStatus = clientInstance.status;

        if (newStatus === 'Ativa') {
            updateSubData.endDate = newEndDate;
            const planTier = plan.tier || 'basico';
            clientAccessLevel = `${planTier}_${plan.durationDays > 60 ? 'anual' : 'mensal'}`;
            if (plan.durationDays > 7000) {
              clientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
            }
            clientAccessExpiresAt = newEndDate;
            clientStatus = 'Ativo';
        } else if (['Cancelada', 'Expirada', 'Pagamento Falhou'].includes(newStatus)) {
            const otherActiveSubscriptions = await Subscription.count({
                where: { /* ... */ }, transaction: t
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
        logger.info(`[SUBSCRIPTION SERVICE] Cliente ID ${clientInstance.id} atualizado para accessLevel: ${clientAccessLevel}.`);

        await subscription.update(updateSubData, { transaction: t });
        await t.commit();
        logger.info(`[SUBSCRIPTION SERVICE] Status da assinatura ID ${subscription.id} (Externo: ${externalSubscriptionId}) atualizado para ${newStatus}.`);

        // ==========================================================
        //         BLOCO DE DEPURAÇÃO DO ENVIO DE MENSAGEM
        // ==========================================================
        logger.info(`[DEPURAÇÃO MSG] Verificando condições para envio. newStatus: '${newStatus}', clientInstance.phone: '${clientInstance.phone}'`); // <<< LOG 1

        if (newStatus === 'Ativa' && clientInstance.phone) {
            logger.info(`[DEPURAÇÃO MSG] CONDIÇÕES ATENDIDAS. Entrando no bloco de envio.`); // <<< LOG 2
            
            const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Cliente';
            let expiryMessagePart = `Seu acesso foi estendido e agora está garantido até *${formatDate(newEndDate)}*.`;
            if (plan.tier.includes('vitalicio')) {
                expiryMessagePart = "Seu acesso *vitalício* continua firme e forte! 🎉";
            }
            let intro, body;

            logger.info(`[DEPURAÇÃO MSG] Status anterior da assinatura: '${oldStatus}'`); // <<< LOG 3

            if (oldStatus !== 'Ativa') {
                intro = `Ebaaa, ${clientName}! Boas notícias! 🥳`;
                body = `Sua assinatura do plano *${plan.name}* foi ativada com sucesso.\n\n${expiryMessagePart}`;
                logger.info(`[DEPURAÇÃO MSG] Mensagem de ATIVAÇÃO/BOAS-VINDAS preparada.`); // <<< LOG 4
            } else {
                intro = `Olá, ${clientName}! Ótimas notícias! 🚀`;
                body = `Sua assinatura do plano *${plan.name}* foi renovada com sucesso.\n\n${expiryMessagePart}`;
                logger.info(`[DEPURAÇÃO MSG] Mensagem de RENOVAÇÃO preparada.`); // <<< LOG 5
            }

            const footer = `Continue aproveitando todos os benefícios! Se precisar de algo, é só chamar.`;
            const finalMessage = `${intro}\n\n${body}\n\n${footer}`;

            logger.info(`[DEPURAÇÃO MSG] Mensagem final a ser enviada: "${finalMessage.substring(0, 100)}..."`); // <<< LOG 6

            try {
                await sendWhatsappMessage(clientInstance.phone, finalMessage);
                logger.info(`[SUBSCRIPTION SERVICE] MENSAGEM ENVIADA COM SUCESSO para o cliente ID ${clientInstance.id}.`); // <<< LOG SUCESSO
            } catch (whatsappError) {
                logger.error(`[SUBSCRIPTION SERVICE] FALHA AO ENVIAR MENSAGEM para o cliente ID ${clientInstance.id}: ${whatsappError.message}`); // <<< LOG ERRO
            }
        }
        // ==========================================================

        return subscription.reload({ include: [{ model: Client, as: 'client'}, {model: Plan, as: 'plan'}] });

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
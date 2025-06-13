// src/features/Subscription/subscription.service.js
const { Client, Plan, Subscription, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService');
const { formatDate, formatCurrency } = require('../../utils/formatters'); // Adicionado formatCurrency

/**
 * Cria uma nova assinatura, opcionalmente registrando um código de afiliado.
 * @param {string} affiliateCode - O código de afiliado usado na compra (opcional).
 * ... outros parâmetros
 */
async function createSubscription(clientId, planId, startDate = null, status = 'Ativa', externalSubscriptionId = null, affiliateCode = null) {
  const t = await sequelize.transaction();
  try {
    const clientInstance = await Client.findByPk(clientId, { transaction: t });
    if (!clientInstance) {
      const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    // === LÓGICA PARA REGISTRAR O INDICADOR NO MOMENTO DA CRIAÇÃO ===
    if (affiliateCode && !clientInstance.referredByClientId) {
      const referrer = await Client.findOne({ 
          where: { 
            affiliateCode: affiliateCode.toUpperCase(),
            id: { [Op.ne]: clientInstance.id } // Garante que o cliente não se auto-indicou
          }, 
          transaction: t 
      });
      if (referrer) {
        await clientInstance.update({ referredByClientId: referrer.id }, { transaction: t });
        logger.info(`[SubscriptionService] Cliente ID ${clientId} foi indicado pelo afiliado ID ${referrer.id} (código: ${affiliateCode}).`);
      } else {
        logger.warn(`[SubscriptionService] Código de afiliado "${affiliateCode}" inválido, não encontrado ou pertence ao próprio cliente.`);
      }
    }
    // === FIM DA LÓGICA DO CÓDIGO ===

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

    // === LÓGICA PARA PAGAR COMISSÃO SE A ASSINATURA JÁ É CRIADA COMO ATIVA ===
    if (status === 'Ativa') {
        const referredClient = await Client.findByPk(clientId, { transaction: t });
        if (referredClient.referredByClientId && plan.affiliateCommissionValue > 0) {
            const affiliateClient = await Client.findByPk(referredClient.referredByClientId, { transaction: t });
            if (affiliateClient) {
                await affiliateClient.increment('balance', { by: plan.affiliateCommissionValue, transaction: t });
                logger.info(`Comissão de ${formatCurrency(plan.affiliateCommissionValue)} creditada ao afiliado ID ${affiliateClient.id} pela criação da assinatura do cliente ID ${clientId}.`);
            }
        }
    }
    // === FIM DA LÓGICA DE COMISSÃO ===

    await t.commit(); 

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
                { model: Client, as: 'client' }, // A associação já traz o cliente completo
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
        const oldStatus = subscription.status;

        if (!clientInstance || !plan) {
            logger.error(`[SUBSCRIPTION SERVICE] Dados inconsistentes para a assinatura ${subscription.id}. Cliente ou Plano ausente.`);
            await t.rollback();
            return null;
        }

        const updateSubData = { status: newStatus };
        let clientAccessLevel = clientInstance.accessLevel;
        let clientAccessExpiresAt = clientInstance.accessExpiresAt;
        let clientStatus = clientInstance.status;

        // A lógica principal acontece aqui, quando uma assinatura é ativada
        if (newStatus === 'Ativa' && oldStatus !== 'Ativa') {
            
            // === NOVA LÓGICA PARA PAGAR A COMISSÃO ===
            if (clientInstance.referredByClientId && plan.affiliateCommissionValue > 0) {
                const affiliateClient = await Client.findByPk(clientInstance.referredByClientId, { transaction: t });
                if (affiliateClient) {
                    await affiliateClient.increment('balance', { 
                        by: plan.affiliateCommissionValue, 
                        transaction: t 
                    });
                    logger.info(`Comissão de ${formatCurrency(plan.affiliateCommissionValue)} creditada ao afiliado ID ${affiliateClient.id} pela ativação da assinatura do cliente ID ${clientInstance.id}.`);
                } else {
                    logger.warn(`Afiliado ID ${clientInstance.referredByClientId} não foi encontrado. Nenhuma comissão será paga para a assinatura ${subscription.id}.`);
                }
            } else {
                logger.info(`Assinatura ${subscription.id} ativada, mas sem indicação ou comissão de afiliado aplicável.`);
            }
            // === FIM DA LÓGICA DE COMISSÃO ===

            // Lógica para atualizar o nível de acesso do cliente que pagou
            updateSubData.endDate = newEndDate;
            const planTier = plan.tier || 'basico';
            clientAccessLevel = `${planTier}_${plan.durationDays > 60 ? 'anual' : 'mensal'}`;
            if (plan.durationDays > 7000) {
              clientAccessLevel = planTier === 'avancado' ? 'vitalicio_avancado' : 'vitalicio_basico';
            }
            clientAccessExpiresAt = newEndDate;
            clientStatus = 'Ativo';

        } else if (['Cancelada', 'Expirada', 'Pagamento Falhou'].includes(newStatus)) {
            // Lógica para rebaixar o plano do cliente se ele não tiver outra assinatura ativa
            const otherActiveSubscriptions = await Subscription.count({
                where: { 
                    clientId: subscription.clientId, 
                    status: 'Ativa', 
                    id: {[Op.ne]: subscription.id} 
                }, transaction: t
            });
            if (otherActiveSubscriptions === 0) {
                clientAccessLevel = 'gratuito';
                clientAccessExpiresAt = null;
                clientStatus = (newStatus === 'Pagamento Falhou') ? 'Pagamento Falhou' : 'Inativo';
            }
        }
        
        // Aplica as atualizações no cliente e na assinatura
        await clientInstance.update({
            accessLevel: clientAccessLevel,
            accessExpiresAt: clientAccessExpiresAt,
            status: clientStatus
        }, { transaction: t });
        
        await subscription.update(updateSubData, { transaction: t });
        
        await t.commit();
        logger.info(`[SUBSCRIPTION SERVICE] Status da assinatura ID ${subscription.id} (Externo: ${externalSubscriptionId}) atualizado para ${newStatus}.`);

        // Bloco de envio de mensagem de WhatsApp (mantido)
        if (newStatus === 'Ativa' && clientInstance.phone) {
            const clientName = clientInstance.name ? clientInstance.name.split(' ')[0] : 'Cliente';
            let expiryMessagePart = `Seu acesso foi estendido e agora está garantido até *${formatDate(newEndDate)}*.`;
            if (plan.tier.includes('vitalicio')) {
                expiryMessagePart = "Seu acesso *vitalício* continua firme e forte! 🎉";
            }
            let intro, body;

            if (oldStatus !== 'Ativa') {
                intro = `Ebaaa, ${clientName}! Boas notícias! 🥳`;
                body = `Sua assinatura do plano *${plan.name}* foi ativada com sucesso.\n\n${expiryMessagePart}`;
            } else {
                intro = `Olá, ${clientName}! Ótimas notícias! 🚀`;
                body = `Sua assinatura do plano *${plan.name}* foi renovada com sucesso.\n\n${expiryMessagePart}`;
            }

            const footer = `Continue aproveitando todos os benefícios! Se precisar de algo, é só chamar.`;
            const finalMessage = `${intro}\n\n${body}\n\n${footer}`;

            try {
                await sendWhatsappMessage(clientInstance.phone, finalMessage);
            } catch (whatsappError) {
                logger.error(`[SUBSCRIPTION SERVICE] FALHA AO ENVIAR MENSAGEM para o cliente ID ${clientInstance.id}: ${whatsappError.message}`);
            }
        }
        
        return subscription.reload({ include: [{ model: Client, as: 'client'}, {model: Plan, as: 'plan'}] });

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
// src/features/Affiliate/affiliate.service.js

const { Client, Plan, Subscription, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService');
const { Op } = require('sequelize');

/**
 * Envia uma notificação para um novo cliente com seu link de afiliado pessoal.
 * @param {object} newClient - A instância do cliente recém-criado.
 */
async function sendAffiliateLinkNotification(newClient) {
  if (!newClient || !newClient.affiliateCode) {
    logger.warn(`[AffiliateService] Tentativa de enviar notificação de link para cliente sem código de afiliado (ID: ${newClient.id}).`);
    return;
  }

  try {
    // Usamos um plano padrão (Básico Mensal, ID 7) para construir um link de exemplo.
    const affiliateLink = `https://www.map-nocontrole.com.br/assinar/7?ref=${newClient.affiliateCode}`;

    const message = `✨ *Você agora é um(a) parceiro(a) MAP no Controle!* ✨\n\n` +
                    `Que tal ganhar uma renda extra enquanto ajuda outras pessoas a se organizarem?\n\n` +
                    `Compartilhe seu link de indicação pessoal e receba uma comissão por cada novo assinante!\n\n` +
                    `🔗 *Seu Link Mágico:*\n${affiliateLink}\n\n` +
                    `Copie, compartilhe e comece a lucrar! 🚀`;

    await sendWhatsappMessage(newClient.phone, message);
    logger.info(`[AffiliateService] Notificação de link de afiliado enviada para o cliente ID ${newClient.id}.`);
  } catch (error) {
    logger.error(`[AffiliateService] Erro ao enviar notificação de link de afiliado para o cliente ID ${newClient.id}: ${error.message}`, error);
  }
}

/**
 * Processa uma nova assinatura para creditar a comissão ao afiliado que indicou,
 * APENAS se for a primeira assinatura paga do novo cliente.
 * 
 * Adicionada a verificação no início para garantir que o cliente tem um plano pago ativo
 * antes de prosseguir com a creditação de comissão.
 * 
 * @param {number} newlySubscribedClientId - O ID do cliente que acabou de ter sua assinatura ativada.
 * @param {object} options - Opções, como a transação do Sequelize.
 */
async function processNewSubscriptionForAffiliate(newlySubscribedClientId, options = {}) {
  const transaction = options.transaction || (await sequelize.transaction());
  try {
    const newClient = await Client.findByPk(newlySubscribedClientId, { transaction });

    // 1. Se o novo cliente não foi indicado por ninguém, encerra o processo.
    if (!newClient || !newClient.referredByClientId) {
      if (!options.transaction) await transaction.commit();
      logger.info(`[AffiliateService] Cliente ID ${newlySubscribedClientId} não foi indicado. Nenhuma comissão a processar.`);
      return;
    }
    
    // <<< PASSO CRUCIAL DE VALIDAÇÃO: Cliente deve ter um plano pago ativo >>>
    const today = new Date().toISOString().split('T')[0];
    const isPaidAccess = newClient.accessLevel && newClient.accessLevel !== 'gratuito' && 
                         (newClient.accessLevel.startsWith('vitalicio_') || 
                         (newClient.accessExpiresAt && new Date(newClient.accessExpiresAt + 'T23:59:59Z') >= new Date(today + 'T00:00:00Z')));
    
    if (!isPaidAccess) {
        if (!options.transaction) await transaction.commit();
        logger.warn(`[AffiliateService] Cliente ID ${newlySubscribedClientId} (indicado por ${newClient.referredByClientId}) NÃO tem um plano pago ATIVO. Comissão não aplicável.`);
        return;
    }
    // <<< FIM DO NOVO PASSO CRUCIAL DE VALIDAÇÃO >>>

    const referrer = await Client.findByPk(newClient.referredByClientId, { transaction });
    if (!referrer) {
      if (!options.transaction) await transaction.rollback();
      logger.error(`[AffiliateService] Referenciador (ID: ${newClient.referredByClientId}) não encontrado para o cliente ${newClient.id}.`);
      return;
    }

    // 2. NOVA VERIFICAÇÃO: Impede autocomissão (self-referral)
    if (referrer.id === newClient.id) {
        if (!options.transaction) await transaction.commit();
        logger.warn(`[AffiliateService] Tentativa de autocomissão (self-referral) pelo Cliente ID ${newClient.id}. Comissão ignorada.`);
        return;
    }

    // Busca a assinatura ATIVA que justifica esta creditação (a mais recente)
    // A query é mais complexa para garantir que a assinatura está ativa e associada ao plano
    const activeSubscription = await Subscription.findOne({
      where: { 
          clientId: newlySubscribedClientId, 
          status: 'Ativa' ,
          // Garantir que a assinatura seja recente e corresponda ao nível de acesso do cliente
          // (Usado para tentar pegar a assinatura correta no caso de várias entradas)
      },
      include: [{ model: Plan, as: 'plan' }],
      order: [['createdAt', 'DESC']], // Pega a mais recente
      transaction,
    });

    if (!activeSubscription || !activeSubscription.plan) {
      // Se a subscrição ativa não foi encontrada (o que é improvável se o cliente estiver com accessLevel correto),
      // faz um rollback se a transação não for externa.
      if (!options.transaction) await transaction.rollback();
      logger.error(`[AffiliateService] Assinatura ativa ou plano não encontrado para o cliente comissionado ${newClient.id}, apesar do accessLevel. Rollback.`);
      return;
    }

    // 3. NOVA VERIFICAÇÃO: Garante que é a PRIMEIRA assinatura ativa do cliente
    // Se o cliente tem acesso vitalício, ele só tem uma "primeira" assinatura.
    const isVitalicio = newClient.accessLevel.startsWith('vitalicio_');
    let totalActivePaidSubscriptions = 0;
    
    if (!isVitalicio) {
        totalActivePaidSubscriptions = await Subscription.count({
            where: {
                clientId: newlySubscribedClientId,
                status: 'Ativa'
            },
            transaction
        });
    }


    if (!isVitalicio && totalActivePaidSubscriptions > 1) {
        // Se já tem mais de uma ativa (implica renovação ou outra compra paga anterior), NÃO credita.
        if (!options.transaction) await transaction.commit();
        logger.info(`[AffiliateService] Cliente ID ${newlySubscribedClientId} já possui ${totalActivePaidSubscriptions} assinaturas ativas (renovação ou segunda compra). Comissão não aplicável.`);
        return;
    }
    // FIM DA VERIFICAÇÃO DE PRIMEIRA COMPRA

    const commissionValue = parseFloat(activeSubscription.plan.affiliateCommissionValue);
    if (isNaN(commissionValue) || commissionValue <= 0) {
      if (!options.transaction) await transaction.commit();
      logger.info(`[AffiliateService] Plano "${activeSubscription.plan.name}" não possui valor de comissão. Nenhuma comissão a processar.`);
      return;
    }

    // 4. Adiciona o valor da comissão ao saldo do afiliado (se todas as verificações passaram)
    await referrer.increment('balance', { by: commissionValue, transaction });
    
    if (!options.transaction) {
        await transaction.commit();
    }
    
    logger.info(`[AffiliateService] Comissão de R$${commissionValue.toFixed(2)} creditada para o afiliado ID ${referrer.id} pela PRIMEIRA assinatura do cliente ID ${newClient.id}.`);

    // 5. Envia a notificação de comissão para o afiliado
    if (referrer.phone) {
      // Recarrega o saldo do referrer para a mensagem de notificação
      const updatedReferrer = await Client.findByPk(referrer.id);
      const notificationMessage = `💰 *Você recebeu uma comissão!* 💰\n\n` +
                                  `Parabéns! Você recebeu *R$${commissionValue.toFixed(2).replace('.', ',')}* pela primeira assinatura de *${newClient.name}*.\n\n` +
                                  `Seu novo saldo é de R$${parseFloat(updatedReferrer.balance).toFixed(2).replace('.', ',')}. Continue assim! 🚀`;
      await sendWhatsappMessage(referrer.phone, notificationMessage);
    }

  } catch (error) {
    if (!options.transaction) await transaction.rollback();
    logger.error(`[AffiliateService] Erro CRÍTICO ao processar comissão para o cliente ${newlySubscribedClientId}: ${error.message}`, error);
  }
}


/**
 * Obtém o dashboard de afiliado para um cliente.
 * @param {number} affiliateClientId - ID do cliente afiliado.
 * @returns {Promise<object>} Dados do dashboard.
 */
async function getAffiliateDashboard(affiliateClientId) {
  try {
    const affiliate = await Client.findByPk(affiliateClientId, {
      attributes: ['id', 'name', 'balance', 'affiliateCode', 'asaasPayoutPixKey']
    });

    if (!affiliate) {
      throw { statusCode: 404, message: 'Afiliado não encontrado.' };
    }

    const totalReferrals = await Client.count({
      where: { referredByClientId: affiliateClientId }
    });
    
    // O total ganho é o saldo, que reflete as comissões pagas.
    const totalEarned = parseFloat(affiliate.balance) || 0;

    const dashboardData = {
      summary: affiliate.toJSON(),
      totalReferrals: totalReferrals,
      totalEarned: totalEarned,
    };

    logger.info(`[AffiliateService] Dashboard para afiliado ID ${affiliateClientId} gerado com sucesso.`);
    return dashboardData;

  } catch (error) {
    logger.error(`[AffiliateService] Erro ao buscar dashboard do afiliado ID ${affiliateClientId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca um histórico detalhado de todas as indicações feitas por um afiliado.
 * @param {number} affiliateClientId - O ID do cliente afiliado.
 * @returns {Promise<Array<object>>} Uma lista de objetos detalhando cada indicação.
 */
async function getAffiliateReferralsHistory(affiliateClientId) {
  try {
    const referrals = await Client.findAll({
      where: { referredByClientId: affiliateClientId },
      include: [
        {
          model: Subscription,
          as: 'subscriptions',
          where: { status: 'Ativa' },
          required: false, // LEFT JOIN para incluir indicados que talvez ainda não assinaram
          include: [{ model: Plan, as: 'plan' }]
        }
      ],
      order: [['createdAt', 'DESC']],
    });

    if (referrals.length === 0) {
      return [];
    }

    const history = referrals.map(referral => {
      // Pega a primeira assinatura ativa, que foi a que gerou a comissão
      const firstActiveSubscription = referral.subscriptions
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .find(sub => sub.status === 'Ativa');
      
      return {
        referredClientId: referral.id,
        name: referral.name,
        email: referral.email,
        phone: referral.phone,
        joinDate: referral.createdAt,
        subscription: firstActiveSubscription 
          ? {
              planName: firstActiveSubscription.plan.name,
              subscriptionDate: firstActiveSubscription.startDate,
              commissionEarned: parseFloat(firstActiveSubscription.plan.affiliateCommissionValue)
            }
          : null // Caso o indicado ainda não tenha uma assinatura ativa
      };
    });

    logger.info(`[AffiliateService] Histórico de ${history.length} indicações gerado para o afiliado ID ${affiliateClientId}.`);
    return history;

  } catch (error) {
    logger.error(`[AffiliateService] Erro ao buscar histórico de indicações para o afiliado ID ${affiliateClientId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  getAffiliateDashboard,
  sendAffiliateLinkNotification,
  processNewSubscriptionForAffiliate,
  getAffiliateReferralsHistory,
};
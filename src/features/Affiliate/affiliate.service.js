// src/features/Affiliate/affiliate.service.js

const { Client, Plan, Subscription, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService');

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
 * Processa uma nova assinatura para creditar a comissão ao afiliado que indicou.
 * @param {number} newlySubscribedClientId - O ID do cliente que acabou de ter sua assinatura ativada.
 */
async function processNewSubscriptionForAffiliate(newlySubscribedClientId) {
  const t = await sequelize.transaction();
  try {
    const newClient = await Client.findByPk(newlySubscribedClientId, { transaction: t });

    // Se o novo cliente não foi indicado por ninguém, encerra o processo.
    if (!newClient || !newClient.referredByClientId) {
      logger.info(`[AffiliateService] Cliente ID ${newlySubscribedClientId} não foi indicado. Nenhuma comissão a processar.`);
      await t.commit();
      return;
    }

    const referrer = await Client.findByPk(newClient.referredByClientId, { transaction: t });
    if (!referrer) {
      logger.error(`[AffiliateService] Referenciador (ID: ${newClient.referredByClientId}) não encontrado para o cliente ${newClient.id}.`);
      await t.rollback();
      return;
    }

    const activeSubscription = await Subscription.findOne({
      where: { clientId: newlySubscribedClientId, status: 'Ativa' },
      include: [{ model: Plan, as: 'plan' }],
      transaction: t,
    });

    if (!activeSubscription || !activeSubscription.plan) {
      logger.error(`[AffiliateService] Assinatura ativa ou plano não encontrado para o cliente comissionado ${newClient.id}.`);
      await t.rollback();
      return;
    }

    const commissionValue = parseFloat(activeSubscription.plan.affiliateCommissionValue);
    if (isNaN(commissionValue) || commissionValue <= 0) {
      logger.info(`[AffiliateService] Plano "${activeSubscription.plan.name}" não possui valor de comissão. Nenhuma comissão a processar.`);
      await t.commit();
      return;
    }

    // Adiciona o valor da comissão ao saldo do afiliado
    await referrer.increment('balance', { by: commissionValue, transaction: t });
    await t.commit();
    
    logger.info(`[AffiliateService] Comissão de R$${commissionValue.toFixed(2)} creditada para o afiliado ID ${referrer.id} pela assinatura do cliente ID ${newClient.id}.`);

    // Envia a notificação de comissão para o afiliado
    if (referrer.phone) {
      const notificationMessage = `💰 *Você recebeu uma comissão!* 💰\n\n` +
                                  `Parabéns! Você recebeu *R$${commissionValue.toFixed(2).replace('.', ',')}* pela assinatura de *${newClient.name}* (Telefone: ${newClient.phone}).\n\n` +
                                  `Seu novo saldo é de R$${(parseFloat(referrer.balance) + commissionValue).toFixed(2).replace('.', ',')}. Continue assim! 🚀`;
      await sendWhatsappMessage(referrer.phone, notificationMessage);
    }

  } catch (error) {
    await t.rollback();
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


async function processNewSubscriptionForAffiliate(newlySubscribedClientId, options = {}) {
  // Permite que uma transação externa seja usada, ou cria uma nova se não for fornecida.
  const transaction = options.transaction || (await sequelize.transaction());
  try {
    const newClient = await Client.findByPk(newlySubscribedClientId, { transaction });

    if (!newClient || !newClient.referredByClientId) {
      if (!options.transaction) await transaction.commit(); // Só comita se a transação foi criada aqui
      return;
    }

    const referrer = await Client.findByPk(newClient.referredByClientId, { transaction });
    if (!referrer) {
      if (!options.transaction) await transaction.rollback();
      return;
    }

    const activeSubscription = await Subscription.findOne({
      where: { clientId: newlySubscribedClientId, status: 'Ativa' },
      include: [{ model: Plan, as: 'plan' }],
      transaction,
    });

    if (!activeSubscription || !activeSubscription.plan) {
      if (!options.transaction) await transaction.rollback();
      return;
    }

    const commissionValue = parseFloat(activeSubscription.plan.affiliateCommissionValue);
    if (isNaN(commissionValue) || commissionValue <= 0) {
      if (!options.transaction) await transaction.commit();
      return;
    }

    await referrer.increment('balance', { by: commissionValue, transaction });
    
    // Só comita se a transação foi criada nesta função
    if (!options.transaction) {
        await transaction.commit();
    }
    
    logger.info(`[AffiliateService] Comissão de R$${commissionValue.toFixed(2)} creditada para o afiliado ID ${referrer.id}.`);

    if (referrer.phone) {
      const notificationMessage = `💰 *Você recebeu uma comissão!* 💰\n\n` +
                                  `Parabéns! Você recebeu *R$${commissionValue.toFixed(2).replace('.', ',')}* pela assinatura de *${newClient.name}* (Telefone: ${newClient.phone}).\n\n` +
                                  `Seu novo saldo é de R$${(parseFloat(referrer.balance) + commissionValue).toFixed(2).replace('.', ',')}. Continue assim! 🚀`;
      await sendWhatsappMessage(referrer.phone, notificationMessage);
    }

  } catch (error) {
    if (!options.transaction) await transaction.rollback(); // Só da rollback se a transação foi criada aqui
    logger.error(`[AffiliateService] Erro ao processar comissão para o cliente ${newlySubscribedClientId}: ${error.message}`, error);
  }
}

module.exports = {
  getAffiliateDashboard,
  sendAffiliateLinkNotification,
  processNewSubscriptionForAffiliate,
};
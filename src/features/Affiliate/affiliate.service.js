// src/features/Affiliate/affiliate.service.js
const { Client, Subscription, Plan, AffiliateCommission, AffiliatePayout, AffiliateClick, sequelize } = require('../../database');

const MIN_WITHDRAWAL = 50; // saque mínimo em R$
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

/**
 * Envia uma notificação WhatsApp para o novo cliente com seu link de afiliado.
 */
async function sendAffiliateLinkNotification(newClient) {
  if (!newClient.phone || !newClient.affiliateCode) {
    logger.warn(`[AffiliateService] Cliente ID ${newClient.id} sem telefone ou código de afiliado para notificação.`);
    return;
  }

  try {
    // Link universal que leva à página de convite personalizada
    const affiliateLink = `https://www.map-nocontrole.com.br/indicacao/${newClient.affiliateCode}`;

    const message = `✨ *Você agora é um(a) parceiro(a) MAP no Controle!* ✨\n\n` +
      `Que tal ganhar uma renda extra enquanto ajuda outras pessoas a se organizarem?\n\n` +
      `Sempre que alguém assinar o MAP através do seu link exclusivo, você ganha comissão!\n\n` +
      `🔗 *Seu Link de Parceiro:* ${affiliateLink}\n\n` +
      `Acompanhe suas indicações e saldo diretamente no seu painel web. Boas vendas! 🚀`;

    const { sendWhatsappMessage } = require('../../services/whatsappService');
    await sendWhatsappMessage(newClient.phone, message);
    logger.info(`[AffiliateService] Notificação de link de afiliado enviada para ${newClient.phone}.`);
  } catch (error) {
    logger.error(`[AffiliateService] Erro ao enviar notificação de link de afiliado para ${newClient.phone}: ${error.message}`);
  }
}

/**
 * Processa a comissão para o afiliado quando um cliente indicado assina um plano pela primeira vez.
 */
async function processNewSubscriptionForAffiliate(subscription, transaction) {
  try {
    const client = await Client.findByPk(subscription.clientId, { transaction });
    if (!client || !client.referredByClientId) return;

    const existingPaidSubscriptions = await Subscription.count({
      where: {
        clientId: client.id,
        status: 'Ativa',
        id: { [Op.ne]: subscription.id }
      },
      transaction
    });

    if (existingPaidSubscriptions > 0) {
      logger.info(`[AffiliateService] Cliente ID ${client.id} já possui assinaturas pagas. Nenhuma comissão será gerada.`);
      return;
    }

    if (client.id === client.referredByClientId) {
      logger.error(`[AffiliateService] Tentativa de auto-indicação detectada para Cliente ID ${client.id}.`);
      return;
    }

    const plan = await Plan.findByPk(subscription.planId, { transaction });
    if (!plan || parseFloat(plan.affiliateCommissionValue) <= 0) {
      logger.info(`[AffiliateService] Plano ID ${subscription.planId} não gera comissão de afiliado.`);
      return;
    }

    const referrer = await Client.findByPk(client.referredByClientId, { transaction });
    if (!referrer) {
      logger.error(`[AffiliateService] Indicador ID ${client.referredByClientId} não encontrado.`);
      return;
    }

    const commissionValue = parseFloat(plan.affiliateCommissionValue);

    // IDEMPOTÊNCIA: uma comissão por assinatura. Se o webhook do Mercado Pago for
    // reentregue, não credita de novo (findOrCreate na coluna única subscriptionId).
    const [commissionRecord, created] = await AffiliateCommission.findOrCreate({
      where: { subscriptionId: subscription.id },
      defaults: {
        affiliateClientId: referrer.id,
        referredClientId: client.id,
        subscriptionId: subscription.id,
        planId: plan.id,
        planName: plan.name,
        amount: commissionValue,
        status: 'Creditada',
      },
      transaction,
    });

    if (!created) {
      logger.info(`[AffiliateService] Comissão da assinatura ${subscription.id} já registrada. Ignorando (idempotência).`);
      return;
    }

    const newBalance = parseFloat(referrer.balance || 0) + commissionValue;
    await referrer.update({ balance: newBalance }, { transaction });

    logger.info(`[AffiliateService] Comissão de R$${commissionValue} creditada ao afiliado ID ${referrer.id} pela assinatura ${subscription.id} do cliente ID ${client.id}.`);

    // Notificar o indicador via WhatsApp
    try {
      const { sendWhatsappMessage } = require('../../services/whatsappService');
      const subscriberName = client.name ? client.name.split(' ')[0] : 'Um novo cliente';
      const notificationMessage = `💰 *Comissão Recebida!* 💰\n\n` +
        `Parabéns! Você acabou de ganhar uma comissão de *R$ ${commissionValue.toFixed(2)}* porque *${subscriberName}* assinou o MAP através da sua indicação.\n\n` +
        `Seu novo saldo é: *R$ ${newBalance.toFixed(2)}*.\n\n` +
        `Continue indicando e aumentando seus ganhos! 🚀`;

      await sendWhatsappMessage(referrer.phone, notificationMessage);
      logger.info(`[AffiliateService] Notificação de comissão enviada para o indicador ID ${referrer.id} (${referrer.phone}).`);
    } catch (notifyError) {
      logger.error(`[AffiliateService] Erro ao notificar indicador ID ${referrer.id} sobre comissão: ${notifyError.message}`);
    }

  } catch (error) {
    logger.error(`[AffiliateService] Erro ao processar comissão para afiliado: ${error.message}`);
    throw error;
  }
}

/**
 * Busca um afiliado pelo código de indicação ou pelo slug personalizado.
 * @param {string} identifier - O código ou slug do afiliado.
 * @param {object} options - Opções do Sequelize.
 * @returns {Promise<Client|null>}
 */
async function findAffiliateByIdentifier(identifier, options = {}) {
  if (!identifier) return null;
  const uppercased = identifier.toUpperCase();
  return await Client.findOne({
    where: {
      [Op.or]: [
        { affiliateCode: uppercased },
        { affiliateSlug: identifier }
      ]
    },
    ...options
  });
}

/**
 * Registra um clique no link de um afiliado.
 * @param {string} identifier - Código ou Slug do afiliado.
 */
async function trackClick(identifier) {
  try {
    const affiliate = await findAffiliateByIdentifier(identifier);
    if (affiliate) {
      await affiliate.increment('affiliateLinkClicks');
      // Registra a abertura individual (para o admin ver horário e conversão).
      try { await AffiliateClick.create({ affiliateClientId: affiliate.id }); } catch (e) { /* não crítico */ }
      logger.info(`[AffiliateService] Clique registrado para o afiliado ID ${affiliate.id} (${identifier}).`);
    }
  } catch (error) {
    logger.error(`[AffiliateService] Erro ao registrar clique para "${identifier}": ${error.message}`);
  }
}

/**
 * Atualiza o slug de afiliado de um cliente.
 */
async function updateAffiliateSlug(clientId, newSlug) {
  if (!newSlug || newSlug.trim() === '') {
    throw { statusCode: 400, message: 'O slug não pode ser vazio.' };
  }

  const slugRegex = /^[a-z0-9-]+$/;
  if (!slugRegex.test(newSlug)) {
    throw { statusCode: 400, message: 'O slug deve conter apenas letras minúsculas, números e hifens.' };
  }

  const t = await sequelize.transaction();
  try {
    const existingSlug = await Client.findOne({
      where: { affiliateSlug: newSlug, id: { [Op.ne]: clientId } },
      transaction: t
    });

    if (existingSlug) {
      throw { statusCode: 409, message: 'Este link já está sendo usado por outro parceiro.' };
    }

    const client = await Client.findByPk(clientId, { transaction: t });
    await client.update({ affiliateSlug: newSlug }, { transaction: t });
    await t.commit();
    return client.toJSON();
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

/**
 * Obtém o dashboard de afiliado para um cliente com métricas avançadas.
 */
async function getAffiliateDashboard(affiliateClientId) {
  try {
    const affiliate = await Client.findByPk(affiliateClientId, {
      attributes: ['id', 'name', 'balance', 'affiliateCode', 'affiliateSlug', 'affiliateLinkClicks', 'asaasPayoutPixKey']
    });

    if (!affiliate) {
      throw { statusCode: 404, message: 'Afiliado não encontrado.' };
    }

    // Se o afiliado não tiver código, vamos gerar um agora para evitar 'undefined' no front
    if (!affiliate.affiliateCode) {
      const { generateUniqueAffiliateCode } = require('../ClientAuth/authUtils');
      const newCode = await generateUniqueAffiliateCode();
      await Client.update({ affiliateCode: newCode }, { where: { id: affiliate.id } });
      affiliate.affiliateCode = newCode;
      logger.info(`[AffiliateService] Código de afiliado gerado retroativamente para ID ${affiliate.id}: ${newCode}`);
    }

    const totalReferrals = await Client.count({
      where: { referredByClientId: affiliateClientId }
    });

    // Total GANHO (histórico bruto) vem do ledger de comissões creditadas.
    // O saldo atual (para saque) continua em affiliate.balance.
    const totalEarnedLedger = await AffiliateCommission.sum('amount', {
      where: { affiliateClientId, status: 'Creditada' }
    });
    const totalEarned = parseFloat(totalEarnedLedger || affiliate.balance || 0);

    const activeReferralsCount = await Client.count({
      distinct: true,
      where: { referredByClientId: affiliateClientId },
      include: [{
        model: Subscription,
        as: 'subscriptions',
        where: { status: 'Ativa' },
        required: true
      }]
    });

    const revenueResult = await Subscription.findAll({
      attributes: [
        [sequelize.fn('SUM', sequelize.col('plan.price')), 'totalRevenue']
      ],
      where: {
        status: 'Ativa',
        clientId: {
          [Op.in]: sequelize.literal(`(SELECT id FROM clients WHERE "referredByClientId" = ${affiliateClientId})`)
        }
      },
      include: [{
        model: Plan,
        as: 'plan',
        attributes: []
      }],
      raw: true
    });
    const totalRevenueGenerated = parseFloat(revenueResult[0]?.totalRevenue || 0);

    const totalClicks = affiliate.affiliateLinkClicks || 0;
    const conversionRate = totalClicks > 0 ? ((totalReferrals / totalClicks) * 100).toFixed(2) : 0;

    const dashboardData = {
      summary: affiliate.toJSON(),
      metrics: {
        totalReferrals,
        activeReferrals: activeReferralsCount,
        totalEarned,
        totalRevenueGenerated,
        totalClicks,
        conversionRate: parseFloat(conversionRate)
      }
    };

    logger.info(`[AffiliateService] Dashboard completo para afiliado ID ${affiliateClientId} gerado.`);
    return dashboardData;

  } catch (error) {
    logger.error(`[AffiliateService] Erro ao buscar dashboard do afiliado ID ${affiliateClientId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAffiliateReferralsHistory(affiliateClientId) {
  try {
    const referrals = await Client.findAll({
      where: { referredByClientId: affiliateClientId },
      include: [
        {
          model: Subscription,
          as: 'subscriptions',
          where: { status: 'Ativa' },
          required: false,
          include: [{ model: Plan, as: 'plan' }]
        }
      ],
      order: [['createdAt', 'DESC']],
    });

    if (referrals.length === 0) {
      return [];
    }

    const history = referrals.map(referral => {
      const firstActiveSubscription = referral.subscriptions
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .find(sub => sub.status === 'Ativa');

      return {
        referredClientId: referral.id,
        name: referral.name,
        email: referral.email,
        phone: referral.phone,
        joinDate: referral.createdAt,
        status: firstActiveSubscription ? 'Ativo' : 'Cadastro',
        subscription: firstActiveSubscription
          ? {
            planName: firstActiveSubscription.plan.name,
            subscriptionDate: firstActiveSubscription.startDate,
            commissionEarned: parseFloat(firstActiveSubscription.plan.affiliateCommissionValue)
          }
          : null
      };
    });

    return history;

  } catch (error) {
    logger.error(`[AffiliateService] Erro ao buscar histórico de indicações para o afiliado ID ${affiliateClientId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAffiliateRanking() {
  try {
    const ranking = await Client.findAll({
      attributes: [
        'id', 'name', 'affiliateCode', 'affiliateSlug',
        [sequelize.literal('(SELECT COUNT(*) FROM clients AS c WHERE c."referredByClientId" = "Client".id)'), 'referralsCount'],
        [sequelize.literal('(SELECT COALESCE(SUM(p.price), 0) FROM subscriptions s JOIN plans p ON s."planId" = p.id JOIN clients c ON s."clientId" = c.id WHERE c."referredByClientId" = "Client".id AND s.status = \'Ativa\')'), 'revenueGenerated']
      ],
      where: {
        affiliateCode: { [Op.ne]: null }
      },
      order: [[sequelize.literal('"revenueGenerated"'), 'DESC']],
      limit: 10,
      raw: true
    });

    return ranking.map(item => ({
      ...item,
      referralsCount: parseInt(item.referralsCount, 10),
      revenueGenerated: parseFloat(item.revenueGenerated)
    }));
  } catch (error) {
    logger.error(`[AffiliateService] Erro ao buscar ranking de afiliados: ${error.message}`);
    throw error;
  }
}

/**
 * Histórico de comissões do afiliado por PERÍODO (hoje/semana/mês/ano ou datas).
 * Lê do ledger (AffiliateCommission), então mostra cada venda com data e valor.
 */
async function getAffiliateCommissions(affiliateClientId, { period = 'mes', dateStart, dateEnd } = {}) {
  try {
    const now = new Date();
    let start, end;
    if (dateStart && dateEnd) {
      start = new Date(`${dateStart}T00:00:00`);
      end = new Date(`${dateEnd}T23:59:59.999`);
    } else {
      end = new Date(now); end.setHours(23, 59, 59, 999);
      start = new Date(now);
      if (period === 'hoje') {
        start.setHours(0, 0, 0, 0);
      } else if (period === 'semana') {
        start.setDate(now.getDate() - 6); start.setHours(0, 0, 0, 0);
      } else if (period === 'ano') {
        start = new Date(now.getFullYear(), 0, 1);
      } else { // mes (default)
        start = new Date(now.getFullYear(), now.getMonth(), 1);
      }
    }

    const commissions = await AffiliateCommission.findAll({
      where: {
        affiliateClientId,
        status: 'Creditada',
        createdAt: { [Op.between]: [start, end] },
      },
      include: [{ model: Client, as: 'referred', attributes: ['id', 'name', 'phone'] }],
      order: [['createdAt', 'DESC']],
    });

    const total = commissions.reduce((s, c) => s + parseFloat(c.amount || 0), 0);

    return {
      period,
      dateStart: start.toISOString().split('T')[0],
      dateEnd: end.toISOString().split('T')[0],
      total: parseFloat(total.toFixed(2)),
      count: commissions.length,
      commissions: commissions.map(c => ({
        id: c.id,
        referredName: c.referred?.name || 'Cliente',
        planName: c.planName,
        amount: parseFloat(c.amount),
        date: c.createdAt,
        status: c.status,
      })),
    };
  } catch (error) {
    logger.error(`[AffiliateService] Erro ao buscar comissões (período) do afiliado ID ${affiliateClientId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Estorna a comissão de uma assinatura (ex.: reembolso/cancelamento no Mercado Pago):
 * marca como 'Estornada' e desconta do saldo do afiliado. Idempotente.
 */
async function reverseAffiliateCommission(subscriptionId) {
  const t = await sequelize.transaction();
  try {
    const commission = await AffiliateCommission.findOne({ where: { subscriptionId, status: 'Creditada' }, transaction: t });
    if (!commission) { await t.commit(); return; }
    await commission.update({ status: 'Estornada' }, { transaction: t });
    const referrer = await Client.findByPk(commission.affiliateClientId, { transaction: t });
    if (referrer) {
      const newBalance = Math.max(0, parseFloat(referrer.balance || 0) - parseFloat(commission.amount || 0));
      await referrer.update({ balance: newBalance }, { transaction: t });
    }
    await t.commit();
    logger.info(`[AffiliateService] Comissão da assinatura ${subscriptionId} estornada (afiliado ${commission.affiliateClientId}).`);
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`[AffiliateService] Erro ao estornar comissão da assinatura ${subscriptionId}: ${error.message}`);
  }
}

/**
 * Solicita SAQUE do saldo atual: cria o registro no histórico (status 'Solicitado')
 * e ZERA o saldo do afiliado. O pagamento é feito manualmente pelo admin, que
 * depois marca como 'Pago'.
 */
async function requestPayout(affiliateClientId) {
  const t = await sequelize.transaction();
  try {
    const affiliate = await Client.findByPk(affiliateClientId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!affiliate) { throw { statusCode: 404, message: 'Afiliado não encontrado.' }; }
    const balance = parseFloat(affiliate.balance || 0);
    if (balance < MIN_WITHDRAWAL) {
      throw { statusCode: 400, message: `Saldo mínimo para saque é R$ ${MIN_WITHDRAWAL.toFixed(2)}. Seu saldo é R$ ${balance.toFixed(2)}.` };
    }
    const payout = await AffiliatePayout.create({
      affiliateClientId,
      amount: balance,
      pixKey: affiliate.asaasPayoutPixKey || null,
      status: 'Solicitado',
    }, { transaction: t });
    // "Fecha" as comissões em aberto (payoutId null) neste saque -> vão pro histórico agrupadas.
    await AffiliateCommission.update(
      { payoutId: payout.id },
      { where: { affiliateClientId, status: 'Creditada', payoutId: null }, transaction: t }
    );
    await affiliate.update({ balance: 0 }, { transaction: t });
    await t.commit();
    logger.info(`[AffiliateService] Saque solicitado pelo afiliado ${affiliateClientId}: R$ ${balance.toFixed(2)} (payout ${payout.id}).`);

    // Avisa o suporte/admin (não crítico).
    try {
      const { sendWhatsappMessage } = require('../../services/whatsappService');
      const adminPhone = process.env.ADMIN_PHONE_FOR_ALERTS || process.env.ADMIN_PHONE_FOR_SUMMARIES;
      if (adminPhone) {
        await sendWhatsappMessage(adminPhone, `💸 *Novo pedido de saque de afiliado*\nAfiliado: ${affiliate.name} (${affiliate.phone})\nValor: R$ ${balance.toFixed(2)}\nPIX: ${affiliate.asaasPayoutPixKey || 'não informada'}`, { force: true });
      }
    } catch (e) { logger.warn(`[AffiliateService] Falha ao avisar admin do saque: ${e.message}`); }

    return payout.toJSON();
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/** Histórico de saques do afiliado, cada um COM as comissões que ele fechou. */
async function getAffiliatePayouts(affiliateClientId) {
  const payouts = await AffiliatePayout.findAll({
    where: { affiliateClientId },
    order: [['createdAt', 'DESC']],
  });
  const result = [];
  for (const p of payouts) {
    const comms = await AffiliateCommission.findAll({
      where: { payoutId: p.id },
      include: [{ model: Client, as: 'referred', attributes: ['id', 'name'] }],
      order: [['createdAt', 'ASC']],
    });
    result.push({
      ...p.toJSON(),
      commissions: comms.map(c => ({
        id: c.id, referredName: c.referred?.name || 'Cliente', planName: c.planName,
        amount: parseFloat(c.amount), date: c.createdAt,
      })),
    });
  }
  return result;
}

/** Comissões EM ABERTO (ainda não sacadas) do afiliado. */
async function getOpenCommissions(affiliateClientId) {
  const comms = await AffiliateCommission.findAll({
    where: { affiliateClientId, status: 'Creditada', payoutId: null },
    include: [{ model: Client, as: 'referred', attributes: ['id', 'name'] }],
    order: [['createdAt', 'DESC']],
  });
  const total = comms.reduce((s, c) => s + parseFloat(c.amount || 0), 0);
  return {
    total: parseFloat(total.toFixed(2)),
    count: comms.length,
    commissions: comms.map(c => ({
      id: c.id, referredName: c.referred?.name || 'Cliente', planName: c.planName,
      amount: parseFloat(c.amount), date: c.createdAt,
    })),
  };
}

/** (Admin) Detalhe de 1 afiliado: cada abertura do link (possível cliente),
 * com horário, e se converteu (plano, valor do plano e comissão). */
async function getAffiliateDetailForAdmin(affiliateClientId) {
  const affiliate = await Client.findByPk(affiliateClientId, {
    attributes: ['id', 'name', 'phone', 'email', 'balance', 'affiliateCode', 'affiliateSlug', 'affiliateLinkClicks', 'asaasPayoutPixKey'],
  });
  if (!affiliate) throw { statusCode: 404, message: 'Afiliado não encontrado.' };

  const clicks = await AffiliateClick.findAll({
    where: { affiliateClientId },
    include: [{ model: Client, as: 'converted', attributes: ['id', 'name', 'phone'] }],
    order: [['createdAt', 'DESC']],
    limit: 500,
  });

  const rows = [];
  for (const click of clicks) {
    let plano = null, planValue = null, commission = null, converteu = false, clientName = null;
    if (click.convertedClientId && click.converted) {
      clientName = click.converted.name;
      const sub = await Subscription.findOne({
        where: { clientId: click.convertedClientId, status: 'Ativa' },
        include: [{ model: Plan, as: 'plan' }],
        order: [['createdAt', 'DESC']],
      });
      if (sub && sub.plan) {
        converteu = true;
        plano = sub.plan.name;
        planValue = parseFloat(sub.plan.price);
        commission = parseFloat(sub.plan.affiliateCommissionValue);
      }
    }
    rows.push({ id: click.id, openedAt: click.createdAt, clientName, plano, planValue, commission, converteu });
  }
  return { affiliate: affiliate.toJSON(), rows };
}

/** (Admin) Lista TODOS os saques pendentes (Solicitado) de todos os afiliados. */
async function getPendingPayouts() {
  const payouts = await AffiliatePayout.findAll({
    where: { status: 'Solicitado' },
    include: [{ model: Client, as: 'affiliate', attributes: ['id', 'name', 'phone', 'asaasPayoutPixKey'] }],
    order: [['createdAt', 'ASC']],
  });
  return payouts.map(p => p.toJSON());
}

/** (Admin) Marca um saque como pago. Não mexe no saldo (já foi zerado no pedido). */
async function markPayoutPaid(payoutId) {
  const payout = await AffiliatePayout.findByPk(payoutId);
  if (!payout) throw { statusCode: 404, message: 'Saque não encontrado.' };
  if (payout.status === 'Pago') return payout.toJSON();
  await payout.update({ status: 'Pago', paidAt: new Date() });
  logger.info(`[AffiliateService] Saque ${payoutId} marcado como PAGO.`);
  return payout.toJSON();
}

module.exports = {
  getAffiliateDashboard,
  sendAffiliateLinkNotification,
  processNewSubscriptionForAffiliate,
  getAffiliateReferralsHistory,
  getAffiliateCommissions,
  reverseAffiliateCommission,
  requestPayout,
  getAffiliatePayouts,
  getOpenCommissions,
  getAffiliateDetailForAdmin,
  getPendingPayouts,
  markPayoutPaid,
  trackClick,
  getAffiliateRanking,
  findAffiliateByIdentifier,
  updateAffiliateSlug
};

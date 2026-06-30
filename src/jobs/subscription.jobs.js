// src/jobs/subscription.jobs.js
const { Op } = require('sequelize');
const { Client, Subscription } = require('../database');
const clientService = require('../features/Client/client.service');
const { sendWhatsappMessage } = require('../services/whatsappService');
const logger = require('../utils/logger');
const cron = require('node-cron');

// <<< INÍCIO DA MODIFICAÇÃO >>>
// A URL de checkout agora é a variável principal para renovação
const CHECKOUT_URL = process.env.MERCADO_PAGO_CHECKOUT_URL || "https://map-nocontrole.com.br/#planos";

/**
 * Envia um aviso para clientes cujo plano expira em 1 ou 3 dias.
 */
async function notifyExpiringSubscriptions() {
    logger.info('[JOB NOTIFICAÇÃO EXPIRAÇÃO] Iniciando verificação de planos prestes a expirar...');

    // <<< CHECK GLOBAL SWITCH REMOVED FOR CORE FUNCTIONALITY >>>
    // const systemService = require('../features/System/system.service');
    // const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
    // if (!isEnabled) {
    //     logger.warn('[JOB NOTIFICAÇÃO EXPIRAÇÃO] Job abortado: Global switch OFF.');
    //     return;
    // }
    // ---------------------------

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const threeDaysFromNow = new Date(today);
    threeDaysFromNow.setDate(today.getDate() + 3);

    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const threeDaysStr = threeDaysFromNow.toISOString().split('T')[0];

    try {
        const clientsToNotify = await Client.findAll({
            where: {
                status: 'Ativo',
                accessLevel: { [Op.notIn]: ['gratuito', 'inadimplente', 'vitalicio_basico', 'vitalicio_avancado'] },
                accessExpiresAt: {
                    [Op.in]: [tomorrowStr, threeDaysStr]
                }
            }
        });

        if (clientsToNotify.length === 0) {
            logger.info('[JOB NOTIFICAÇÃO EXPIRAÇÃO] Nenhum plano expirando em 1 ou 3 dias.');
            return;
        }

        logger.info(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Encontrados ${clientsToNotify.length} clientes para notificar.`);

        for (const client of clientsToNotify) {
            const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
            const daysRemaining = client.accessExpiresAt === tomorrowStr ? 'amanhã' : 'em 3 dias';

            const message = `👋 Olá, ${clientName}!\n\n` +
                `Um lembrete amigável de que sua assinatura do MAP no Controle expira *${daysRemaining}*! 😱\n\n` +
                `Para garantir que você não perca acesso às suas ferramentas de organização, renove seu plano a qualquer momento. É super rápido!\n\n` +
                `👉 Clique aqui para renovar: ${CHECKOUT_URL}\n\n` +
                `Qualquer dúvida, é só me chamar! 😉`;

            await sendWhatsappMessage(client.phone, message);
            logger.info(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Mensagem de aviso enviada para ${client.phone}.`);
        }

    } catch (error) {
        logger.error(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Erro ao notificar assinaturas: ${error.message}`, { error });
    }
}

/**
 * <<< NOVA FUNÇÃO >>>
 * Envia um lembrete diário para usuários com planos já expirados.
 */
async function sendDailyRenewalRemindersToExpiredUsers() {
    logger.info('[JOB LEMBRETE EXPIRADOS] Iniciando verificação de usuários com planos expirados...');

    // <<< CHECK GLOBAL SWITCH REMOVED FOR CORE FUNCTIONALITY >>>
    // const systemService = require('../features/System/system.service');
    // const isEnabled = await systemService.isAutomatedJobProcessingEnabled();
    // if (!isEnabled) {
    //     logger.warn('[JOB LEMBRETE EXPIRADOS] Job abortado: Global switch OFF.');
    //     return;
    // }
    // ---------------------------

    const today = new Date().toISOString().split('T')[0];

    try {
        const expiredClients = await Client.findAll({
            where: {
                status: 'Ativo', // Apenas para não incomodar quem foi inativado/bloqueado
                accessLevel: { [Op.notIn]: ['gratuito', 'inadimplente', 'vitalicio_basico', 'vitalicio_avancado'] },
                accessExpiresAt: {
                    [Op.lt]: today // A data de expiração é anterior a hoje
                }
            }
        });

        if (expiredClients.length === 0) {
            logger.info('[JOB LEMBRETE EXPIRADOS] Nenhum cliente com plano expirado encontrado para lembrar.');
            return;
        }

        logger.info(`[JOB LEMBRETE EXPIRADOS] Encontrados ${expiredClients.length} clientes com planos expirados. Enviando lembretes...`);

        for (const client of expiredClients) {
            const clientName = client.name ? client.name.split(' ')[0] : 'Olá';

            const message = `Olá, ${clientName}. 😕\n\n` +
                `Sua assinatura do MAP no Controle expirou. Seus dados continuam guardados com segurança, mas as funcionalidades premium foram desativadas.\n\n` +
                `Para reativar seu acesso completo e continuar no controle, é só escolher um novo plano em nosso site:\n` +
                `${CHECKOUT_URL}\n\n` +
                `Assim que o pagamento for confirmado, seu acesso é liberado na hora! ✨`;

            // force: true — mensagem de win-back PRECISA chegar a quem está expirado
            // (o validateMessageRecipient bloquearia, pois o plano já venceu).
            const sent = await sendWhatsappMessage(client.phone, message, { force: true });
            if (sent) {
                logger.info(`[JOB LEMBRETE EXPIRADOS] Mensagem de renovação enviada para ${client.phone}.`);
            } else {
                logger.warn(`[JOB LEMBRETE EXPIRADOS] Falha ao enviar renovação para ${client.phone}.`);
            }
        }

    } catch (error) {
        logger.error(`[JOB LEMBRETE EXPIRADOS] Erro ao notificar usuários expirados: ${error.message}`, { error });
    }
}

/**
 * Marca como INADIMPLENTE os clientes cujo plano venceu (accessExpiresAt < hoje).
 * - Mantém status 'Ativo' para PERMITIR o login (que cai na tela de pagamento).
 * - Encerra a(s) assinatura(s) ativa(s) vencida(s) como 'Expirada'.
 * - Envia UMA mensagem no WhatsApp com o link de pagamento (force, pois o plano venceu).
 * Roda 1x/dia; como o filtro exclui 'inadimplente', cada cliente é processado só uma vez.
 */
async function markExpiredSubscriptionsAsInadimplente() {
    logger.info('[JOB EXPIRACAO->INADIMPLENTE] Verificando planos vencidos...');
    const today = new Date().toISOString().split('T')[0];
    const checkoutBaseUrl = process.env.CHECKOUT_BASE_URL || "https://www.map-nocontrole.com.br";
    try {
        const expired = await Client.findAll({
            where: {
                status: 'Ativo',
                accessLevel: { [Op.notIn]: ['gratuito', 'inadimplente', 'vitalicio_basico', 'vitalicio_avancado'] },
                accessExpiresAt: { [Op.lt]: today },
            }
        });

        if (expired.length === 0) {
            logger.info('[JOB EXPIRACAO->INADIMPLENTE] Nenhum plano recém-vencido.');
            return;
        }
        logger.info(`[JOB EXPIRACAO->INADIMPLENTE] ${expired.length} cliente(s) a marcar como inadimplente.`);

        for (const client of expired) {
            try {
                // Mantém status 'Ativo' (login permitido -> tela de pagamento); só rebaixa o nível.
                await client.update({ accessLevel: 'inadimplente' });
                await Subscription.update(
                    { status: 'Expirada' },
                    { where: { clientId: client.id, status: 'Ativa' } }
                );

                const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
                const message =
                    `Olá, ${clientName}. ⚠️\n\n` +
                    `Sua assinatura do MAP no Controle *venceu* e sua conta ficou como *inadimplente*. Seus dados estão guardados, mas os recursos foram pausados.\n\n` +
                    `Para reativar agora, escolha um plano:\n\n` +
                    `*Plano Básico*\n` +
                    `- Mensal: ${checkoutBaseUrl}/checkout/7\n` +
                    `- Anual: ${checkoutBaseUrl}/checkout/8\n\n` +
                    `*Plano Avançado*\n` +
                    `- Mensal: ${checkoutBaseUrl}/checkout/9\n` +
                    `- Anual: ${checkoutBaseUrl}/checkout/10\n\n` +
                    `Assim que o pagamento for confirmado, seu acesso é liberado na hora! ✨`;

                await sendWhatsappMessage(client.phone, message, { force: true });
                logger.info(`[JOB EXPIRACAO->INADIMPLENTE] Cliente ${client.id} marcado inadimplente + link enviado.`);
            } catch (e) {
                logger.error(`[JOB EXPIRACAO->INADIMPLENTE] Erro no cliente ${client.id}: ${e.message}`);
            }
        }
    } catch (error) {
        logger.error(`[JOB EXPIRACAO->INADIMPLENTE] Erro geral: ${error.message}`, { error });
    }
}

/**
 * <<< FUNÇÃO MODIFICADA >>>
 * Inicia todos os jobs relacionados a assinaturas.
 */
function startSubscriptionJobs() {
    // Job 0: Marcar como INADIMPLENTE os planos vencidos (mantém login -> tela de pagamento)
    // e mandar o link de pagamento. Roda todo dia às 5h (antes dos avisos).
    const expireSchedule = '0 5 * * *';
    if (cron.validate(expireSchedule)) {
        logger.info(`[JOB EXPIRACAO->INADIMPLENTE] Agendado para: ${expireSchedule}`);
        cron.schedule(expireSchedule, markExpiredSubscriptionsAsInadimplente, {
            timezone: process.env.TZ || "America/Sao_Paulo",
        });
    } else {
        logger.error(`[JOB EXPIRACAO->INADIMPLENTE] Schedule cron inválido: ${expireSchedule}.`);
    }

    // Job 1: Notificar planos que estão PRESTES a expirar. Roda todo dia às 9 da manhã.
    const expiringSchedule = '0 9 * * *';
    if (cron.validate(expiringSchedule)) {
        logger.info(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Agendado para: ${expiringSchedule}`);
        cron.schedule(expiringSchedule, notifyExpiringSubscriptions, {
            timezone: process.env.TZ || "America/Sao_Paulo",
        });
    } else {
        logger.error(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Schedule cron inválido: ${expiringSchedule}.`);
    }

    // Job 2: Notificar planos que JÁ expiraram. Roda todo dia às 10 da manhã.
    const expiredSchedule = '0 10 * * *';
    if (cron.validate(expiredSchedule)) {
        logger.info(`[JOB LEMBRETE EXPIRADOS] Agendado para: ${expiredSchedule}`);
        cron.schedule(expiredSchedule, sendDailyRenewalRemindersToExpiredUsers, {
            timezone: process.env.TZ || "America/Sao_Paulo",
        });
    } else {
        logger.error(`[JOB LEMBRETE EXPIRADOS] Schedule cron inválido: ${expiredSchedule}.`);
    }
}

// A função handleExpiredSubscriptions foi removida pois sua lógica foi integrada e melhorada
// no novo job 'sendDailyRenewalRemindersToExpiredUsers' e no bloqueio do 'whatsapp.service'.
// O acesso é alterado para 'gratuito' no momento da expiração pelo job de verificação de pagamentos (não presente aqui, mas assumido).

module.exports = {
    startSubscriptionJobs
};
// <<< FIM DA MODIFICAÇÃO >>>
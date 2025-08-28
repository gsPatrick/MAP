// src/jobs/subscriptionJobs.js
const { Op } = require('sequelize');
const { Client } = require('../database');
const clientService = require('../features/Client/client.service');
const { sendWhatsappMessage } = require('../services/whatsappService');
const logger = require('../utils/logger');

const PLAN_SITE_URL = process.env.PLAN_SITE_URL || "https://map-nocontrole.com.br/#planos";

/**
 * Envia uma mensagem de aviso para clientes cujo plano expira amanhã.
 */
async function notifyExpiringSubscriptions() {
    logger.info('[JOB] Iniciando verificação de assinaturas expirando amanhã...');
    try {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const clientsToNotify = await Client.findAll({
            where: {
                status: 'Ativo',
                accessLevel: { [Op.notIn]: ['gratuito', 'vitalicio_basico', 'vitalicio_avancado'] },
                accessExpiresAt: {
                    [Op.eq]: tomorrowStr
                }
            }
        });

        if (clientsToNotify.length === 0) {
            logger.info('[JOB] Nenhuma assinatura expirando amanhã.');
            return;
        }

        logger.info(`[JOB] Encontrados ${clientsToNotify.length} clientes com plano expirando amanhã. Enviando avisos...`);

        for (const client of clientsToNotify) {
            const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
            const message = `👋 Olá, ${clientName}!\n\n` +
                            `Só passando para te avisar que sua assinatura do MAP no Controle expira *amanhã*! 😱\n\n` +
                            `Para não perder acesso às suas ferramentas de organização, você pode renovar seu plano a qualquer momento. É super rápido!\n\n` +
                            `Clique aqui para renovar: ${PLAN_SITE_URL}\n\n` +
                            `Qualquer dúvida, é só me chamar! 😉`;
            
            await sendWhatsappMessage(client.phone, message);
            logger.info(`[JOB] Mensagem de aviso de expiração enviada para ${client.phone}.`);
        }
    } catch (error) {
        logger.error(`[JOB] Erro ao notificar assinaturas expirando: ${error.message}`, { error });
    }
}

/**
 * Desativa o acesso de clientes cujo plano expirou ontem.
 */
async function handleExpiredSubscriptions() {
    logger.info('[JOB] Iniciando verificação de assinaturas que expiraram...');
    try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        const clientsToExpire = await Client.findAll({
            where: {
                status: 'Ativo',
                accessLevel: { [Op.notIn]: ['gratuito', 'vitalicio_basico', 'vitalicio_avancado'] },
                accessExpiresAt: {
                    [Op.eq]: yesterdayStr
                }
            }
        });

        if (clientsToExpire.length === 0) {
            logger.info('[JOB] Nenhuma assinatura expirou ontem.');
            return;
        }

        logger.info(`[JOB] Encontrados ${clientsToExpire.length} clientes cujo plano expirou. Atualizando status...`);

        for (const client of clientsToExpire) {
            // Atualiza o nível de acesso para 'gratuito'
            await clientService.updateClientAccessLevel(client.id, { accessLevel: 'gratuito' });
            
            const clientName = client.name ? client.name.split(' ')[0] : 'Olá';
            const message = `Olá, ${clientName}. 😕\n\n` +
                            `Sua assinatura do MAP no Controle expirou. Seus dados continuam guardados com segurança, mas as funcionalidades premium foram desativadas.\n\n` +
                            `Para reativar seu acesso completo e continuar no controle, é só escolher um novo plano em nosso site:\n` +
                            `${PLAN_SITE_URL}\n\n` +
                            `Assim que o pagamento for confirmado, seu acesso é liberado na hora! ✨`;

            await sendWhatsappMessage(client.phone, message);
            logger.info(`[JOB] Status do cliente ${client.phone} atualizado para gratuito e mensagem de expiração enviada.`);
        }
    } catch (error) {
        logger.error(`[JOB] Erro ao lidar com assinaturas expiradas: ${error.message}`, { error });
    }
}

// <<< FUNÇÃO NOVA >>>
async function notifyExpiringSubscriptions() {
    logger.info('[JOB NOTIFICAÇÃO EXPIRAÇÃO] Iniciando verificação de planos prestes a expirar...');
    
    const PLAN_SITE_URL = process.env.PLAN_SITE_URL || "https://map-nocontrole.com.br/#planos";
    const today = new Date();
    
    // Calcula as datas de "amanhã" e "daqui a 3 dias"
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
                accessLevel: { [Op.notIn]: ['gratuito', 'vitalicio_basico', 'vitalicio_avancado'] },
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
                            `👉 Clique aqui para renovar: ${PLAN_SITE_URL}\n\n` +
                            `Qualquer dúvida, é só me chamar! 😉`;
            
            await sendWhatsappMessage(client.phone, message);
            logger.info(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Mensagem de aviso enviada para ${client.phone}.`);
        }

    } catch (error) {
        logger.error(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Erro ao notificar assinaturas: ${error.message}`, { error });
    }
}

// <<< FUNÇÃO NOVA >>>
function startSubscriptionJobs() {
    // Roda todo dia às 9 da manhã
    const schedule = '0 9 * * *'; 
    if (cron.validate(schedule)) {
        logger.info(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Agendado para: ${schedule}`);
        cron.schedule(schedule, notifyExpiringSubscriptions, {
            timezone: process.env.TZ || "America/Sao_Paulo",
        });
    } else {
        logger.error(`[JOB NOTIFICAÇÃO EXPIRAÇÃO] Schedule cron inválido: ${schedule}.`);
    }
}


module.exports = {
    notifyExpiringSubscriptions,
    handleExpiredSubscriptions,
    startSubscriptionJobs
};
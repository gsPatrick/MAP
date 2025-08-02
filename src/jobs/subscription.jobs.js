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

module.exports = {
    notifyExpiringSubscriptions,
    handleExpiredSubscriptions
};
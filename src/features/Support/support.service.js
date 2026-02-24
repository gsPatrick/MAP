// d:/daniatualagrvai/MAP/src/features/Support/support.service.js
const { SupportTicket, Client } = require('../../models');
const { Op } = require('sequelize');

class SupportService {
    /**
     * Cria um novo chamado de suporte
     */
    async createTicket(clientId, ticketData) {
        return await SupportTicket.create({
            clientId,
            type: ticketData.type,
            subject: ticketData.subject,
            description: ticketData.description,
            priority: ticketData.priority || 'Media',
        });
    }

    /**
     * Lista chamados de um cliente específico
     */
    async listClientTickets(clientId) {
        return await SupportTicket.findAll({
            where: { clientId },
            order: [['createdAt', 'DESC']],
        });
    }

    /**
     * Lista todos os chamados (Admin)
     */
    async listAllTickets(filters = {}) {
        const where = {};
        if (filters.status) where.status = filters.status;
        if (filters.type) where.type = filters.type;

        return await SupportTicket.findAll({
            where,
            include: [
                {
                    model: Client,
                    as: 'client',
                    attributes: ['id', 'name', 'email', 'phone'],
                },
            ],
            order: [['createdAt', 'DESC']],
        });
    }

    /**
     * Atualiza o status ou dados de um chamado
     */
    async updateTicket(ticketId, updateData) {
        const ticket = await SupportTicket.findByPk(ticketId);
        if (!ticket) throw new Error('Chamado não encontrado.');

        if (updateData.status === 'Resolvido' && ticket.status !== 'Resolvido') {
            updateData.resolvedAt = new Date();
        }

        if (updateData.status && updateData.status !== ticket.status) {
            updateData.lastResponseAt = new Date();
        }

        return await ticket.update(updateData);
    }

    /**
     * Obtém métricas de suporte para o Admin
     */
    async getSupportMetrics() {
        const totalTickets = await SupportTicket.count();
        const statusCounts = await SupportTicket.findAll({
            attributes: ['status', [SupportTicket.sequelize.fn('COUNT', 'id'), 'count']],
            group: ['status'],
        });

        const resolvedTickets = await SupportTicket.findAll({
            where: {
                status: 'Resolvido',
                resolvedAt: { [Op.ne]: null },
            },
            attributes: [
                [
                    SupportTicket.sequelize.fn(
                        'AVG',
                        SupportTicket.sequelize.literal('julianday(resolvedAt) - julianday(createdAt)')
                    ),
                    'avgResponseDays',
                ],
            ],
        });

        // Nota: A função julianday é específica do SQLite. Se for PostgreSQL/MySQL, a sintaxe muda.
        // Como o sistema parece estar usando SQLite para desenvolvimento/local, vou manter assim ou usar uma abordagem mais genérica se necessário.
        // Vamos tentar uma abordagem mais manual para as métricas se der erro de DB.

        return {
            totalTickets,
            statusDistribution: statusCounts,
            avgResolutionTime: resolvedTickets[0]?.dataValues?.avgResponseDays || 0,
        };
    }
}

module.exports = new SupportService();

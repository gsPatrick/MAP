// src/features/Support/support.service.js
const { SupportTicket, SupportMessage, Client } = require('../../database');
const { Op } = require('sequelize');

class SupportService {
    /**
     * Cria um novo chamado (ticket) + a primeira mensagem do chat (a descrição).
     */
    async createTicket(clientId, ticketData) {
        const client = await Client.findByPk(clientId, { attributes: ['id', 'name'] });
        const ticket = await SupportTicket.create({
            clientId,
            type: ticketData.type,
            subject: ticketData.subject,
            description: ticketData.description,
            priority: ticketData.priority || 'Media',
            status: 'Aberto',
            lastResponseAt: new Date(),
        });
        // Primeira mensagem do chat = descrição do chamado.
        if (ticketData.description) {
            await SupportMessage.create({
                ticketId: ticket.id,
                senderType: 'client',
                senderName: client?.name || 'Cliente',
                message: ticketData.description,
            });
        }
        return ticket;
    }

    /**
     * Lista chamados de um cliente específico.
     */
    async listClientTickets(clientId) {
        return await SupportTicket.findAll({
            where: { clientId },
            order: [['updatedAt', 'DESC']],
        });
    }

    /**
     * Lista todos os chamados (Admin).
     */
    async listAllTickets(filters = {}) {
        const where = {};
        if (filters.status) where.status = filters.status;
        if (filters.type) where.type = filters.type;

        return await SupportTicket.findAll({
            where,
            include: [{ model: Client, as: 'client', attributes: ['id', 'name', 'email', 'phone'] }],
            order: [['updatedAt', 'DESC']],
        });
    }

    /**
     * Retorna 1 chamado com o histórico de mensagens (chat).
     * Se clientId for passado, valida que o chamado pertence ao cliente.
     */
    async getTicketWithMessages(ticketId, clientId = null) {
        const where = { id: ticketId };
        if (clientId) where.clientId = clientId;
        const ticket = await SupportTicket.findOne({
            where,
            include: [
                { model: Client, as: 'client', attributes: ['id', 'name', 'email', 'phone'] },
                { model: SupportMessage, as: 'messages', separate: true, order: [['createdAt', 'ASC']] },
            ],
        });
        if (!ticket) throw { statusCode: 404, message: 'Chamado não encontrado.' };
        return ticket;
    }

    /**
     * Adiciona uma mensagem no chat de um chamado.
     * senderType: 'client' | 'admin'
     */
    async addMessage(ticketId, { senderType, senderName, message }, clientId = null) {
        const where = { id: ticketId };
        if (clientId) where.clientId = clientId;
        const ticket = await SupportTicket.findOne({ where });
        if (!ticket) throw { statusCode: 404, message: 'Chamado não encontrado.' };
        if (!message || !message.trim()) throw { statusCode: 400, message: 'Mensagem vazia.' };

        const msg = await SupportMessage.create({
            ticketId,
            senderType,
            senderName: senderName || (senderType === 'admin' ? 'Suporte' : 'Cliente'),
            message: message.trim(),
        });

        // Cliente respondendo em chamado resolvido/cancelado -> reabre.
        const updates = { lastResponseAt: new Date() };
        if (senderType === 'client' && ['Resolvido', 'Cancelado'].includes(ticket.status)) {
            updates.status = 'Aberto';
        }
        await ticket.update(updates);

        return msg;
    }

    /**
     * Atualiza o status/dados de um chamado (Admin).
     */
    async updateTicket(ticketId, updateData) {
        const ticket = await SupportTicket.findByPk(ticketId);
        if (!ticket) throw { statusCode: 404, message: 'Chamado não encontrado.' };

        if (updateData.status === 'Resolvido' && ticket.status !== 'Resolvido') {
            updateData.resolvedAt = new Date();
        }
        if (updateData.status && updateData.status !== ticket.status) {
            updateData.lastResponseAt = new Date();
        }
        return await ticket.update(updateData);
    }

    /**
     * Métricas de suporte para o Admin (compatível com Postgres).
     */
    async getSupportMetrics() {
        const totalTickets = await SupportTicket.count();

        const statusRows = await SupportTicket.findAll({
            attributes: ['status', [SupportTicket.sequelize.fn('COUNT', SupportTicket.sequelize.col('id')), 'count']],
            group: ['status'],
        });
        const statusDistribution = statusRows.map(r => ({
            status: r.status,
            count: parseInt(r.dataValues.count, 10),
        }));

        // Tempo médio de resolução (em dias) calculado em JS -> sem função específica de banco.
        const resolved = await SupportTicket.findAll({
            where: { status: 'Resolvido', resolvedAt: { [Op.ne]: null } },
            attributes: ['createdAt', 'resolvedAt'],
        });
        let avgResolutionTime = 0;
        if (resolved.length > 0) {
            const totalDays = resolved.reduce((sum, t) => {
                const ms = new Date(t.resolvedAt).getTime() - new Date(t.createdAt).getTime();
                return sum + (ms / 86400000);
            }, 0);
            avgResolutionTime = parseFloat((totalDays / resolved.length).toFixed(1));
        }

        return { totalTickets, statusDistribution, avgResolutionTime };
    }
}

module.exports = new SupportService();

// d:/daniatualagrvai/MAP/src/features/Support/support.controller.js
const supportService = require('./support.service');

class SupportController {
    /**
     * Cliente cria um novo chamado
     */
    async createTicket(req, res) {
        try {
            const clientId = req.user.id;
            const ticket = await supportService.createTicket(clientId, req.body);
            return res.status(201).json({
                status: 'success',
                data: ticket,
            });
        } catch (error) {
            console.error('Erro ao criar chamado:', error);
            return res.status(500).json({
                status: 'error',
                message: 'Erro interno ao criar chamado.',
            });
        }
    }

    /**
     * Cliente lista seus próprios chamados
     */
    async listMyTickets(req, res) {
        try {
            const clientId = req.user.id;
            const tickets = await supportService.listClientTickets(clientId);
            return res.status(200).json({
                status: 'success',
                data: tickets,
            });
        } catch (error) {
            console.error('Erro ao listar chamados:', error);
            return res.status(500).json({
                status: 'error',
                message: 'Erro interno ao listar chamados.',
            });
        }
    }

    /**
     * Admin lista todos os chamados
     */
    async adminListTickets(req, res) {
        try {
            const tickets = await supportService.listAllTickets(req.query);
            return res.status(200).json({
                status: 'success',
                data: tickets,
            });
        } catch (error) {
            console.error('Erro ao listar chamados (Admin):', error);
            return res.status(500).json({
                status: 'error',
                message: 'Erro interno ao listar chamados.',
            });
        }
    }

    /**
     * Admin atualiza um chamado
     */
    async adminUpdateTicket(req, res) {
        try {
            const { id } = req.params;
            const ticket = await supportService.updateTicket(id, req.body);
            return res.status(200).json({
                status: 'success',
                data: ticket,
            });
        } catch (error) {
            console.error('Erro ao atualizar chamado:', error);
            return res.status(400).json({
                status: 'error',
                message: error.message || 'Erro ao atualizar chamado.',
            });
        }
    }

    /**
     * Admin obtém métricas
     */
    async adminGetMetrics(req, res) {
        try {
            const metrics = await supportService.getSupportMetrics();
            return res.status(200).json({
                status: 'success',
                data: metrics,
            });
        } catch (error) {
            console.error('Erro ao obter métricas de suporte:', error);
            return res.status(500).json({
                status: 'error',
                message: 'Erro interno ao obter métricas.',
            });
        }
    }
}

module.exports = new SupportController();

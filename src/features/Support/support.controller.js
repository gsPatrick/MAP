// d:/daniatualagrvai/MAP/src/features/Support/support.controller.js
const supportService = require('./support.service');

class SupportController {
    /**
     * Cliente cria um novo chamado
     */
    async createTicket(req, res) {
        try {
            const clientId = req.client.id;
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
            const clientId = req.client.id;
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
     * Cliente abre 1 chamado com o chat (mensagens).
     */
    async getMyTicket(req, res) {
        try {
            const ticket = await supportService.getTicketWithMessages(req.params.id, req.client.id);
            return res.status(200).json({ status: 'success', data: ticket });
        } catch (error) {
            return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Erro ao abrir chamado.' });
        }
    }

    /**
     * Cliente envia mensagem no chat do seu chamado.
     */
    async postMyMessage(req, res) {
        try {
            const msg = await supportService.addMessage(
                req.params.id,
                { senderType: 'client', senderName: req.client.name, message: req.body.message },
                req.client.id
            );
            return res.status(201).json({ status: 'success', data: msg });
        } catch (error) {
            return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Erro ao enviar mensagem.' });
        }
    }

    /**
     * Admin abre 1 chamado com o chat.
     */
    async adminGetTicket(req, res) {
        try {
            const ticket = await supportService.getTicketWithMessages(req.params.id);
            return res.status(200).json({ status: 'success', data: ticket });
        } catch (error) {
            return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Erro ao abrir chamado.' });
        }
    }

    /**
     * Admin envia mensagem no chat.
     */
    async adminPostMessage(req, res) {
        try {
            const msg = await supportService.addMessage(
                req.params.id,
                { senderType: 'admin', senderName: req.user?.name || 'Suporte', message: req.body.message }
            );
            return res.status(201).json({ status: 'success', data: msg });
        } catch (error) {
            return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Erro ao enviar mensagem.' });
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

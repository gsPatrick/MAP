// src/features/Admin/admin.controller.js
const adminService = require('./admin.service');
const clientService = require('../Client/client.service');
const whatsappService = require('../../services/whatsappService');

// <<< CONTROLLER ALTERADO >>>
// Lista todos os clientes com dados detalhados para o painel de admin.
const getAdminClientList = (req, res, next) => {
    adminService.getAdminClientList(req.query)
        .then(result => res.status(200).json({ status: 'success', ...result }))
        .catch(next);
};

const changeClientPhone = (req, res, next) => {
    const clientId = parseInt(req.params.clientId, 10);
    const { newPhoneNumber } = req.body;

    if (isNaN(clientId)) {
        return res.status(400).json({ status: 'fail', message: 'ID do cliente inválido.' });
    }
    if (!newPhoneNumber) {
        return res.status(400).json({ status: 'fail', message: 'O campo "newPhoneNumber" é obrigatório.' });
    }

    adminService.changeClientPhoneNumber(clientId, newPhoneNumber)
        .then(updatedClient => res.status(200).json({ status: 'success', data: updatedClient }))
        .catch(next);
};

// --- CRUD de Clientes (reutilizando clientService - mantido para compatibilidade) ---
const getAllClients = (req, res, next) => clientService.getAllClientContacts(req.query)
    .then(result => res.status(200).json({ status: 'success', ...result }))
    .catch(next);

const createClient = (req, res, next) => clientService.createClientContact(req.body)
    .then(newClient => res.status(201).json({ status: 'success', data: newClient }))
    .catch(next);

const updateClient = (req, res, next) => clientService.updateClientContact(req.params.clientId, req.body)
    .then(updatedClient => updatedClient ? res.status(200).json({ status: 'success', data: updatedClient }) : res.status(404).json({ status: 'fail', message: 'Cliente não encontrado.' }))
    .catch(next);

const deleteClient = (req, res, next) => clientService.deleteClientContact(req.params.clientId)
    .then(success => success ? res.status(204).send() : res.status(404).json({ status: 'fail', message: 'Cliente não encontrado.' }))
    .catch(next);

// --- Funções do Admin Service ---
const getDashboardMetrics = (req, res, next) => adminService.getDashboardMetrics()
    .then(metrics => res.status(200).json({ status: 'success', data: metrics }))
    .catch(next);

const createCustomPlan = (req, res, next) => adminService.createCustomPlan(req.body)
    .then(newPlan => res.status(201).json({ status: 'success', data: newPlan }))
    .catch(next);

// <<< CONTROLLER ALTERADO >>>
const changeUserPlan = (req, res, next) => {
    const { clientId, planId, customMessage } = req.body;
    if (!clientId || !planId) {
        return res.status(400).json({ status: 'fail', message: 'clientId e planId são obrigatórios.' });
    }
    adminService.changeUserPlan(clientId, planId, customMessage)
        .then(result => res.status(200).json({ status: 'success', data: result }))
        .catch(next);
};

// Confirma o pagamento ativando o plano que o cliente já escolheu (Pendente).
const confirmClientPayment = (req, res, next) => {
    const { clientId } = req.params;
    if (!clientId) {
        return res.status(400).json({ status: 'fail', message: 'clientId é obrigatório.' });
    }
    adminService.confirmClientPayment(clientId)
        .then(result => res.status(200).json({ status: 'success', data: result }))
        .catch(next);
};

// <<< CONTROLLER ALTERADO >>>
const sendBroadcastMessage = (req, res, next) => {
    const { message, targetGroup } = req.body;
    adminService.sendBroadcastMessage(message, targetGroup)
        .then(result => res.status(200).json({ status: 'success', data: result }))
        .catch(next);
};

// <<< CONTROLLER ALTERADO >>>
const getAllPlans = (req, res, next) => adminService.getAllPlans(req.query)
    .then(plans => res.status(200).json({ status: 'success', data: plans }))
    .catch(next);

const getAffiliatesDashboard = (req, res, next) => adminService.getAffiliatesDashboard()
    .then(dashboard => res.status(200).json({ status: 'success', data: dashboard }))
    .catch(next);


const updatePlan = (req, res, next) => {
    const planId = parseInt(req.params.planId, 10);
    if (isNaN(planId)) {
        return res.status(400).json({ status: 'fail', message: 'ID do plano inválido.' });
    }
    adminService.updatePlan(planId, req.body)
        .then(updatedPlan => res.status(200).json({ status: 'success', data: updatedPlan }))
        .catch(next);
};

// <<< NOVO CONTROLLER PARA ZERAR O SALDO >>>
const clearClientBalance = (req, res, next) => {
    const { clientId } = req.params;
    adminService.clearClientBalance(clientId)
        .then(() => res.status(200).json({ status: 'success', message: 'Saldo do cliente zerado com sucesso.' }))
        .catch(next);
};

const deleteClientAsAdmin = (req, res, next) => {
    const clientId = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) {
        return res.status(400).json({ status: 'fail', message: 'ID do cliente inválido.' });
    }

    adminService.deleteClientByUser(clientId)
        .then(() => {
            res.status(204).send();
        })
        .catch(next);
};

// <<< NOVO CONTROLLER >>>
const createClientAsAdmin = (req, res, next) => {
    adminService.createClientAsAdmin(req.body)
        .then(newClient => res.status(201).json({ status: 'success', data: newClient }))
        .catch(next);
};

// <<< NOVOS CONTROLLERS PARA Z-API >>>
const getZapiStatus = (req, res, next) => {
    whatsappService.getZapiInstanceStatus()
        .then(status => {
            if (status) {
                res.status(200).json({ status: 'success', data: status });
            } else {
                res.status(503).json({ status: 'fail', message: 'Não foi possível obter o status da instância Z-API.' });
            }
        })
        .catch(next);
};

const getZapiQrCode = (req, res, next) => {
    try {
        const imageUrl = whatsappService.getZapiQrCodeImageUrl();
        res.status(200).json({ status: 'success', data: { imageUrl } });
    } catch (error) {
        next(error);
    }
};

const getAdminStats = (req, res, next) => {
    adminService.getAdminStats()
        .then(stats => res.status(200).json({ status: 'success', data: stats }))
        .catch(next);
};

module.exports = {
    getAdminClientList,
    getAllClients,
    createClient,
    updateClient,
    deleteClient,
    getDashboardMetrics,
    createCustomPlan,
    changeUserPlan,
    confirmClientPayment,
    sendBroadcastMessage,
    getAffiliatesDashboard,
    getAllPlans,
    changeClientPhone,
    updatePlan,
    deleteClientAsAdmin,
    clearClientBalance,
    createClientAsAdmin, // Exportar novo controller
    getZapiStatus,       // Exportar novo controller
    getZapiQrCode,       // Exportar novo controller
    getAdminStats,       // Exportar estatísticas do admin
};
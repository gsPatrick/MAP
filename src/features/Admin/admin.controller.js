

// src/features/Admin/admin.controller.js
const adminService = require('./admin.service');
const clientService = require('../Client/client.service');

/**
 * <<< NOVO CONTROLLER PARA O PAINEL DE ADMIN >>>
 * Lista todos os clientes com dados detalhados para o painel de admin.
 */
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

// --- CRUD de Clientes (reutilizando clientService) ---
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

const changeUserPlan = (req, res, next) => {
    const { clientId, planId } = req.body;
    if (!clientId || !planId) {
        return res.status(400).json({ status: 'fail', message: 'clientId e planId são obrigatórios.' });
    }
    adminService.changeUserPlan(clientId, planId)
        .then(result => res.status(200).json({ status: 'success', data: result }))
        .catch(next);
};

/**
 * <<< CONTROLLER MELHORADO >>>
 * Envia uma mensagem em massa para um grupo alvo.
 */
const sendBroadcastMessage = (req, res, next) => {
    const { message, targetGroup } = req.body;
    adminService.sendBroadcastMessage(message, targetGroup)
        .then(result => res.status(200).json({ status: 'success', data: result }))
        .catch(next);
};

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

module.exports = {
  getAdminClientList, // <<< EXPORTAR NOVO CONTROLLER
  getAllClients,
  createClient,
  updateClient,
  deleteClient,
  getDashboardMetrics,
  createCustomPlan,
  changeUserPlan,
  sendBroadcastMessage,
  getAffiliatesDashboard,
  getAllPlans,
  changeClientPhone,
  updatePlan,
  deleteClientAsAdmin,
  clearClientBalance
};
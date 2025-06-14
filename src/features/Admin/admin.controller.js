// src/features/Admin/admin.controller.js
const adminService = require('./admin.service');
const clientService = require('../Client/client.service');

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

const sendBroadcastMessage = (req, res, next) => {
    const { message } = req.body;
    adminService.sendBroadcastMessage(message)
        .then(result => res.status(200).json({ status: 'success', data: result }))
        .catch(next);
};

const getAffiliatesDashboard = (req, res, next) => adminService.getAffiliatesDashboard()
    .then(dashboard => res.status(200).json({ status: 'success', data: dashboard }))
    .catch(next);

module.exports = {
  getAllClients,
  createClient,
  updateClient,
  deleteClient,
  getDashboardMetrics,
  createCustomPlan,
  changeUserPlan,
  sendBroadcastMessage,
  getAffiliatesDashboard,
};
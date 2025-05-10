// src/features/Appointment/appointment.controller.js
const appointmentService = require('./appointment.service');
const logger = require('../../utils/logger');

function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id)) {
        const error = new Error('ID da Conta Financeira inválido na rota.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    return id;
}

async function scheduleAppointment(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    // Adicionar validação de schema para req.body
    const newAppointment = await appointmentService.scheduleAppointment(financialAccountId, req.body);
    res.status(201).json({ status: 'success', data: newAppointment });
  } catch (error) {
    next(error);
  }
}

async function getAllAppointments(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const result = await appointmentService.getAllAppointments(financialAccountId, req.query);
    res.status(200).json({ status: 'success', ...result });
  } catch (error) {
    next(error);
  }
}

async function getAppointmentById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const appointmentId = parseInt(req.params.appointmentId, 10); // appointmentId da sub-rota
    if (isNaN(appointmentId)) { /* ... erro 400 ... */ }
    const appointment = await appointmentService.getAppointmentById(financialAccountId, appointmentId);
    if (!appointment) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: appointment });
  } catch (error) {
    next(error);
  }
}

async function updateAppointment(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const appointmentId = parseInt(req.params.appointmentId, 10);
    if (isNaN(appointmentId)) { /* ... erro 400 ... */ }
    if (Object.keys(req.body).length === 0) { /* ... erro 400 ... */ }
    const updatedAppointment = await appointmentService.updateAppointment(financialAccountId, appointmentId, req.body);
    if (!updatedAppointment) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: updatedAppointment });
  } catch (error) {
    next(error);
  }
}

async function cancelAppointment(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const appointmentId = parseInt(req.params.appointmentId, 10);
    if (isNaN(appointmentId)) { /* ... erro 400 ... */ }
    const success = await appointmentService.deleteOrCancelAppointment(financialAccountId, appointmentId, false); // false para cancelar
    if (!success) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', message: 'Compromisso cancelado com sucesso.' });
  } catch (error) {
    next(error);
  }
}

async function deleteAppointment(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const appointmentId = parseInt(req.params.appointmentId, 10);
    if (isNaN(appointmentId)) { /* ... erro 400 ... */ }
    const success = await appointmentService.deleteOrCancelAppointment(financialAccountId, appointmentId, true); // true para deletar
    if (!success) { /* ... erro 404 ... */ }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  scheduleAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  cancelAppointment,
  deleteAppointment,
};
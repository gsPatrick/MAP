// src/features/Appointment/appointment.routes.js
const { Router } = require('express');
const appointmentController = require('./appointment.controller');

const router = Router({ mergeParams: true });

router.get('/agenda-view', appointmentController.getAgendaView);

// Rota para criar um novo agendamento
router.post('/', appointmentController.scheduleAppointment);

// Rotas para listar todos os agendamentos (funciona com ou sem barra final)
router.get('/', appointmentController.getAllAppointments); // Ex: /api/financial-accounts/:financialAccountId/appointments/
router.get('', appointmentController.getAllAppointments); // Ex: /api/financial-accounts/:financialAccountId/appointments

// Rotas para ações específicas do agendamento (confirmar, completar)
router.post('/:appointmentId/confirm', appointmentController.confirmAppointment);
router.post('/:appointmentId/complete', appointmentController.completeAppointment);

// Rotas para um agendamento específico (obter, atualizar, cancelar, deletar)
router.get('/:appointmentId', appointmentController.getAppointmentById);
router.put('/:appointmentId', appointmentController.updateAppointment);
router.patch('/:appointmentId/cancel', appointmentController.cancelAppointment);
router.delete('/:appointmentId', appointmentController.deleteAppointment);

module.exports = router;
// src/features/Appointment/appointment.routes.js
const { Router } = require('express');
const appointmentController = require('./appointment.controller');

const router = Router({ mergeParams: true });

router.get('/agenda-view', appointmentController.getAgendaView);

router.post('/', appointmentController.scheduleAppointment);
router.get('/', appointmentController.getAllAppointments);

// <<< ADICIONE ESTAS NOVAS ROTAS DE AÇÃO AQUI >>>
router.post('/:appointmentId/confirm', appointmentController.confirmAppointment);
router.post('/:appointmentId/complete', appointmentController.completeAppointment);
// <<< FIM DAS NOVAS ROTAS >>>

router.get('/:appointmentId', appointmentController.getAppointmentById);
router.put('/:appointmentId', appointmentController.updateAppointment);
router.patch('/:appointmentId/cancel', appointmentController.cancelAppointment);
router.delete('/:appointmentId', appointmentController.deleteAppointment);

module.exports = router;
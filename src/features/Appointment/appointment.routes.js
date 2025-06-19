// src/features/Appointment/appointment.routes.js
const { Router } = require('express');
const appointmentController = require('./appointment.controller');
// const { authenticateToken, authorizeFinancialAccountAccess } = require('../../middlewares/authMiddleware');

const router = Router({ mergeParams: true }); // mergeParams para acessar :financialAccountId
router.get('/agenda-view', appointmentController.getAgendaView);
// router.use(authenticateToken);
// router.use(authorizeFinancialAccountAccess); // Middleware para checar acesso à financialAccountId

router.post('/', appointmentController.scheduleAppointment);
router.get('/', appointmentController.getAllAppointments);
router.get('/:appointmentId', appointmentController.getAppointmentById);
router.put('/:appointmentId', appointmentController.updateAppointment);
router.patch('/:appointmentId/cancel', appointmentController.cancelAppointment);
router.delete('/:appointmentId', appointmentController.deleteAppointment);

module.exports = router;
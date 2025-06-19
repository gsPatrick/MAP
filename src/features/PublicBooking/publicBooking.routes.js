
const { Router } = require('express');
const publicBookingController = require('./ublicBooking.controller');

const router = Router();

// Rota para obter os dados públicos de um prestador (nome, serviços)
// Ex: GET /api/public/booking/123
router.get('/:financialAccountId', publicBookingController.getProviderPublicInfo);

// Rota para verificar os horários disponíveis em uma data específica
// Ex: GET /api/public/booking/123/availability?date=2024-10-28
router.get('/:financialAccountId/availability', publicBookingController.getAvailableTimeSlots);

// Rota para criar um novo agendamento a partir da página pública
// Ex: POST /api/public/booking/123/schedule
router.post('/:financialAccountId/schedule', publicBookingController.createPublicBooking);

module.exports = router;
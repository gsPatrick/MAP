// src/features/PublicBooking/publicBooking.controller.js
const publicBookingService = require('./publicBooking.service');
const logger = require('../../utils/logger');

/**
 * Obtém informações públicas do prestador de serviço (nome, lista de serviços).
 */
async function getProviderPublicInfo(req, res, next) {
  try {
    const { financialAccountId } = req.params;
    const publicInfo = await publicBookingService.getProviderPublicInfo(parseInt(financialAccountId, 10));

    res.status(200).json({
      status: 'success',
      message: 'Informações do prestador obtidas com sucesso.',
      data: publicInfo,
    });
  } catch (error) {
    logger.error(`[PublicBookingController] Erro ao obter informações públicas: ${error.message}`);
    next(error);
  }
}

/**
 * Obtém os slots de horário disponíveis para uma data específica.
 */
async function getAvailableTimeSlots(req, res, next) {
  try {
    const { financialAccountId } = req.params;
    const { date, serviceIds } = req.query;

    if (!date || !serviceIds) {
      const error = new Error("Parâmetros 'date' (YYYY-MM-DD) e 'serviceIds' (separados por vírgula) são obrigatórios.");
      error.statusCode = 400;
      throw error;
    }
    
    const serviceIdsArray = serviceIds.split(',').map(id => parseInt(id.trim(), 10));
    if (serviceIdsArray.some(isNaN)) {
        const error = new Error("O parâmetro 'serviceIds' contém IDs inválidos.");
        error.statusCode = 400;
        throw error;
    }

    const slots = await publicBookingService.getAvailableTimeSlots(parseInt(financialAccountId, 10), date, serviceIdsArray);

    res.status(200).json({
      status: 'success',
      message: 'Horários disponíveis obtidos com sucesso.',
      data: {
        date: date,
        availableSlots: slots,
      },
    });
  } catch (error) {
    logger.error(`[PublicBookingController] Erro ao obter horários disponíveis: ${error.message}`);
    next(error);
  }
}

/**
 * Cria um novo agendamento a partir da página pública.
 */
async function createPublicBooking(req, res, next) {
  try {
    const { financialAccountId } = req.params;
    const bookingData = req.body; // { clientDetails: { name, email, phone }, serviceIds: [], eventDateTime: '...' }

    const newAppointment = await publicBookingService.createPublicBooking(parseInt(financialAccountId, 10), bookingData);

    res.status(201).json({
      status: 'success',
      message: 'Agendamento solicitado com sucesso! O prestador foi notificado e entrará em contato para confirmar.',
      data: {
        appointmentId: newAppointment.id,
        title: newAppointment.title,
        eventDateTime: newAppointment.eventDateTime,
      },
    });
  } catch (error) {
    logger.error(`[PublicBookingController] Erro ao criar agendamento público: ${error.message}`);
    next(error);
  }
}

module.exports = {
  getProviderPublicInfo,
  getAvailableTimeSlots,
  createPublicBooking,
};
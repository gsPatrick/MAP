// src/features/Appointment/appointment.controller.js
const appointmentService = require('./appointment.service');
const logger = require('../../utils/logger');

// Helper para validar e extrair financialAccountId da rota
function getFinancialAccountIdFromRequest(req) {
    const id = parseInt(req.params.financialAccountId, 10);
    if (isNaN(id) || id <= 0) { // Adicionada checagem para id > 0
        const error = new Error('ID da Conta Financeira inválido ou não fornecido na rota.');
        error.statusCode = 400; error.status = 'fail';
        throw error;
    }
    // A validação se a conta pertence ao usuário/cliente autenticado
    // e se está ativa já é feita pelo middleware authorizeFinancialAccountOwnership
    // no router pai (`clientFinancialAccountRouter`).
    return id; // Retorna o ID validado e autorizado
}

function getAppointmentIdFromRequest(req) {
    const id = parseInt(req.params.appointmentId, 10);
    if (isNaN(id) || id <= 0) { // Adicionada checagem para id > 0
        const error = new Error('ID do Compromisso inválido ou não fornecido na rota.');
        error.statusCode = 400; error.status = 'fail';
        throw error;
    }
    return id;
}


async function scheduleAppointment(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    // Validação de schema para req.body (título, eventDateTime obrigatórios)
    // Opcional: validar se businessClientIds é um array de números válidos.
    // O serviço já valida se os IDs de businessClient existem e pertencem à conta.
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
    res.status(200).json({ status: 'success', data: result.appointments, totalItems: result.totalItems }); // Ajustado para retornar compromissos e totalItems
  } catch (error) {
    next(error);
  }
}

async function getAppointmentById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const appointmentId = getAppointmentIdFromRequest(req);
    const appointment = await appointmentService.getAppointmentById(financialAccountId, appointmentId);
    if (!appointment) {
         const error = new Error(`Compromisso ID ${appointmentId} não encontrado nesta conta financeira.`);
         error.statusCode = 404; error.status = 'fail'; throw error;
    }
    res.status(200).json({ status: 'success', data: appointment });
  } catch (error) {
    next(error);
  }
}

async function updateAppointment(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const appointmentId = getAppointmentIdFromRequest(req);
    if (Object.keys(req.body).length === 0) {
        const error = new Error('Nenhum dado fornecido para atualização.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    // Opcional: validar se businessClientIds é um array de números válidos.
    // O serviço já valida se os IDs de businessClient existem e pertencem à conta.
    const updatedAppointment = await appointmentService.updateAppointment(financialAccountId, appointmentId, req.body);
    if (!updatedAppointment) {
         const error = new Error(`Compromisso ID ${appointmentId} não encontrado nesta conta financeira para atualização.`);
         error.statusCode = 404; error.status = 'fail'; throw error;
    }
    res.status(200).json({ status: 'success', data: updatedAppointment });
  } catch (error) {
    next(error);
  }
}

async function cancelAppointment(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const appointmentId = getAppointmentIdFromRequest(req);
    const success = await appointmentService.deleteOrCancelAppointment(financialAccountId, appointmentId, false); // false para cancelar
    if (!success) {
        const error = new Error(`Compromisso ID ${appointmentId} não encontrado nesta conta financeira para cancelamento.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
    }
    res.status(200).json({ status: 'success', message: 'Compromisso cancelado com sucesso.' });
  } catch (error) {
    next(error);
  }
}

async function deleteAppointment(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req);
    const appointmentId = getAppointmentIdFromRequest(req);
    const success = await appointmentService.deleteOrCancelAppointment(financialAccountId, appointmentId, true); // true para deletar
    if (!success) {
         const error = new Error(`Compromisso ID ${appointmentId} não encontrado nesta conta financeira para exclusão.`);
         error.statusCode = 404; error.status = 'fail'; throw error;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

async function getAgendaView(req, res, next) {
  try {
    const { financialAccountId } = req.params;
    const { start, end } = req.query; // Ex: ?start=2024-10-01&end=2024-10-31

    if (!start || !end) {
      const error = new Error("Parâmetros 'start' e 'end' (YYYY-MM-DD) são obrigatórios.");
      error.statusCode = 400;
      throw error;
    }

    const agendaEvents = await appointmentService.getAgendaView(parseInt(financialAccountId, 10), start, end);

    res.status(200).json({
      status: 'success',
      message: 'Visão da agenda obtida com sucesso.',
      data: agendaEvents,
    });
  } catch (error) {
    logger.error(`[AppointmentController] Erro ao obter visão da agenda: ${error.message}`);
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
  getAgendaView
};
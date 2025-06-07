// src/features/Hydration/hydration.controller.js
const hydrationService = require('./hydration.service');

async function getDailyLogs(req, res, next) {
  try {
    // O ID do cliente vem do token de autenticação (req.client.id)
    const clientId = req.client.id;
    const logs = await hydrationService.getOrCreateDailyLogs(clientId);
    res.status(200).json({ status: 'success', data: logs });
  } catch (error) {
    next(error);
  }
}

async function updateLog(req, res, next) {
  try {
    const clientId = req.client.id;
    const logId = parseInt(req.params.logId, 10);
    const { status } = req.body;

    if (isNaN(logId)) {
      const error = new Error('ID do log inválido.');
      error.statusCode = 400;
      throw error;
    }

    const updatedLog = await hydrationService.updateLogStatus(clientId, logId, status);
    res.status(200).json({ status: 'success', data: updatedLog });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDailyLogs,
  updateLog,
};
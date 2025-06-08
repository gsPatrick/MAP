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

async function getTodaysLogs(req, res) {
    try {
        // req.client.id é populado pelo middleware de autenticação
        const clientId = req.client.id;
        if (!clientId) {
            return res.status(401).json({ message: 'Cliente não autenticado.' });
        }

        const logs = await hydrationService.getTodaysLogsByClient(clientId);

        res.status(200).json(logs);
    } catch (error) {
        // Usa o logger se disponível, ou console.error
        console.error('Erro ao buscar logs de hidratação do dia:', error);
        res.status(500).json({ message: 'Erro interno ao buscar logs de hidratação.' });
    }
}

async function updateSettingsAndGenerateLogs(req, res) {
    try {
        const clientId = req.client.id;
        const settings = req.body;

        const result = await hydrationService.createOrUpdateHydrationSettings(clientId, settings);
        res.status(200).json({ status: 'success', message: result.message });
    } catch (error) {
        console.error('Erro ao salvar configurações de hidratação e gerar logs:', error);
        res.status(500).json({ message: 'Erro interno ao salvar configurações.' });
    }
}


module.exports = {
  getDailyLogs,
  updateLog,
  getTodaysLogs,
  updateSettingsAndGenerateLogs
};
// src/features/DevTools/devTools.controller.js
const devToolsService = require('./devTools.service');
const logger = require('../../utils/logger');

async function activateTestAccessLevelController(req, res, next) { // Renomeado
  try {
    const clientId = parseInt(req.params.clientId, 10);
    // O accessLevel agora deve ser um dos valores do ENUM em Client.js
    // Ex: 'basico_mensal', 'avancado_anual', 'gratuito'
    const accessLevel = req.query.level || req.body.accessLevel || 'basico_mensal';

    if (isNaN(clientId)) {
      const error = new Error('ID do Cliente inválido na rota.');
      error.statusCode = 400;
      return next(error);
    }

    const updatedClient = await devToolsService.activateClientTestAccessLevel(clientId, accessLevel);

    res.status(200).json({
      status: 'success',
      message: `Nível de acesso de TESTE '${accessLevel}' ativado para cliente ID ${clientId}.`,
      data: updatedClient,
    });

  } catch (error) {
    logger.error(`[DEV-TOOLS CONTROLLER] Erro capturado em activateTestAccessLevelController: ${error.message}`, {
        clientId: req.params.clientId,
        accessLevel: req.query.level || req.body.accessLevel,
    });
    next(error);
  }
}

// NOVO CONTROLLER para simular assinatura
async function simulateSubscriptionController(req, res, next) {
    try {
        const clientId = parseInt(req.params.clientId, 10);
        const planId = parseInt(req.body.planId || req.query.planId, 10);
        const status = req.body.status || req.query.status || 'Ativa';

        if (isNaN(clientId)) {
            const error = new Error('ID do Cliente inválido na rota.');
            error.statusCode = 400; return next(error);
        }
        if (isNaN(planId)) {
            const error = new Error('ID do Plano (planId) é obrigatório no corpo ou query.');
            error.statusCode = 400; return next(error);
        }

        const result = await devToolsService.simulateCreateSubscriptionForClient(clientId, planId, status);

        res.status(200).json({
            status: 'success',
            message: `Assinatura simulada para Plano ID ${planId} criada para Cliente ID ${clientId} com status '${status}'.`,
            data: result,
        });
    } catch (error) {
        logger.error(`[DEV-TOOLS CONTROLLER] Erro em simulateSubscriptionController: ${error.message}`, {
            clientId: req.params.clientId,
            planId: req.body.planId || req.query.planId,
        });
        next(error);
    }
}


module.exports = {
  activateTestAccessLevelController, // Renomeado
  simulateSubscriptionController, // NOVO
};
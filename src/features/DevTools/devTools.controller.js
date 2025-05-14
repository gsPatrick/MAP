// src/features/DevTools/devTools.controller.js
const devToolsService = require('./devTools.service');
// const logger = require('../../utils/logger'); // Opcional

async function activateTestAccess(req, res, next) {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    const accessLevel = req.query.level || req.body.accessLevel || 'mensal';

    if (isNaN(clientId)) {
      const error = new Error('ID do Cliente inválido na rota.');
      error.statusCode = 400;
      // error.status = 'fail'; // Se você usar um campo 'status' no seu errorHandler
      return next(error); // Passa para o errorHandler
    }

    // A chamada ao serviço está correta aqui (assumindo que foi corrigida no passo anterior)
    const updatedClient = await devToolsService.activateClientTestAccess(clientId, accessLevel);

    res.status(200).json({
      status: 'success',
      message: `Nível de acesso de teste '${accessLevel}' ativado para cliente ID ${clientId}.`,
      data: updatedClient,
    });

  } catch (error) {
    // O serviço lança erros (com ou sem statusCode).
    // O controller os captura e passa para o middleware de tratamento de erros do Express.
    // O errorHandler global (definido em app.js) cuidará de definir o statusCode final
    // se não estiver presente no erro.
    logger.error(`[DEV-TOOLS CONTROLLER] Erro capturado em activateTestAccess: ${error.message}`, {
        clientId: req.params.clientId,
        accessLevel: req.query.level || req.body.accessLevel,
        // errorStack: error.stack // Descomente para logar o stack completo se necessário
    });
    next(error);
  }
}

module.exports = {
  activateTestAccess,
};
// src/features/DevTools/devTools.service.js
const { Client, sequelize } = require('../../database'); // Ajuste o caminho se necessário
const logger = require('../../utils/logger');

/**
 * Ativa um nível de acesso de teste para um cliente específico.
 * @param {number} clientId - O ID do cliente.
 * @param {string} accessLevel - O nível de acesso a ser definido (ex: 'mensal', 'anual', 'vitalicio', 'gratuito').
 * @returns {Promise<object>} O objeto do cliente atualizado.
 */
async function activateTestAccess(req, res, next) {
    try {
      const clientId = parseInt(req.params.clientId, 10);
      // O nível de acesso pode vir do query param ou do corpo da requisição
      const accessLevel = req.query.level || req.body.accessLevel || 'mensal'; // Padrão para 'mensal' se não especificado
  
      if (isNaN(clientId)) {
        const error = new Error('ID do Cliente inválido na rota.');
        error.statusCode = 400;
        error.status = 'fail';
        return next(error);
      }
  
      const updatedClient = await devToolsService.activateClientTestAccess(clientId, accessLevel);
  
      res.status(200).json({
        status: 'success',
        message: `Nível de acesso de teste '${accessLevel}' ativado para cliente ID ${clientId}.`,
        data: updatedClient,
      });
  
    } catch (error) {
      // Se o erro não tiver statusCode, o errorHandler global pode definir como 500.
      // Ou você pode ser mais específico aqui.
      if (!error.statusCode && error.message.includes('não encontrado')) {
          error.statusCode = 404;
      } else if (!error.statusCode && error.message.includes('inválido')) {
          error.statusCode = 400;
      }
      next(error); // Passa para o middleware de tratamento de erros
    }
  }
module.exports = {
    activateTestAccess,
};
// src/features/DevTools/devTools.service.js
const { Client, sequelize } = require('../../database'); // Ajuste o caminho se necessário
const logger = require('../../utils/logger');

/**
 * Ativa um nível de acesso de teste para um cliente específico.
 * @param {number} clientId - O ID do cliente.
 * @param {string} accessLevel - O nível de acesso a ser definido (ex: 'mensal', 'anual', 'vitalicio', 'gratuito').
 * @returns {Promise<object>} O objeto do cliente atualizado.
 * @throws {Error} Se o cliente não for encontrado ou o nível de acesso for inválido.
 */
async function activateClientTestAccess(clientId, accessLevel = 'mensal') {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      // Lança um erro que será capturado pelo controller
      const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
      error.statusCode = 404; // Adiciona statusCode para o controller usar
      throw error;
    }

    const validAccessLevels = ['gratuito', 'mensal', 'anual', 'vitalicio'];
    if (!validAccessLevels.includes(accessLevel)) {
      // Lança um erro que será capturado pelo controller
      const error = new Error(`Nível de acesso de teste "${accessLevel}" inválido. Válidos são: ${validAccessLevels.join(', ')}.`);
      error.statusCode = 400; // Adiciona statusCode
      throw error;
    }

    const updateData = { accessLevel };
    const now = new Date();

    if (accessLevel === 'mensal') {
      const expiryDate = new Date(now);
      expiryDate.setMonth(expiryDate.getMonth() + 1);
      updateData.accessExpiresAt = expiryDate.toISOString().split('T')[0];
    } else if (accessLevel === 'anual') {
      const expiryDate = new Date(now);
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      updateData.accessExpiresAt = expiryDate.toISOString().split('T')[0];
    } else { // 'gratuito' ou 'vitalicio'
      updateData.accessExpiresAt = null;
    }

    await client.update(updateData, { transaction: t });
    await t.commit();

    logger.info(`[DEV-TOOLS] Nível de acesso de teste "${accessLevel}" ativado para cliente ${clientId} (ID: ${client.id}). Expira em: ${updateData.accessExpiresAt || 'Nunca'}.`);
    return client.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`[DEV-TOOLS] Erro ao ativar nível de acesso de teste para cliente ${clientId} (Nível: ${accessLevel}): ${error.message}`, { errorDetails: error });
    // Re-lança o erro original (ou um erro encapsulado) para ser tratado pelo controller.
    // Se o erro já tem statusCode (como os que lançamos acima), ele será preservado.
    // Se for um erro inesperado do Sequelize ou DB, ele não terá statusCode aqui.
    throw error;
  }
}

module.exports = {
  activateClientTestAccess,
};
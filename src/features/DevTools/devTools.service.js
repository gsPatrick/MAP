// src/features/DevTools/devTools.service.js
const { Client, Plan, sequelize } = require('../../database'); // Adicionado Plan
const logger = require('../../utils/logger');
const subscriptionService = require('../Subscription/subscription.service'); // IMPORTANTE

/**
 * Ativa um nível de acesso de teste para um cliente específico, atualizando diretamente o Client.
 * @param {number} clientId - O ID do cliente.
 * @param {string} accessLevel - O nível de acesso a ser definido (ex: 'basico_mensal', 'avancado_anual').
 * @returns {Promise<object>} O objeto do cliente atualizado.
 * @throws {Error} Se o cliente não for encontrado ou o nível de acesso for inválido.
 */
async function activateClientTestAccessLevel(clientId, accessLevel = 'basico_mensal') {
  const t = await sequelize.transaction();
  try {
    const client = await Client.findByPk(clientId, { transaction: t });
    if (!client) {
      const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
      error.statusCode = 404; throw error;
    }

    // Valida se o accessLevel está no ENUM do modelo Client
    const validAccessLevels = Client.rawAttributes.accessLevel.values;
    if (!validAccessLevels.includes(accessLevel)) {
      const error = new Error(`Nível de acesso de teste "${accessLevel}" inválido. Válidos são: ${validAccessLevels.join(', ')}.`);
      error.statusCode = 400; throw error;
    }

    const updateData = { accessLevel };
    const now = new Date();

    if (accessLevel.includes('_mensal')) {
      const expiryDate = new Date(now);
      expiryDate.setMonth(expiryDate.getMonth() + 1);
      updateData.accessExpiresAt = expiryDate.toISOString().split('T')[0];
    } else if (accessLevel.includes('_anual')) {
      const expiryDate = new Date(now);
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      updateData.accessExpiresAt = expiryDate.toISOString().split('T')[0];
    } else if (accessLevel.startsWith('vitalicio_') || accessLevel === 'gratuito') {
      updateData.accessExpiresAt = null;
    } else {
        // Para níveis que não se encaixam no padrão _mensal/_anual/vitalicio_/gratuito,
        // pode ser necessário uma lógica diferente ou assumir uma expiração padrão.
        // Por ora, se não for mensal/anual/vitalício, não define expiração (pode ser um erro de setup).
        logger.warn(`[DEV-TOOLS] Nível de acesso '${accessLevel}' não tem regra de expiração automática definida neste endpoint de teste. Verifique a configuração.`);
        // updateData.accessExpiresAt = null; // ou uma data de expiração padrão curta para teste
    }


    await client.update(updateData, { transaction: t });
    await t.commit();

    logger.info(`[DEV-TOOLS] Nível de acesso de TESTE "${accessLevel}" ativado para cliente ${clientId}. Expira em: ${updateData.accessExpiresAt || 'Nunca'}.`);
    return client.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`[DEV-TOOLS] Erro ao ativar nível de acesso de teste para cliente ${clientId} (Nível: ${accessLevel}): ${error.message}`, { errorDetails: error });
    throw error;
  }
}


/**
 * SIMULA a criação de uma assinatura para um cliente com um plano específico.
 * Útil para testes de desenvolvimento.
 * @param {number} clientId - O ID do cliente.
 * @param {number} planId - O ID do plano a ser assinado.
 * @param {string} status - Status da assinatura (default: 'Ativa').
 * @returns {Promise<object>} A assinatura criada e o cliente atualizado.
 */
async function simulateCreateSubscriptionForClient(clientId, planId, status = 'Ativa') {
    try {
        const client = await Client.findByPk(clientId);
        if (!client) {
            const error = new Error(`Cliente com ID ${clientId} não encontrado.`);
            error.statusCode = 404; throw error;
        }
        const plan = await Plan.findByPk(planId);
        if (!plan) {
            const error = new Error(`Plano com ID ${planId} não encontrado.`);
            error.statusCode = 404; throw error;
        }

        // O subscriptionService.createSubscription agora lida com a atualização do client.accessLevel
        const newSubscription = await subscriptionService.createSubscription(
            clientId,
            planId,
            null, // startDate (hoje por padrão no serviço)
            status
        );

        // Recarrega o cliente para pegar o accessLevel atualizado
        const updatedClient = await Client.findByPk(clientId);

        logger.info(`[DEV-TOOLS] Assinatura SIMULADA (ID: ${newSubscription.id}) para Plano "${plan.name}" criada para Cliente ${clientId}. Cliente atualizado.`);
        return {
            subscription: newSubscription,
            client: updatedClient.toJSON()
        };

    } catch (error) {
        logger.error(`[DEV-TOOLS] Erro ao simular criação de assinatura para cliente ${clientId}, plano ${planId}: ${error.message}`, { errorDetails: error });
        throw error; // Relança para o controller tratar
    }
}

module.exports = {
  activateClientTestAccessLevel, // Renomeado para clareza
  simulateCreateSubscriptionForClient, // NOVA FUNÇÃO
};
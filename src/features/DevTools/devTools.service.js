// src/features/DevTools/devTools.service.js
const { Client, Plan, sequelize } = require('../../database'); // Adicionado Plan
const logger = require('../../utils/logger');
const subscriptionService = require('../Subscription/subscription.service'); // IMPORTANTE
const { Op } = require('sequelize'); // <<< ESTA LINHA É A CORREÇÃO

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

/**
 * SIMULA um pagamento recebido no Asaas, disparando o webhook correspondente.
 * @param {string} paymentId - O ID do pagamento (ex: 'pay_123').
 * @param {number} value - O valor do pagamento.
 * @returns {Promise<object>} O resultado da simulação.
 */
async function simulatePayment(paymentId, value) {
    // Esta função simplesmente chama o serviço do Asaas.
    // A lógica real está no asaasApiService.
    try {
        const result = await asaasApiService.simulatePayment(paymentId, value);
        logger.info(`[DEV-TOOLS] Simulação de pagamento para ${paymentId} concluída no service.`);
        return result;
    } catch (error) {
        logger.error(`[DEV-TOOLS] Erro ao simular pagamento no Asaas: ${error.message}`);
        throw error;
    }
}


/**
 * Cria um cliente de teste completo, com conta financeira e plano de acesso ativo.
 * Simula o fluxo de um usuário que acabou de se cadastrar e pagar.
 * @param {object} userData - { phone, email, password, name, accessLevel }
 * @returns {Promise<object>} Objeto com o cliente criado e sua conta financeira.
 */
async function createFullTestUser(userData) {
  const { phone, email, password, name, accessLevel = 'avancado_anual' } = userData;

  if (!phone || !email || !password || !name) {
    throw { statusCode: 400, message: 'Telefone, email, senha e nome são obrigatórios.' };
  }

  const t = await sequelize.transaction();
  try {
    // 1. Cria o contato do cliente
    const clientData = {
      phone,
      email,
      passwordHash: password,
      debugPassword: password,
      name,
      status: 'Ativo',
      accessLevel: accessLevel, // O hook do modelo Client cuidará da data de expiração
    };
    
    // Usamos o service de cliente para criar o contato.
    // O createClientContact já verifica se o telefone existe.
    // Vamos adaptar para usar a transação e evitar a criação de contas/categorias padrão que faremos a seguir.
    
    const normalizedPhone = phone.replace(/\D/g, '');
    const existingClient = await Client.findOne({ where: { [Op.or]: [{ phone: normalizedPhone }, { email }] } });
    if(existingClient){
        throw { statusCode: 409, message: `Cliente com telefone ${phone} ou email ${email} já existe.`};
    }

    const newClient = await Client.create(clientData, { transaction: t });

    // 2. Cria a Conta Financeira Pessoal (PF) padrão
    const pfAccount = await FinancialAccount.create({
      clientId: newClient.id,
      accountName: 'Minhas Contas',
      accountType: 'PF',
      isDefault: true,
      isActive: true,
    }, { transaction: t });
    
    // 3. Cria as categorias padrão para a conta PF
    await clientService.createDefaultCategoriesForAccount(pfAccount.id, 'PF', t);
    
    // Se o plano for avançado, já cria a conta PJ também
    let pjAccount = null;
    if (accessLevel.includes('avancado')) {
        pjAccount = await FinancialAccount.create({
            clientId: newClient.id,
            accountName: 'Minha Empresa',
            accountType: 'PJ',
            isDefault: false,
            isActive: true,
        }, { transaction: t });
        await clientService.createDefaultCategoriesForAccount(pjAccount.id, 'PJ', t);
    }
    
    await t.commit();
    
    const clientJSON = newClient.toJSON();
    clientJSON.financialAccounts = [pfAccount.toJSON()];
    if(pjAccount) {
        clientJSON.financialAccounts.push(pjAccount.toJSON());
    }

    logger.info(`[DEV-TOOLS] Usuário de teste completo criado para ${email} com plano ${accessLevel}.`);
    return clientJSON;

  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`[DEV-TOOLS] Erro ao criar usuário de teste completo: ${error.message}`, { error, userData });
    throw error;
  }
}



module.exports = {
  activateClientTestAccessLevel, // Renomeado para clareza
  simulateCreateSubscriptionForClient, // NOVA FUNÇÃO
  simulatePayment,
  createFullTestUser
};
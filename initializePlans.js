// src/scripts/initializePlans.js
const { Plan } = require('./src/database');
const logger = require('./src/utils/logger');

// Definição dos 4 planos base do sistema.
// Estes são os valores "corretos" que o sistema irá garantir.
const basePlansData = [
  {
    name: 'Básico Mensal',
    description: 'Acesso completo às funcionalidades do plano básico, com cobrança mensal.',
    price: 29.90,
    currency: 'BRL',
    durationDays: 30,
    tier: 'basico',
    affiliateCommissionValue: 10.00,
    isActive: true,
  },
  {
    name: 'Básico Anual',
    description: 'Acesso completo às funcionalidades do plano básico por um ano, com desconto.',
    price: 299.00, // <<< PREÇO CORRETO GARANTIDO PELO SCRIPT
    currency: 'BRL',
    durationDays: 365,
    tier: 'basico',
    affiliateCommissionValue: 80.00,
    isActive: true,
  },
  {
    name: 'Avançado Mensal',
    description: 'Acesso a todas as funcionalidades, incluindo recursos empresariais, com cobrança mensal.',
    price: 39.90,
    currency: 'BRL',
    durationDays: 30,
    tier: 'avancado',
    affiliateCommissionValue: 20.00,
    isActive: true,
  },
  {
    name: 'Avançado Anual',
    description: 'Acesso a todas as funcionalidades, incluindo recursos empresariais, por um ano com desconto.',
    price: 399.00, // <<< PREÇO CORRETO GARANTIDO PELO SCRIPT
    currency: 'BRL',
    durationDays: 365,
    tier: 'avancado',
    affiliateCommissionValue: 150.00,
    isActive: true,
  }
];

/**
 * <<< FUNÇÃO ATUALIZADA >>>
 * Garante que os planos base existam e estejam com os dados corretos no banco.
 * Se um plano não existe, ele é criado.
 * Se um plano existe mas tem dados diferentes (ex: preço), ele é ATUALIZADO.
 */
async function initializeBasePlans() {
  try {
    logger.info('[DB INIT] Sincronizando e corrigindo os planos base...');
    
    let createdCount = 0;
    let updatedCount = 0;
    let checkedCount = 0;

    for (const planData of basePlansData) {
      // 1. Tenta encontrar o plano pelo nome
      const existingPlan = await Plan.findOne({ where: { name: planData.name } });

      if (!existingPlan) {
        // 2. Se não existe, cria o plano.
        await Plan.create(planData);
        logger.info(`[DB INIT] Plano "${planData.name}" não encontrado. CRIANDO com sucesso.`);
        createdCount++;
      } else {
        // 3. Se existe, verifica se os dados importantes estão corretos.
        const needsUpdate = 
          Number(existingPlan.price) !== Number(planData.price) ||
          existingPlan.durationDays !== planData.durationDays ||
          existingPlan.tier !== planData.tier ||
          Number(existingPlan.affiliateCommissionValue) !== Number(planData.affiliateCommissionValue);

        if (needsUpdate) {
          // 4. Se algum dado está diferente, atualiza o plano.
          await existingPlan.update(planData);
          logger.warn(`[DB INIT] Plano "${planData.name}" encontrado com dados desatualizados. ATUALIZANDO para os valores corretos.`);
          updatedCount++;
        } else {
          // 5. Se está tudo certo, apenas registra a verificação.
          logger.debug(`[DB INIT] Plano "${planData.name}" já existe e está correto. Verificação OK.`);
          checkedCount++;
        }
      }
    }

    if (createdCount > 0) {
      logger.info(`[DB INIT] ${createdCount} novo(s) plano(s) base foram criados.`);
    }
    if (updatedCount > 0) {
      logger.info(`[DB INIT] ${updatedCount} plano(s) existente(s) foram corrigidos/atualizados.`);
    }
    logger.info(`[DB INIT] Sincronização de ${basePlansData.length} planos base concluída.`);

  } catch (error) {
    logger.error('[DB INIT] Erro crítico ao inicializar/sincronizar os planos base:', error);
    // process.exit(1); // Descomente se for crítico para a aplicação
  }
}

module.exports = {
  initializeBasePlans
};
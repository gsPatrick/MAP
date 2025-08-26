// src/scripts/initializePlans.js
const { Plan } = require('../database');
const logger = require('../utils/logger');

// Definição dos 4 planos base do sistema.
// Os nomes são amigáveis para o usuário final.
const basePlansData = [
  {
    name: 'Básico Mensal',
    description: 'Acesso completo às funcionalidades do plano básico, com cobrança mensal.',
    price: 39.90,
    currency: 'BRL',
    durationDays: 30,
    tier: 'basico',
    affiliateCommissionValue: 10.00,
    isActive: true,
  },
  {
    name: 'Básico Anual',
    description: 'Acesso completo às funcionalidades do plano básico por um ano, com desconto.',
    price: 389.90, // Preço anual sugerido
    currency: 'BRL',
    durationDays: 365,
    tier: 'basico',
    affiliateCommissionValue: 80.00,
    isActive: true,
  },
  {
    name: 'Avançado Mensal',
    description: 'Acesso a todas as funcionalidades, incluindo recursos empresariais, com cobrança mensal.',
    price: 79.90,
    currency: 'BRL',
    durationDays: 30,
    tier: 'avancado',
    affiliateCommissionValue: 20.00,
    isActive: true,
  },
  {
    name: 'Avançado Anual',
    description: 'Acesso a todas as funcionalidades, incluindo recursos empresariais, por um ano com desconto.',
    price: 789.90, // Preço anual sugerido
    currency: 'BRL',
    durationDays: 365,
    tier: 'avancado',
    affiliateCommissionValue: 150.00,
    isActive: true,
  }
];

/**
 * Verifica se os planos base existem no banco de dados e os cria se necessário.
 * Esta função deve ser chamada na inicialização da aplicação.
 */
async function initializeBasePlans() {
  try {
    logger.info('[DB INIT] Verificando a existência dos planos base...');
    
    let createdCount = 0;
    let checkedCount = 0;

    for (const planData of basePlansData) {
      // O método findOrCreate é perfeito para esta tarefa:
      // Ele busca um plano com o nome. Se encontrar, retorna ele. Se não, cria um novo.
      const [plan, created] = await Plan.findOrCreate({
        where: { name: planData.name },
        defaults: planData // Os dados a serem usados se precisar criar
      });

      if (created) {
        logger.info(`[DB INIT] Plano "${plan.name}" não encontrado. Criado com sucesso.`);
        createdCount++;
      } else {
        logger.debug(`[DB INIT] Plano "${plan.name}" já existe. Verificação OK.`);
        checkedCount++;
      }
    }

    if (createdCount > 0) {
        logger.info(`[DB INIT] ${createdCount} plano(s) base foram criados.`);
    }
    logger.info(`[DB INIT] Verificação de ${checkedCount + createdCount} planos base concluída.`);

  } catch (error) {
    logger.error('[DB INIT] Erro crítico ao inicializar os planos base:', error);
    // Em um ambiente de produção, você pode querer que a aplicação pare se os planos não puderem ser criados.
    // process.exit(1);
  }
}

module.exports = {
  initializeBasePlans
};
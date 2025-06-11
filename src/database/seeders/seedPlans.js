// src/database/seeders/seedPlans.js
const { Plan } = require('../index');
const logger = require('../../utils/logger');

// Lista de planos com foco no NOME e no PREÇO, que são os dados que usamos.
const plansData = [
  {
    name: 'Plano Sandbox Teste Avancado',
    defaults: {
      description: 'Plano para testes no sandbox que libera acesso avançado.',
      price: 5.00,
      currency: 'BRL',
      durationDays: 30,
      tier: 'avancado',
      isActive: true,
    }
  },
  {
    name: 'MAP - Pessoal Mensal',
    defaults: {
      description: 'Plano mensal para acesso pessoal.',
      price: 39.90,
      currency: 'BRL',
      durationDays: 30,
      tier: 'basico',
      isActive: true,
    }
  },
  {
    name: 'MAP - Pessoal Anual',
    defaults: {
      description: 'Plano anual para acesso pessoal.',
      price: 38.00,
      currency: 'BRL',
      durationDays: 365,
      tier: 'basico',
      isActive: true,
    }
  },
  {
    name: 'MAP - Empresarial Mensal',
    defaults: {
      description: 'Plano mensal para acesso pessoal e empresarial.',
      price: 79.00,
      currency: 'BRL',
      durationDays: 30,
      tier: 'avancado',
      isActive: true,
    }
  },
  {
    name: 'MAP - Empresarial Anual',
    defaults: {
      description: 'Plano anual para acesso pessoal e empresarial.',
      price: 78.00,
      currency: 'BRL',
      durationDays: 365,
      tier: 'avancado',
      isActive: true,
    }
  },
];

/**
 * Função que garante que os planos essenciais existam no banco.
 */
async function seedPlans() {
  try {
    logger.info('[SEEDER] Verificando e semeando planos essenciais...');
    for (const planData of plansData) {
      // Tenta encontrar um plano com o mesmo nome
      const [plan, created] = await Plan.findOrCreate({
        where: { name: planData.name },
        // Se não encontrar, cria com estes dados. O 'price' está aqui.
        defaults: {
          name: planData.name,
          ...planData.defaults,
        }
      });

      if (created) {
        logger.info(`[SEEDER] Plano "${plan.name}" criado com preço R$${plan.price}.`);
      }
    }
    logger.info('[SEEDER] Semeadura de planos concluída.');
  } catch (error) {
    logger.error('[SEEDER] Erro ao semear os planos:', error);
    throw new Error('Falha na semeadura de planos essenciais.');
  }
}

module.exports = { seedPlans };
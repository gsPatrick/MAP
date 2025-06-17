// src/database/seeders/seedPlans.js
const { Plan } = require('../index');
const logger = require('../../utils/logger');

const plansData = [
  {
    id: 1,
    name: 'Básico Mensal',
    price: 49.90,
    durationDays: 30,
    tier: 'basico',
    affiliateCommissionValue: 15.00, // << VALOR DA COMISSÃO AQUI
    isActive: true,
  },
  {
    id: 2,
    name: 'Básico Anual',
    price: 499.90,
    durationDays: 365,
    tier: 'basico',
    affiliateCommissionValue: 100.00, // << VALOR DA COMISSÃO AQUI
    isActive: true,
  },
  {
    id: 3,
    name: 'Avançado Mensal',
    price: 89.90,
    durationDays: 30,
    tier: 'avancado',
    affiliateCommissionValue: 25.00, // << VALOR DA COMISSÃO AQUI
    isActive: true,
  },
  {
    id: 4,
    name: 'Avançado Anual',
    price: 899.90,
    durationDays: 365,
    tier: 'avancado',
    affiliateCommissionValue: 200.00, // << VALOR DA COMISSÃO AQUI
    isActive: true,
  },
  {
    id: 5,
    name: 'Vitalício Básico',
    price: 999.90,
    durationDays: 36500, // ~100 anos
    tier: 'vitalicio',
    affiliateCommissionValue: 250.00, // << VALOR DA COMISSÃO AQUI
    isActive: false, // Exemplo de plano inativo para novas vendas
  },
  {
    id: 6,
    name: 'Vitalício Avançado',
    price: 1499.90,
    durationDays: 36500, // ~100 anos
    tier: 'vitalicio',
    affiliateCommissionValue: 350.00, // << VALOR DA COMISSÃO AQUI
    isActive: true,
  },
];

async function seedPlans() {
  try {
    logger.info('Semeando planos essenciais...');
    for (const planData of plansData) {
      const [plan, created] = await Plan.findOrCreate({
        where: { id: planData.id },
        defaults: planData,
      });

      if (created) {
        logger.info(`Plano "${plan.name}" criado.`);
      } else {
        // Se o plano já existe, verifica se precisa ser atualizado
        const updates = {};
        if (plan.price !== planData.price) updates.price = planData.price;
        if (plan.name !== planData.name) updates.name = planData.name;
        if (plan.durationDays !== planData.durationDays) updates.durationDays = planData.durationDays;
        if (plan.tier !== planData.tier) updates.tier = planData.tier;
        if (plan.isActive !== planData.isActive) updates.isActive = planData.isActive;
        // Verifica e atualiza o valor da comissão
        if (plan.affiliateCommissionValue !== planData.affiliateCommissionValue) {
          updates.affiliateCommissionValue = planData.affiliateCommissionValue;
        }

        if (Object.keys(updates).length > 0) {
          await plan.update(updates);
          logger.info(`Plano "${plan.name}" atualizado com novos valores.`);
        }
      }
    }
    logger.info('Semeadura de planos concluída.');
  } catch (error) {
    logger.error('Erro ao semear os planos:', error);
  }
}

module.exports = { seedPlans };
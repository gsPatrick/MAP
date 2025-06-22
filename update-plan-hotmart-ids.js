// scripts/update-plan-hotmart-ids.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); // Carrega .env da raiz do projeto
const { Plan, sequelize } = require('./src/database/index'); // Ajuste o caminho se seu database/index.js estiver em outro lugar
const logger = require('./src/utils/logger'); // Ajuste o caminho se seu logger estiver em outro lugar
const { Op } = require('sequelize'); // Importar Op

const plansData = [
  // ==========================================================
  // PLANO DE TESTE
  // ==========================================================

  // --- PLANOS PESSOAIS ---
  {
    targetName: 'MAP - Pessoal Mensal',
    hotmartId: null,
    asaasProductId: 'plan_pessoal_mensal_id_do_asaas',
    defaults: {
      description: 'Plano mensal para acesso pessoal.',
      price: 39.90,
      currency: 'BRL',
      durationDays: 30,
      tier: 'basico',
      isActive: true,
      affiliateCommissionValue: 10.00, // << DEFINA O VALOR DA COMISSÃO
    }
  },
  {
    targetName: 'MAP - Pessoal Anual',
    hotmartId: null,
    asaasProductId: 'plan_pessoal_anual_id_do_asaas',
    defaults: {
      description: 'Plano anual para acesso pessoal.',
      price: 38.00, // Este preço parece menor que o mensal, talvez 380.00?
      currency: 'BRL',
      durationDays: 365,
      tier: 'basico',
      isActive: true,
      affiliateCommissionValue: 80.00, // << DEFINA O VALOR DA COMISSÃO
    }
  },

  // --- PLANOS EMPRESARIAIS ---
  {
    targetName: 'MAP - Empresarial Mensal',
    hotmartId: null,
    asaasProductId: 'plan_empresa_mensal_id_do_asaas',
    defaults: {
      description: 'Plano mensal para acesso pessoal e empresarial.',
      price: 79.00,
      currency: 'BRL',
      durationDays: 30,
      tier: 'avancado',
      isActive: true,
      affiliateCommissionValue: 20.00, // << DEFINA O VALOR DA COMISSÃO
    }
  },
  {
    targetName: 'MAP - Empresarial Anual',
    hotmartId: null,
    asaasProductId: 'plan_empresa_anual_id_do_asaas',
    defaults: {
      description: 'Plano anual para acesso pessoal e empresarial.',
      price: 78.00, // Este preço parece menor que o mensal, talvez 780.00?
      currency: 'BRL',
      durationDays: 365,
      tier: 'avancado',
      isActive: true,
      affiliateCommissionValue: 150.00, // << DEFINA O VALOR DA COMISSÃO
    }
  },
];

async function updateOrCreatePlans() {
  try {
    await sequelize.authenticate();
    logger.info('Conexão com o banco de dados estabelecida.');

    // Não precisa mais do sync aqui, pois as migrations cuidam da estrutura
    // await sequelize.sync({ alter: true });

    for (const planEntry of plansData) {
      let plan = await Plan.findOne({ where: { name: planEntry.targetName } });

      if (plan) {
        logger.info(`Plano "${plan.name}" encontrado. Atualizando dados...`);
        // Atualiza os defaults e os IDs para garantir que estejam corretos
        // A lógica de `plan.changed()` já detecta as mudanças
        await plan.update({
            ...planEntry.defaults,
            hotmartProductId: planEntry.hotmartId,
            asaasProductId: planEntry.asaasProductId,
        });
        logger.info(`Plano "${plan.name}" verificado/atualizado.`);

      } else {
        logger.info(`Plano "${planEntry.targetName}" não encontrado. Criando...`);
        plan = await Plan.create({
          name: planEntry.targetName,
          hotmartProductId: planEntry.hotmartId,
          asaasProductId: planEntry.asaasProductId,
          ...planEntry.defaults
        });
        logger.info(`Plano "${plan.name}" criado com sucesso.`);
      }
    }
  } catch (error) {
    logger.error('Erro durante a operação no banco de dados:', error);
  } finally {
    await sequelize.close();
    logger.info('Conexão com o banco de dados fechada.');
  }
}

// Executa a função
updateOrCreatePlans();
// scripts/update-plan-hotmart-ids.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); // Carrega .env da raiz do projeto
const { Plan, sequelize } = require('./src/database/index'); // Ajuste o caminho se seu database/index.js estiver em outro lugar
const logger = require('./src/utils/logger'); // Ajuste o caminho se seu logger estiver em outro lugar
const { Op } = require('sequelize'); // Importar Op

// Lista completa de planos, incluindo o plano de teste para o sandbox do ASAAS
const plansData = [
  // ==========================================================
  // PLANO DE TESTE
  // ==========================================================
  {
    targetName: 'Plano Sandbox Teste Avancado',
    hotmartId: null,
    asaasProductId: null, // asaasId foi renomeado para asaasProductId para consistência
    defaults: {
      description: 'Plano para testes no sandbox que libera acesso avançado.',
      price: 5.00,
      currency: 'BRL',
      durationDays: 30,
      tier: 'avancado',
      isActive: true,
    }
  },

  // --- PLANOS PESSOAIS ---
  {
    targetName: 'MAP - Pessoal Mensal',
    hotmartId: null,
    asaasProductId: 'plan_pessoal_mensal_id_do_asaas', // Substitua pelo ID real do ASAAS quando tiver
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
    targetName: 'MAP - Pessoal Anual',
    hotmartId: null,
    asaasProductId: 'plan_pessoal_anual_id_do_asaas', // Substitua pelo ID real do ASAAS quando tiver
    defaults: {
      description: 'Plano anual para acesso pessoal.',
      price: 38.00,
      currency: 'BRL',
      durationDays: 365,
      tier: 'basico',
      isActive: true,
    }
  },

  // --- PLANOS EMPRESARIAIS ---
  {
    targetName: 'MAP - Empresarial Mensal',
    hotmartId: null,
    asaasProductId: 'plan_empresa_mensal_id_do_asaas', // Substitua pelo ID real do ASAAS quando tiver
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
    targetName: 'MAP - Empresarial Anual',
    hotmartId: null,
    asaasProductId: 'plan_empresa_anual_id_do_asaas', // Substitua pelo ID real do ASAAS quando tiver
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

async function updateOrCreatePlans() {
  try {
    await sequelize.authenticate();
    logger.info('Conexão com o banco de dados estabelecida.');

    // Garante que todas as tabelas (incluindo 'plans') existam antes de continuar.
    // O { alter: true } é seguro para não apagar dados existentes em desenvolvimento.
    await sequelize.sync({ alter: true });
    logger.info('Modelos sincronizados com o banco de dados. Tabelas verificadas/criadas.');

    for (const planEntry of plansData) {
      let plan = await Plan.findOne({ where: { name: planEntry.targetName } });

      if (plan) {
        logger.info(`Plano "${plan.name}" encontrado. Atualizando dados se necessário...`);
        // Atualiza os defaults e os IDs para garantir que estejam corretos
        Object.assign(plan, planEntry.defaults);
        plan.hotmartProductId = planEntry.hotmartId;
        plan.asaasProductId = planEntry.asaasProductId;
        
        if (plan.changed()) {
           await plan.save();
           logger.info(`Plano "${plan.name}" atualizado com sucesso.`);
        } else {
           logger.info(`Plano "${plan.name}" já está atualizado.`);
        }

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
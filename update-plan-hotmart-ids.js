// scripts/update-plan-hotmart-ids.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); // Carrega .env da raiz do projeto
const { Plan, sequelize } = require('./src/database/index'); // Ajuste o caminho se seu database/index.js estiver em outro lugar
const logger = require('./src/utils/logger'); // Ajuste o caminho se seu logger estiver em outro lugar
const { Op } = require('sequelize'); // Importar Op

const plansData = [
  {
    targetName: 'No Controle Plano Pessoal - Mensal',
    hotmartId: '5626407',
    defaults: { // Dados para usar na criação se não existir
      description: 'Plano mensal para acesso pessoal.',
      price: 29.90, // Coloque o preço correto
      currency: 'BRL',
      durationDays: 30,
      tier: 'basico', // Ou 'avancado', dependendo do plano
      isActive: true,
    }
  },
  {
    targetName: 'No Controle Plano Pessoal + Empresarial - Mensal',
    hotmartId: '5626407',
    defaults: {
      description: 'Plano mensal para acesso pessoal e empresarial.',
      price: 49.90, // Coloque o preço correto
      currency: 'BRL',
      durationDays: 30,
      tier: 'avancado', // Ou 'basico'
      isActive: true,
    }
  },
  {
    targetName: 'Plano Webhook Teste ID 0',
    hotmartId: '0',
    defaults: {
      description: 'Plano usado para testar webhooks com Product ID 0.',
      price: 1.00,
      currency: 'BRL',
      durationDays: 30,
      tier: 'basico',
      isActive: true,
    }
  }
];

async function updateOrCreatePlans() {
  try {
    await sequelize.authenticate();
    logger.info('Conexão com o banco de dados estabelecida.');

    for (const planEntry of plansData) {
      let plan = await Plan.findOne({ where: { name: planEntry.targetName } });

      if (plan) { // Se o plano existe pelo nome, apenas atualiza o hotmartId
        logger.info(`Plano "${plan.name}" encontrado. Verificando/Atualizando Hotmart ID para ${planEntry.hotmartId}...`);
        if (planEntry.hotmartId && plan.hotmartProductId !== planEntry.hotmartId) {
          const existingConflict = await Plan.findOne({
            where: { hotmartProductId: planEntry.hotmartId, id: { [Op.ne]: plan.id } }
          });
          if (existingConflict) {
            logger.error(`ERRO: Hotmart Product ID ${planEntry.hotmartId} já usado por "${existingConflict.name}". Não atualizando "${plan.name}".`);
            continue;
          }
          plan.hotmartProductId = planEntry.hotmartId;
          await plan.save();
          logger.info(`Plano "${plan.name}" atualizado. Novo hotmartProductId: ${plan.hotmartProductId}`);
        } else if (!planEntry.hotmartId && plan.hotmartProductId !== null) {
          plan.hotmartProductId = null; // Permite remover o hotmartId
          await plan.save();
           logger.info(`Plano "${plan.name}" atualizado. hotmartProductId removido.`);
        } else {
          logger.info(`Plano "${plan.name}" já está com Hotmart ID ${plan.hotmartProductId || 'N/A'} ou nenhum ID foi fornecido para atualização.`);
        }
      } else { // Se o plano não existe pelo nome, tenta criar
        logger.info(`Plano "${planEntry.targetName}" não encontrado. Tentando criar com Hotmart ID ${planEntry.hotmartId}...`);
        // Antes de criar, verifica se já existe um plano com este hotmartId (se fornecido)
        if (planEntry.hotmartId) {
          const existingByHotmartId = await Plan.findOne({ where: { hotmartProductId: planEntry.hotmartId } });
          if (existingByHotmartId) {
            logger.warn(`Um plano ("${existingByHotmartId.name}") já existe com Hotmart Product ID "${planEntry.hotmartId}". Não será criado um novo plano chamado "${planEntry.targetName}" com este mesmo Hotmart ID.`);
            continue;
          }
        }
        plan = await Plan.create({
          name: planEntry.targetName,
          hotmartProductId: planEntry.hotmartId,
          ...planEntry.defaults // Usa os valores padrão definidos
        });
        logger.info(`Plano "${plan.name}" criado com Hotmart Product ID: ${plan.hotmartProductId}`);
      }
    }

  } catch (error) {
    logger.error('Erro durante a operação no banco de dados:', error);
  } finally {
    await sequelize.close();
    logger.info('Conexão com o banco de dados fechada.');
  }
}

updateOrCreatePlans();
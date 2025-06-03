// scripts/update-plan-hotmart-ids.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); // Carrega .env da raiz do projeto
const { Plan, sequelize } = require('./src/database/index'); // Ajuste o caminho se seu database/index.js estiver em outro lugar
const logger = require('./src/utils/logger'); // Ajuste o caminho se seu logger estiver em outro lugar
const { Op } = require('sequelize'); // Importar Op


const plansData = [
  {
    targetName: 'No Controle Plano Pessoal - Mensal', // Nome EXATO como você quer no seu banco
    hotmartId: '5626771',                            // NOVO ID da Hotmart para este plano
    defaults: {
      description: 'Plano mensal para acesso pessoal.',
      price: 39.90, // << AJUSTE O PREÇO SE NECESSÁRIO
      currency: 'BRL',
      durationDays: 30,
      tier: 'basico', // Assumindo que o plano pessoal é 'basico'. Ajuste se for 'avancado'.
      isActive: true,
    }
  },
  {
    targetName: 'No Controle Plano Pessoal + Empresarial - Mensal', // Nome EXATO
    hotmartId: '5626776',                                        // NOVO ID da Hotmart para este plano
    defaults: {
      description: 'Plano mensal para acesso pessoal e empresarial.',
      price: 49.90, // << AJUSTE O PREÇO SE NECESSÁRIO
      currency: 'BRL',
      durationDays: 30,
      tier: 'avancado', // Assumindo que o plano com empresarial é 'avancado'. Ajuste se necessário.
      isActive: true,
    }
  },
  {
    targetName: 'Plano Webhook Teste ID 0', // Mantendo para seus testes de webhook com ID 0
    hotmartId: '0',
    defaults: {
      description: 'Plano usado para testar webhooks com Product ID 0.',
      price: 0.01,
      currency: 'BRL',
      durationDays: 30,
      tier: 'basico',
      isActive: true,
    }
  }
  // Remova quaisquer definições de planos anuais daqui se você não os terá mais
];

async function updateOrCreatePlans() {
  try {
    await sequelize.authenticate();
    logger.info('Conexão com o banco de dados estabelecida.');

    for (const planEntry of plansData) {
      let plan = await Plan.findOne({ where: { name: planEntry.targetName } });

      if (plan) { // Se o plano existe pelo nome, verifica/atualiza o hotmartId
        logger.info(`Plano "${plan.name}" encontrado. Verificando/Atualizando Hotmart ID para ${planEntry.hotmartId}...`);
        // Somente atualiza se o hotmartId for diferente e não nulo/vazio
        if (planEntry.hotmartId && plan.hotmartProductId !== planEntry.hotmartId) {
          const existingConflict = await Plan.findOne({
            where: { hotmartProductId: planEntry.hotmartId, id: { [Op.ne]: plan.id } }
          });
          if (existingConflict) {
            logger.error(`ERRO: Hotmart Product ID ${planEntry.hotmartId} já usado por "${existingConflict.name}". Não atualizando "${plan.name}".`);
            continue;
          }
          plan.hotmartProductId = planEntry.hotmartId;
          // Opcional: Atualizar outros campos do 'defaults' se quiser que o script também os mantenha sincronizados
          // Object.assign(plan, planEntry.defaults); // Descomente para atualizar todos os defaults
          await plan.save();
          logger.info(`Plano "${plan.name}" atualizado. Novo hotmartProductId: ${plan.hotmartProductId}`);
        } else if (!planEntry.hotmartId && plan.hotmartProductId !== null) {
          plan.hotmartProductId = null;
          await plan.save();
          logger.info(`Plano "${plan.name}" atualizado. hotmartProductId removido.`);
        } else {
          logger.info(`Plano "${plan.name}" já está com Hotmart ID ${plan.hotmartProductId || 'N/A'} ou o novo ID é o mesmo.`);
        }
      } else { // Se o plano não existe pelo nome, tenta criar
        logger.info(`Plano "${planEntry.targetName}" não encontrado. Tentando criar com Hotmart ID ${planEntry.hotmartId}...`);
        if (planEntry.hotmartId) { // Só prossegue se houver um hotmartId para verificar conflito
          const existingByHotmartId = await Plan.findOne({ where: { hotmartProductId: planEntry.hotmartId } });
          if (existingByHotmartId) {
            logger.warn(`Um plano ("${existingByHotmartId.name}") já existe com Hotmart Product ID "${planEntry.hotmartId}". Não será criado um novo plano chamado "${planEntry.targetName}" com este mesmo Hotmart ID.`);
            continue;
          }
        }
        // Cria o plano
        plan = await Plan.create({
          name: planEntry.targetName,
          hotmartProductId: planEntry.hotmartId, // Pode ser null se não definido no planEntry
          ...planEntry.defaults
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
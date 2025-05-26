// src/jobs/index.js

// Importa as funções de *início* dos jobs
const startMotivationalMessageJob = require('./motivationalMessageJob');
const startWaterReminderJob = require('./waterReminderJob');
const startAppointmentReminderJob = require('./appointmentReminderJob');
const startAlertsJob = require('./alertsJob');
const startFinancialSummaryJobs = require('./financialSummaryJob');
const startRecurringTransactionJob = require('./recurringTransactionJob');

const logger = require('../utils/logger');

// Importa o banco de dados e os modelos aqui
// Estes serão importados APENAS QUANDO startJobs for chamado e aguardado em app.js
const { sequelize, UserPreference } = require('../database');


// Torna a função startJobs assíncrona
async function startJobs() {
  logger.info('Iniciando configuração e agendamento de todos os Jobs...');

  try {
    // Busca as preferências *APÓS* a conexão e sincronização terem sido feitas em app.js
    // O await garante que o UserPreference está disponível
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });

    if (!preferences) {
      logger.warn('[JOBS INDEX] Preferências do sistema não encontradas. Alguns jobs podem não ser agendados corretamente com base em defaults de DB.');
      // Se necessário, crie um registro padrão aqui se o hook do modelo não garantir (embora ele garanta)
      // Ou force o uso dos schedules padrão definidos em cada job
    }
    
    // Obtém o objeto de modelos da instância do Sequelize
    const models = sequelize.models;

    // Chama as funções de início de cada job, passando as preferências e os modelos
    // As funções start...Job AGORA APENAS CONFIGURAM o CRON, não leem o DB imediatamente
    startMotivationalMessageJob(preferences, models);
    startWaterReminderJob(preferences, models);
    startAppointmentReminderJob(preferences, models);
    startAlertsJob(preferences, models);
    startFinancialSummaryJobs(preferences, models);
    startRecurringTransactionJob(preferences, models);

    logger.info('Todos os Jobs foram configurados e agendados.');
  } catch (error) {
    // Loga e re-lança o erro para que app.js possa tratar a falha crítica
    logger.error('Erro crítico durante a inicialização ou agendamento dos Jobs:', error);
    throw error;
  }
}

// Exporta a função async startJobs
module.exports = {
  startJobs
};
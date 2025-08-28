// src/jobs/index.js
const startMotivationalMessageJob = require('./motivationalMessageJob');
const startWaterReminderJob = require('./waterReminderJob');
const startAppointmentReminderJob = require('./appointmentReminderJob');
const startAlertsJob = require('./alertsJob');
const startFinancialSummaryJobs = require('./financialSummaryJob');
const startRecurringTransactionJob = require('./recurringTransactionJob');
const startGoogleCalendarWatchRenewalJob = require('./googleCalendarWatchRenewalJob'); // <<< NOVO JOB
const startMorningBriefingJob = require('./morningBriefingJob'); // <<< NOVO JOB IMPORTADO
const startChecklistSummaryJob = require('./checklistSummaryJob'); // <<< ADICIONE ESTE IMPORT
const startChecklistReminderJob = require('./checklistReminderJob'); // <<< ADICIONE ESTE IMPORT
const { startSubscriptionJobs } = require('./subscription.jobs');

const logger = require('../utils/logger');
const { sequelize, UserPreference } = require('../database');

async function startJobs() {
  logger.info('Iniciando configuração e agendamento de todos os Jobs...');
  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (!preferences) {
      logger.warn('[JOBS INDEX] Preferências do sistema não encontradas.');
      // Considerar criar preferências padrão se o hook do modelo não for suficiente
    }
    const models = sequelize.models;

    startMotivationalMessageJob(preferences, models);
    startWaterReminderJob(preferences, models);
    startAppointmentReminderJob(preferences, models);
    startAlertsJob(preferences, models);
    startFinancialSummaryJobs(preferences, models);
    startRecurringTransactionJob(preferences, models);
    startGoogleCalendarWatchRenewalJob(preferences, models); // <<< INICIA O NOVO JOB
    startMorningBriefingJob(preferences, models); // <<< NOVO JOB INICIADO
    startChecklistSummaryJob(); // <<< ADICIONE ESTA LINHA
    startChecklistReminderJob();
     startSubscriptionJobs();
    logger.info('Todos os Jobs foram configurados e agendados.');
  } catch (error) {
    logger.error('Erro crítico durante a inicialização ou agendamento dos Jobs:', error);
    throw error;
  }
}

module.exports = {
  startJobs
};
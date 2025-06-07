// src/jobs/index.js
const startMotivationalMessageJob = require('./motivationalMessageJob');
const startWaterReminderJob = require('./waterReminderJob');
const startAppointmentReminderJob = require('./appointmentReminderJob');
const startAlertsJob = require('./alertsJob');
const startFinancialSummaryJobs = require('./financialSummaryJob');
const startRecurringTransactionJob = require('./recurringTransactionJob');
const startGoogleCalendarWatchRenewalJob = require('./googleCalendarWatchRenewalJob');
// <<< NOVO IMPORT >>>
const startHighFrequencyRecurringJob = require('./highFrequencyRecurringJob');
const startInvoiceGenerationJob = require('./invoiceGenerationJob'); // <<< NOVO IMPORT

const logger = require('../utils/logger');
const { sequelize, UserPreference } = require('../database');

async function startJobs() {
  logger.info('Iniciando configuração e agendamento de todos os Jobs...');
  try {
    const preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (!preferences) {
      logger.warn('[JOBS INDEX] Preferências do sistema não encontradas.');
    }
    const models = sequelize.models;

    startMotivationalMessageJob(preferences, models);
    startWaterReminderJob(preferences, models);
    startAppointmentReminderJob(preferences, models);
    startAlertsJob(preferences, models);
    startFinancialSummaryJobs(preferences, models);
    startRecurringTransactionJob(preferences, models); // Job de baixa frequência
    startGoogleCalendarWatchRenewalJob(preferences, models);
    // <<< INICIAR NOVO JOB >>>
    startHighFrequencyRecurringJob(preferences, models); // Job de alta frequência
        startInvoiceGenerationJob(preferences, models); // <<< INICIA O NOVO JOB DE FATURAS


    logger.info('Todos os Jobs foram configurados e agendados.');
  } catch (error) {
    logger.error('Erro crítico durante a inicialização ou agendamento dos Jobs:', error);
    throw error;
  }
}

module.exports = {
  startJobs
};
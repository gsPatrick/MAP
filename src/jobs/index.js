// src/jobs/index.js
const startMotivationalMessageJob = require('./motivationalMessageJob');
const startWaterReminderJob = require('./waterReminderJob');
const startAppointmentReminderJob = require('./appointmentReminderJob');
const startAlertsJob = require('./alertsJob');
const startFinancialSummaryJobs = require('./financialSummaryJob');
const startRecurringTransactionJob = require('./recurringTransactionJob'); // Adicione este se ainda não estiver
const logger = require('../utils/logger');

function startJobs() {
  logger.info('Iniciando configuração e agendamento de todos os Jobs...');

  startMotivationalMessageJob();
  startWaterReminderJob();
  startAppointmentReminderJob();
  startAlertsJob();
  startFinancialSummaryJobs();
  startRecurringTransactionJob(); // Certifique-se que está sendo chamado

  logger.info('Todos os Jobs foram configurados e agendados.');
}

// A forma de exportar é crucial
module.exports = {
  startJobs // Exportando um objeto com a função startJobs
};
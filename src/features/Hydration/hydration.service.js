// src/features/Hydration/hydration.service.js
const { WaterIntakeLog, Client, UserPreference } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const dayjs = require('dayjs');

const MIN_CUSTOM_INTERVAL_IN_MINUTES_SYSTEM = 15;

/**
 * Gera ou recupera os logs de hidratação para um cliente em um dia específico.
 * Se os logs para o dia ainda não existem, eles são criados com base nas preferências do cliente.
 */
async function getOrCreateDailyLogs(clientId) {
  const today = dayjs().format('YYYY-MM-DD');

  let logs = await WaterIntakeLog.findAll({
    where: { clientId, intakeDate: today },
    order: [['scheduledTime', 'ASC']]
  });

  // Se já existem logs para hoje, retorna eles.
  if (logs.length > 0) {
    logger.info(`Logs de hidratação para o dia ${today} já existem para o cliente ${clientId}. Retornando existentes.`);
    return logs.map(log => log.toJSON());
  }

  // Se não existem, busca as preferências para criá-los.
  // Esta lógica assume que as preferências são globais. Se fossem por cliente, o include seria no Client.
  const prefs = await UserPreference.findOne();
  if (!prefs || !prefs.enableWaterReminder || prefs.waterReminderFrequencyType === 'disabled') {
    logger.info(`Lembretes de água desativados para o cliente ${clientId}. Nenhum log gerado.`);
    return [];
  }

  const {
    dailyGoalMl,
    waterReminderFrequencyType,
    waterReminderCustomIntervalMinutes,
    waterReminderStartTime,
    waterReminderEndTime
  } = prefs;

  const listToCreate = [];
  let intervalMinutes;

  if (waterReminderFrequencyType === 'custom') {
    intervalMinutes = waterReminderCustomIntervalMinutes >= MIN_CUSTOM_INTERVAL_IN_MINUTES_SYSTEM ? waterReminderCustomIntervalMinutes : MIN_CUSTOM_INTERVAL_IN_MINUTES_SYSTEM;
  } else {
    intervalMinutes = parseInt(waterReminderFrequencyType.replace('h', ''), 10) * 60;
  }

  const start = dayjs(`1970-01-01T${waterReminderStartTime}`);
  const end = dayjs(`1970-01-01T${waterReminderEndTime}`);

  if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
    return [];
  }

  const durationTotalMinutes = end.diff(start, 'minute');
  let numberOfIntervals = 0;
  if (durationTotalMinutes >= 0 && intervalMinutes > 0) {
    numberOfIntervals = Math.floor(durationTotalMinutes / intervalMinutes) + 1;
  }

  const amountPerPortion = (dailyGoalMl > 0 && numberOfIntervals > 0)
    ? Math.max(100, Math.round(dailyGoalMl / numberOfIntervals / 50) * 50)
    : 250;

  let currentTime = start;
  for (let i = 0; i < numberOfIntervals; i++) {
    if (currentTime.isAfter(end)) break;
    listToCreate.push({
      clientId,
      intakeDate: today,
      scheduledTime: currentTime.format('HH:mm:ss'),
      amount: amountPerPortion,
      status: 'pending'
    });
    currentTime = currentTime.add(intervalMinutes, 'minute');
  }

  if (listToCreate.length > 0) {
    const createdLogs = await WaterIntakeLog.bulkCreate(listToCreate);
    logger.info(`${createdLogs.length} logs de hidratação criados para o dia ${today} para o cliente ${clientId}.`);
    return createdLogs.map(log => log.toJSON());
  }

  return [];
}

/**
 * Atualiza o status de um log de hidratação específico.
 */
async function updateLogStatus(clientId, logId, status) {
  if (!['pending', 'completed'].includes(status)) {
    const error = new Error('Status inválido. Use "pending" ou "completed".');
    error.statusCode = 400;
    throw error;
  }

  const log = await WaterIntakeLog.findOne({ where: { id: logId, clientId } });

  if (!log) {
    const error = new Error('Log de hidratação não encontrado ou não pertence a este usuário.');
    error.statusCode = 404;
    throw error;
  }

  const updatedLog = await log.update({
    status,
    completedAt: status === 'completed' ? new Date() : null
  });

  logger.info(`Log de hidratação ID ${logId} atualizado para status "${status}" para o cliente ${clientId}.`);
  return updatedLog.toJSON();
}

module.exports = {
  getOrCreateDailyLogs,
  updateLogStatus,
};
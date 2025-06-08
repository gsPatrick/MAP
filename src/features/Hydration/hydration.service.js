// src/features/Hydration/hydration.service.js
const { WaterIntakeLog, Client, UserPreference } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const dayjs = require('dayjs');

const MIN_CUSTOM_INTERVAL_IN_MINUTES_SYSTEM = 15;


async function createOrUpdateHydrationSettings(clientId, settings) {
    const {
        dailyGoalMl,
        enableWaterReminder,
        waterReminderFrequencyType,
        waterReminderCustomIntervalMinutes,
        waterReminderStartTime, // Formato 'HH:mm:ss'
        waterReminderEndTime,   // Formato 'HH:mm:ss'
    } = settings;

    // 1. Salva as preferências na tabela UserPreference (ou em Client, se você mover para lá)
    // Por enquanto, vamos manter em UserPreference como no seu código original.
    const preferences = await UserPreference.findOne();
    await preferences.update({
        dailyGoalMl,
        enableWaterReminder,
        waterReminderFrequencyType,
        waterReminderCustomIntervalMinutes,
        waterReminderStartTime,
        waterReminderEndTime,
    });

    const today = dayjs().format('YYYY-MM-DD');

    // 2. Apaga logs PENDENTES futuros para este cliente para evitar duplicatas
    await WaterIntakeLog.destroy({
        where: {
            clientId: clientId,
            status: 'pending',
            intakeDate: { [Op.gte]: today }
        }
    });

    // 3. Se os lembretes estão desativados, não há mais nada a fazer.
    if (!enableWaterReminder || waterReminderFrequencyType === 'disabled') {
        return { message: 'Lembretes desativados. Logs futuros foram limpos.' };
    }

    // 4. Calcula os horários e gera os novos logs
    let intervalMinutes;
    if (waterReminderFrequencyType === '2h') intervalMinutes = 120;
    else if (waterReminderFrequencyType === '3h') intervalMinutes = 180;
    else if (waterReminderFrequencyType === 'custom') intervalMinutes = waterReminderCustomIntervalMinutes;
    else return { message: 'Frequência inválida.' };

    const start = dayjs(today + 'T' + waterReminderStartTime);
    const end = dayjs(today + 'T' + waterReminderEndTime);
    const reminders = [];
    let current = start;

    while (current.isBefore(end) || current.isSame(end)) {
        reminders.push({ time: current.format('HH:mm:ss') });
        current = current.add(intervalMinutes, 'minute');
    }

    if (reminders.length === 0) {
        return { message: 'Nenhum lembrete a ser gerado com base nos horários fornecidos.' };
    }

    // Calcula a quantidade de água por lembrete
    const amountPerReminder = Math.round(dailyGoalMl / reminders.length);

    const logsToCreate = reminders.map(r => ({
        clientId: clientId,
        intakeDate: today,
        scheduledTime: r.time,
        status: 'pending',
        amount: amountPerReminder,
    }));

    // 5. Cria todos os logs de uma vez no banco de dados
    await WaterIntakeLog.bulkCreate(logsToCreate);

    return { message: `${logsToCreate.length} logs de hidratação criados para hoje.` };
}


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

/**
 * Busca todos os logs de hidratação (completos, pendentes, etc.) para um cliente na data de hoje.
 * @param {number} clientId - O ID do cliente logado.
 * @returns {Promise<WaterIntakeLog[]>} - Uma promessa que resolve para um array de logs de hidratação.
 */
async function getTodaysLogsByClient(clientId) {
    const today = dayjs().format('YYYY-MM-DD');

    const logs = await WaterIntakeLog.findAll({
        where: {
            clientId: clientId,
            intakeDate: today,
        },
        order: [['scheduledTime', 'ASC']] // Ordena por hora
    });

    return logs;
}



module.exports = {
  getOrCreateDailyLogs,
  updateLogStatus,
  getTodaysLogsByClient,
  createOrUpdateHydrationSettings
};
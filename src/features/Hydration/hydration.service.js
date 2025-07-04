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
            status: { [Op.in]: ['pending', 'notified'] }, // Inclui 'notified' para limpar lembretes ativos
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
  // MUDANÇA: Adicionado 'notified' como status válido.
  if (!['pending', 'completed', 'notified', 'failed'].includes(status)) { 
    const error = new Error('Status inválido. Use "pending", "completed", "notified" ou "failed".');
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
    // Define completedAt apenas se o status for 'completed'
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

/**
 * Cria um único log de consumo de água.
 * @param {number} clientId - ID do cliente.
 * @param {number} amount - Quantidade de água em ml.
 * @param {string} scheduledTime - Hora agendada para o log (HH:MM:SS).
 * @param {string} status - Status inicial do log ('pending', 'completed', 'notified').
 * @param {string} intakeDate - Data do log (YYYY-MM-DD). Default para hoje.
 * @returns {Promise<WaterIntakeLog>} O log de água criado.
 */
async function createSingleWaterIntakeLog(clientId, amount, scheduledTime, status = 'pending', intakeDate = null) {
    const today = intakeDate || new Date().toISOString().split('T')[0];
    const newLog = await WaterIntakeLog.create({
        clientId,
        intakeDate: today,
        scheduledTime,
        amount,
        status,
        completedAt: status === 'completed' ? new Date() : null,
    });
    logger.info(`[HydrationService] Novo log de água para ${clientId} criado: ${amount}ml às ${scheduledTime}, status ${status}.`);
    return newLog;
}


async function logWaterIntake(clientId, amount = null) {
    if (amount && (isNaN(amount) || amount <= 0)) {
        throw new Error("A quantidade de água registrada deve ser um número positivo.");
    }

    if (amount) {
        // Se uma quantidade foi especificada, criamos um novo registro já completo.
        const now = new Date();
        const scheduledTime = now.toLocaleTimeString('pt-BR', { hour12: false, timeZone: process.env.TZ || 'America/Sao_Paulo' });
        // Usa a nova função
        const newLog = await createSingleWaterIntakeLog(clientId, amount, scheduledTime, 'completed');
        logger.info(`[HydrationService] Log de água de ${amount}ml criado diretamente para cliente ${clientId}.`);
        return newLog.toJSON();
    } else {
        // Se nenhuma quantidade foi especificada, encontramos o próximo log pendente e o marcamos.
        const today = new Date().toISOString().split('T')[0];
        const nextPendingLog = await WaterIntakeLog.findOne({
            where: {
                clientId,
                status: { [Op.in]: ['pending', 'notified'] }, // Pode ser 'pending' ou 'notified'
                intakeDate: today,
            },
            order: [['scheduledTime', 'ASC']]
        });

        if (nextPendingLog) {
            return await updateLogStatus(clientId, nextPendingLog.id, 'completed');
        } else {
            // Se não há logs pendentes, podemos criar um genérico ou informar o usuário.
            logger.info(`[HydrationService] Nenhum log pendente ou notificado encontrado para cliente ${clientId}. Criando log genérico.`);
            return await logWaterIntake(clientId, 200); // Chama a si mesmo com um valor padrão.
        }
    }
}

/**
 * Lida com a resposta negativa do usuário ('Não Bebi').
 * Marca o log original como 'completed' e cria um novo log para 5 minutos no futuro.
 * @param {number} clientId - ID do cliente.
 * @param {number} originalLogId - ID do log original ao qual o usuário respondeu 'Não Bebi'.
 * @returns {Promise<void>}
 */
async function handleNegativeWaterResponse(clientId, originalLogId) {
    const originalLog = await WaterIntakeLog.findOne({ where: { id: originalLogId, clientId } });

    if (!originalLog) {
        logger.warn(`[HydrationService] Tentativa de processar resposta negativa para log de água inexistente (ID: ${originalLogId}, Cliente: ${clientId}).`);
        return;
    }

    // 1. Marcar o log original como 'completed' para tirá-lo do fluxo de lembretes pendentes/notificados.
    // Isso é importante para que o job não o pegue mais para reenvio do lembrete original.
    await updateLogStatus(clientId, originalLogId, 'completed');
    logger.info(`[HydrationService] Log de água original (ID: ${originalLogId}) marcado como 'completed' após resposta 'Não Bebi'.`);

    // 2. Criar um novo log de água para 5 minutos no futuro, com o mesmo 'amount' e status 'pending'.
    const newScheduledTime = dayjs().add(5, 'minute').format('HH:mm:ss');
    await createSingleWaterIntakeLog(clientId, originalLog.amount, newScheduledTime, 'pending');
    logger.info(`[HydrationService] Novo log de água criado para reenvio em 5 minutos (Cliente: ${clientId}, Horário: ${newScheduledTime}).`);
}


module.exports = {
  getOrCreateDailyLogs,
  updateLogStatus,
  getTodaysLogsByClient,
  createOrUpdateHydrationSettings,
  logWaterIntake,
  handleNegativeWaterResponse // Exportar a nova função
};
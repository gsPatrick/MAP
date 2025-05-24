// src/features/System/system.service.js
const { UserPreference, MotivationalPhrase, sequelize } = require('../../database'); // Removido FinancialCategory e FinancialTransaction
const logger = require('../../utils/logger');
// const { Op } = require('sequelize'); // Removido se não usado mais aqui

/**
 * Obtém as preferências/configurações do sistema.
 * Assume que há apenas um registro de UserPreference ou que estamos buscando um específico.
 * Para simplificar, buscaremos o primeiro registro. Em um sistema multi-admin,
 * você buscaria pelo userId ou teria um ID fixo para configurações globais.
 * @returns {Promise<object|null>} As configurações do sistema.
 */
async function getSystemPreferences() {
  try {
    let preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (!preferences) {
      logger.info('Nenhuma preferência do sistema encontrada. Criando com valores padrão.');
      preferences = await UserPreference.create({});
    }
    logger.info('Preferências do sistema recuperadas.');
    return preferences.toJSON();
  } catch (error) {
    logger.error(`Erro ao obter preferências do sistema: ${error.message}`, { error });
    throw new Error(`Erro ao obter preferências do sistema: ${error.message}`);
  }
}

/**
 * Atualiza as preferências/configurações do sistema.
 * @param {object} updateData - Dados a serem atualizados no UserPreference.
 * @returns {Promise<object|null>} As configurações atualizadas.
 */
async function updateSystemPreferences(updateData) {
  const t = await sequelize.transaction();
  try {
    let preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
    if (!preferences) {
      logger.info('Nenhuma preferência do sistema encontrada para atualizar. Criando uma nova.');
      preferences = await UserPreference.create(updateData, { transaction: t });
    } else {
      const allowedUpdates = [
        'enableWaterReminder', 'waterReminderFrequencyType', 'waterReminderCustomIntervalMinutes',
        'waterReminderStartTime', 'waterReminderEndTime', 'dailyGoalMl', 'lastWaterReminderSentTimestamp',
        'enableMotivationMessage', 'motivationMessageTime', 'lastMotivationalMessageSentDate',
        'dailySummaryTime', 'weeklySummaryDayOfWeek', 'weeklySummaryTime',
        'monthlyReportDayOfMonth', 'monthlyReportTime',
        'defaultAppointmentReminderLeadTimeMinutes', 'recurringJobSchedule',
        'appointmentReminderJobSchedule', 'alertsJobSchedule', 'motivationalMessageJobSchedule',
        'waterReminderJobSchedule', 'dueAlertLeadDays', 'fiscalAlertLeadDaysMEI'
      ];
      const filteredData = {};
      for (const key of allowedUpdates) {
        if (updateData.hasOwnProperty(key)) {
          filteredData[key] = updateData[key];
        }
      }
      if (Object.keys(filteredData).length > 0) {
        await preferences.update(filteredData, { transaction: t });
      } else {
        logger.info('[SYSTEM SERVICE] Nenhum dado válido para atualizar preferências do sistema.');
      }
    }
    await t.commit();
    logger.info('Preferências do sistema atualizadas com sucesso.');
    return preferences.reload().then(p => p.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar preferências do sistema: ${error.message}`, { error, updateData });
    throw new Error(`Erro ao atualizar preferências do sistema: ${error.message}`);
  }
}

// --- Gerenciamento de Frases Motivacionais ---
async function createMotivationalPhrase(phraseData) {
  try {
    if (!phraseData.text) {
      const error = new Error('Texto é obrigatório para a frase motivacional.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const phrase = await MotivationalPhrase.create(phraseData);
    logger.info(`Frase Motivacional criada: ID ${phrase.id}`);
    return phrase.toJSON();
  } catch (error) {
    logger.error(`Erro ao criar frase motivacional: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAllMotivationalPhrases(queryParams = {}) {
    const { isActive } = queryParams;
    const whereConditions = {};
    if (isActive !== undefined) {
        whereConditions.isActive = (isActive === 'true' || isActive === true);
    }
  try {
    const phrases = await MotivationalPhrase.findAll({ where: whereConditions, order: [['createdAt', 'DESC']] });
    return phrases.map(p => p.toJSON());
  } catch (error) {
    logger.error(`Erro ao listar frases motivacionais: ${error.message}`, { error });
    throw new Error(`Erro ao listar frases motivacionais: ${error.message}`);
  }
}

async function updateMotivationalPhrase(phraseId, updateData) {
  try {
    const phrase = await MotivationalPhrase.findByPk(phraseId);
    if (!phrase) {
        const e = new Error('Frase motivacional não encontrada.');
        e.statusCode = 404; e.status = 'fail'; throw e;
    }
    const allowedFields = ['text', 'isActive'];
    const filteredData = {};
    for (const key of allowedFields) {
        if (updateData.hasOwnProperty(key)) {
            filteredData[key] = updateData[key];
        }
    }
    if (Object.keys(filteredData).length === 0) {
        return phrase.toJSON();
    }
    await phrase.update(filteredData);
    logger.info(`Frase Motivacional atualizada: ID ${phrase.id}`);
    return phrase.toJSON();
  } catch (error) {
    logger.error(`Erro ao atualizar frase motivacional ID ${phraseId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteMotivationalPhrase(phraseId) {
  try {
    const phrase = await MotivationalPhrase.findByPk(phraseId);
    if (!phrase) {
        logger.warn(`Frase motivacional ID ${phraseId} não encontrada para exclusão.`);
        return false;
    }
    await phrase.destroy();
    logger.info(`Frase Motivacional deletada: ID ${phrase.id}`);
    return true;
  } catch (error) {
    logger.error(`Erro ao deletar frase motivacional ID ${phraseId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}


module.exports = {
  getSystemPreferences,
  updateSystemPreferences,
  // Funções de FinancialCategory removidas daqui
  createMotivationalPhrase,
  getAllMotivationalPhrases,
  updateMotivationalPhrase,
  deleteMotivationalPhrase,
};
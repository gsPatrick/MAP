// src/features/Availability/availability.service.js
const { AvailabilityRule, Appointment, FinancialAccount, sequelize } = require('../../database');
const { Op } = require('sequelize');
const { RRule, RRuleSet, rrulestr } = require('rrule');
const logger = require('../../utils/logger');

/**
 * Valida a conta financeira (se é PJ/MEI e está ativa).
 */
async function validateServiceAccount(financialAccountId, transaction = null) {
  const account = await FinancialAccount.findByPk(financialAccountId, { transaction });
  if (!account) {
    const error = new Error(`Conta Financeira com ID ${financialAccountId} não encontrada.`);
    error.statusCode = 404; throw error;
  }
  if (!['PJ', 'MEI'].includes(account.accountType)) {
    const error = new Error('A gestão de disponibilidade é exclusiva para contas PJ/MEI.');
    error.statusCode = 403; throw error;
  }
  return account;
}

/**
 * Cria uma nova regra de disponibilidade.
 */
async function createAvailabilityRule(financialAccountId, ruleData) {
  await validateServiceAccount(financialAccountId);
  const { type, rrule, startTime, endTime, specificDate, title } = ruleData;

  if (!type || !title) {
    const error = new Error("Tipo ('work', 'break', 'day_off') e Título da regra são obrigatórios.");
    error.statusCode = 400; throw error;
  }

  const newRule = await AvailabilityRule.create({ ...ruleData, financialAccountId });
  logger.info(`Regra de disponibilidade ID ${newRule.id} ("${newRule.title}") criada para FA ID ${financialAccountId}.`);
  return newRule.toJSON();
}

/**
 * Lista todas as regras de disponibilidade de uma conta.
 */
async function getAllAvailabilityRules(financialAccountId) {
  await validateServiceAccount(financialAccountId);
  const rules = await AvailabilityRule.findAll({
    where: { financialAccountId },
    order: [['type', 'ASC'], ['startTime', 'ASC']],
  });
  return rules.map(rule => rule.toJSON());
}

/**
 * Busca uma regra de disponibilidade por ID.
 */
async function getAvailabilityRuleById(financialAccountId, ruleId) {
    await validateServiceAccount(financialAccountId);
    const rule = await AvailabilityRule.findOne({ where: { id: ruleId, financialAccountId } });
    if (!rule) {
        const error = new Error(`Regra de disponibilidade ID ${ruleId} não encontrada.`);
        error.statusCode = 404;
        throw error;
    }
    return rule.toJSON();
}


/**
 * Atualiza uma regra de disponibilidade.
 */
async function updateAvailabilityRule(financialAccountId, ruleId, updateData) {
    await validateServiceAccount(financialAccountId);
    const rule = await AvailabilityRule.findOne({ where: { id: ruleId, financialAccountId } });
    if (!rule) {
        const error = new Error(`Regra de disponibilidade ID ${ruleId} não encontrada.`);
        error.statusCode = 404;
        throw error;
    }
    await rule.update(updateData);
    logger.info(`Regra de disponibilidade ID ${ruleId} atualizada para FA ID ${financialAccountId}.`);
    return rule.toJSON();
}

/**
 * Deleta uma regra de disponibilidade.
 */
async function deleteAvailabilityRule(financialAccountId, ruleId) {
    await validateServiceAccount(financialAccountId);
    const rule = await AvailabilityRule.findOne({ where: { id: ruleId, financialAccountId } });
    if (!rule) {
        const error = new Error(`Regra de disponibilidade ID ${ruleId} não encontrada.`);
        error.statusCode = 404;
        throw error;
    }
    await rule.destroy();
    logger.info(`Regra de disponibilidade ID ${ruleId} deletada da FA ID ${financialAccountId}.`);
    return true;
}


/**
 * Verifica se um determinado slot de tempo está disponível para agendamento.
 * @param {number} financialAccountId - O ID da conta a ser verificada.
 * @param {Date|string} startDateTime - O início do horário desejado.
 * @param {number} durationMinutes - A duração do agendamento em minutos.
 * @returns {Promise<boolean>} True se o horário estiver livre, false caso contrário.
 */
async function isTimeSlotAvailable(financialAccountId, startDateTime, durationMinutes) {
  const desiredStart = new Date(startDateTime);
  const desiredEnd = new Date(desiredStart.getTime() + durationMinutes * 60 * 1000);
  
  // 1. Verificar colisão com agendamentos existentes
  const existingAppointment = await Appointment.findOne({
    where: {
      financialAccountId,
      status: { [Op.in]: ['Scheduled', 'Confirmed'] },
      eventDateTime: {
        [Op.lt]: desiredEnd,
        [Op.gt]: new Date(desiredStart.getTime() - (24 * 60 * 60 * 1000)), // Otimização para não buscar todo o DB
      },
    },
  });

  if (existingAppointment) {
    const existingStart = new Date(existingAppointment.eventDateTime);
    const existingEnd = new Date(existingStart.getTime() + (existingAppointment.durationMinutes || 60) * 60 * 1000);
    if (desiredStart < existingEnd && desiredEnd > existingStart) {
      logger.warn(`[Availability] Conflito de horário para FA ${financialAccountId}: Slot desejado ${desiredStart.toISOString()} colide com agendamento existente ID ${existingAppointment.id}.`);
      return false;
    }
  }

  // 2. Obter todas as regras de disponibilidade
  const rules = await AvailabilityRule.findAll({ where: { financialAccountId } });
  const workRule = rules.find(r => r.type === 'work');
  const breakRules = rules.filter(r => r.type === 'break');
  const dayOffRules = rules.filter(r => r.type === 'day_off');

  // 3. Verificar se é um dia de folga específico
  const desiredDateString = desiredStart.toISOString().split('T')[0];
  if (dayOffRules.some(rule => rule.specificDate === desiredDateString)) {
    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredDateString} é um dia de folga.`);
    return false;
  }

  // 4. Verificar se o dia da semana e o horário estão dentro da jornada de trabalho
  if (!workRule || !workRule.rrule || !workRule.startTime || !workRule.endTime) {
    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: Nenhuma regra de trabalho (work rule) válida encontrada.`);
    return false;
  }

  try {
    const rule = rrulestr(workRule.rrule);
    const startOfDay = new Date(desiredStart.toISOString().split('T')[0] + 'T00:00:00.000Z');
    const endOfDay = new Date(desiredStart.toISOString().split('T')[0] + 'T23:59:59.999Z');
    
    // Verifica se o dia desejado é uma ocorrência da regra de trabalho
    const occurrences = rule.between(startOfDay, endOfDay);
    if (occurrences.length === 0) {
      logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: O dia ${desiredDateString} não é um dia de trabalho segundo a RRULE.`);
      return false;
    }

    // Compara apenas as horas e minutos, ignorando a data
    const workStart = new Date(`1970-01-01T${workRule.startTime}Z`);
    const workEnd = new Date(`1970-01-01T${workRule.endTime}Z`);
    const desiredStartTime = new Date(`1970-01-01T${desiredStart.toISOString().split('T')[1]}`);
    const desiredEndTime = new Date(`1970-01-01T${desiredEnd.toISOString().split('T')[1]}`);

    if (desiredStartTime < workStart || desiredEndTime > workEnd) {
      logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredStart.toISOString()} está fora do expediente (${workRule.startTime}-${workRule.endTime}).`);
      return false;
    }

    // 5. Verificar se colide com um intervalo (break)
    for (const breakRule of breakRules) {
        if (breakRule.rrule) {
            const breakOccurrences = rrulestr(breakRule.rrule).between(startOfDay, endOfDay);
            if (breakOccurrences.length > 0) {
                const breakStart = new Date(`1970-01-01T${breakRule.startTime}Z`);
                const breakEnd = new Date(`1970-01-01T${breakRule.endTime}Z`);
                if (desiredStartTime < breakEnd && desiredEndTime > breakStart) {
                    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredStart.toISOString()} colide com um intervalo.`);
                    return false;
                }
            }
        }
    }

  } catch (e) {
    logger.error(`[Availability] Erro ao processar RRULE para FA ${financialAccountId}: ${e.message}`);
    return false;
  }

  logger.info(`[Availability] Slot disponível para FA ${financialAccountId} em ${desiredStart.toISOString()}.`);
  return true;
}

module.exports = {
  createAvailabilityRule,
  getAllAvailabilityRules,
  getAvailabilityRuleById,
  updateAvailabilityRule,
  deleteAvailabilityRule,
  isTimeSlotAvailable,
};
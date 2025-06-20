// src/features/Availability/availability.service.js
const { AvailabilityRule, Appointment, FinancialAccount, sequelize } = require('../../database');
const { Op } = require('sequelize');
const { RRule, RRuleSet, rrulestr } = require('rrule');
const logger = require('../../utils/logger');

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

async function getAllAvailabilityRules(financialAccountId) {
  await validateServiceAccount(financialAccountId);
  const rules = await AvailabilityRule.findAll({
    where: { financialAccountId },
    order: [['type', 'ASC'], ['startTime', 'ASC']],
  });
  return rules.map(rule => rule.toJSON());
}

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
async function isTimeSlotAvailable(financialAccountId, desiredStart, desiredEnd) {
  const desiredDateString = desiredStart.toISOString().split('T')[0];

  // 1. Buscar TODOS os agendamentos do dia para verificação manual
  const dayStart = new Date(`${desiredDateString}T00:00:00.000Z`);
  const dayEnd = new Date(`${desiredDateString}T23:59:59.999Z`);

  const appointmentsOnThisDay = await Appointment.findAll({
    where: {
      financialAccountId,
      status: { [Op.in]: ['Scheduled', 'Confirmed'] },
      eventDateTime: {
        [Op.between]: [dayStart, dayEnd],
      },
    },
  });

  // 2. Iterar e verificar conflitos manualmente
  for (const existingAppt of appointmentsOnThisDay) {
    const existingStart = new Date(existingAppt.eventDateTime);
    const existingDuration = existingAppt.durationMinutes || 30; // Fallback seguro
    const existingEnd = new Date(existingStart.getTime() + existingDuration * 60 * 1000);

    // Lógica de sobreposição: (InícioA < FimB) e (FimA > InícioB)
    if (desiredStart.getTime() < existingEnd.getTime() && desiredEnd.getTime() > existingStart.getTime()) {
      logger.warn(`[Availability] Conflito de horário para FA ${financialAccountId}: Slot desejado ${desiredStart.toISOString()} colide com agendamento existente ID ${existingAppt.id}.`);
      return false;
    }
  }

  // 3. O resto da lógica para verificar regras de trabalho, pausas e folgas
  const rules = await AvailabilityRule.findAll({ where: { financialAccountId } });
  const workRule = rules.find(r => r.type === 'work');
  const breakRules = rules.filter(r => r.type === 'break');
  const dayOffRules = rules.filter(r => r.type === 'day_off');

  if (dayOffRules.some(rule => rule.specificDate === desiredDateString)) {
    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredDateString} é um dia de folga.`);
    return false;
  }

  if (!workRule || !workRule.rrule || !workRule.startTime || !workRule.endTime) {
    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: Nenhuma regra de trabalho (work rule) válida encontrada.`);
    return false;
  }

  try {
    const rule = rrulestr(workRule.rrule, { dtstart: dayStart });
    const occurrences = rule.between(dayStart, dayEnd, true);
    if (occurrences.length === 0) {
      logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: O dia ${desiredDateString} não é um dia de trabalho segundo a RRULE.`);
      return false;
    }

    const [workStartHour, workStartMinute] = workRule.startTime.split(':').map(Number);
    const [workEndHour, workEndMinute] = workRule.endTime.split(':').map(Number);
    
    const desiredStartTotalMinutes = desiredStart.getUTCHours() * 60 + desiredStart.getUTCMinutes();
    const desiredEndTotalMinutes = desiredEnd.getUTCHours() * 60 + desiredEnd.getUTCMinutes();
    const workStartTotalMinutes = workStartHour * 60 + workStartMinute;
    const workEndTotalMinutes = workEndHour * 60 + workEndMinute;

    if (desiredStartTotalMinutes < workStartTotalMinutes || desiredEndTotalMinutes > workEndTotalMinutes) {
      logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredStart.toISOString()} está fora do expediente (${workRule.startTime}-${workRule.endTime}).`);
      return false;
    }

    for (const breakRule of breakRules) {
        if (breakRule.rrule && breakRule.startTime && breakRule.endTime) {
            const breakRuleInstance = rrulestr(breakRule.rrule, { dtstart: dayStart });
            const breakOccurrences = breakRuleInstance.between(dayStart, dayEnd, true);
            if (breakOccurrences.length > 0) {
                const [breakStartHour, breakStartMinute] = breakRule.startTime.split(':').map(Number);
                const [breakEndHour, breakEndMinute] = breakRule.endTime.split(':').map(Number);
                const breakStartTotalMinutes = breakStartHour * 60 + breakStartMinute;
                const breakEndTotalMinutes = breakEndHour * 60 + breakEndMinute;

                if (desiredStartTotalMinutes < breakEndTotalMinutes && desiredEndTotalMinutes > breakStartTotalMinutes) {
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
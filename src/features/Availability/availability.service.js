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
  const desiredDate = desiredStart.toISOString().split('T')[0]; // YYYY-MM-DD

  // 1. Verificar se o horário colide com algum agendamento existente
  const existingAppointment = await Appointment.findOne({
    where: {
      financialAccountId,
      status: { [Op.in]: ['Scheduled', 'Confirmed'] },
      eventDateTime: {
        [Op.lt]: desiredEnd, // Começa antes do fim do desejado
        [Op.gt]: new Date(desiredStart.getTime() - (24 * 60 * 60 * 1000)), // Evita buscar todo o DB
      },
    },
  });

  if (existingAppointment) {
    const existingStart = new Date(existingAppointment.eventDateTime);
    const existingEnd = new Date(existingStart.getTime() + (existingAppointment.durationMinutes || 60) * 60 * 1000);
    // Verifica a sobreposição real
    if (desiredStart < existingEnd && desiredEnd > existingStart) {
      logger.warn(`[Availability] Conflito de horário para FA ${financialAccountId}: Slot desejado ${desiredStart.toISOString()} colide com agendamento existente ID ${existingAppointment.id}.`);
      return false; // Conflito com agendamento existente
    }
  }

  // 2. Obter todas as regras de disponibilidade para a conta
  const rules = await AvailabilityRule.findAll({ where: { financialAccountId } });
  const workRules = rules.filter(r => r.type === 'work');
  const breakRules = rules.filter(r => r.type === 'break' || r.type === 'day_off');

  // 3. Verificar se o horário está dentro de um período de trabalho
  let isInWorkSlot = false;
  for (const rule of workRules) {
    if (rule.rrule) {
      const rruleSet = rrulestr(rule.rrule, { dtstart: new Date(desiredDate + 'T00:00:00Z') });
      const occurrences = rruleSet.between(new Date(desiredDate + 'T00:00:00Z'), new Date(desiredDate + 'T23:59:59Z'));
      if (occurrences.length > 0) {
        const workStart = new Date(`${desiredDate}T${rule.startTime}`);
        const workEnd = new Date(`${desiredDate}T${rule.endTime}`);
        if (desiredStart >= workStart && desiredEnd <= workEnd) {
          isInWorkSlot = true;
          break;
        }
      }
    }
  }

  if (!isInWorkSlot) {
    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredStart.toISOString()} está fora do horário de trabalho.`);
    return false; // Fora do horário de trabalho
  }

  // 4. Verificar se o horário colide com alguma folga ou intervalo
  for (const rule of breakRules) {
    // Folga de dia inteiro
    if (rule.type === 'day_off' && rule.specificDate === desiredDate) {
      logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredDate} é um dia de folga.`);
      return false;
    }
    // Intervalo recorrente
    if (rule.type === 'break' && rule.rrule) {
      const rruleSet = rrulestr(rule.rrule, { dtstart: new Date(desiredDate + 'T00:00:00Z') });
      const occurrences = rruleSet.between(new Date(desiredDate + 'T00:00:00Z'), new Date(desiredDate + 'T23:59:59Z'));
      if (occurrences.length > 0) {
        const breakStart = new Date(`${desiredDate}T${rule.startTime}`);
        const breakEnd = new Date(`${desiredDate}T${rule.endTime}`);
        if (desiredStart < breakEnd && desiredEnd > breakStart) {
          logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredStart.toISOString()} colide com um intervalo.`);
          return false; // Conflito com intervalo
        }
      }
    }
  }

  // Se passou por todas as verificações, o horário está disponível
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
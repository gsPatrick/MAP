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
async function isTimeSlotAvailable(financialAccountId, startDateTime, durationMinutes) {
  try {
    const desiredStart = new Date(startDateTime);
    const desiredEnd = new Date(desiredStart.getTime() + durationMinutes * 60 * 1000);
    const desiredDateString = desiredStart.toISOString().split('T')[0]; // YYYY-MM-DD

    // 1. Busca todas as regras e agendamentos para o dia de uma só vez para eficiência.
    const rules = await AvailabilityRule.findAll({ where: { financialAccountId } });
    const appointmentsOnThisDay = await Appointment.findAll({
      where: {
        financialAccountId,
        status: { [Op.in]: ['Scheduled', 'Confirmed'] },
        eventDateTime: {
          [Op.between]: [
            new Date(`${desiredDateString}T00:00:00.000Z`),
            new Date(`${desiredDateString}T23:59:59.999Z`),
          ],
        },
      },
    });

    // 2. Verifica se é um dia de folga (day_off)
    const dayOffRule = rules.find(rule => 
      rule.type === 'day_off' && rule.specificDate === desiredDateString
    );
    if (dayOffRule) {
      // logger.debug(`[Availability] Conflito: Dia de folga (${dayOffRule.title}) em ${desiredDateString}.`);
      return false; // É um dia de folga, horário indisponível.
    }

    // 3. Encontra a regra de trabalho e verifica se o dia é de trabalho
    const workRule = rules.find(rule => rule.type === 'work' && rule.rrule && rule.startTime && rule.endTime);
    if (!workRule) {
      // logger.debug(`[Availability] Conflito: Nenhuma regra de trabalho ('work') encontrada.`);
      return false; // Sem regra de trabalho, nada está disponível.
    }
    
    // Verifica se a regra de trabalho se aplica a este dia específico
    const rrule = rrulestr(workRule.rrule, { dtstart: desiredStart });
    const occurrences = rrule.between(
        new Date(`${desiredDateString}T00:00:00.000Z`),
        new Date(`${desiredDateString}T23:59:59.999Z`),
        true
    );
    if (occurrences.length === 0) {
        // logger.debug(`[Availability] Conflito: A regra de trabalho não se aplica ao dia ${desiredDateString}.`);
        return false; // Não é um dia de trabalho segundo a regra.
    }
    
    // 4. Constrói os horários de início e fim do expediente como Date objects
    const workStart = new Date(`${desiredDateString}T${workRule.startTime}Z`);
    const workEnd = new Date(`${desiredDateString}T${workRule.endTime}Z`);

    // 5. Verifica se o slot desejado está DENTRO do horário de expediente
    if (desiredStart < workStart || desiredEnd > workEnd) {
      // logger.debug(`[Availability] Conflito: Slot ${desiredStart.toISOString()} está fora do expediente (${workStart.toISOString()} - ${workEnd.toISOString()}).`);
      return false; // Horário fora do expediente.
    }
    
    // 6. Verifica conflito com PAUSAS (breaks)
    const breakRules = rules.filter(r => r.type === 'break' && r.startTime && r.endTime);
    for (const breakRule of breakRules) {
      const breakStart = new Date(`${desiredDateString}T${breakRule.startTime}Z`);
      const breakEnd = new Date(`${desiredDateString}T${breakRule.endTime}Z`);
      // Verifica se o slot desejado colide com o horário da pausa
      if (desiredStart < breakEnd && desiredEnd > breakStart) {
        // logger.debug(`[Availability] Conflito: Slot colide com a pausa "${breakRule.title}".`);
        return false;
      }
    }

    // 7. Verifica conflito com AGENDAMENTOS EXISTENTES
    for (const existingAppt of appointmentsOnThisDay) {
      const existingStart = new Date(existingAppt.eventDateTime);
      const existingDuration = existingAppt.durationMinutes || 30; // Fallback
      const existingEnd = new Date(existingStart.getTime() + existingDuration * 60 * 1000);
      
      // Verifica se o slot desejado colide com um agendamento existente
      if (desiredStart < existingEnd && desiredEnd > existingStart) {
        // logger.debug(`[Availability] Conflito: Slot colide com agendamento existente ID ${existingAppt.id}.`);
        return false;
      }
    }

    // 8. Se passou por todas as verificações, o horário está disponível.
    // logger.info(`[Availability] Sucesso: Slot ${desiredStart.toISOString()} está disponível.`);
    return true;

  } catch (error) {
    logger.error(`[isTimeSlotAvailable] Erro ao verificar disponibilidade para FA ${financialAccountId}: ${error.message}`, { error });
    return false; // Em caso de erro, assume que não está disponível por segurança.
  }
}


module.exports = {
  createAvailabilityRule,
  getAllAvailabilityRules,
  getAvailabilityRuleById,
  updateAvailabilityRule,
  deleteAvailabilityRule,
  isTimeSlotAvailable,
};
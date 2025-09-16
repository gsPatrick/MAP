// src/features/Availability/availability.service.js

// Adicione estas linhas no topo para lidar com fuso horário
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

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
  const t = await sequelize.transaction();
  try {
    await validateServiceAccount(financialAccountId, t);
    const { type, title } = ruleData;

    if (!type || !title) {
      const error = new Error("Tipo ('work', 'break', 'day_off') e Título da regra são obrigatórios.");
      error.statusCode = 400; throw error;
    }

    // --- INÍCIO DA CORREÇÃO ESTRUTURAL ---
    // Se a regra é do tipo 'work', ela não deve ser duplicada, mas sim atualizada.
    if (type === 'work') {
      const existingWorkRule = await AvailabilityRule.findOne({
        where: {
          financialAccountId: financialAccountId,
          type: 'work'
        },
        order: [['updatedAt', 'DESC']], // Garante que pegamos a mais recente para atualizar
        transaction: t
      });

      if (existingWorkRule) {
        logger.info(`Regra de trabalho existente (ID: ${existingWorkRule.id}) encontrada para FA ID ${financialAccountId}. Atualizando em vez de criar...`);
        await existingWorkRule.update(ruleData, { transaction: t });
        await t.commit();
        return existingWorkRule.toJSON();
      }
    }
    // --- FIM DA CORREÇÃO ESTRUTURAL ---

    // Se não for do tipo 'work' ou se não houver uma regra de trabalho existente, cria uma nova.
    const newRule = await AvailabilityRule.create({ ...ruleData, financialAccountId }, { transaction: t });
    await t.commit();
    logger.info(`Nova regra de disponibilidade ID ${newRule.id} ("${newRule.title}") criada para FA ID ${financialAccountId}.`);
    return newRule.toJSON();

  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro em createAvailabilityRule para FA ID ${financialAccountId}: ${error.message}`, { error });
    throw error;
  }
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
 * Verifica se um determinado slot de tempo está disponível para agendamento,
 * considerando o fuso horário de São Paulo para as regras de negócio.
 *
 * @param {number} financialAccountId - O ID da conta a ser verificada.
 * @param {Date} startDateTime - O início do horário desejado (objeto Date em UTC).
 * @param {number} durationMinutes - A duração do agendamento em minutos.
 * @returns {Promise<boolean>} True se o horário estiver livre, false caso contrário.
 */
async function isTimeSlotAvailable(financialAccountId, startDateTime, durationMinutes) {
  const BRAZIL_TZ = 'America/Sao_Paulo'; // Fuso horário oficial

  try {
    const desiredStart = new Date(startDateTime);
    const desiredEnd = new Date(desiredStart.getTime() + durationMinutes * 60 * 1000);
    const desiredDateString = dayjs(desiredStart).tz(BRAZIL_TZ).format('YYYY-MM-DD');

    // 1. Busca todas as regras e agendamentos para o dia.
    const rules = await AvailabilityRule.findAll({ where: { financialAccountId } });
    const appointmentsOnThisDay = await Appointment.findAll({
      where: {
        financialAccountId,
        status: { [Op.in]: ['Scheduled', 'Confirmed'] },
        eventDateTime: {
          [Op.between]: [
            dayjs.tz(desiredDateString, BRAZIL_TZ).startOf('day').toDate(),
            dayjs.tz(desiredDateString, BRAZIL_TZ).endOf('day').toDate(),
          ],
        },
      },
    });

    // 2. Verifica se é um dia de folga (day_off)
    const dayOffRule = rules.find(rule => 
      rule.type === 'day_off' && rule.specificDate === desiredDateString
    );
    if (dayOffRule) return false;

    // 3. Encontra a regra de trabalho e verifica se o dia é de trabalho
    const workRule = rules
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .find(r => r.type === 'work' && r.rrule && r.startTime && r.endTime);

    if (!workRule) return false;
    
    // --- INÍCIO DA CORREÇÃO ---
    // Define o início e o fim do dia desejado para a verificação da RRULE.
    const dayStart = dayjs(desiredStart).startOf('day').toDate();
    const dayEnd = dayjs(desiredStart).endOf('day').toDate();
    
    // Analisa a string RRULE da regra de trabalho.
    const rrule = rrulestr(workRule.rrule);

    // Verifica se existe ALGUMA ocorrência da regra de trabalho DENTRO do dia desejado.
    // Esta é a verificação correta para saber se é um dia de trabalho.
    if (rrule.between(dayStart, dayEnd, true).length === 0) {
      return false; 
    }
    // --- FIM DA CORREÇÃO ---
    
    // 4. Constrói horários de expediente e pausas no FUSO HORÁRIO DE SÃO PAULO
    const workStart = dayjs.tz(`${desiredDateString}T${workRule.startTime}`, BRAZIL_TZ).toDate();
    const workEnd = dayjs.tz(`${desiredDateString}T${workRule.endTime}`, BRAZIL_TZ).toDate();
    
    // 5. Verifica se o slot desejado está DENTRO do horário de expediente
    if (desiredStart < workStart || desiredEnd > workEnd) {
      return false; 
    }
    
    // 6. Verifica conflito com PAUSAS (breaks)
    const breakRules = rules.filter(r => r.type === 'break' && r.startTime && r.endTime);
    for (const breakRule of breakRules) {
      const breakStart = dayjs.tz(`${desiredDateString}T${breakRule.startTime}`, BRAZIL_TZ).toDate();
      const breakEnd = dayjs.tz(`${desiredDateString}T${breakRule.endTime}`, BRAZIL_TZ).toDate();
      if (desiredStart < breakEnd && desiredEnd > breakStart) {
        return false;
      }
    }

    // 7. Verifica conflito com AGENDAMENTOS EXISTENTES
    for (const existingAppt of appointmentsOnThisDay) {
      const existingStart = new Date(existingAppt.eventDateTime);
      const existingEnd = new Date(existingStart.getTime() + (existingAppt.durationMinutes || 30) * 60 * 1000);
      
      if (desiredStart < existingEnd && desiredEnd > existingStart) {
        return false;
      }
    }

    // 8. Se passou por tudo, o horário está disponível.
    return true;

  } catch (error) {
    logger.error(`[isTimeSlotAvailable] Erro ao verificar disponibilidade para FA ${financialAccountId}: ${error.message}`, { error });
    return false;
  }
}
/**
 * Cria uma regra de trabalho padrão (ex: Seg-Sex, 09h-18h) para uma nova conta.
 * @param {number} financialAccountId - O ID da conta PJ/MEI.
 * @param {string} startTime - Hora de início no formato 'HH:MM'.
 * @param {string} endTime - Hora de fim no formato 'HH:MM'.
 * @param {string} daysOfWeek - Dias da semana no formato RRULE (ex: 'MO,TU,WE,TH,FR').
 * @returns {Promise<object>} A regra de disponibilidade criada.
 */
async function createDefaultWorkRule(financialAccountId, startTime, endTime, daysOfWeek) {
  await validateServiceAccount(financialAccountId);
  
  const ruleData = {
    financialAccountId,
    title: 'Horário de Trabalho Padrão',
    type: 'work',
    startTime,
    endTime,
    rrule: `FREQ=WEEKLY;BYDAY=${daysOfWeek}`,
    slotIntervalMinutes: 30, // Um valor padrão razoável
  };

  const newRule = await AvailabilityRule.create(ruleData);
  logger.info(`Regra de trabalho padrão criada para FA ID ${financialAccountId}.`);
  return newRule.toJSON();
}

module.exports = {
  createAvailabilityRule,
  getAllAvailabilityRules,
  getAvailabilityRuleById,
  updateAvailabilityRule,
  deleteAvailabilityRule,
  isTimeSlotAvailable,
  createDefaultWorkRule
};
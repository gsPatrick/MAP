// src/utils/dateUtils.js
const { RRule, RRuleSet, rrulestr, Weekday } = require('rrule');
const logger = require('./logger');

/**
 * Calcula a próxima data/hora de ocorrência de uma regra de recorrência.
 * @param {string|Date} startDateInput - Data e hora de início da regra (ISO string ou Date).
 * @param {string} frequency - 'minutely', 'hourly', 'daily', 'weekly', etc.
 * @param {number} interval - A cada X [frequência].
 * @param {number|null} dayOfMonthInput - Dia do mês para regras mensais+.
 * @param {number|Array<number>|null} dayOfWeekRuleInput - Dia(s) da semana para regras semanais.
 * @param {string|Date|null} afterDateInput - Calcular ocorrências após esta data/hora (geralmente lastGeneratedDate).
 * @returns {Date|null} Próximo objeto Date de ocorrência ou null se não houver.
 */
function calculateNextDueDate(startDateInput, frequency, interval = 1, dayOfMonthInput = null, dayOfWeekRuleInput = null, afterDateInput = null) {
  try {
    // A biblioteca rrule trabalha com objetos Date. A entrada já deve ser um objeto Date ou uma string ISO que o JS possa parsear.
    const dtstart = new Date(startDateInput);

    const options = {
      dtstart: dtstart,
      interval: parseInt(interval, 10) || 1,
    };

    // Mapeia a frequência da string para a constante da biblioteca RRule
    switch (frequency.toLowerCase()) {
      case 'minutely':
        options.freq = RRule.MINUTELY;
        break;
      case 'hourly':
        options.freq = RRule.HOURLY;
        break;
      case 'daily':
        options.freq = RRule.DAILY;
        break;
      case 'weekly':
        options.freq = RRule.WEEKLY;
        if (dayOfWeekRuleInput !== null && dayOfWeekRuleInput !== undefined) {
          const rruleDaysMap = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];
          if (Array.isArray(dayOfWeekRuleInput)) {
            options.byweekday = dayOfWeekRuleInput.map(d => rruleDaysMap[parseInt(d, 10)]);
          } else {
            options.byweekday = rruleDaysMap[parseInt(dayOfWeekRuleInput, 10)];
          }
        }
        break;
      case 'bi-weekly': // Quinzenal
        options.freq = RRule.WEEKLY;
        options.interval = (parseInt(interval, 10) || 1) * 2; // Intervalo de 2 semanas
         if (dayOfWeekRuleInput !== null && dayOfWeekRuleInput !== undefined) {
          const rruleDaysMap = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];
          options.byweekday = rruleDaysMap[parseInt(dayOfWeekRuleInput, 10)]; // Dia específico da quinzena
        }
        break;
      case 'monthly':
        options.freq = RRule.MONTHLY;
        if (dayOfMonthInput !== null && dayOfMonthInput !== undefined) {
          const dayOfMonth = parseInt(dayOfMonthInput, 10);
          options.bymonthday = dayOfMonth; // RRule lida com bymonthday positivo e negativo (-1 para último dia)
        }
        break;
      case 'quarterly': // Trimestral
        options.freq = RRule.MONTHLY;
        options.interval = (parseInt(interval, 10) || 1) * 3; // Intervalo de 3 meses
        if (dayOfMonthInput !== null && dayOfMonthInput !== undefined) options.bymonthday = parseInt(dayOfMonthInput, 10);
        else options.bymonthday = dtstart.getDate(); // Usa o dia da dtstart se não especificado
        break;
      case 'semi-annually': // Semestral
        options.freq = RRule.MONTHLY;
        options.interval = (parseInt(interval, 10) || 1) * 6; // Intervalo de 6 meses
        if (dayOfMonthInput !== null && dayOfMonthInput !== undefined) options.bymonthday = parseInt(dayOfMonthInput, 10);
        else options.bymonthday = dtstart.getDate();
        break;
      case 'annually':
        options.freq = RRule.YEARLY;
        break;
      default:
        logger.error(`[dateUtils] Frequência desconhecida para rrule: ${frequency}`);
        return null;
    }

    const rule = new RRule(options);
   
    // A data base para a busca da próxima ocorrência é a data da última geração
    // ou, se nunca foi gerada, a data/hora atual para não criar eventos passados.
    const searchAfterDate = afterDateInput ? new Date(afterDateInput) : new Date();

    // `inc=false` significa que retorna a primeira ocorrência ESTRITAMENTE APÓS a `searchAfterDate`.
    const nextOccurrence = rule.after(searchAfterDate, false);

    // Retorna o objeto Date completo, que inclui data e hora.
    if (nextOccurrence) {
      return nextOccurrence;
    }

    logger.info(`[dateUtils] Nenhuma próxima ocorrência encontrada para a regra após ${searchAfterDate.toISOString()}:`, { rule: rule.toString() });
    return null;

  } catch (e) {
    logger.error("[dateUtils] Erro ao calcular nextDueDate com rrule:", { message: e.message, stack: e.stack, inputs: {startDateInput, frequency, interval, dayOfMonthInput, dayOfWeekRuleInput, afterDateInput }});
    return null;
  }
}

module.exports = { calculateNextDueDate };
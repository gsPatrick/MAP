// src/utils/dateUtils.js
const { RRule, RRuleSet, rrulestr,Weekday } = require('rrule'); // Import Weekday for byweekday
const logger = require('./logger');

/**
 * Calcula a próxima data de ocorrência de uma regra de recorrência.
 * @param {string|Date} startDateInput - Data de início da regra (YYYY-MM-DD).
 * @param {string} frequency - 'daily', 'weekly', 'monthly', 'annually'.
 * @param {number} interval - A cada X [frequência].
 * @param {number|null} dayOfMonthInput - Dia do mês para 'monthly' (1-31). Pode ser negativo para contar do fim (-1 = último dia).
 * @param {number|Array<number>|null} dayOfWeekRuleInput - Dia(s) da semana para 'weekly' (0=Dom, 1=Seg,..., 6=Sab).
 * @param {string|Date|null} afterDateInput - Calcular ocorrências após esta data (geralmente lastGeneratedDate ou hoje).
 * @returns {string|null} Próxima data de ocorrência (YYYY-MM-DD) ou null se não houver próxima.
 */
function calculateNextDueDate(startDateInput, frequency, interval = 1, dayOfMonthInput = null, dayOfWeekRuleInput = null, afterDateInput = null) {
  try {
    // RRule trabalha com datas locais, mas é melhor normalizar para UTC para evitar problemas de fuso.
    // A dtstart define o "alinhamento" da recorrência.
    const dtstart = new Date(Date.parse(new Date(startDateInput).toISOString().slice(0, 10) + 'T00:00:00.000Z'));

    const options = {
      dtstart: dtstart,
      interval: parseInt(interval, 10) || 1,
    };

    switch (frequency.toLowerCase()) {
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
      case 'bi-weekly':
        options.freq = RRule.WEEKLY;
        options.interval = (parseInt(interval, 10) || 1) * 2;
         if (dayOfWeekRuleInput !== null && dayOfWeekRuleInput !== undefined) {
          const rruleDaysMap = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];
          options.byweekday = rruleDaysMap[parseInt(dayOfWeekRuleInput, 10)];
        }
        break;
      case 'monthly':
        options.freq = RRule.MONTHLY;
        if (dayOfMonthInput !== null && dayOfMonthInput !== undefined) {
          const dayOfMonth = parseInt(dayOfMonthInput, 10);
          // RRule lida com bymonthday positivo e negativo (-1 para último dia)
          options.bymonthday = dayOfMonth;
        }
        break;
      case 'quarterly':
        options.freq = RRule.MONTHLY;
        options.interval = (parseInt(interval, 10) || 1) * 3;
        if (dayOfMonthInput !== null && dayOfMonthInput !== undefined) options.bymonthday = parseInt(dayOfMonthInput, 10);
        else options.bymonthday = dtstart.getUTCDate(); // Usa o dia da dtstart se não especificado
        break;
      case 'semi-annually':
        options.freq = RRule.MONTHLY;
        options.interval = (parseInt(interval, 10) || 1) * 6;
        if (dayOfMonthInput !== null && dayOfMonthInput !== undefined) options.bymonthday = parseInt(dayOfMonthInput, 10);
        else options.bymonthday = dtstart.getUTCDate();
        break;
      case 'annually':
        options.freq = RRule.YEARLY;
        // Por padrão, rrule usará o mês e dia da dtstart.
        // Se quiser especificar:
        // options.bymonth = parseInt(monthOfYearInput, 10);
        // options.bymonthday = parseInt(dayOfMonthInput, 10);
        break;
      default:
        logger.error(`[dateUtils] Frequência desconhecida para rrule: ${frequency}`);
        return null;
    }

    const rule = new RRule(options);
    
    let searchAfterDate;
    const todayUTC = new Date(Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'));

    if (afterDateInput) {
      // Queremos a próxima ocorrência ESTRITAMENTE APÓS a afterDateInput
      searchAfterDate = new Date(Date.parse(new Date(afterDateInput).toISOString().slice(0, 10) + 'T00:00:00.000Z'));
    } else {
      // Primeira ocorrência: deve ser igual ou maior que dtstart E igual ou maior que hoje.
      searchAfterDate = dtstart > todayUTC ? new Date(dtstart) : new Date(todayUTC);
      // Para a primeira ocorrência, queremos que ela possa ser a própria searchAfterDate.
      // RRule.after(date, inc=false) retorna a primeira ocorrência *após* date.
      // Para incluir a própria searchAfterDate se ela for uma ocorrência, precisamos de uma pequena manipulação.
      const occurrencesIncludingSearchDate = rule.between(searchAfterDate, new Date(searchAfterDate.getTime() + 24*60*60*1000 -1), true); // Verifica se hoje/searchAfterDate é ocorrência
      if(occurrencesIncludingSearchDate.length > 0 && occurrencesIncludingSearchDate[0].getTime() === searchAfterDate.getTime()){
          const nextOccurrence = occurrencesIncludingSearchDate[0];
          const year = nextOccurrence.getUTCFullYear();
          const month = String(nextOccurrence.getUTCMonth() + 1).padStart(2, '0');
          const day = String(nextOccurrence.getUTCDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
      }
      // Se não, busca a próxima após a searchAfterDate (ou seja, após hoje ou dtstart)
    }
    
    // `inc=false` é o padrão para RRule.after, o que significa que retorna a primeira ocorrência APÓS a data fornecida.
    // Se `afterDateInput` é a `lastGeneratedDate`, isso está correto.
    // Se `afterDateInput` é nulo (primeira vez), `searchAfterDate` é hoje ou `dtstart`. `rule.after` encontrará a primeira ocorrência válida.
    const nextOccurrence = rule.after(searchAfterDate);

    if (nextOccurrence) {
      const year = nextOccurrence.getUTCFullYear();
      const month = String(nextOccurrence.getUTCMonth() + 1).padStart(2, '0');
      const day = String(nextOccurrence.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    logger.info(`[dateUtils] Nenhuma próxima ocorrência encontrada para a regra após ${searchAfterDate.toISOString().split('T')[0]}:`, { rule: rule.toString() });
    return null;

  } catch (e) {
    logger.error("[dateUtils] Erro ao calcular nextDueDate com rrule:", { message: e.message, stack: e.stack, inputs: {startDateInput, frequency, interval, dayOfMonthInput, dayOfWeekRuleInput, afterDateInput }});
    return null;
  }
}

module.exports = { calculateNextDueDate };
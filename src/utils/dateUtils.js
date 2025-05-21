// src/utils/dateUtils.js
const { RRule, RRuleSet, rrulestr,Weekday } = require('rrule'); // Import Weekday for byweekday
const logger = require('./logger'); // Supondo que logger está em ../utils/logger.js

/**
 * Calcula a próxima data de ocorrência de uma regra de recorrência.
 * @param {string|Date} startDateInput - Data de início da regra (YYYY-MM-DD).
 * @param {string} frequency - 'daily', 'weekly', 'monthly', 'annually', 'bi-weekly', 'quarterly', 'semi-annually'.
 * @param {number} interval - A cada X [frequência].
 * @param {number|null} dayOfMonthInput - Dia do mês para 'monthly', 'quarterly', 'semi-annually' (1-31). Pode ser negativo para contar do fim (-1 = último dia).
 * @param {number|Array<number>|null} dayOfWeekRuleInput - Dia(s) da semana para 'weekly', 'bi-weekly' (0=Dom, 1=Seg,..., 6=Sab).
 * @param {string|Date|null} afterDateInput - Calcular ocorrências após esta data (geralmente lastGeneratedDate ou hoje).
 * @returns {string|null} Próxima data de ocorrência (YYYY-MM-DD) ou null se não houver próxima.
 */
function calculateNextDueDate(startDateInput, frequency, interval = 1, dayOfMonthInput = null, dayOfWeekRuleInput = null, afterDateInput = null) {
  try {
    // RRule trabalha com datas locais, mas é melhor normalizar para UTC para evitar problemas de fuso.
    // A dtstart define o "alinhamento" da recorrência.
    // Garante que startDateInput seja tratada como UTC para evitar shifts de um dia.
    const startDateObj = new Date(startDateInput); // Se YYYY-MM-DD, será meia-noite LOCAL
    const dtstart = new Date(Date.UTC(startDateObj.getFullYear(), startDateObj.getMonth(), startDateObj.getDate()));


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
        else options.bymonthday = dtstart.getUTCDate(); // Usa o dia da dtstart se não especificado
        break;
      case 'semi-annually': // Semestral
        options.freq = RRule.MONTHLY;
        options.interval = (parseInt(interval, 10) || 1) * 6; // Intervalo de 6 meses
        if (dayOfMonthInput !== null && dayOfMonthInput !== undefined) options.bymonthday = parseInt(dayOfMonthInput, 10);
        else options.bymonthday = dtstart.getUTCDate();
        break;
      case 'annually':
        options.freq = RRule.YEARLY;
        // Por padrão, rrule usará o mês e dia da dtstart.
        // Se fosse necessário especificar explicitamente:
        // if (dayOfMonthInput !== null) options.bymonthday = parseInt(dayOfMonthInput);
        // if (monthOfYearInput !== null) options.bymonth = parseInt(monthOfYearInput); // 1-12
        break;
      default:
        logger.error(`[dateUtils] Frequência desconhecida para rrule: ${frequency}`);
        return null;
    }

    const rule = new RRule(options);
   
    let searchAfterDate;
    // Pega a data de hoje em UTC, zerando horas, para comparação
    const todayObj = new Date();
    const todayUTC = new Date(Date.UTC(todayObj.getUTCFullYear(), todayObj.getUTCMonth(), todayObj.getUTCDate()));

    if (afterDateInput) {
      // Queremos a próxima ocorrência ESTRITAMENTE APÓS a afterDateInput
      const afterDateObj = new Date(afterDateInput);
      searchAfterDate = new Date(Date.UTC(afterDateObj.getUTCFullYear(), afterDateObj.getUTCMonth(), afterDateObj.getUTCDate()));
    } else {
      // Primeira ocorrência: deve ser igual ou maior que dtstart E igual ou maior que hoje.
      searchAfterDate = dtstart > todayUTC ? new Date(dtstart) : new Date(todayUTC);
      // Para a primeira ocorrência, queremos que ela possa ser a própria searchAfterDate.
      // RRule.after(date, inc=false) retorna a primeira ocorrência *após* date.
      // Para incluir a própria searchAfterDate se ela for uma ocorrência, precisamos de uma pequena manipulação.
      const occurrencesIncludingSearchDate = rule.between(searchAfterDate, new Date(Date.UTC(searchAfterDate.getUTCFullYear(), searchAfterDate.getUTCMonth(), searchAfterDate.getUTCDate() + 1) -1 ), true); // Verifica no dia
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
    const nextOccurrence = rule.after(searchAfterDate, false); // inc=false é default, mas explícito aqui.

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
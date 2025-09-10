// src/features/WhatsappHandler/onboarding.ai.service.js
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');

/**
 * Usa a IA para interpretar a resposta do usuário sobre seus dias e horários de trabalho.
 * @param {string} userInput - A mensagem enviada pelo usuário (ex: "trabalho de segunda a sexta, das 8h às 18h").
 * @returns {Promise<{startTime: string, endTime: string, rruleDays: string}|null>} Objeto com horários e dias formatados, ou null se a IA não conseguir interpretar.
 */
async function interpretWorkSchedule(userInput) {
  const systemPrompt = `
    Sua única tarefa é analisar a frase de um usuário e extrair SEUS DIAS E HORÁRIOS DE TRABALHO.
    Responda APENAS com um objeto JSON contendo as chaves "startTime", "endTime" e "rruleDays".

    - "startTime" e "endTime" devem estar no formato "HH:MM".
    - "rruleDays" deve ser uma string com os dias da semana no formato RRULE (MO, TU, WE, TH, FR, SA, SU), separados por vírgula.

    REGRAS DE INTERPRETAÇÃO:
    - "Segunda a Sexta" ou "dias de semana" -> rruleDays: "MO,TU,WE,TH,FR"
    - "Segunda a Sábado" -> rruleDays: "MO,TU,WE,TH,FR,SA"
    - "Todos os dias" ou "diariamente" -> rruleDays: "SU,MO,TU,WE,TH,FR,SA"
    - "Finais de semana" -> rruleDays: "SA,SU"
    - Se o usuário especificar dias avulsos como "terças e quintas", use as abreviações corretas.
    - Se o usuário disser "das 8 às 18", "de 9h até 17h30", "09:00 as 18:00", interprete e formate para "HH:MM".
    - Se alguma informação (dias ou horários) estiver faltando, retorne a chave correspondente como null.

    Exemplos de Resposta:
    - Usuário: "trabalho de segunda a sexta das 9h às 18h" -> {"startTime": "09:00", "endTime": "18:00", "rruleDays": "MO,TU,WE,TH,FR"}
    - Usuário: "somente às quartas e sextas, de 13h as 17h30" -> {"startTime": "13:00", "endTime": "17:30", "rruleDays": "WE,FR"}
    - Usuário: "das 10h até as 19h" -> {"startTime": "10:00", "endTime": "19:00", "rruleDays": null}
    - Usuário: "seg, ter, qua" -> {"startTime": null, "endTime": null, "rruleDays": "MO,TU,WE"}
  `;

  try {
    const aiResponse = await aiModelService.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(aiResponse.choices[0].message.content);
    logger.info(`[OnboardingAI] Horário interpretado da IA: ${JSON.stringify(result)}`);

    // Validação final
    if ((result.startTime && result.endTime && result.rruleDays) || (result.startTime && result.endTime) || result.rruleDays) {
      return result;
    }
    return null;

  } catch (error) {
    logger.error(`[OnboardingAI] Erro ao interpretar horário com a IA: ${error.message}`, error);
    return null;
  }
}

module.exports = {
  interpretWorkSchedule,
};
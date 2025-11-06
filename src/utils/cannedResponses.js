// src/utils/cannedResponses.js

const responses = new Map();

const greetingResponse = {
  overall_summary_suggestion: null,
  detected_actions: [{ action: "GENERAL_GREETING_OR_SMALLTALK", parameters: {} }],
  clarifications_needed: [],
  reply_to_user_suggestion: "Olá! 👋 Como posso te ajudar a organizar suas finanças e seu dia hoje?"
};

const thanksResponse = {
    overall_summary_suggestion: null,
    detected_actions: [{ action: "GENERAL_GREETING_OR_SMALLTALK", parameters: {} }],
    clarifications_needed: [],
    reply_to_user_suggestion: "De nada! 😊 Se precisar de mais alguma coisa, é só chamar!"
};

const byeResponse = {
    overall_summary_suggestion: null,
    detected_actions: [{ action: "GENERAL_GREETING_OR_SMALLTALK", parameters: {} }],
    clarifications_needed: [],
    reply_to_user_suggestion: "Até mais! Tenha um ótimo dia! 👋"
};

// Mapeamento de mensagens normalizadas para respostas
responses.set('oi', greetingResponse);
responses.set('ola', greetingResponse);
responses.set('bom dia', greetingResponse);
responses.set('boa tarde', greetingResponse);
responses.set('boa noite', greetingResponse);
responses.set('e ai', greetingResponse);
responses.set('opa', greetingResponse);

responses.set('obrigado', thanksResponse);
responses.set('obg', thanksResponse);
responses.set('vlw', thanksResponse);
responses.set('valeu', thanksResponse);
responses.set('brigado', thanksResponse);

responses.set('tchau', byeResponse);
responses.set('ate mais', byeResponse);
responses.set('flw', byeResponse);


/**
 * Verifica se a mensagem do usuário corresponde a uma resposta rápida pré-definida.
 * @param {string} userMessage A mensagem do usuário.
 * @returns {object | null} O objeto de resposta completo ou null se não houver correspondência.
 */
function getQuickResponse(userMessage) {
    const normalizedMessage = userMessage.trim().toLowerCase();
    return responses.get(normalizedMessage) || null;
}

module.exports = { getQuickResponse };
// src/services/aiTriage.service.js
const { OpenAI } = require('openai');
const logger = require('../utils/logger');

// Usa a mesma instância do OpenAI, se já inicializada em outro lugar,
// ou cria uma nova. Para simplicidade, vamos usar a mesma chave.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TRIAGE_MODEL = 'gpt-3.5-turbo';

/**
 * Etapa 1: Classifica a intenção geral do usuário.
 * @param {string} userMessage A mensagem do usuário.
 * @returns {Promise<'small_talk' | 'question' | 'command' | 'unknown'>} A categoria da intenção.
 */
async function triageIntent(userMessage) {
  const systemPrompt = `
    Sua única tarefa é classificar a mensagem do usuário em uma de três categorias: 'small_talk', 'question' ou 'command'.
    - 'small_talk': Saudações, despedidas, agradecimentos, conversas casuais. (Ex: "oi", "obrigado", "tudo bem?")
    - 'question': Perguntas sobre como usar o sistema ou pedidos de informação que não executam uma ação. (Ex: "como lanço uma despesa?", "qual meu saldo?", "meus cartões")
    - 'command': Ordens diretas para criar, editar, deletar ou executar uma ação. (Ex: "lançar 50 reais de uber", "agendar dentista amanhã", "excluir última despesa")
    Responda APENAS com a categoria. Nenhuma outra palavra.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: TRIAGE_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const category = response.choices[0].message.content.trim();
    if (['small_talk', 'question', 'command'].includes(category)) {
      logger.info(`[AI TRIAGE - Intent] Mensagem classificada como: ${category}`);
      return category;
    }
    logger.warn(`[AI TRIAGE - Intent] Categoria inesperada da IA: ${category}`);
    return 'command'; // Fallback seguro: se não tiver certeza, trate como um comando.
  } catch (error) {
    logger.error(`[AI TRIAGE - Intent] Erro ao classificar intenção: ${error.message}`);
    return 'command'; // Fallback seguro
  }
}

/**
 * Etapa 2: Classifica a complexidade de um comando.
 * @param {string} userMessage A mensagem do usuário que já foi classificada como 'command'.
 * @returns {Promise<'simple' | 'complex'>} A complexidade do comando.
 */
async function triageCommandComplexity(userMessage) {
  const systemPrompt = `
    Sua única tarefa é classificar um comando do usuário como 'simple' ou 'complex'.
    - 'simple': Ações diretas, com dados explícitos e sem contexto temporal complexo. Geralmente uma única ação. (Ex: "lançar 50 de ifood", "bebi 200ml de água", "ver fatura do nubank")
    - 'complex': Ações que envolvem edição, parcelamento, recorrência, datas relativas, contexto passado, ou múltiplos passos. (Ex: "edite minha última despesa", "parcelei a TV em 10x", "criar recorrência do aluguel", "aquela compra que fiz semana passada")
    Responda APENAS com 'simple' ou 'complex'. Nenhuma outra palavra.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: TRIAGE_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      max_tokens: 5,
    });

    const complexity = response.choices[0].message.content.trim();
    if (['simple', 'complex'].includes(complexity)) {
      logger.info(`[AI TRIAGE - Complexity] Comando classificado como: ${complexity}`);
      return complexity;
    }
    logger.warn(`[AI TRIAGE - Complexity] Complexidade inesperada da IA: ${complexity}`);
    return 'complex'; // Fallback seguro: na dúvida, use o modelo mais poderoso.
  } catch (error) {
    logger.error(`[AI TRIAGE - Complexity] Erro ao classificar complexidade: ${error.message}`);
    return 'complex'; // Fallback seguro
  }
}

module.exports = {
  triageIntent,
  triageCommandComplexity,
};
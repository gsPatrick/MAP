// src/services/aiTriage.service.js
const { OpenAI } = require('openai');
const logger = require('../utils/logger');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TRIAGE_MODEL = 'gpt-3.5-turbo';

/**
 * Realiza a triagem da mensagem do usuário em uma única chamada de API,
 * classificando a intenção e a complexidade do comando.
 * @param {string} userMessage A mensagem do usuário.
 * @returns {Promise<{intent: 'small_talk' | 'question' | 'command', complexity: 'simple' | 'complex' | null}>} O resultado da triagem.
 */
async function performTriage(userMessage) {
  const systemPrompt = `
    Sua única tarefa é analisar a mensagem do usuário e retornar um objeto JSON com duas chaves: "intent" e "complexity".

    1.  **"intent"**: Classifique a intenção em uma de três categorias:
        *   'small_talk': Saudações, despedidas, agradecimentos, conversas casuais. (Ex: "oi", "obrigado", "tudo bem?")
        *   'question': Perguntas sobre como usar o sistema ou pedidos de informação. (Ex: "como lanço uma despesa?", "qual meu saldo?", "meus cartões")
        *   'command': Ordens diretas para criar, editar, deletar ou executar uma ação. (Ex: "lançar 50 reais de uber", "agendar dentista amanhã", "excluir última despesa")

    2.  **"complexity"**: Se a "intent" for 'command', classifique a complexidade do comando:
        *   'simple': Ações diretas, com dados explícitos e sem contexto temporal complexo. Geralmente uma única ação. (Ex: "lançar 50 de ifood", "bebi 200ml de água", "ver fatura do nubank")
        *   'complex': Ações que envolvem edição, parcelamento, recorrência, datas relativas, contexto passado, ou múltiplos passos. (Ex: "edite minha última despesa", "parcelei a TV em 10x", "criar recorrência do aluguel", "aquela compra que fiz semana passada")

    Se a "intent" NÃO for 'command', o valor de "complexity" DEVE ser null.

    Responda APENAS com o objeto JSON. Nenhum outro texto.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: TRIAGE_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(response.choices[0].message.content);
    logger.info(`[AI TRIAGE] Mensagem classificada com sucesso: ${JSON.stringify(result)}`);
    return result;

  } catch (error) {
    logger.error(`[AI TRIAGE] Erro ao realizar triagem. Usando fallback seguro: ${error.message}`);
    // Fallback seguro: na dúvida, assume que é um comando complexo para não perder funcionalidade.
    return { intent: 'command', complexity: 'complex' };
  }
}

module.exports = {
  performTriage,
};
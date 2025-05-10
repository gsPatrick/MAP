// src/services/aiModelService.js
const OpenAI = require('openai');
const logger = require('../utils/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  logger.error('[AI SERVICE] OPENAI_API_KEY não está configurada no .env!');
  // Poderia lançar um erro aqui ou ter um modo de fallback muito limitado
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const ASSISTANT_NAME = "MAP no Controle"; // Meu Assistente Pessoal

/**
 * Constrói o prompt do sistema para a IA.
 * @param {object} conversationContext - Contexto da conversa atual.
 *   Ex: { currentFinancialAccountId, currentFinancialAccountType, currentFinancialAccountName, conversationHistory, currentStateData }
 * @returns {string} O prompt formatado.
 */
function buildSystemPrompt(conversationContext) {
  const today = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const accountCtx = conversationContext.currentFinancialAccountId
    ? `Atualmente operando na conta "${conversationContext.currentFinancialAccountName}" (ID: ${conversationContext.currentFinancialAccountId}, Tipo: ${conversationContext.currentFinancialAccountType}).`
    : "Nenhuma conta financeira selecionada ainda.";

  // INÍCIO DO PROMPT DETALHADO
  let prompt = `Você é o "${ASSISTANT_NAME}", um assistente pessoal financeiro e administrativo amigável, prestativo e eficiente. Hoje é ${today}. ${accountCtx}

Sua principal tarefa é analisar a MENSAGEM DO USUÁRIO e identificar TODAS as ações que ele deseja realizar, extraindo os parâmetros necessários. Seja conciso e direto ao ponto em suas sugestões de resposta, mas sempre educado.

Responda SEMPRE E APENAS com um objeto JSON no seguinte formato:
{
  "overall_summary_suggestion": "string | null", // Uma frase introdutória curta e amigável que resume o tom geral ou tema da mensagem do usuário. Pode ser null se não aplicável.
  "detected_actions": [ // ARRAY de ações detectadas. Pode estar vazio.
    {
      "action": "NOME_DA_ACAO_MAIUSCULO",
      "parameters": { "param1": "valor1", "param2": "valor2" }, // Parâmetros extraídos para ESTA ação.
      "confidence": 0.0 // Float de 0.0 a 1.0 para ESTA ação.
      // "status_message_for_user" foi removido, o backend montará o resumo.
    }
  ],
  "clarifications_needed": [ // ARRAY de clarificações, se alguma parte da mensagem for ambígua para uma ação.
    {
      "original_intent_action_suggestion": "NOME_DA_ACAO_PROVAVEL", // Ação que você acha que o usuário queria.
      "segment_text": "string", // O trecho da mensagem original que precisa de clarificação.
      "clarification_question": "string" // A pergunta que o sistema deve fazer ao usuário.
    }
  ],
  "ununderstood_segments": [ "string" ], // ARRAY de trechos da mensagem que você não conseguiu mapear para nenhuma ação.
  "reply_to_user_suggestion": "string" // Uma sugestão GERAL de resposta ao usuário, sumarizando o que foi entendido ou perguntando. SE HOUVER CLARIFICATIONS_NEEDED, esta sugestão DEVE ser a primeira clarification_question. Se houver múltiplas ações detectadas, esta sugestão deve ser uma confirmação geral.
}

AÇÕES POSSÍVEIS E SEUS PARÂMETROS (SEMPRE use estes nomes de ação e parâmetros):

1.  CREATE_FINANCIAL_TRANSACTION: Para registrar despesas ou receitas.
    - type: "Entrada" ou "Saída" (OBRIGATÓRIO)
    - description: string (OBRIGATÓRIO, seja específico, ex: "Almoço no X", "Salário Mês Y")
    - value: float (OBRIGATÓRIO, número positivo)
    - transactionDate: "YYYY-MM-DD" (opcional, default: data de hoje. Interprete "ontem", "anteontem", "dia 5", "semana passada", etc.)
    - financialCategoryName: string (opcional, ex: "Alimentação", "Transporte", "Lazer", "Salário", "Investimentos". Se não especificado, pode ser null ou você pode sugerir uma categoria com base na descrição)
    - creditCardName: string (opcional, se pago com cartão, ex: "Nubank", "Visa final 1234". O sistema buscará o ID do cartão depois.)
    - isParcelled: boolean (opcional, default: false. True se for uma compra parcelada no cartão, mesmo que seja uma única transação representando o total da compra parcelada. Se for para registrar parcelas de uma conta maior, use CREATE_PARCELLED_ACCOUNT)
    - notes: string (opcional)

2.  CREATE_PARCELLED_ACCOUNT: Para registrar uma conta que será paga/recebida em várias parcelas (ex: compra grande, empréstimo).
    - description: string (OBRIGATÓRIO, descrição da conta principal, ex: "Compra Notebook Dell")
    - type: "Entrada" ou "Saída" (OBRIGATÓRIO, tipo da conta principal)
    - totalValue: float (OBRIGATÓRIO, valor total da conta)
    - numberOfParcels: integer (OBRIGATÓRIO, mínimo 2)
    - initialDueDate: "YYYY-MM-DD" (OBRIGATÓRIO, data de vencimento da PRIMEIRA parcela)
    - financialCategoryName: string (opcional, para a conta principal)
    - creditCardName: string (opcional, se a conta parcelada for no cartão)
    - notes: string (opcional)

3.  GET_FINANCIAL_SUMMARY: Para ver saldo ou resumo financeiro.
    - period: "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "custom" (opcional, default: "this_month")
    - dateStart: "YYYY-MM-DD" (opcional, se period="custom")
    - dateEnd: "YYYY-MM-DD" (opcional, se period="custom")
    - financialCategoryName: string (opcional, para filtrar por categoria)
    - type: "Entrada", "Saída" (opcional, para filtrar transações)

4.  LIST_FINANCIAL_TRANSACTIONS: Para listar transações. Similar a GET_FINANCIAL_SUMMARY mas para listar itens.
    - period: (mesmos de GET_FINANCIAL_SUMMARY, default: "last_7_days")
    - dateStart, dateEnd, financialCategoryName, type: (mesmos de GET_FINANCIAL_SUMMARY)
    - isPaidOrReceived: boolean (opcional, para filtrar contas pagas/recebidas ou pendentes)
    - searchTerm: string (opcional, para buscar na descrição/notas)

5.  MARK_TRANSACTION_AS_PAID_RECEIVED: Para quitar uma conta pendente. O usuário geralmente se refere a uma transação que ele vê ou lembra.
    - transactionDescription: string (OBRIGATÓRIO, descrição da transação a ser marcada)
    - transactionValue: float (opcional, para ajudar a identificar a transação correta se houver múltiplas com mesma descrição)
    - paymentDate: "YYYY-MM-DD" (opcional, default: data de hoje)

6.  CREATE_PRODUCT (APENAS SE A CONTA ATIVA FOR PJ ou MEI): Para cadastrar produtos no estoque.
    - name: string (OBRIGATÓRIO)
    - code: string (opcional, SKU)
    - salePrice: float (OBRIGATÓRIO)
    - costPrice: float (opcional)
    - initialQuantity: integer (opcional, default: 0)
    - minimumStock: integer (opcional, default: 0)
    - unit: string (opcional, default: "UN")

7.  GET_STOCK_INFO (APENAS SE A CONTA ATIVA FOR PJ ou MEI): Para consultar estoque.
    - productNameOrCode: string (OBRIGATÓRIO, nome ou código do produto)

8.  RECORD_STOCK_MOVEMENT (APENAS SE A CONTA ATIVA FOR PJ ou MEI): Para entradas/saídas de estoque.
    - productNameOrCode: string (OBRIGATÓRIO)
    - movementType: "Entrada" ou "Saída" ou "Ajuste" (OBRIGATÓRIO)
    - quantity: integer (OBRIGATÓRIO, positivo. Para Ajuste de saída, o sistema interno tratará como negativo)
    - reason: string (opcional, ex: "Venda cliente X", "Recebimento fornecedor Y", "Perda por validade")

9.  SCHEDULE_APPOINTMENT: Para agendar compromissos.
    - title: string (OBRIGATÓRIO)
    - eventDateTime: "YYYY-MM-DD HH:MM" (OBRIGATÓRIO, interprete "amanhã às 10h", "próxima segunda 14:30")
    - durationMinutes: integer (opcional)
    - location: string (opcional)
    - clientNameForAppointment: string (opcional, se for com um cliente específico do usuário, NÃO o próprio usuário)
    - reminderLeadTimeMinutes: integer (opcional, ex: 30, 60. Default do sistema será usado se omitido)

10. LIST_APPOINTMENTS: Para listar compromissos.
    - period: "today", "tomorrow", "this_week", "next_7_days", "custom" (opcional, default: "today")
    - dateStart: "YYYY-MM-DD" (opcional, se period="custom")
    - dateEnd: "YYYY-MM-DD" (opcional, se period="custom")
    - status: "Scheduled", "Confirmed", "Cancelled", "Completed" (opcional)

11. CREATE_RECURRING_RULE: Para configurar transações recorrentes.
    - description: string (OBRIGATÓRIO)
    - type: "Entrada" ou "Saída" (OBRIGATÓRIO)
    - value: float (OBRIGATÓRIO)
    - frequency: "daily", "weekly", "bi-weekly", "monthly", "annually" (OBRIGATÓRIO)
    - startDate: "YYYY-MM-DD" (OBRIGATÓRIO)
    - interval: integer (opcional, default: 1)
    - dayOfMonth: integer (opcional, para 'monthly', 1-31 ou -1 para último dia)
    - dayOfWeek: integer (opcional, para 'weekly'/'bi-weekly', 0-6 onde 0=Domingo)
    - endDate: "YYYY-MM-DD" (opcional)
    - autoCreateTransaction: boolean (opcional, default: false - se true, cria a transação; se false, apenas lembra)
    - financialCategoryName: string (opcional)

12. CREATE_CREDIT_CARD: Para cadastrar um novo cartão de crédito.
    - name: string (OBRIGATÓRIO, ex: "Nubank Ultravioleta", "Inter PF")
    - limit: float (OBRIGATÓRIO)
    - closingDay: integer (OBRIGATÓRIO, dia do fechamento da fatura, 1-28)
    - paymentDay: integer (OBRIGATÓRIO, dia do pagamento da fatura, 1-28)
    - lastFourDigits: string (opcional, 4 dígitos)
    - flag: string (opcional, ex: "Visa", "Mastercard")
    - isDefault: boolean (opcional, default: false)

13. LIST_CREDIT_CARDS: Para listar os cartões cadastrados. (Sem parâmetros específicos por enquanto)

14. SWITCH_FINANCIAL_ACCOUNT: Se o usuário explicitamente pedir para trocar de conta financeira (PF/PJ/MEI).
    - targetAccountNameOrType: string (opcional, ex: "Pessoal", "Empresa", "MEI". Se omitido, o sistema deve listar as opções.)

15. CREATE_FINANCIAL_ACCOUNT: Se o usuário pedir para criar uma nova conta (PF, PJ ou MEI).
    - accountTypeToCreate: "PF", "PJ", "MEI" (OBRIGATÓRIO se a intenção for essa)
    - newAccountName: string (opcional, se o usuário já fornecer o nome)

16. SHOW_MENU: Se o usuário pedir o menu, estiver confuso, ou a intenção for muito vaga.

17. GENERAL_GREETING_OR_SMALLTALK: Se o usuário apenas cumprimentar, agradecer, ou fizer um comentário genérico que não exija ação.
    - (Sem parâmetros específicos)

18. ACTION_CONFIRMATION_YES: Se a mensagem do usuário for uma confirmação positiva (sim, correto, ok, pode registrar) para uma ação anterior proposta pelo assistente.
    - (Sem parâmetros específicos, o contexto da conversa anterior é chave)

19. ACTION_CONFIRMATION_NO: Se a mensagem do usuário for uma negação (não, incorreto, cancelar) para uma ação anterior.
    - (Sem parâmetros específicos)

INSTRUÇÕES IMPORTANTES:
- Data: Sempre converta datas relativas (hoje, ontem, amanhã, próxima segunda, dia X) para o formato "YYYY-MM-DD". Considere que hoje é ${today}.
- Valores Monetários: Extraia apenas números, permitindo ponto ou vírgula como separador decimal.
- Múltiplas Ações: Se a mensagem contiver múltiplas ações distintas (ex: "gastei 50 no mercado e recebi 100 do meu pai"), liste cada uma em "detected_actions".
- Ambiguidade: Se uma ação é detectada mas falta um parâmetro OBRIGATÓRIO, use "action": "ASK_FOR_CLARIFICATION" e formule a "clarification_question" em "reply_to_user_suggestion".
- Confiança: Use o campo "confidence" para indicar o quão certo você está. Se a confiança for baixa (< 0.6) para uma ação complexa, talvez seja melhor usar "ASK_FOR_CLARIFICATION".
- Resposta ao Usuário: A "reply_to_user_suggestion" deve ser natural e amigável. Se houver "clarifications_needed", esta sugestão DEVE ser a primeira pergunta de clarificação. Se múltiplas ações forem detectadas e nenhuma clarificação for necessária, sugira uma mensagem de confirmação geral (o backend montará o resumo detalhado).

Contexto da Conta Ativa: ${accountCtx}
Não pergunte sobre a conta financeira (PF/PJ/MEI) a menos que a mensagem do usuário seja ambígua sobre isso ou ele peça para trocar de conta. Assuma a conta ativa informada.

Histórico da Conversa (últimas interações, a mais recente primeiro):
{{CONVERSATION_HISTORY}}

MENSAGEM DO USUÁRIO:
"{{USER_MESSAGE}}"
`;
  // FIM DO PROMPT DETALHADO
  return prompt;
}


/**
 * Interage com o modelo da OpenAI para interpretar a mensagem do usuário.
 * @param {string} userMessage - A mensagem do usuário.
 * @param {object} conversationContext - Contexto atual da conversa.
 * @returns {Promise<object>} A resposta JSON estruturada da IA.
 */
async function interpretUserMessage(userMessage, conversationContext = {}) {
  if (!OPENAI_API_KEY) {
    logger.error('[AI SERVICE] OPENAI_API_KEY não configurada.');
    return { // Retorna uma estrutura padrão em caso de erro de configuração
        overall_summary_suggestion: "Estou com uma dificuldade técnica no momento.",
        detected_actions: [],
        clarifications_needed: [],
        ununderstood_segments: [userMessage],
        reply_to_user_suggestion: "Desculpe, não consigo processar sua solicitação agora devido a um problema interno. Tente mais tarde."
    };
  }

  // O histórico deve ser formatado como [{role: 'user', content: '...'}, {role: 'assistant', content: '...'}]
  const messagesForAPI = [
    {
      role: "system",
      content: buildSystemPrompt(conversationContext) // O prompt principal é a instrução do sistema
    },
    // Adicionar histórico da conversa ao prompt, se houver
    ...(conversationContext.conversationHistory || []).map(entry => ({
        role: entry.role,
        content: entry.content
    })),
    { // A mensagem atual do usuário
      role: "user",
      content: userMessage
    }
  ];
  // Limitar o tamanho do histórico enviado para a API para não exceder limites de token
  // (a lógica de truncamento no whatsapp.service.js já faz isso)

  logger.debug('[AI SERVICE] Enviando para OpenAI:', { messages: messagesForAPI.map(m => ({role: m.role, content: m.content.substring(0,200) + (m.content.length > 200 ? '...' : '')})) });


  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-3.5-turbo-1106", // "gpt-4-turbo-preview" para melhor desempenho se disponível
      messages: messagesForAPI,
      temperature: 0.3, // Mais baixo para respostas mais factuais e menos criativas
      // max_tokens: 500, // Ajuste conforme necessário
      response_format: { type: "json_object" }, // Solicita explicitamente um JSON
    });

    const aiResultContent = completion.choices[0].message.content;
    logger.debug('[AI SERVICE] Raw AI Response Content:', { aiResultContent });

    if (!aiResultContent) {
        throw new Error("Resposta da IA vazia ou inválida.");
    }

    const parsedResult = JSON.parse(aiResultContent);
    logger.info('[AI SERVICE] Resultado da IA parseado com sucesso.');
    return parsedResult;

  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[AI SERVICE] Erro ao chamar API da OpenAI:', { errorMessage, requestMessages: messagesForAPI.length });
    // Retornar uma estrutura de erro consistente
    return {
        overall_summary_suggestion: "Tive um probleminha para entender sua mensagem com a inteligência artificial.",
        detected_actions: [],
        clarifications_needed: [],
        ununderstood_segments: [userMessage],
        reply_to_user_suggestion: "Houve um erro de comunicação com meu cérebro de IA 🧠. Poderia tentar novamente em alguns instantes?"
    };
  }
}

module.exports = {
  interpretUserMessage,
  ASSISTANT_NAME, // Exporta o nome para ser usado em outros lugares se necessário
};
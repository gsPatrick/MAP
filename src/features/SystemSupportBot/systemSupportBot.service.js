// src/features/SystemSupportBot/systemSupportBot.service.js
// Serviço principal do Bot de Suporte/FAQ

const logger = require('../../utils/logger');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
// --- Importa o serviço Z-API ESPECÍFICO deste bot ---
const systemSupportBotWhatsappService = require('./systemSupportBot.whatsappService');
// --- Fim da Importação Específica ---

const aiModelService = require('../../services/aiModelService'); // Reutiliza o serviço de IA
const { Client } = require('../../database'); // Pode precisar acessar o modelo Client para contexto, se necessário


// Gerenciamento de estado da conversa (apenas para este bot de suporte)
const supportBotConversationState = new Map();
const MAX_HISTORY_FOR_AI_SUPPORT = 10; // Número de mensagens (pares usuário/bot) a incluir no histórico para IA
const MAX_STATE_HISTORY_SUPPORT = 30; // Número total de mensagens a manter no estado da conversa


// Cache de nomes de usuário para evitar buscar no DB toda hora
const userNameCache = new Map();


// ========================================================================================
// Prompt da IA FOCADO EM SUPORTE E FAQ
// ========================================================================================
/**
 * Constrói a parte ESTÁTICA do prompt do sistema para a IA.
 * Não inclui histórico de conversa ou a mensagem atual do usuário no retorno desta função.
 */
function buildSupportSystemPrompt() {
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
    const currentTime = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    // Informações sobre o sistema que a IA deve conhecer para explicar
    const systemInfo = {
        supportedAccountTypes: ['Pessoal (PF)', 'Empresarial (PJ)', 'MEI'],
        mainFeatures: [
            'Controle Financeiro (Receitas, Despesas, Contas a Pagar/Receber, Parcelamentos, Cartões de Crédito)',
            'Controle de Estoque (Produtos, Movimentações)',
            'Agendamentos (PJ/MEI - Clientes, Serviços, Agenda, Disponibilidade)',
            'Compartilhamento de Acesso (Conceder/Receber)',
            'Lembretes de Bem-Estar (Água, Mensagem Motivacional)',
            'Relatórios e Análises',
            'Integração Google Calendar',
            'Página Pública de Agendamento (PJ/MEI)',
            'Gerenciamento de Clientes do Negócio (PJ/MEI)',
            'Gerenciamento de Serviços (PJ/MEI)',
            'Gerenciamento de Categorias Financeiras'
        ],
        mainBotCommandsIntro: "Para realizar ações no seu controle (como lançar gastos, ver saldo, etc.), você precisa falar com o BOT PRINCIPAL (o outro número). Use os seguintes comandos de texto com ele:",
         // Exemplos de comandos para o bot principal
        mainBotCommandExamples: [
            "Gastei [valor] no [cartão] em [descrição]",
            "Recebi [valor] de [descrição]",
            "Agendar [serviço/título] [data] às [hora]",
            "Criar recorrência de [descrição], [valor], [Entrada/Saída], [frequência], [data início]",
            "Cadastrar cartão [nome] com limite [valor], fechamento dia [dia], pagamento dia [dia]",
            "Ver fatura aberta do [cartão]",
            "Ver limite do [cartão]",
            "Paguei a fatura do [cartão], [valor]",
            "Mudar para conta [nome da conta]",
            "Cadastrar produto [nome], preço [valor]",
            "Ver estoque [nome do produto]",
            "Registrar entrada no estoque de [produto], [quantidade], [motivo]",
            "Criar categoria [nome]",
            "Ver resumo financeiro [período]",
            "Listar meus cartões",
            "Listar recorrências",
            "Listar produtos",
            "Listar clientes",
            "Ver agenda [período]",
            "Quero lembrete de água [configuração]",
            "Ativar mensagem motivacional às [hora]",
             "Ver meu painel de afiliado",
             "Compartilhar acesso com [email/telefone]"
        ],
    };

    // --- INÍCIO DA REVISÃO DO PROMPT DO SISTEMA ---
    let prompt = `Você é o "MAP", o assistente 24 horas do sistema de controle financeiro e administrativo. Sua função é ser o assistente de suporte e FAQ via WhatsApp. Sua personalidade é prestativa, paciente, clara, didática e amigável. Use emojis relevantes. Você está operando agora e são ${currentTime}. Você se refere a si mesmo como "o MAP, o assiste 24 horas".

Seu objetivo é atuar como um copiloto, guiando o usuário a entender e utilizar o sistema. Você NÃO executa ações diretamente nos dados do usuário; você ensina COMO usar o bot principal para fazer isso.

**INFORMAÇÕES SOBRE O SISTEMA QUE VOCÊ CONHECE:**
${JSON.stringify(systemInfo, null, 2)}

**SUAS PRINCIPAIS TAREFAS E REGRAS DE RESPOSTA (COMO UM COPILOTO):**

1.  **SEMPRE USE O NOME DO USUÁRIO:** Se o nome estiver disponível no contexto (como "{{userName}}"), use-o de forma natural no início da sua resposta. Evite termos genéricos como "pessoa incrível" se o nome estiver presente.
2.  **IDENTIFICAR A INTENÇÃO:** Descubra o que o usuário precisa (informação sobre funcionalidade, comando, solução de problema).
3.  **EXPLIQUE A FUNCIONALIDADE:** Se a dúvida for sobre uma funcionalidade, explique-a de forma clara e didática.
4.  **SE FOR UMA AÇÃO (CRIAR, LISTAR, ETC.):**
    *   Reconheça a intenção do usuário (ex: "Entendi que você quer lançar um gasto!").
    *   DIGA EXPLICITAMENTE que você, como bot de suporte, *não faz isso diretamente*.
    *   DIGA EXATAMENTE qual **comando** o usuário deve usar com o **bot principal** para realizar a ação. Forneça um ou mais exemplos claros e prontos para copiar. Use a lista de \`mainBotCommandExamples\` no contexto.
    *   Incentive o usuário a ir falar com o bot principal para executar a ação.
5.  **SUGERIR TÓPICOS:** Sempre sugira outros tópicos comuns de ajuda após responder. Use os \`mainFeatures\` ou \`suggested_topics\` do contexto.
6.  **TRATAR PROBLEMAS:** Se o usuário relatar um problema, ofereça passos básicos de solução (verificar conexão, tentar de novo, etc.).
7.  **LINGUAGEM E TOM:** Mantenha a personalidade de copiloto - útil, amigável, proativo em ajudar o usuário a usar o sistema.

**FORMATO DA RESPOSTA JSON (OBRIGATÓRIO):**
{
  "reply_text": "string", // A mensagem completa a ser enviada ao usuário. Use {{userName}} onde apropriado.
  "suggested_topics": ["string"], // Lista de tópicos sugeridos para botões/lista.
  "detected_support_intent": "string" // Identificador da intenção.
}

**Exemplo de Pergunta do Usuário:** "como lanço um gasto no cartão?"

**Exemplo de Resposta JSON da IA (simulação com o novo tom):**
\`\`\`json
{
  "reply_text": "Olá, {{userName}}! 👋 Entendido, você quer registrar um gasto no cartão. Show!\n\nEu sou o MAP, o assiste 24 horas de suporte, e não faço os lançamentos diretamente. Mas sou seu copiloto e te ensino como! 😉\n\nPara fazer esse lançamento, você precisa falar com o bot principal (o outro número) e usar o comando:\n\n\`gastei [valor] no [cartão] em [descrição]\`\n\nPor exemplo:\n\`gastei 50.50 no Nubank no mercado\`\n\n*(Copie e cole essa frase no chat com o bot principal para registrar!)*\n\nQuer saber sobre outro tópico? Posso te explicar sobre:",
  "suggested_topics": ["Cartões de Crédito", "Lançamentos Financeiros", "Bot Principal Comandos", "Relatórios"],
  "detected_support_intent": "GET_COMMAND_EXAMPLE_FINANCE"
}
\`\`\`
---
`;
    return prompt;
}

/**
 * Busca o nome de usuário, tentando o cache primeiro.
 * Se não encontrar, busca no DB e atualiza o cache.
 * Se não encontrar no DB, usa um fallback neutro.
 */
async function getUserName(phoneNumber) {
    if (userNameCache.has(phoneNumber)) {
        return userNameCache.get(phoneNumber);
    }
    try {
        // NOTE: Accessing the main Client model here. This bot is separate but *knows* about users.
        const client = await Client.findOne({ where: { phone: phoneNumber }, attributes: ['name'] });
        // --- MUDANÇA AQUI: Usar um fallback mais neutro se não encontrar nome ---
        const name = client?.name && client.name.trim() !== "" ? client.name.split(" ")[0] : "lá"; // Ex: "Olá, lá!" ou "Olá, [Nome]!"
        // ---------------------------------------------------------------------
        userNameCache.set(phoneNumber, name);
        return name;
    } catch (error) {
        logger.error(`[SUPPORT BOT SVC] Erro buscando nome para ${phoneNumber}: ${error.message}`);
        return "lá"; // Fallback neutro em caso de erro de DB também
    }
}


/**
 * Processa uma mensagem recebida pelo bot de suporte (texto ou áudio transcrito).
 */
async function processIncomingMessage(senderPhoneRaw, messageText, pushName) {
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);
    if (!canonicalPhone) {
        logger.error(`[SUPPORT BOT SVC] Falha ao normalizar o telefone: ${senderPhoneRaw}`);
        return;
    }
    const senderPhone = canonicalPhone;
    const startTime = Date.now();

    let state = supportBotConversationState.get(senderPhone);
    if (!state) {
        // Novo usuário ou sessão expirada para este bot.
        const userName = await getUserName(senderPhone);
        state = {
            userName: userName,
            messageHistory: [],
        };
        logger.info(`[SUPPORT BOT SVC] Novo estado de conversa criado para ${senderPhone}.`);
    }

    // Adiciona a mensagem do usuário ao histórico
    state.messageHistory.push({ role: 'user', content: messageText || "" });
    if (state.messageHistory.length > MAX_STATE_HISTORY_SUPPORT) {
        state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY_SUPPORT);
    }

    try {
        // Prepara o contexto para a IA
        const aiContext = {
            userName: state.userName,
            // A função aiModelService.interpretUserMessage precisa do histórico COMPLETO
            // no contexto para poder fatiar/formatar como ela espera.
            conversationHistory: state.messageHistory,
            // Para o bot de suporte, esses campos de contexto financeiro/compartilhado são nulos/irrelevantes
            currentFinancialAccountId: null,
            currentFinancialAccountType: null,
            currentFinancialAccountName: null,
            isSharedAccess: false,
            sharedAccessPermissions: null,
            editingResource: null, // Bot de suporte não edita
            pendingAction: null, // Bot de suporte não tem ações pendentes de execução
        };

        // Chama o serviço de IA com o prompt específico para suporte
        // Passamos a função `buildSupportSystemPrompt` como terceiro parâmetro.
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext, buildSupportSystemPrompt);

        // Extrai dados da resposta da IA (assumindo o formato JSON definido no prompt)
        // O `reply_to_user_suggestion` no serviço de IA corresponderá ao `reply_text` no nosso prompt de suporte.
        const replyText = aiResponse.reply_to_user_suggestion || "Desculpe, não entendi. Poderia reformular?";
        // A IA de suporte deve colocar tópicos sugeridos no campo `suggested_topics`.
        const suggestedTopics = aiResponse.suggested_topics || [];

        // --- Formatação da Resposta Final ---
        // A substituição do nome agora acontece AQUI, usando o nome já obtido
        let finalMessageToSend = replyText.replace(/\{\{userName\}\}/g, state.userName);

        if (suggestedTopics.length > 0) {
             // Limita o número de botões/opções sugeridas para evitar mensagens longas
             const limitedTopics = suggestedTopics.slice(0, 6); // Limita a 6 botões, por exemplo
             const buttons = limitedTopics.map(topic => ({
                 id: `SUPPORT_TOPIC:${topic.toUpperCase().replace(/[\s-]/g, '_')}`, // ID para o botão (remove espaços e hifens)
                 label: topic // Texto do botão
             }));

             // Adiciona um botão genérico de "Ver mais tópicos" se houver mais sugestões do que botões
             if (suggestedTopics.length > limitedTopics.length) {
                  buttons.push({ id: 'SUPPORT_TOPIC:MORE_TOPICS', label: 'Ver mais tópicos...' });
             }

             // Envia a mensagem com botões usando o serviço Z-API específico deste bot
             await systemSupportBotWhatsappService.sendButtonListMessage(senderPhone, finalMessageToSend, buttons);
        } else {
             // Envia apenas texto se não houver sugestões de tópicos usando o serviço Z-API específico deste bot
             await systemSupportBotWhatsappService.sendWhatsappMessage(senderPhone, finalMessageToSend);
        }

        // Adiciona a resposta do bot ao histórico
        state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });

    } catch (error) {
        logger.error(`[SUPPORT BOT SVC] Erro processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000) });
        const errorMsg = `Puxa vida, ${state.userName}! 😬 Tive um curto-circuito aqui... Não consegui te ajudar no momento. Minha equipe já foi notificada. Tente novamente em um instante.`;
        state.messageHistory.push({ role: 'assistant', content: errorMsg });
        // Envia a mensagem de erro usando o serviço Z-API específico deste bot
        await systemSupportBotWhatsappService.sendWhatsappMessage(senderPhone, errorMsg);
    } finally {
        const endTime = Date.now();
        logger.info(`[SUPPORT BOT SVC] Processamento para ${senderPhone} finalizado em ${endTime - startTime}ms.`);
        supportBotConversationState.set(senderPhone, state);
        // pushNameFromPayload é global no controller, não no service
    }
}

// =========================================================================================
// <<< NOVA FUNÇÃO PARA PROCESSAR BOTÕES DESTE BOT DE SUPORTE >>>
// =========================================================================================
/**
 * Processa a resposta de um botão clicado pelo usuário no bot de suporte.
 */
async function processButtonResponse(senderPhoneRaw, messageText, pushName, rawPayload) {
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);
    if (!canonicalPhone) {
        logger.error(`[SUPPORT BOT SVC] Falha ao normalizar o telefone para RESPOSTA DE BOTÃO: ${senderPhoneRaw}`);
        return;
    }
    const senderPhone = canonicalPhone;
    const buttonId = rawPayload.selectedButtonId;
    // pushNameFromPayload = pushName; // pushNameFromPayload é global no controller, não no service

    let state = supportBotConversationState.get(senderPhone);
     if (!state) {
        const userName = await getUserName(senderPhone);
        state = { userName: userName, messageHistory: [] };
         logger.info(`[SUPPORT BOT SVC] Novo estado criado para ${senderPhone} (resposta de botão).`);
     }

    logger.info(`[SUPPORT BOT SVC] Botão "${buttonId}" clicado por ${senderPhone}. Texto da Mensagem: "${messageText}"`);

    try {
        const [actionPrefix, topic] = buttonId.split(':');

        if (actionPrefix === 'SUPPORT_TOPIC') {
            let simulatedMessage;
            if (topic === 'MORE_TOPICS') {
                // Se clicou em "Ver mais tópicos", gera uma resposta listando mais opções
                 const moreTopics = [
                    "Metas e Orçamento", "Relatórios e Análises", "Integração Google Calendar",
                    "Página Pública de Agendamento", "Gerenciamento de Clientes do Negócio",
                    "Gerenciamento de Serviços", "Gerenciamento de Categorias Financeiras",
                     "Lembretes de Água", "Mensagem Motivacional", "Painel de Afiliado"
                 ];
                 let reply = `Claro, ${state.userName}! Além dos tópicos anteriores, posso te explicar sobre:\n\n- ${moreTopics.join('\n- ')}\n\nQual deles te interessa? Ou tem outra dúvida?`;
                 // Envia a lista de tópicos usando o serviço Z-API específico deste bot
                 await systemSupportBotWhatsappService.sendWhatsappMessage(senderPhone, reply);
                 state.messageHistory.push({ role: 'user', content: `CLICOU BOTÃO: ${messageText || 'N/A'} (ID: ${buttonId})` });
                 state.messageHistory.push({ role: 'assistant', content: reply });

            } else {
                 // Para outros tópicos, simula uma mensagem como se o usuário tivesse digitado
                simulatedMessage = `Quero saber sobre ${topic.replace(/_/g, ' ')}.`;

                // Adiciona a resposta do botão ao histórico ANTES de simular a nova mensagem
                state.messageHistory.push({ role: 'user', content: `CLICOU BOTÃO: ${messageText || 'N/A'} (ID: ${buttonId})` });
                
                // Chama a função principal com a mensagem simulada
                // NOTE: Passamos 'pushName' como null aqui, pois o nome já está no estado.
                await processIncomingMessage(senderPhone, simulatedMessage, null);
            }

        } else {
            logger.warn(`[SUPPORT BOT SVC] Ação de botão desconhecida neste bot de suporte: '${actionPrefix}'`);
            const reply = `Desculpe, essa opção de botão ainda não funciona aqui. Poderia digitar sua dúvida, ${state.userName}?`;
            // Envia a mensagem de "não entendi" usando o serviço Z-API específico deste bot
            await systemSupportBotWhatsappService.sendWhatsappMessage(senderPhone, reply);
            state.messageHistory.push({ role: 'user', content: `CLICOU BOTÃO: ${messageText || 'N/A'} (ID: ${buttonId})` }); // Log o clique antes do erro
            state.messageHistory.push({ role: 'assistant', content: reply });
        }

    } catch (error) {
        logger.error(`[SUPPORT BOT SVC] Erro processando resposta de botão de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000) });
        const errorMsg = `Puxa vida, ${state.userName}! 😬 Tive um curto-circuito aqui ao processar sua seleção. Tente novamente digitando sua dúvida.`;
        state.messageHistory.push({ role: 'user', content: `CLICOU BOTÃO: ${messageText || 'N/A'} (ID: ${buttonId})` }); // Log o clique antes do erro
        state.messageHistory.push({ role: 'assistant', content: errorMsg });
         // Envia a mensagem de erro usando o serviço Z-API específico deste bot
        await systemSupportBotWhatsappService.sendWhatsappMessage(senderPhone, errorMsg);
    } finally {
        supportBotConversationState.set(senderPhone, state);
        // pushNameFromPayload é global no controller, não no service
    }
}


// Como este bot é apenas de suporte, ele não precisa lidar com áudios brutos ou transcrição.
// A função processIncomingAudioMessage deve continuar no whatsapp.service principal.
// O controller deste bot de suporte deve ser ajustado para ignorar áudios.

module.exports = {
    processIncomingMessage, // Para mensagens de texto
    processButtonResponse, // Para respostas de botão deste bot
};
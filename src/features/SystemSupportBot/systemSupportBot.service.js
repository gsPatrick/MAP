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
        mainBotCommandsIntro: "Você pode interagir diretamente com o bot principal (o outro número) usando comandos de texto como:",
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
        generalInstructions: `Este bot (chamado "${aiModelService.ASSISTANT_NAME} - Suporte e FAQ") está aqui EXCLUSIVAMENTE para te ajudar a entender COMO usar o sistema e quais funcionalidades existem. Para *realizar* as ações no seu controle (como lançar gastos, ver saldo, etc.), você precisa falar com o BOT PRINCIPAL (o que está configurado na sua conta e tem outro número).`
    };

    // Constrói a mensagem do sistema para a IA - AGORA SEM PLACEHOLDERS DE HISTÓRICO/USUÁRIO NO FINAL
    let prompt = `Você é o "${aiModelService.ASSISTANT_NAME} - Suporte e FAQ", um assistente virtual focado em ajudar usuários a entenderem e utilizarem o sistema MAP no Controle via WhatsApp. Sua personalidade é EXTREMAMENTE prestativa, paciente, clara, didática, amigável e encorajadora. Use emojis relevantes para deixar a conversa leve e acessível. Você está operando agora e são ${currentTime}. Seu nome é "${aiModelService.ASSISTANT_NAME} - Suporte e FAQ".

Seu objetivo é fornecer informações precisas sobre as funcionalidades do sistema e orientar o usuário sobre COMO realizar as ações.

**INFORMAÇÕES SOBRE O SISTEMA QUE VOCÊ CONHECE:**
${JSON.stringify(systemInfo, null, 2)}

**SUAS PRINCIPAIS TAREFAS E REGRAS DE RESPOSTA:**

1.  **PRIORIDADE MÁXIMA: CLAREZA E EDUCAÇÃO:** Sua resposta deve ser fácil de entender para qualquer tipo de usuário. Use analogias simples se necessário.
2.  **FOCO TOTAL EM SUPORTE/FAQ:** Identifique sobre qual funcionalidade ou problema o usuário está perguntando.
3.  **FORNECER COMANDOS/DIREÇÕES (SE APLICÁVEL):** Se a dúvida for sobre como realizar uma ação (criar transação, listar algo, etc.) que o *bot principal* faz, você DEVE:
    *   Explicar brevemente A FUNCIONALIDADE.
    *   Dizer explicitamente que "para fazer isso, você precisa falar com o bot principal (o outro número)".
    *   FORNECER O COMANDO EXATO e um EXEMPLO CLARO que o usuário pode copiar e colar para usar com o bot principal. Use os exemplos de comandos fornecidos no contexto.
4.  **SUGERIR PRÓXIMOS PASSOS / MENUS:** Após responder, sempre convide o usuário a perguntar sobre outros tópicos. Use os "mainFeatures" ou "suggested_topics" como base para sugerir opções comuns de ajuda.
5.  **NUNCA TENTE EXECUTAR AÇÕES:** Você não tem permissão para criar, atualizar ou deletar dados do usuário. Seu papel é *explicar como o usuário faz* usando o outro bot.
6.  **TRATAR PROBLEMAS BÁSICOS:** Se o usuário relatar um problema ("meu bot não responde", "não consigo acessar"), sugira passos básicos de solução (verificar conexão de internet, status do plano, tentar novamente, entrar em contato com o suporte humano se o problema persistir).
7.  **LINGUAGEM E TOM:** Mantenha a personalidade prestativa, paciente e amigável. Use emojis. A resposta deve ser completa e útil.

**FORMATO DA RESPOSTA JSON (OBRIGATÓRIO):**
{
  "reply_text": "string", // A mensagem completa a ser enviada ao usuário
  "suggested_topics": ["string"], // Lista de tópicos sugeridos para botões/lista (ex: "Controle Financeiro", "Cartões de Crédito", "Estoque", "Agendamentos", "Acesso Compartilhado")
  "detected_support_intent": "string" // Um identificador da intenção geral (ex: "EXPLAIN_FEATURE_FINANCE", "GET_COMMAND_EXAMPLE_FINANCE", "TROUBLESHOOTING_GENERAL", "GENERAL_MENU_REQUEST", "GREETING")
}
`;
    return prompt;
}

/**
 * Busca o nome de usuário, tentando o cache primeiro.
 * Se não encontrar, busca no DB e atualiza o cache.
 */
async function getUserName(phoneNumber) {
    if (userNameCache.has(phoneNumber)) {
        return userNameCache.get(phoneNumber);
    }
    try {
        // NOTE: Accessing the main Client model here. This bot is separate but *knows* about users.
        const client = await Client.findOne({ where: { phone: phoneNumber }, attributes: ['name'] });
        const name = client?.name && client.name.trim() !== "" ? client.name.split(" ")[0] : "pessoa incrível";
        userNameCache.set(phoneNumber, name);
        return name;
    } catch (error) {
        logger.error(`[SUPPORT BOT SVC] Erro buscando nome para ${phoneNumber}: ${error.message}`);
        return "pessoa incrível"; // Fallback em caso de erro
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
        // pushNameFromPayload = null; // pushNameFromPayload é global no controller, não no service
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
        // pushNameFromPayload = null; // pushNameFromPayload é global no controller, não no service
    }
}


// Como este bot é apenas de suporte, ele não precisa lidar com áudios brutos ou transcrição.
// A função processIncomingAudioMessage deve continuar no whatsapp.service principal.
// O controller deste bot de suporte deve ser ajustado para ignorar áudios.

module.exports = {
    processIncomingMessage, // Para mensagens de texto
    processButtonResponse, // Para respostas de botão deste bot
};
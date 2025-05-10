// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service'); // Para categorias

const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');
// const { Op } = require('sequelize'); // Removido se não usado diretamente aqui

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8; // Pares de mensagens (usuário/assistente)
const MAX_STATE_HISTORY = 20; // Total de mensagens no estado

// --- Helper Functions (Mantidas e podem ser expandidas) ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    logger.debug(`[WHATSAPP SERVICE] Buscando categoria financeira por nome: "${name}" para conta ${financialAccountId}, tipo ${transactionType}`);
    // Tenta encontrar pelo nome exato primeiro, considerando o tipo se fornecido
    let foundCategory = await systemService.findFinancialCategoryByNameAndType(name, transactionType, financialAccountId);
    if (foundCategory) return foundCategory.id;

    // Se não encontrar, tenta pelo nome (sem considerar o tipo, pode ser mais flexível)
    // Note: systemService.findFinancialCategoryByName agora chama findFinancialCategoryByNameAndType com type=null
    foundCategory = await systemService.findFinancialCategoryByName(name, financialAccountId);
    if (foundCategory) {
        logger.info(`[WHATSAPP SERVICE] Categoria por nome "${name}" (tipo ${transactionType || 'qualquer'}) não encontrada exatamente. Usando correspondência por nome: "${foundCategory.name}" (ID: ${foundCategory.id})`);
        return foundCategory.id;
    }

    logger.warn(`[WHATSAPP SERVICE] Categoria financeira com nome "${name}" não encontrada.`);
    return null;
}

async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const cards = await creditCardService.getAllCreditCards(financialAccountId, { isActive: true });
    const found = cards.find(card => card.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const partialFound = cards.find(card => card.name.toLowerCase().includes(name.toLowerCase()));
    if (partialFound) {
        logger.info(`[WHATSAPP SERVICE] Cartão por nome "${name}" não encontrado exatamente. Usando correspondência parcial: "${partialFound.name}" (ID: ${partialFound.id})`);
        return partialFound.id;
    }
    logger.warn(`[WHATSAPP SERVICE] Cartão de crédito com nome "${name}" não encontrado para a conta ${financialAccountId}.`);
    return null;
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    const { products } = await productService.getAllProducts(financialAccountId, { search: nameOrCode, isActive: true, limit: 5 });
    if (products && products.length > 0) {
        const exactMatch = products.find(p => p.name.toLowerCase() === nameOrCode.toLowerCase() || (p.code && p.code.toLowerCase() === nameOrCode.toLowerCase()));
        if (exactMatch) return exactMatch.id;
        logger.info(`[WHATSAPP SERVICE] Produto por nome/código "${nameOrCode}" não encontrado exatamente. Usando o primeiro da busca: "${products[0].name}" (ID: ${products[0].id})`);
        return products[0].id;
    }
    logger.warn(`[WHATSAPP SERVICE] Produto com nome/código "${nameOrCode}" não encontrado para a conta ${financialAccountId}.`);
    return null;
}

function initializeState(client, defaultAccount = null) {
    const clientName = client ? (client.name || "pessoa incrível") : "pessoa incrível"; // Usar um fallback se o nome não estiver disponível
    const newState = {
        currentAction: null,
        data: {},
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount ? defaultAccount.accountType : null,
        clientName: clientName,
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null,
        lastAiResponse: null,
    };
    if (defaultAccount && client) { // Saudação apenas se tivermos cliente e conta
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Bem-vindo(a) de volta à sua conta "${newState.activeFinancialAccountName}". Como posso te ajudar hoje?` });
    } else if (client) { // Saudação se tiver cliente mas sem conta ainda
         newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Como posso te ajudar hoje?` });
    }
    return newState;
}

// --- Funções de Formatação de Resumo ---
function formatFinancialTransactionSummary(transaction, forMulti = false) {
    const dateFormatted = transaction.transactionDate
        ? new Date(transaction.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' })
        : 'Data não informada';

    let statusText = "";
    if (transaction.isPayableOrReceivable) {
        const dueDateFormatted = transaction.dueDate ? new Date(transaction.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';
        statusText = transaction.isPaidOrReceived
            ? (transaction.type === 'Entrada' ? "✅ recebido" : "✅ pago")
            : `🗓️ ${transaction.type === 'Entrada' ? 'a receber' : 'a pagar'} em ${dueDateFormatted}`;
    } else {
        statusText = transaction.type === 'Entrada' ? "✅ recebido" : "✅ pago";
    }

    let categoryEmoji = transaction.type === 'Entrada' ? '📥' : '💸'; // Default
    if (transaction.category && transaction.category.name) {
        const catNameLower = transaction.category.name.toLowerCase();
        if (catNameLower.includes('lazer') || catNameLower.includes('jogo') || catNameLower.includes('entretenimento')) categoryEmoji = '🎮';
        else if (catNameLower.includes('alimentação') || catNameLower.includes('restaurante') || catNameLower.includes('doce')) categoryEmoji = '🍔';
        else if (catNameLower.includes('salário') || catNameLower.includes('recebimento')) categoryEmoji = '💰';
        else if (catNameLower.includes('transporte')) categoryEmoji = '🚗';
        // Adicionar mais emojis por categoria
    }

    let summary = "";
    if (!forMulti) summary += "📜 Resumo da Transação:\n\n"; // Título só se for transação única

    summary += `${categoryEmoji} Descrição: ${transaction.description}\n`;
    summary += `💰 Valor: R$ ${parseFloat(transaction.value).toFixed(2)}\n`;
    if (transaction.category && transaction.category.name) {
        summary += `🏷️ Categoria: ${transaction.category.name}\n`;
    }
    summary += `📅 Data: ${dateFormatted}\n`;
    summary += `\n${statusText}`;
    return summary;
}

function formatAppointmentSummary(appointment, forMulti = false) {
    const eventDateTimeFormatted = appointment.eventDateTime
        ? new Date(appointment.eventDateTime).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ || 'America/Sao_Paulo' })
        : 'Data/Hora não informada';

    let summary = "";
    if (!forMulti) summary += "📅 Resumo do Compromisso:\n\n";

    summary += `📝 Título: ${appointment.title}\n`;
    summary += `🗓️ Data e Hora: ${eventDateTimeFormatted}\n`;
    if (appointment.durationMinutes) summary += `⏳ Duração: ${appointment.durationMinutes} min\n`;
    if (appointment.location) summary += `📍 Local: ${appointment.location}\n`;
    summary += `🚦 Status: ${appointment.status}`;
    return summary;
}

function formatRecurringRuleSummary(rule, forMulti = false) {
    const startDateFormatted = rule.startDate ? new Date(rule.startDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/I';
    const endDateFormatted = rule.endDate ? new Date(rule.endDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'Sem data final';
    const nextDateFormatted = rule.nextDueDate ? new Date(rule.nextDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';

    let categoryEmoji = rule.type === 'Entrada' ? '📥' : '💸'; // Default
     if (rule.category && rule.category.name) {
        const catNameLower = rule.category.name.toLowerCase();
        if (catNameLower.includes('lazer') || catNameLower.includes('netflix') || catNameLower.includes('entretenimento')) categoryEmoji = '🎬';
        else if (catNameLower.includes('assinatura')) categoryEmoji = '📰';
        // Adicionar mais
    }

    let summary = "";
    if(!forMulti) summary += "🔄 Resumo da Recorrência:\n\n";

    summary += `📜 Descrição: ${rule.description}\n`;
    summary += `💰 Valor: R$ ${parseFloat(rule.value).toFixed(2)} (${rule.type})\n`;
    if (rule.category && rule.category.name) {
        summary += `${categoryEmoji} Categoria: ${rule.category.name}\n`;
    }
    summary += `📅 Data Inicial: ${startDateFormatted}\n`;
    if(rule.endDate) summary += `🏁 Data Final: ${endDateFormatted}\n`;
    summary += `🔁 Frequência: ${rule.frequency} (a cada ${rule.interval})\n`;
    if (rule.dayOfMonth) summary += `🗓️ Dia do Mês: ${rule.dayOfMonth}\n`;
    if (rule.dayOfWeek !== null && rule.dayOfWeek !== undefined) summary += `🗓️ Dia da Semana: ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][rule.dayOfWeek]}\n`;
    summary += `➡️ Próximo Vencimento: ${nextDateFormatted}\n`;
    summary += `✍️ Criação Automática: ${rule.autoCreateTransaction ? 'Sim' : 'Não (Apenas Lembrete)'}\n`;
    summary += `🚦 Status da Regra: ${rule.isActive ? 'Ativa' : 'Inativa'}`;
    return summary;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    // Lógica para lidar com cliques em botões
    if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
        state = conversationState.get(senderPhone);
        if (!state) {
            logger.warn(`[WHATSAPP SERVICE] Estado não encontrado para ${senderPhone} ao processar clique de botão: ${rawPayload.selectedButtonId}`);
            await sendWhatsappMessage(senderPhone, "Ops! Parece que nossa conversa se perdeu um pouquinho. Pode tentar de novo o que queria fazer?");
            return;
        }

        const buttonId = rawPayload.selectedButtonId;
        logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone}: ${buttonId}`);
        let buttonClickHandled = true; // Assume que o clique será tratado aqui
        let replyForButtonClick = "Entendido!";

        if (buttonId.startsWith('edit_transaction_')) {
            const transactionId = buttonId.replace('edit_transaction_', '');
            state.editingResource = { type: 'transaction', id: transactionId };
            replyForButtonClick = `Ok, vamos editar a transação (ID: ${transactionId}). O que você gostaria de alterar nela (descrição, valor, data, categoria)?`;
            state.currentAction = 'awaiting_transaction_edit_details'; // Novo estado para edição
        } else if (buttonId.startsWith('delete_transaction_')) {
            const transactionId = buttonId.replace('delete_transaction_', '');
            state.pendingConfirmation = { action: 'CONFIRM_DELETE_TRANSACTION', parameters: { transactionId: transactionId } };
            state.currentAction = 'awaiting_confirmation';
            replyForButtonClick = `Você tem certeza que quer excluir essa transação? 😟 (Sim/Não)`;
        } else if (buttonId.startsWith('edit_appointment_')) {
            const appointmentId = buttonId.replace('edit_appointment_', '');
            state.editingResource = { type: 'appointment', id: appointmentId };
            replyForButtonClick = `Certo! Vamos editar o compromisso (ID: ${appointmentId}). O que gostaria de mudar (título, data/hora, local)?`;
            state.currentAction = 'awaiting_appointment_edit_details';
        } else if (buttonId.startsWith('delete_appointment_')) {
            const appointmentId = buttonId.replace('delete_appointment_', '');
            state.pendingConfirmation = { action: 'CONFIRM_DELETE_APPOINTMENT', parameters: { appointmentId: appointmentId } };
            state.currentAction = 'awaiting_confirmation';
            replyForButtonClick = `Tem certeza que deseja excluir este compromisso? (Sim/Não)`;
        }
        // Adicionar para recorrências se tiver botões de editar/excluir para elas
        else {
            buttonClickHandled = false; // Botão não reconhecido aqui, deixa a IA tentar
        }

        if (buttonClickHandled) {
            state.messageHistory.push({ role: 'user', content: `[CLIQUE NO BOTÃO: ${buttonId}]` }); // Loga o clique
            state.messageHistory.push({ role: 'assistant', content: replyForButtonClick });
            conversationState.set(senderPhone, state);
            await sendWhatsappMessage(senderPhone, replyForButtonClick);
            return; // Clique tratado, não precisa da IA por agora.
        }
        // Se buttonClickHandled for false, o fluxo continua para a IA.
    }


    try {
        const client = await clientService.findOrCreateClientByPhone(senderPhone, { name: pushName }, true);
        if (!client) {
            await sendWhatsappMessage(senderPhone, "Desculpe, estou com um problema para identificar você no momento. Por favor, tente mais tarde. 😕");
            return;
        }

        state = conversationState.get(senderPhone) || initializeState(client);
        if (client.name && state.clientName !== client.name) {
            state.clientName = client.name;
        }

        state.messageHistory.push({ role: 'user', content: messageText });
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }

        if (!state.activeFinancialAccountId) {
            const accounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
            const defaultAccount = accounts.find(acc => acc.isDefault) || (accounts.length > 0 ? accounts[0] : null);

            if (!defaultAccount && accounts.length === 0) {
                state.currentAction = 'creating_first_account_type';
                const welcomeMsg = `Olá ${state.clientName}! 😊 Bem-vindo(a) ao ${aiModelService.ASSISTANT_NAME}! Para começarmos, vamos configurar sua primeira conta. Ela é para suas finanças *Pessoais (PF)*, para sua *Empresa (PJ)* ou para seu *MEI*?`;
                state.messageHistory.push({ role: 'assistant', content: welcomeMsg });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, welcomeMsg);
                return;
            } else if (accounts.length === 1 || (defaultAccount && accounts.length > 0)) {
                const accountToSet = defaultAccount || accounts[0];
                // Se o estado já existe, apenas atualiza a conta. Senão, inicializa.
                if(conversationState.has(senderPhone)){
                    state.activeFinancialAccountId = accountToSet.id;
                    state.activeFinancialAccountName = accountToSet.accountName;
                    state.activeFinancialAccountType = accountToSet.accountType;
                } else {
                    state = initializeState(client, accountToSet);
                }
                // Garante que a mensagem do usuário seja a última após a possível saudação de seleção de conta
                state.messageHistory = state.messageHistory.filter(m => m.role !== 'user'); // Remove entradas de usuário anteriores se houver
                state.messageHistory.push({ role: 'assistant', content: `Olá ${state.clientName}! 😊 Conta "${state.activeFinancialAccountName}" (${state.activeFinancialAccountType}) selecionada. Como posso te ajudar?` });
                state.messageHistory.push({ role: 'user', content: messageText });

            } else {
                state.currentAction = 'selecting_initial_financial_account';
                state.data = { accountsToList: accounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType})) };
                let accountOptionsText = `Olá ${state.clientName}! Notei que você tem algumas contas por aqui:\n`;
                accounts.forEach((acc) => { accountOptionsText += `\n- *${acc.accountName}* (${acc.accountType})`; });
                accountOptionsText += "\n\nQual delas você gostaria de usar agora? Só me dizer o nome dela. 😉";
                state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, accountOptionsText);
                return;
            }
        }
         // Garante que nome e tipo da conta ativa estejam no estado, mesmo que já houvesse uma conta ativa
        if (state.activeFinancialAccountId && (!state.activeFinancialAccountName || !state.activeFinancialAccountType || state.data?.accountsToList)) {
            const accDetails = await clientService.getFinancialAccountById(state.activeFinancialAccountId);
            if (accDetails && accDetails.isActive) {
                state.activeFinancialAccountName = accDetails.accountName;
                state.activeFinancialAccountType = accDetails.accountType;
                delete state.data?.accountsToList; // Limpa lista de contas se uma foi selecionada
            } else { // Conta se tornou inativa ou foi deletada
                logger.warn(`[WHATSAPP SERVICE] Conta ativa ID ${state.activeFinancialAccountId} não é mais válida para ${senderPhone}. Resetando estado de conta.`);
                state.activeFinancialAccountId = null; state.activeFinancialAccountName = null; state.activeFinancialAccountType = null;
                return processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload); // Tenta selecionar conta novamente
            }
        }


        logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id} (${state.clientName}), Conta: ${state.activeFinancialAccountName || 'N/A'}, Msg: "${messageText}"`);
        // Salva o estado antes de qualquer lógica de pré-processamento ou IA
        conversationState.set(senderPhone, state);


        // === Lógica de Estado da Conversa (ANTES da IA) ===
        if (state.currentAction) {
            let stateHandledInPreProcessing = false;
            let replyForPreProcessing = "";

            // Ações de confirmação explícita
            if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                const lowerMsg = messageText.toLowerCase().trim();
                const actionToConfirm = state.pendingConfirmation.action;
                const paramsToConfirm = state.pendingConfirmation.parameters;

                if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                    state.currentAction = null; state.pendingConfirmation = null;
                    conversationState.set(senderPhone, state); // Salva estado limpo

                    if (actionToConfirm === 'CONFIRM_DELETE_TRANSACTION') {
                        const success = await financialService.deleteTransaction(state.activeFinancialAccountId, paramsToConfirm.transactionId);
                        replyForPreProcessing = success ? "Transação excluída com sucesso! 👍 Algo mais?" : "Não consegui excluir a transação. Pode ter sido um erro ou ela já foi removida.";
                    } else if (actionToConfirm === 'CONFIRM_DELETE_APPOINTMENT') {
                        const success = await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, paramsToConfirm.appointmentId, true); // true para deletar
                        replyForPreProcessing = success ? "Compromisso excluído! ✅ Mais alguma coisa?" : "Não foi possível excluir o compromisso.";
                    } else if (actionToConfirm === 'CONFIRM_CREATE_FINANCIAL_ACCOUNT') {
                         const createdAcc = await clientService.createFinancialAccount(client.id, {
                            accountName: paramsToConfirm.accountName,
                            accountType: paramsToConfirm.accountType,
                            isDefault: (await clientService.getClientFinancialAccounts(client.id, {isActive: true})).length === 0 // Garante que a primeira seja default
                        });
                        state.activeFinancialAccountId = createdAcc.id;
                        state.activeFinancialAccountName = createdAcc.accountName;
                        state.activeFinancialAccountType = createdAcc.accountType;
                        replyForPreProcessing = `Conta "${createdAcc.accountName}" (${createdAcc.accountType}) criada e já está selecionada! 🎉 Como posso te ajudar agora?`;
                    }
                    // Adicionar mais 'else if' para outras ações que precisam de confirmação (ex: CONFIRM_DELETE_RECURRING_RULE)
                    else {
                        replyForPreProcessing = `Entendido, confirmado! Vou prosseguir.`; // Mensagem genérica, a IA vai pegar o contexto
                        // Deixa a IA reprocessar com o "sim" no histórico.
                        // Para que a IA pegue, não setamos stateHandledInPreProcessing = true se a ação não foi executada aqui.
                        // No entanto, é melhor que o "sim" não vá para a IA e a ação seja despachada.
                        // Para este exemplo, vamos assumir que a IA reprocessará.
                        // Se quiséssemos executar aqui, seria:
                        // messageText = `Executar ${actionToConfirm} com ${JSON.stringify(paramsToConfirm)}`;
                        // E aí a IA pegaria essa "nova" mensagem.
                        // Ou um dispatcher interno.
                        // Vamos deixar que o fluxo caia na IA após essa confirmação genérica.
                        state.messageHistory.push({role: 'assistant', content: replyForPreProcessing});
                        await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                        // Não retorna, deixa a IA processar o "sim" no histórico, ou a próxima mensagem se a IA já respondeu.
                        // Na verdade, se o usuário disse "sim", ele espera que a ação aconteça.
                        // Vamos permitir que a IA processe novamente a intenção original com base no histórico atualizado.
                        // Limpar currentAction e pendingConfirmation é crucial.
                        state.currentAction = null;
                        state.pendingConfirmation = null;
                        conversationState.set(senderPhone, state); // Salva o estado limpo
                        // A IA será chamada em seguida.
                    }
                    stateHandledInPreProcessing = true; // Indica que o estado de confirmação foi tratado.
                    if(replyForPreProcessing) { // Se uma ação foi executada diretamente
                         state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                         await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                         if (state.currentAction === null && !state.pendingConfirmation) return; // Ação resolvida.
                    }

                } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) {
                    replyForPreProcessing = "Ok, cancelado! Sem problemas. O que gostaria de fazer então? 😊";
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    stateHandledInPreProcessing = true;
                    state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                    conversationState.set(senderPhone, state);
                    await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                    return;
                }
                // Se não for sim/não claro, o estado de confirmação permanece e a IA tentará interpretar a nova mensagem.
            }
            // Lógica para criação da primeira conta
            else if (state.currentAction === 'creating_first_account_type') {
                const typeChosen = messageText.toLowerCase();
                let accountTypeToCreate = null;
                if (typeChosen.includes('pessoal') || typeChosen.includes('pf')) accountTypeToCreate = 'PF';
                else if (typeChosen.includes('empresa') || typeChosen.includes('pj')) accountTypeToCreate = 'PJ';
                else if (typeChosen.includes('mei')) accountTypeToCreate = 'MEI';

                if (accountTypeToCreate) {
                    state.data.accountTypeToCreate = accountTypeToCreate;
                    state.currentAction = 'awaiting_first_account_name';
                    replyForPreProcessing = `Ótimo! E qual nome você gostaria de dar para esta sua conta ${accountTypeToCreate}? (Ex: "Minhas Finanças", "Empresa ABC")`;
                    stateHandledInPreProcessing = true;
                } else {
                    replyForPreProcessing = "Não entendi bem o tipo. Pode ser Pessoal (PF), Empresa (PJ) ou MEI?";
                    // Mantém currentAction, só envia a pergunta de novo
                }
            } else if (state.currentAction === 'awaiting_first_account_name') {
                const accountName = messageText.trim();
                if (accountName.length > 2 && accountName.length < 100) { // Validação básica do nome
                    const newAccount = await clientService.createFinancialAccount(client.id, {
                        accountName: accountName,
                        accountType: state.data.accountTypeToCreate,
                        isDefault: true
                    });
                    state.activeFinancialAccountId = newAccount.id;
                    state.activeFinancialAccountName = newAccount.accountName;
                    state.activeFinancialAccountType = newAccount.accountType;
                    replyForPreProcessing = `Perfeito! Sua conta "${newAccount.accountName}" (${newAccount.accountType}) foi criada e já está selecionada! 🎉 Como posso te ajudar agora?`;
                    state.currentAction = null; state.data = {};
                    stateHandledInPreProcessing = true;
                } else {
                    replyForPreProcessing = "Esse nome parece um pouco curto ou longo demais. Poderia me dizer um nome entre 3 e 100 letras para sua conta?";
                }
            } else if (state.currentAction === 'selecting_initial_financial_account') {
                 const chosenAccountNameRaw = messageText.trim();
                 const accountToSelect = state.data.accountsToList.find(acc => acc.name.toLowerCase() === chosenAccountNameRaw.toLowerCase() || acc.name.toLowerCase().includes(chosenAccountNameRaw.toLowerCase()));
                 if (accountToSelect) {
                    state.activeFinancialAccountId = accountToSelect.id;
                    state.activeFinancialAccountName = accountToSelect.name;
                    state.activeFinancialAccountType = accountToSelect.type;
                    replyForPreProcessing = `Entendido! Selecionei a conta "${state.activeFinancialAccountName}". Como posso ajudar?`;
                    state.currentAction = null; state.data = {};
                    stateHandledInPreProcessing = true;
                 } else {
                    let errorReply = `Hum, não encontrei uma conta com o nome parecido com "${chosenAccountNameRaw}". Você tem estas opções:\n`;
                    state.data.accountsToList.forEach(acc => {errorReply += `\n- *${acc.name}* (${acc.type})`});
                    errorReply += "\n\nQual delas gostaria de usar?"
                    replyForPreProcessing = errorReply;
                    // Mantém o currentAction
                 }
            }

            if (stateHandledInPreProcessing && replyForPreProcessing) {
                state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                if (state.currentAction === null && !state.pendingConfirmation) return;
            }
        }

        // === Chamada para a IA ===
        const aiContext = {
            currentFinancialAccountId: state.activeFinancialAccountId,
            currentFinancialAccountType: state.activeFinancialAccountType,
            currentFinancialAccountName: state.activeFinancialAccountName,
            clientName: state.clientName,
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
            currentStateData: state.data, // Passa dados de fluxos em andamento (ex: accountsToList)
        };
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponse: JSON.stringify(aiResponse).substring(0,500) + "..."}); // Log resumido
        state.lastAiResponse = aiResponse;

        let finalReplyParts = [];
        if (aiResponse.overall_summary_suggestion) {
            finalReplyParts.push(aiResponse.overall_summary_suggestion.replace("[Nome do Usuário]", state.clientName));
        }

        let requiresConfirmationByAI = false;
        let singleActionFormattedResult = null;
        let multipleActionFormattedResults = [];

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            for (const detectedAction of aiResponse.detected_actions) {
                const params = detectedAction.parameters || {};
                const MIN_CONFIDENCE_FOR_AUTO_ACTION = 0.70; // Ajustar conforme necessário

                if (detectedAction.confidence < MIN_CONFIDENCE_FOR_AUTO_ACTION &&
                    !['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO'].includes(detectedAction.action)) {
                    requiresConfirmationByAI = true;
                    state.pendingConfirmation = detectedAction; // Salva para o próximo turno
                    break;
                }

                let currentActionFormatted = "";
                try {
                    switch (detectedAction.action) {
                        case 'CREATE_FINANCIAL_TRANSACTION': {
                            const categoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                            const cardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                            const txData = {
                                description: params.description, type: params.type, value: parseFloat(params.value),
                                transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes,
                                isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : false),
                                dueDate: params.dueDate,
                                isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (!params.dueDate)
                            };
                            const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                            const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id); // Recarrega para ter a categoria populada
                            currentActionFormatted = formatFinancialTransactionSummary(reloadedTx, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'transaction', id: newTx.id };
                            break;
                        }
                        case 'CREATE_PARCELLED_ACCOUNT': {
                            const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                            const cardIdParcel = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                            const parcelData = {
                                description: params.description, type: params.type, totalValue: parseFloat(params.totalValue),
                                numberOfParcels: parseInt(params.numberOfParcels), initialDueDate: params.initialDueDate,
                                financialCategoryId: catIdParcel, creditCardId: cardIdParcel, notes: params.notes
                            };
                            const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData);
                            currentActionFormatted = `Conta parcelada "${params.description}" (${parcelResult.parcels.length}x) registrada com sucesso! A primeira parcela vence em ${new Date(parcelResult.parcels[0].dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR')}.`;
                            // Não tem botões de editar/excluir para conta parcelada por enquanto.
                            break;
                        }
                        case 'GET_FINANCIAL_SUMMARY': {
                            const filterParams = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                            };
                            if (params.period) {
                                const todayLocale = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
                                todayLocale.setHours(0,0,0,0);

                                switch(params.period) {
                                    case 'today': filterParams.dateStart = filterParams.dateEnd = todayLocale.toISOString().split('T')[0]; break;
                                    case 'yesterday': const y = new Date(todayLocale); y.setDate(y.getDate() - 1); filterParams.dateStart = filterParams.dateEnd = y.toISOString().split('T')[0]; break;
                                    case 'this_week':
                                        const day = todayLocale.getDay(); const diff = todayLocale.getDate() - day + (day === 0 ? -6 : 1); // Seg = 1, Dom = 0 (-6)
                                        const first = new Date(todayLocale.setDate(diff));
                                        const last = new Date(first); last.setDate(first.getDate() + 6);
                                        filterParams.dateStart = first.toISOString().split('T')[0]; filterParams.dateEnd = last.toISOString().split('T')[0]; break;
                                    case 'this_month':
                                        filterParams.dateStart = new Date(todayLocale.getFullYear(), todayLocale.getMonth(), 1).toISOString().split('T')[0];
                                        filterParams.dateEnd = new Date(todayLocale.getFullYear(), todayLocale.getMonth() + 1, 0).toISOString().split('T')[0]; break;
                                    // Adicionar last_week, last_month, this_year
                                }
                            }
                            const summary = await financialService.getFinancialSummary(state.activeFinancialAccountId, filterParams);
                            let periodText = params.period ? params.period.replace("_", " ") : (filterParams.dateStart && filterParams.dateEnd ? `${new Date(filterParams.dateStart+'T00:00:00Z').toLocaleDateString('pt-BR')} a ${new Date(filterParams.dateEnd+'T00:00:00Z').toLocaleDateString('pt-BR')}` : "geral");
                            currentActionFormatted = `📊 Resumo Financeiro (${periodText} para ${state.activeFinancialAccountName}):\n\n` +
                                          `🟢 Entradas: R$ ${summary.totalEntradas.toFixed(2)}\n` +
                                          `🔴 Saídas: R$ ${summary.totalSaidas.toFixed(2)}\n` +
                                          `💰 *Saldo Efetivado: R$ ${summary.saldoEfetivado.toFixed(2)}*\n\n` +
                                          `📈 A Receber (Pend.): R$ ${summary.totalAReceberPendente.toFixed(2)}\n` +
                                          `📉 A Pagar (Pend.): R$ ${summary.totalAPagarPendente.toFixed(2)}`;
                            break;
                        }
                        case 'LIST_FINANCIAL_TRANSACTIONS': {
                             const filterParamsList = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                                isPaidOrReceived: params.isPaidOrReceived, searchTerm: params.searchTerm,
                                limit: 5, page: 1
                            };
                            if (params.period) { /* ... lógica de período completa aqui ... */ }

                            const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList);
                            if (totalItems === 0) {
                                currentActionFormatted = "Nenhuma transação encontrada para os filtros que você pediu. 👍";
                            } else {
                                let listText = `📜 Encontrei ${totalItems} transações. As mais recentes são:\n`;
                                for (const t of transactions) {
                                    const catName = t.category ? t.category.name : 'Sem Categoria';
                                    const emoji = t.type === 'Entrada' ? '🟢' : '🔴';
                                    const date = new Date(t.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'});
                                    listText += `\n${emoji} ${t.description} - R$ ${parseFloat(t.value).toFixed(2)}\n    (${catName} em ${date})`;
                                    if (t.isPayableOrReceivable) {
                                        listText += t.isPaidOrReceived ? " (Liquidada)" : ` (Vence ${new Date(t.dueDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})})`;
                                    }
                                }
                                if (totalItems > 5) listText += `\n\nE mais ${totalItems - 5} transações.`;
                                currentActionFormatted = listText;
                            }
                            break;
                        }
                        case 'SCHEDULE_APPOINTMENT': {
                            let eventDateTime = params.eventDateTime;
                            // Se a IA retornar apenas a data, adicionar um horário padrão (ex: 09:00)
                            // Ou instruir a IA a sempre retornar data E hora se for um compromisso.
                            // Se a IA retornar "amanhã" para um lembrete de "pagar fatura", o título será "Pagar fatura"
                            // e a data será amanhã. O sistema pode definir um horário padrão ou a IA pode ser instruída a isso.
                            if (params.eventDateTime && params.eventDateTime.length === 10) { // YYYY-MM-DD
                                eventDateTime += ' 09:00'; // Adiciona horário padrão se não especificado
                            }
                            const appData = {
                                title: params.title, eventDateTime: eventDateTime,
                                durationMinutes: params.durationMinutes, location: params.location,
                                reminderLeadTimeMinutes: params.reminderLeadTimeMinutes
                            };
                            const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                            const reloadedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newApp.id); // Para ter todos os campos formatados
                            currentActionFormatted = formatAppointmentSummary(reloadedApp, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'appointment', id: newApp.id };
                            break;
                        }
                        case 'CREATE_RECURRING_RULE': {
                            const catRecId = params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null;
                            let ruleValue = parseFloat(params.value);
                            if ((isNaN(ruleValue) || ruleValue <= 0) && params.description && params.description.toLowerCase().includes('netflix')) {
                                ruleValue = 55.90; // Exemplo de valor padrão para Netflix
                                logger.info(`[WHATSAPP SERVICE] Valor para Netflix não fornecido, usando padrão ${ruleValue}`);
                            }
                            if (isNaN(ruleValue) || ruleValue <= 0) {
                                // Se o valor ainda for inválido, a IA deveria ter pedido clarificação ou nós pedimos aqui.
                                // Por ora, vamos deixar passar para a criação, que pode falhar ou usar 0.
                                // Idealmente, a IA é instruída a pedir o valor.
                            }
                            const ruleData = {
                                description: params.description, type: params.type, value: ruleValue || 0, // Garante um número
                                frequency: params.frequency, startDate: params.startDate,
                                interval: params.interval || 1, dayOfMonth: params.dayOfMonth, dayOfWeek: params.dayOfWeek,
                                endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction || false,
                                financialCategoryId: catRecId
                            };
                            const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                            const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);
                            currentActionFormatted = formatRecurringRuleSummary(reloadedRule, aiResponse.detected_actions.length > 1);
                            // if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'recurring_rule', id: newRule.id }; // Se tiver botões para recorrência
                            break;
                        }
                        // Outros cases (CREATE_PRODUCT, GET_STOCK_INFO, etc. devem ter seus formatadores)
                        // ...

                        default:
                            if (aiResponse.detected_actions.length === 1 && aiResponse.reply_to_user_suggestion && !aiResponse.overall_summary_suggestion) {
                                currentActionFormatted = aiResponse.reply_to_user_suggestion;
                            } else {
                                currentActionFormatted = `Ação "${detectedAction.action}" ${params.description ? `para "${params.description}"` : ''} foi entendida.`;
                            }
                            if ((detectedAction.action === "GENERAL_GREETING_OR_SMALLTALK" || detectedAction.action === "GENERAL_QUESTION_OR_HELP") && aiResponse.reply_to_user_suggestion) {
                                finalReplyParts = [aiResponse.reply_to_user_suggestion.replace("[Nome do Usuário]", state.clientName)];
                                multipleActionFormattedResults = [];
                                break; // Sai do loop de ações, pois é só uma resposta de conversa
                            }
                            break;
                    } // Fim do Switch

                    if (currentActionFormatted) {
                        if (aiResponse.detected_actions.length === 1) {
                            singleActionFormattedResult = currentActionFormatted;
                        } else {
                            multipleActionFormattedResults.push(currentActionFormatted);
                        }
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack, params: params });
                    const errorMsgPart = `Ops! Tive um problema ao tentar processar "${params.description || detectedAction.action}". (${e.message.length < 70 ? e.message : 'Erro interno'})`;
                    if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = errorMsgPart;
                    else multipleActionFormattedResults.push(errorMsgPart);
                }
            } // Fim do loop for detected_actions
        } // Fim if detected_actions

        // --- Construção da Resposta Final ---
        if (requiresConfirmationByAI && state.pendingConfirmation) {
            finalReplyParts = [aiResponse.reply_to_user_suggestion || `Hmm, entendi que você quer fazer algo como "${state.pendingConfirmation.parameters.description || state.pendingConfirmation.action}". É isso mesmo, ${state.clientName}? (Sim/Não)`];
            state.currentAction = 'awaiting_confirmation';
        } else if (singleActionFormattedResult) { // Se UMA ação foi formatada
            finalReplyParts.push(singleActionFormattedResult);
        } else if (multipleActionFormattedResults.length > 0) { // Se MÚLTIPLAS ações foram formatadas
            if (finalReplyParts.length === 0 && multipleActionFormattedResults.length > 1) {
                finalReplyParts.push(`${state.clientName}, aqui está o que eu fiz pra você: 😉`);
            }
            finalReplyParts.push(multipleActionFormattedResults.join("\n\n---\n\n"));
        } else if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            finalReplyParts = [aiResponse.reply_to_user_suggestion || "Preciso de mais alguns detalhes para continuar, " + state.clientName + ". " + aiResponse.clarifications_needed[0].clarification_question];
            state.currentAction = 'awaiting_clarification_response'; // A IA vai guiar a partir daqui
            state.data.clarificationContext = { /* informações para a IA saber o que estava tentando fazer */ };
        } else if (aiResponse.reply_to_user_suggestion) { // Se nenhuma ação, mas a IA tem uma sugestão de resposta (ex: small talk)
            if (finalReplyParts.length === 0 || (finalReplyParts.length === 1 && finalReplyParts[0] === aiResponse.overall_summary_suggestion)) {
                finalReplyParts = [aiResponse.reply_to_user_suggestion.replace("[Nome do Usuário]", state.clientName)];
            } else if (!finalReplyParts.join(" ").includes(aiResponse.reply_to_user_suggestion.replace("[Nome do Usuário]", state.clientName))) {
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion.replace("[Nome do Usuário]", state.clientName));
            }
        } else { // Fallback final se nada mais se aplicar
            finalReplyParts.push(`Entendido, ${state.clientName}! Se precisar de mais alguma coisa, é só chamar. 😊`);
        }

        // Adicionar Call to Action e Fechamento Padrão
        const performedConcreteAction = singleActionFormattedResult || multipleActionFormattedResults.length > 0;
        if (performedConcreteAction && !requiresConfirmationByAI) {
            const platformUrl = process.env.PLATFORM_URL || 'SEU_SITE_AQUI';
            if (platformUrl !== 'SEU_SITE_AQUI') {
                 finalReplyParts.push(`\n📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em ${platformUrl}`);
            }
            if (!finalReplyParts.some(p => p.toLowerCase().includes("mais alguma coisa") || p.toLowerCase().includes("só chamar"))) {
                 finalReplyParts.push("Se precisar de algo a mais é só me chamar! 😄");
            }
        }

        const completeFinalReply = finalReplyParts.join("\n\n").trim();
        state.messageHistory.push({ role: 'assistant', content: completeFinalReply });

        // Lógica de limpeza de estado
        if (!requiresConfirmationByAI &&
            state.currentAction !== 'awaiting_clarification_response' &&
            state.currentAction !== 'selecting_initial_financial_account' &&
            !state.currentAction?.startsWith('creating_first_account') &&
            !state.currentAction?.startsWith('awaiting_') // Evita limpar estados de edição
            ) {
            if (state.currentAction !== 'awaiting_confirmation') { // Não limpar se acabou de setar para confirmação
                // state.currentAction = null; // Descomentar com cautela
                // state.data = {};
            }
        }
        conversationState.set(senderPhone, state);

        // Envio de Resposta Final
        if (completeFinalReply) {
            const resourceForButtons = state.editingResource;
            if (resourceForButtons && !requiresConfirmationByAI && aiResponse.detected_actions?.length === 1) {
                let buttons = [];
                const buttonTitle = `Opções para "${(aiResponse.detected_actions[0].parameters.description || aiResponse.detected_actions[0].parameters.title || "item").substring(0,20)}":`;
                if (resourceForButtons.type === 'transaction') {
                    buttons = [
                        { id: `edit_transaction_${resourceForButtons.id}`, label: "Editar transação" },
                        { id: `delete_transaction_${resourceForButtons.id}`, label: "Excluir transação" },
                    ];
                } else if (resourceForButtons.type === 'appointment') {
                    buttons = [
                        { id: `edit_appointment_${resourceForButtons.id}`, label: "Editar compromisso" },
                        { id: `delete_appointment_${resourceForButtons.id}`, label: "Excluir compromisso" },
                    ];
                }
                // Adicionar para recorrência se tiver botões

                if (buttons.length > 0) {
                    // A `completeFinalReply` já contém o resumo da ação.
                    // A Z-API permite uma mensagem que acompanha a lista de botões.
                    await sendButtonListMessage(senderPhone, completeFinalReply, buttons, buttonTitle);
                } else {
                    await sendWhatsappMessage(senderPhone, completeFinalReply);
                }
                state.editingResource = null; // Limpa após oferecer os botões
            } else {
                await sendWhatsappMessage(senderPhone, completeFinalReply);
            }
        }

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack, messageText, rawPayload });
        const clientNameToUseInError = state ? state.clientName : (pushName || "você");
        conversationState.delete(senderPhone);
        try {
            await sendWhatsappMessage(senderPhone, `Puxa vida, ${clientNameToUseInError}! 😬 Parece que tive um curto-circuito aqui e não consegui processar sua mensagem. Minha equipe de engenheiros já está de olho nisso! 👩‍💻👨‍💻 Por favor, tente de novo em um momentinho. Desculpe o transtorno!`);
        } catch (sendError) {
            logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro crítico para ${senderPhone}: ${sendError.message}`);
        }
    } finally {
        const endTime = Date.now();
        logger.info(`[WHATSAPP HANDLER] Processamento para ${senderPhone} finalizado em ${endTime - startTime}ms.`);
        if (state) conversationState.set(senderPhone, state); // Garante que o estado final seja salvo
    }
}

module.exports = { processIncomingMessage };
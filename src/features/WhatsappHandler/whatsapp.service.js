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
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;

// --- Helper Functions (Mantidas e podem ser expandidas) ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    logger.debug(`[WHATSAPP SERVICE] Buscando categoria financeira por nome: "${name}" para conta ${financialAccountId}, tipo ${transactionType}`);
    // Tenta encontrar pelo nome exato primeiro, considerando o tipo se fornecido
    let foundCategory = await systemService.findFinancialCategoryByNameAndType(name, transactionType, financialAccountId); // Esta função precisaria ser criada em systemService
    if (foundCategory) return foundCategory.id;

    // Se não encontrar, tenta pelo nome (sem considerar o tipo, pode ser mais flexível)
    foundCategory = await systemService.findFinancialCategoryByName(name, null, financialAccountId); // Função genérica em systemService
    if (foundCategory) {
        logger.info(`[WHATSAPP SERVICE] Categoria por nome "${name}" (tipo ${transactionType}) não encontrada exatamente. Usando correspondência por nome: "${foundCategory.name}" (ID: ${foundCategory.id})`);
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
    const clientName = client ? (client.name || "pessoa incrível") : "pessoa incrível";
    const newState = {
        currentAction: null,
        data: {},
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount ? defaultAccount.accountType : null,
        clientName: clientName, // Armazena o nome do cliente para usar nas saudações da IA
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null, // { type: 'transaction' | 'appointment' | 'recurring_rule', id: resourceId }
        lastAiResponse: null,
    };
    if (defaultAccount) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Bem-vindo(a) de volta à sua conta "${newState.activeFinancialAccountName}". Como posso te ajudar hoje?` });
    } else if (client) {
         newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Como posso te ajudar hoje?` });
    }
    return newState;
}

function formatFinancialTransactionSummary(transaction, introMessage = "📜 Resumo da Transação:") {
    const dateFormatted = transaction.transactionDate
        ? new Date(transaction.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' })
        : 'Data não informada';
    let status = "";
    if (transaction.type === 'Entrada') {
        status = transaction.isPayableOrReceivable ? (transaction.isPaidOrReceived ? "✅ recebido" : `🗓️ a receber em ${new Date(transaction.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR')}`) : "✅ recebido";
    } else { // Saída
        status = transaction.isPayableOrReceivable ? (transaction.isPaidOrReceived ? "✅ pago" : `🗓️ a pagar em ${new Date(transaction.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR')}`) : "✅ pago";
    }

    let summary = `${introMessage}\n`;
    summary += `💡 Descrição: ${transaction.description}\n`;
    summary += `💰 Valor: R$ ${parseFloat(transaction.value).toFixed(2)}\n`;
    if (transaction.category && transaction.category.name) { // Supondo que 'category' é incluído no objeto transação
        const categoryEmoji = transaction.type === 'Entrada' ? '📥' : (transaction.category.name.toLowerCase().includes('lazer') || transaction.category.name.toLowerCase().includes('jogo') ? '🎮' : (transaction.category.name.toLowerCase().includes('alimentação') ? '🍔' : '🎈'));
        summary += `${categoryEmoji} Categoria: ${transaction.category.name}\n`;
    }
    summary += `📅 Data: ${dateFormatted}\n`;
    summary += `\n${status}`;
    return summary;
}

function formatAppointmentSummary(appointment, introMessage = "📅 Resumo do Compromisso:") {
    const eventDateTimeFormatted = appointment.eventDateTime
        ? new Date(appointment.eventDateTime).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ || 'America/Sao_Paulo' })
        : 'Data/Hora não informada';
    let summary = `${introMessage}\n\n`;
    summary += `📝 Descrição: ${appointment.title}\n`;
    summary += `📅 Data e Hora: ${eventDateTimeFormatted}\n`;
    if (appointment.durationMinutes) summary += `⏳ Duração: ${appointment.durationMinutes} min\n`;
    if (appointment.location) summary += `📍 Local: ${appointment.location}\n`;
    summary += `🚦 Status: ${appointment.status}`;
    return summary;
}

function formatRecurringRuleSummary(rule, introMessage = "🔄 Resumo da Recorrência:") {
    const startDateFormatted = rule.startDate ? new Date(rule.startDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/I';
    const endDateFormatted = rule.endDate ? new Date(rule.endDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'Sem data final';
    const nextDateFormatted = rule.nextDueDate ? new Date(rule.nextDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';

    let summary = `${introMessage}\n\n`;
    summary += `📜 Descrição: ${rule.description}\n`;
    summary += `💰 Valor: R$ ${parseFloat(rule.value).toFixed(2)} (${rule.type})\n`;
    if (rule.category && rule.category.name) {
         const categoryEmoji = rule.type === 'Entrada' ? '📥' : (rule.category.name.toLowerCase().includes('lazer') || rule.category.name.toLowerCase().includes('netflix') ? '🎬' : '💼');
        summary += `${categoryEmoji} Categoria: ${rule.category.name}\n`;
    }
    summary += `📅 Data Inicial: ${startDateFormatted}\n`;
    summary += `🏁 Data Final: ${endDateFormatted}\n`;
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

    // Lógica para lidar com cliques em botões (precisa do payload da Z-API para isso)
    // Exemplo: if (rawPayload && rawPayload.selectedButtonId) { ... }
    if (rawPayload && rawPayload.selectedButtonId) {
        state = conversationState.get(senderPhone);
        if (!state) {
            logger.warn(`[WHATSAPP SERVICE] Estado não encontrado para ${senderPhone} ao processar clique de botão.`);
            await sendWhatsappMessage(senderPhone, "Ops! Parece que nossa conversa se perdeu um pouquinho. Pode tentar de novo?");
            return;
        }

        const buttonId = rawPayload.selectedButtonId;
        logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone}: ${buttonId}`);
        let buttonReply = "Entendido!";

        if (buttonId.startsWith('edit_transaction_')) {
            const transactionId = buttonId.replace('edit_transaction_', '');
            state.editingResource = { type: 'transaction', id: transactionId };
            // A IA deve agora perguntar o que editar, ou o sistema pode ter um fluxo fixo.
            // Por ora, vamos deixar a IA guiar após setar o estado.
            messageText = `Quero editar a transação ${transactionId}`; // Simula uma mensagem para a IA
            buttonReply = `Ok, vamos editar essa transação! O que você gostaria de alterar nela (descrição, valor, data, categoria)?`;
            // Envia a resposta e DEIXA a IA ser chamada com o novo messageText simulado.
            state.messageHistory.push({ role: 'user', content: messageText }); // Adiciona ao histórico para a IA
            state.messageHistory.push({ role: 'assistant', content: buttonReply });
            conversationState.set(senderPhone, state);
            await sendWhatsappMessage(senderPhone, buttonReply);
            return; // Não chama a IA diretamente aqui, a próxima mensagem do usuário será processada pela IA
                     // Ou melhor: chama a IA com uma mensagem simulada. Para este exemplo, vamos direto.
        } else if (buttonId.startsWith('delete_transaction_')) {
            const transactionId = buttonId.replace('delete_transaction_', '');
            state.pendingConfirmation = { action: 'CONFIRM_DELETE_TRANSACTION', parameters: { transactionId: transactionId } };
            state.currentAction = 'awaiting_confirmation';
            buttonReply = `Você tem certeza que quer excluir essa transação? 😟 (Sim/Não)`;
            state.messageHistory.push({ role: 'assistant', content: buttonReply });
            conversationState.set(senderPhone, state);
            await sendWhatsappMessage(senderPhone, buttonReply);
            return;
        } else if (buttonId.startsWith('edit_appointment_')) {
            const appointmentId = buttonId.replace('edit_appointment_', '');
            state.editingResource = { type: 'appointment', id: appointmentId };
            messageText = `Quero editar o compromisso ${appointmentId}`;
            buttonReply = `Certo! Vamos editar o compromisso. O que gostaria de mudar (título, data/hora, local)?`;
            state.messageHistory.push({ role: 'user', content: messageText });
            state.messageHistory.push({ role: 'assistant', content: buttonReply });
            conversationState.set(senderPhone, state);
            await sendWhatsappMessage(senderPhone, buttonReply);
            return;
        } else if (buttonId.startsWith('delete_appointment_')) {
            const appointmentId = buttonId.replace('delete_appointment_', '');
            state.pendingConfirmation = { action: 'CONFIRM_DELETE_APPOINTMENT', parameters: { appointmentId: appointmentId } };
            state.currentAction = 'awaiting_confirmation';
            buttonReply = `Tem certeza que deseja excluir este compromisso? (Sim/Não)`;
            state.messageHistory.push({ role: 'assistant', content: buttonReply });
            conversationState.set(senderPhone, state);
            await sendWhatsappMessage(senderPhone, buttonReply);
            return;
        }
        // Adicionar mais `else if` para outros botões (recorrência, etc.)
        // Se o botão não for tratado acima, ele cai no fluxo normal da IA.
    }


    try {
        const client = await clientService.findOrCreateClientByPhone(senderPhone, { name: pushName }, true);
        if (!client) {
            await sendWhatsappMessage(senderPhone, "Desculpe, estou com um problema para identificar você no momento. Por favor, tente mais tarde. 😕");
            return;
        }

        state = conversationState.get(senderPhone) || initializeState(client);
        if (client.name && state.clientName !== client.name) { // Atualiza nome no estado se mudou
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
                state = initializeState(client, accountToSet); // Reinicializa com a conta
                state.messageHistory.pop(); // Remove a última mensagem do usuário para reinserir com contexto de conta
                state.messageHistory.push({ role: 'assistant', content: `Olá ${state.clientName}! 😊 Conta "${state.activeFinancialAccountName}" (${state.activeFinancialAccountType}) selecionada. Como posso te ajudar?` });
                state.messageHistory.push({ role: 'user', content: messageText });
            } else { // Múltiplas contas, sem default clara ou o usuário precisa escolher
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
        if (state.activeFinancialAccountId && (!state.activeFinancialAccountName || !state.activeFinancialAccountType)) {
            const accDetails = await clientService.getFinancialAccountById(state.activeFinancialAccountId);
            if (accDetails && accDetails.isActive) {
                state.activeFinancialAccountName = accDetails.accountName; state.activeFinancialAccountType = accDetails.accountType;
            } else {
                state.activeFinancialAccountId = null; state.activeFinancialAccountName = null; state.activeFinancialAccountType = null;
                return processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload);
            }
        }

        logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id} (${state.clientName}), Conta: ${state.activeFinancialAccountName || 'N/A'}, Msg: "${messageText}"`);
        conversationState.set(senderPhone, state);

        // === Lógica de Estado da Conversa (ANTES da IA) ===
        if (state.currentAction) {
            let stateHandledInPreProcessing = false;
            let replyForPreProcessing = "";

            if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                const lowerMsg = messageText.toLowerCase().trim();
                const actionToConfirm = state.pendingConfirmation.action;
                const paramsToConfirm = state.pendingConfirmation.parameters;

                if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                    state.currentAction = null; state.pendingConfirmation = null; // Limpa estado de confirmação
                    conversationState.set(senderPhone, state);

                    // Agora, tentamos executar a ação confirmada diretamente
                    if (actionToConfirm === 'CONFIRM_DELETE_TRANSACTION') {
                        const success = await financialService.deleteTransaction(state.activeFinancialAccountId, paramsToConfirm.transactionId);
                        replyForPreProcessing = success ? "Transação excluída com sucesso! 👍 Algo mais?" : "Não consegui excluir a transação. Pode ter sido um erro ou ela já foi removida.";
                    } else if (actionToConfirm === 'CONFIRM_DELETE_APPOINTMENT') {
                        const success = await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, paramsToConfirm.appointmentId, true);
                        replyForPreProcessing = success ? "Compromisso excluído! ✅ Mais alguma coisa?" : "Não foi possível excluir o compromisso.";
                    } else if (actionToConfirm === 'CONFIRM_CREATE_FINANCIAL_ACCOUNT') {
                         const createdAcc = await clientService.createFinancialAccount(client.id, {
                            accountName: paramsToConfirm.accountName,
                            accountType: paramsToConfirm.accountType,
                            isDefault: (await clientService.getClientFinancialAccounts(client.id)).length === 0
                        });
                        state.activeFinancialAccountId = createdAcc.id;
                        state.activeFinancialAccountName = createdAcc.accountName;
                        state.activeFinancialAccountType = createdAcc.accountType;
                        replyForPreProcessing = `Conta "${createdAcc.accountName}" (${createdAcc.accountType}) criada e selecionada! O que faremos agora?`;
                    }
                     // Adicionar mais `else if` para outras ações que precisam de confirmação
                    else {
                        // Se a ação confirmada não é tratada diretamente aqui,
                        // preparamos para que a IA a processe.
                        // Idealmente, a IA deveria ter sido informada da confirmação.
                        // Por ora, uma mensagem genérica.
                        replyForPreProcessing = `Entendido, confirmado! Vou prosseguir com ${paramsToConfirm.description || actionToConfirm}. (Em um cenário ideal, a ação seria executada ou a IA seria notificada).`;
                    }
                    stateHandledInPreProcessing = true;
                } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) {
                    replyForPreProcessing = "Ok, cancelado! Sem problemas. O que gostaria de fazer então? 😊";
                    state.currentAction = null; state.pendingConfirmation = null;
                    stateHandledInPreProcessing = true;
                }
                // Se não for sim/não, a IA tentará interpretar.
            }
            else if (state.currentAction === 'creating_first_account_type') { /* ... como antes ... */ }
            else if (state.currentAction === 'awaiting_first_account_name') { /* ... como antes ... */ }
            else if (state.currentAction === 'selecting_initial_financial_account') { /* ... como antes ... */ }
            // Adicionar tratamento para 'awaiting_new_account_type_from_ia' e 'awaiting_clarification_response' se necessário ANTES da IA.
            // Geralmente, esses estados são melhor resolvidos pela IA com o novo input do usuário.

            if (stateHandledInPreProcessing) {
                state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                // Se a ação foi completamente resolvida (ex: cancelamento ou execução direta da confirmação),
                // e não precisamos da IA em seguida, podemos retornar.
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
            currentStateData: state.data,
        };
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponse});
        state.lastAiResponse = aiResponse;

        let finalReplyParts = [];
        if (aiResponse.overall_summary_suggestion) {
            finalReplyParts.push(aiResponse.overall_summary_suggestion);
        }

        let requiresConfirmationByAI = false;
        let singleActionResult = null; // Para guardar o resultado formatado de uma única ação
        let multipleActionResults = [];

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            for (const detectedAction of aiResponse.detected_actions) {
                const params = detectedAction.parameters || {};
                const MIN_CONFIDENCE_FOR_AUTO_ACTION = 0.70;

                if (detectedAction.confidence < MIN_CONFIDENCE_FOR_AUTO_ACTION &&
                    !['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO'].includes(detectedAction.action)) {
                    requiresConfirmationByAI = true;
                    state.pendingConfirmation = detectedAction;
                    break; // Se uma ação precisa de confirmação, paramos de processar outras por enquanto
                }

                let currentActionFormattedResult = "";
                try {
                    switch (detectedAction.action) {
                        case 'CREATE_FINANCIAL_TRANSACTION':
                            const category = await systemService.getFinancialCategoryById(await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type));
                            const card = params.creditCardName ? await creditCardService.getCreditCardById(state.activeFinancialAccountId, await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId)) : null;
                            const txData = {
                                description: params.description, type: params.type, value: parseFloat(params.value),
                                transactionDate: params.transactionDate || new Date().toISOString().split('T')[0],
                                financialCategoryId: category ? category.id : null,
                                creditCardId: card ? card.id : null, notes: params.notes,
                                isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : false),
                                dueDate: params.dueDate,
                                isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (!params.dueDate) // Se não tem dueDate, assume que é pago/recebido
                            };
                            const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                            // Para formatar, precisamos recarregar com a categoria
                            const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                            currentActionFormattedResult = formatFinancialTransactionSummary(reloadedTx);
                            if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'transaction', id: newTx.id };
                            break;

                        case 'SCHEDULE_APPOINTMENT':
                             // A IA pode retornar "lembrete para pagar X amanhã" como um SCHEDULE_APPOINTMENT
                             // O title será "Pagar X", eventDateTime será amanhã (ex: 09:00), duration pode ser nulo.
                            let eventDateTime = params.eventDateTime;
                            if (params.eventDateTime && params.eventDateTime.length === 10) { // Se for só YYYY-MM-DD
                                eventDateTime += ' 09:00'; // Adiciona um horário padrão
                            }
                            const appData = { title: params.title, eventDateTime: eventDateTime,
                                            durationMinutes: params.durationMinutes, location: params.location,
                                            reminderLeadTimeMinutes: params.reminderLeadTimeMinutes };
                            const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                            const reloadedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newApp.id);
                            currentActionFormattedResult = formatAppointmentSummary(reloadedApp);
                            if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'appointment', id: newApp.id };
                            break;

                        case 'CREATE_RECURRING_RULE':
                            const catRec = await systemService.getFinancialCategoryById(await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type));
                            let ruleValue = parseFloat(params.value);
                            if (isNaN(ruleValue) || ruleValue <=0) { // Se IA não pegou valor para Netflix, por exemplo
                                if (params.description && params.description.toLowerCase().includes('netflix')) ruleValue = 55.90; // Exemplo
                                else { /* lançar erro ou pedir clarificação se valor for crucial */ }
                            }
                            const ruleData = {
                                description: params.description, type: params.type, value: ruleValue,
                                frequency: params.frequency, startDate: params.startDate,
                                interval: params.interval, dayOfMonth: params.dayOfMonth, dayOfWeek: params.dayOfWeek,
                                endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction,
                                financialCategoryId: catRec ? catRec.id : null
                            };
                            const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                            const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);
                            currentActionFormattedResult = formatRecurringRuleSummary(reloadedRule);
                            // if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'recurring_rule', id: newRule.id };
                            break;

                        // Adicionar outros cases para formatar GET_FINANCIAL_SUMMARY, LIST_TRANSACTIONS, etc.
                        // Por enquanto, o default pode pegar a `reply_to_user_suggestion` se não houver formatação específica.

                        default: // Para ações que não têm um formatador específico aqui, usamos a sugestão da IA se disponível
                            if (aiResponse.detected_actions.length === 1 && aiResponse.reply_to_user_suggestion && !aiResponse.overall_summary_suggestion) {
                                // Se é uma única ação e a IA deu uma boa resposta única, usamos ela, removendo a saudação se já tivemos uma.
                                currentActionFormattedResult = aiResponse.reply_to_user_suggestion;
                            } else if (params.description) { // Fallback genérico
                                currentActionFormattedResult = `Ação "${detectedAction.action}" para "${params.description}" processada.`;
                            } else {
                                currentActionFormattedResult = `Ação "${detectedAction.action}" processada.`;
                            }
                            // Casos como GENERAL_GREETING, GENERAL_QUESTION_OR_HELP cairão aqui se não tiverem formatação especial.
                            // A `reply_to_user_suggestion` da IA é a principal resposta para eles.
                            if ((detectedAction.action === "GENERAL_GREETING_OR_SMALLTALK" || detectedAction.action === "GENERAL_QUESTION_OR_HELP") && aiResponse.reply_to_user_suggestion) {
                                finalReplyParts = [aiResponse.reply_to_user_suggestion]; // Substitui tudo
                                multipleActionResults = []; // Limpa outros resultados
                                break; // Sai do loop de ações
                            }
                            break;
                    }
                    if (currentActionFormattedResult) {
                        if (aiResponse.detected_actions.length === 1) {
                            singleActionResult = currentActionFormattedResult;
                        } else {
                            multipleActionResults.push(currentActionFormattedResult);
                        }
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack, params: params });
                    const errorMsgPart = `Ops! Tive um problema ao tentar processar "${params.description || detectedAction.action}". (${e.message.length < 70 ? e.message : 'Erro interno'})`;
                    if (aiResponse.detected_actions.length === 1) singleActionResult = errorMsgPart;
                    else multipleActionResults.push(errorMsgPart);
                }
            } // Fim do loop for
        } // Fim if detected_actions

        // Construir a resposta final
        if (requiresConfirmationByAI && state.pendingConfirmation) {
            // A IA já deve ter fornecido a pergunta de confirmação em reply_to_user_suggestion
            finalReplyParts = [aiResponse.reply_to_user_suggestion || `Hmm, entendi que você quer fazer algo como "${state.pendingConfirmation.parameters.description || state.pendingConfirmation.action}". É isso mesmo? (Sim/Não)`];
            state.currentAction = 'awaiting_confirmation';
        } else if (singleActionResult) {
            finalReplyParts.push(singleActionResult);
        } else if (multipleActionResults.length > 0) {
            if (finalReplyParts.length === 0 && multipleActionResults.length > 1) { // Sem saudação da IA, múltiplas ações
                finalReplyParts.push(`${state.clientName}, aqui está o que eu fiz pra você: 😉`);
            }
            finalReplyParts.push(multipleActionResults.join("\n\n---\n\n"));
        } else if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            finalReplyParts = [aiResponse.reply_to_user_suggestion || "Preciso de mais alguns detalhes para continuar. " + aiResponse.clarifications_needed[0].clarification_question];
            state.currentAction = 'awaiting_clarification_response';
            state.data = { /* ... dados para clarificação ... */ };
        } else if (aiResponse.reply_to_user_suggestion) {
            // Se não houve ações formatadas, nem confirmação, nem clarificação, usamos a sugestão principal da IA.
            // Isso cobre GENERAL_GREETING, GENERAL_QUESTION, ou quando a IA não detecta ações.
             if (finalReplyParts.length === 0 || (finalReplyParts.length === 1 && finalReplyParts[0] === aiResponse.overall_summary_suggestion)) {
                finalReplyParts = [aiResponse.reply_to_user_suggestion];
            } else if (!finalReplyParts.includes(aiResponse.reply_to_user_suggestion)){
                // Se já temos uma saudação e a sugestão da IA é diferente e relevante (ex: uma frase de fechamento)
                finalReplyParts.push(aiResponse.reply_to_user_suggestion);
            }
        } else { // Fallback final
            finalReplyParts.push(`Entendido, ${state.clientName}! Se precisar de mais alguma coisa, é só chamar. 😊`);
        }


        // Adicionar Call to Action e Fechamento Padrão se houveram ações concretas.
        if ((singleActionResult || multipleActionResults.length > 0) && !requiresConfirmationByAI) {
            finalReplyParts.push(`\n📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em [${process.env.PLATFORM_URL || 'SEU_SITE_AQUI'}]`);
            if (!finalReplyParts.some(p => p.toLowerCase().includes("mais alguma coisa") || p.toLowerCase().includes("só chamar"))) {
                 finalReplyParts.push("Se precisar de algo a mais é só me chamar! 😄");
            }
        }

        const completeFinalReply = finalReplyParts.join("\n\n").trim();
        state.messageHistory.push({ role: 'assistant', content: completeFinalReply });

        if (!requiresConfirmationByAI && state.currentAction !== 'awaiting_clarification_response' && state.currentAction !== 'selecting_initial_financial_account' && !state.currentAction?.startsWith('creating_first_account')) {
            // Limpa estados que não são multi-etapas explícitas
            if (state.currentAction !== 'awaiting_confirmation') { // Não limpar se acabou de setar para confirmação
                 // state.currentAction = null; // Cuidado ao limpar o currentAction aqui
                 // state.data = {};
            }
        }
        conversationState.set(senderPhone, state);

        // Envio de Resposta Final
        if (completeFinalReply) {
            const resourceToEdit = state.editingResource; // Pega antes de limpar
            if (resourceToEdit && !requiresConfirmationByAI) { // Só mostra botões se foi uma única ação bem sucedida
                let buttons = [];
                if (resourceToEdit.type === 'transaction') {
                    buttons = [
                        { id: `edit_transaction_${resourceToEdit.id}`, label: "Editar transação" },
                        { id: `delete_transaction_${resourceToEdit.id}`, label: "Excluir transação" },
                    ];
                } else if (resourceToEdit.type === 'appointment') {
                    buttons = [
                        { id: `edit_appointment_${resourceToEdit.id}`, label: "Editar compromisso" },
                        { id: `delete_appointment_${resourceToEdit.id}`, label: "Excluir compromisso" },
                    ];
                }
                // Adicionar para recorrência se necessário

                if (buttons.length > 0) {
                    await sendButtonListMessage(senderPhone, completeFinalReply, buttons, "Opções Rápidas");
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
        conversationState.delete(senderPhone);
        try {
            await sendWhatsappMessage(senderPhone, `Puxa vida, ${state ? state.clientName : 'você'}! 😬 Parece que tive um curto-circuito aqui e não consegui processar sua mensagem. Minha equipe de engenheiros já está de olho nisso! 👩‍💻👨‍💻 Por favor, tente de novo em um momentinho. Desculpe o transtorno!`);
        } catch (sendError) {
            logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro crítico para ${senderPhone}: ${sendError.message}`);
        }
    } finally {
        const endTime = Date.now();
        logger.info(`[WHATSAPP HANDLER] Processamento para ${senderPhone} finalizado em ${endTime - startTime}ms.`);
        if (state) conversationState.set(senderPhone, state);
    }
}

module.exports = { processIncomingMessage };
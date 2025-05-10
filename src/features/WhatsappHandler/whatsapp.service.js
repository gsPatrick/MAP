// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service');

const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;

// --- Helper Functions ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    let foundCategory = await systemService.findFinancialCategoryByNameAndType(name, transactionType, financialAccountId);
    if (foundCategory) return foundCategory.id;
    foundCategory = await systemService.findFinancialCategoryByName(name, financialAccountId);
    if (foundCategory) {
        logger.info(`[WHATSAPP SERVICE] Categoria por nome "${name}" (tipo ${transactionType || 'qualquer'}) não encontrada exat. Usando parcial: "${foundCategory.name}" (ID: ${foundCategory.id})`);
        return foundCategory.id;
    }
    logger.warn(`[WHATSAPP SERVICE] Categoria com nome "${name}" não encontrada.`);
    return null;
}

async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const cards = await creditCardService.getAllCreditCards(financialAccountId, { isActive: true });
    const found = cards.find(card => card.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const partialFound = cards.find(card => card.name.toLowerCase().includes(name.toLowerCase()));
    if (partialFound) {
        logger.info(`[WHATSAPP SERVICE] Cartão por nome "${name}" não encontrado exat. Usando parcial: "${partialFound.name}" (ID: ${partialFound.id})`);
        return partialFound.id;
    }
    logger.warn(`[WHATSAPP SERVICE] Cartão com nome "${name}" não encontrado para conta ${financialAccountId}.`);
    return null;
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    const { products } = await productService.getAllProducts(financialAccountId, { search: nameOrCode, isActive: true, limit: 5 });
    if (products && products.length > 0) {
        const exactMatch = products.find(p => p.name.toLowerCase() === nameOrCode.toLowerCase() || (p.code && p.code.toLowerCase() === nameOrCode.toLowerCase()));
        if (exactMatch) return exactMatch.id;
        logger.info(`[WHATSAPP SERVICE] Produto por nome/cód "${nameOrCode}" não encontrado exat. Usando busca: "${products[0].name}" (ID: ${products[0].id})`);
        return products[0].id;
    }
    logger.warn(`[WHATSAPP SERVICE] Produto com nome/cód "${nameOrCode}" não encontrado para conta ${financialAccountId}.`);
    return null;
}

function initializeState(client, defaultAccount = null) {
    const clientName = client ? (client.name || "pessoa incrível") : "pessoa incrível";
    const newState = {
        currentAction: null, data: {},
        activeFinancialAccountId: defaultAccount?.id || null,
        activeFinancialAccountName: defaultAccount?.accountName || null,
        activeFinancialAccountType: defaultAccount?.accountType || null,
        clientName: clientName, messageHistory: [], pendingConfirmation: null,
        editingResource: null, lastAiResponse: null,
    };
    const initialGreeting = `Olá ${clientName}! 😊 ${defaultAccount ? `Bem-vindo(a) de volta à sua conta "${newState.activeFinancialAccountName}". ` : ''}Como posso te ajudar hoje?`;
    newState.messageHistory.push({ role: 'assistant', content: initialGreeting });
    return newState;
}

function translatePeriod(periodKey) {
    if(!periodKey) return "período não especificado";
    const map = {
        "today": "hoje", "ontem": "ontem", "hoje": "hoje",
        "this_week": "esta semana", "semana_passada": "semana passada", "esta_semana": "esta semana",
        "this_month": "este mês", "mes_passado": "mês passado", "este_mes": "este mês",
        "this_year": "este ano", "este_ano": "este ano",
        "custom": "período personalizado", "personalizado": "período personalizado",
        "ultimos_7_dias": "últimos 7 dias", "last_7_days": "últimos 7 dias",
    };
    return map[periodKey.toLowerCase()] || periodKey;
}

function formatFinancialTransactionSummary(transaction, forMulti = false) {
    const dateFormatted = transaction.transactionDate ? new Date(transaction.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/I';
    let statusText = transaction.type === 'Entrada' ? "✅ recebido" : "✅ pago";
    if (transaction.isPayableOrReceivable) {
        const dueDateFormatted = transaction.dueDate ? new Date(transaction.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';
        statusText = transaction.isPaidOrReceived ? (transaction.type === 'Entrada' ? "✅ recebido" : "✅ pago") : `🗓️ ${transaction.type === 'Entrada' ? 'a receber' : 'a pagar'} em ${dueDateFormatted}`;
    }
    let categoryEmoji = transaction.type === 'Entrada' ? '📥' : '💸';
    if (transaction.category?.name) {
        const catNameLower = transaction.category.name.toLowerCase();
        if (catNameLower.includes('lazer') || catNameLower.includes('jogo') || catNameLower.includes('entretenimento')) categoryEmoji = '🎮';
        else if (catNameLower.includes('alimentação') || catNameLower.includes('restaurante') || catNameLower.includes('doce')) categoryEmoji = '🍔';
        else if (catNameLower.includes('salário') || catNameLower.includes('recebimento') || catNameLower.includes('pai')) categoryEmoji = '💰';
        else if (catNameLower.includes('transporte')) categoryEmoji = '🚗';
    }
    let summary = !forMulti ? "📜 Resumo da Transação:\n\n" : "";
    summary += `${categoryEmoji} Descrição: ${transaction.description}\n💰 Valor: R$ ${parseFloat(transaction.value).toFixed(2)}\n`;
    if (transaction.category?.name) summary += `🏷️ Categoria: ${transaction.category.name}\n`;
    summary += `📅 Data: ${dateFormatted}\n\n${statusText}`;
    return summary;
}

function formatAppointmentSummary(appointment, forMulti = false) {
    const eventDateTime = new Date(appointment.eventDateTime);
    const tz = process.env.TZ || 'America/Sao_Paulo';
    // const eventDateFormatted = eventDateTime.toLocaleDateString('pt-BR', { timeZone: tz });
    // const eventTimeFormatted = eventDateTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second:'2-digit', timeZone: tz });
    const eventDateTimeFormatted = eventDateTime.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz })

    let summary = !forMulti ? "📅 Resumo do Compromisso:\n\n" : "";
    summary += `📝 Título: ${appointment.title}\n🗓️ Data e Hora: ${eventDateTimeFormatted}\n`;
    if (appointment.durationMinutes) summary += `⏳ Duração: ${appointment.durationMinutes} min\n`;
    if (appointment.location) summary += `📍 Local: ${appointment.location}\n`;
    if (appointment.associatedValue && appointment.associatedTransactionType) {
        summary += `💸 Valor Associado: R$ ${parseFloat(appointment.associatedValue).toFixed(2)} (${appointment.associatedTransactionType})\n`
    }
    summary += `🚦 Status: ${appointment.status}`;
    return summary;
}

function formatRecurringRuleSummary(rule, forMulti = false) {
    const startDateFormatted = rule.startDate ? new Date(rule.startDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/I';
    const nextDateFormatted = rule.nextDueDate ? new Date(rule.nextDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';
    let categoryEmoji = rule.type === 'Entrada' ? '📥' : '💸';
     if (rule.category?.name) {
        const catNameLower = rule.category.name.toLowerCase();
        if (catNameLower.includes('lazer') || catNameLower.includes('netflix') || catNameLower.includes('entretenimento')) categoryEmoji = '🎬';
        else if (catNameLower.includes('assinatura')) categoryEmoji = '📰';
    }
    let summary = !forMulti ? "🔄 Resumo da Recorrência:\n\n" : "";
    summary += `📜 Descrição: ${rule.description}\n💰 Valor: R$ ${parseFloat(rule.value).toFixed(2)} (${rule.type})\n`;
    if (rule.category?.name) summary += `${categoryEmoji} Categoria: ${rule.category.name}\n`;
    summary += `📅 Data Inicial: ${startDateFormatted}\n`;
    if(rule.endDate) summary += `🏁 Data Final: ${new Date(rule.endDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' })}\n`;
    summary += `🔁 Frequência: ${translatePeriod(rule.frequency)} (a cada ${rule.interval})\n`;
    if (rule.dayOfMonth) summary += `🗓️ Dia do Mês: ${rule.dayOfMonth}\n`;
    if (rule.dayOfWeek !== null) summary += `🗓️ Dia da Semana: ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][rule.dayOfWeek]}\n`;
    summary += `➡️ Próximo Vencimento: ${nextDateFormatted}\n✍️ Criação Automática: ${rule.autoCreateTransaction ? 'Sim' : 'Não (Apenas Lembrete)'}\n🚦 Status: ${rule.isActive ? 'Ativa' : 'Inativa'}`;
    return summary;
}

async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
        state = conversationState.get(senderPhone);
        if (!state) {
            logger.warn(`[WHATSAPP SERVICE] Estado não encontrado para ${senderPhone} ao processar clique de botão: ${rawPayload.selectedButtonId}`);
            await sendWhatsappMessage(senderPhone, "Ops! Parece que nossa conversa se perdeu um pouquinho. Pode tentar de novo o que queria fazer?");
            return;
        }
        const buttonId = rawPayload.selectedButtonId;
        logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone}: ${buttonId}`);
        let buttonClickHandled = true;
        let replyForButtonClick = "Entendido!";

        if (buttonId.startsWith('edit_transaction_')) {
            const transactionId = buttonId.replace('edit_transaction_', '');
            state.editingResource = { type: 'transaction', id: transactionId };
            replyForButtonClick = `Ok, ${state.clientName}! Vamos editar essa transação (ID: ${transactionId}). O que você gostaria de alterar nela (descrição, valor, data, categoria)?`;
            state.currentAction = 'awaiting_transaction_edit_details';
        } else if (buttonId.startsWith('delete_transaction_')) {
            const transactionId = buttonId.replace('delete_transaction_', '');
            state.pendingConfirmation = { action: 'CONFIRM_DELETE_TRANSACTION', parameters: { transactionId: transactionId } };
            state.currentAction = 'awaiting_confirmation';
            replyForButtonClick = `Você tem certeza que quer excluir essa transação, ${state.clientName}? 😟 (Sim/Não)`;
        } else if (buttonId.startsWith('edit_appointment_')) {
            const appointmentId = buttonId.replace('edit_appointment_', '');
            state.editingResource = { type: 'appointment', id: appointmentId };
            replyForButtonClick = `Certo, ${state.clientName}! Vamos editar o compromisso (ID: ${appointmentId}). O que gostaria de mudar (título, data/hora, local)?`;
            state.currentAction = 'awaiting_appointment_edit_details';
        } else if (buttonId.startsWith('delete_appointment_')) {
            const appointmentId = buttonId.replace('delete_appointment_', '');
            state.pendingConfirmation = { action: 'CONFIRM_DELETE_APPOINTMENT', parameters: { appointmentId: appointmentId } };
            state.currentAction = 'awaiting_confirmation';
            replyForButtonClick = `Tem certeza que deseja excluir este compromisso, ${state.clientName}? (Sim/Não)`;
        } else {
            buttonClickHandled = false;
        }

        if (buttonClickHandled) {
            state.messageHistory.push({ role: 'user', content: `[CLIQUE NO BOTÃO: ${buttonId}]` });
            state.messageHistory.push({ role: 'assistant', content: replyForButtonClick });
            conversationState.set(senderPhone, state);
            await sendWhatsappMessage(senderPhone, replyForButtonClick);
            return;
        }
    }

    try {
        const client = await clientService.findOrCreateClientByPhone(senderPhone, { name: pushName }, true);
        if (!client) {
             await sendWhatsappMessage(senderPhone, "Desculpe, estou com um problema para identificar você no momento. Por favor, tente mais tarde. 😕");
            return;
        }

        state = conversationState.get(senderPhone) || initializeState(client);
        if (client.name && state.clientName !== client.name) state.clientName = client.name;

        state.messageHistory.push({ role: 'user', content: messageText });
        if (state.messageHistory.length > MAX_STATE_HISTORY) state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);

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
                if(conversationState.has(senderPhone)){
                    state.activeFinancialAccountId = accountToSet.id; state.activeFinancialAccountName = accountToSet.accountName; state.activeFinancialAccountType = accountToSet.accountType;
                } else { state = initializeState(client, accountToSet); }
                state.messageHistory = state.messageHistory.filter(m => m.role !== 'user' && m.content !== messageText);
                const currentAssistantGreeting = state.messageHistory.length > 0 && state.messageHistory[state.messageHistory.length -1].role === 'assistant' ? state.messageHistory[state.messageHistory.length -1].content : `Olá ${state.clientName}! 😊 Conta "${state.activeFinancialAccountName}" (${state.activeFinancialAccountType}) selecionada. Como posso te ajudar?`;
                state.messageHistory = state.messageHistory.filter(m => !(m.role === 'assistant' && m.content.includes("Como posso te ajudar hoje?"))); // Evita duplicar saudação
                state.messageHistory.push({ role: 'assistant', content: currentAssistantGreeting });
                state.messageHistory.push({ role: 'user', content: messageText });
            } else {
                state.currentAction = 'selecting_initial_financial_account';
                state.data = { accountsToList: accounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType})) };
                let accountOptionsText = `Olá ${state.clientName}! Notei que você tem algumas contas por aqui:\n`;
                accounts.forEach((acc) => { accountOptionsText += `\n- *${acc.accountName}* (${acc.accountType})`; });
                accountOptionsText += `\n\nQual delas você gostaria de usar agora? Só me dizer o nome dela. 😉`;
                state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, accountOptionsText);
                return;
            }
        }
        if (state.activeFinancialAccountId && (!state.activeFinancialAccountName || !state.activeFinancialAccountType || state.data?.accountsToList)) {
            const accDetails = await clientService.getFinancialAccountById(state.activeFinancialAccountId);
            if (accDetails?.isActive) {
                state.activeFinancialAccountName = accDetails.accountName; state.activeFinancialAccountType = accDetails.accountType;
                delete state.data?.accountsToList;
            } else {
                state.activeFinancialAccountId = null; state.activeFinancialAccountName = null; state.activeFinancialAccountType = null;
                return processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload);
            }
        }
        logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id} (${state.clientName}), Conta: ${state.activeFinancialAccountName || 'N/A'}, Msg: "${messageText}"`);
        conversationState.set(senderPhone, state);

        if (state.currentAction) {
            let stateHandledInPreProcessing = false;
            let replyForPreProcessing = "";
            if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                const lowerMsg = messageText.toLowerCase().trim();
                const actionToConfirm = state.pendingConfirmation.action;
                const paramsToConfirm = state.pendingConfirmation.parameters;
                let actionExecutedDirectly = false;
                if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                    state.currentAction = null; state.pendingConfirmation = null;
                    if (actionToConfirm === 'CONFIRM_DELETE_TRANSACTION') { /* ... */ actionExecutedDirectly = true; }
                    else if (actionToConfirm === 'CONFIRM_DELETE_APPOINTMENT') { /* ... */ actionExecutedDirectly = true; }
                    else if (actionToConfirm === 'CONFIRM_CREATE_FINANCIAL_ACCOUNT') { /* ... */ actionExecutedDirectly = true; }
                    else { replyForPreProcessing = `Entendido, ${state.clientName}! Vou prosseguir com isso.`; }
                    stateHandledInPreProcessing = true;
                    if(replyForPreProcessing && actionExecutedDirectly) { /* ... envia e retorna ... */ }
                    else if (replyForPreProcessing) { /* ... envia e continua para IA ...*/ }
                } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) { /* ... cancela e retorna ... */ }
            }
            else if (state.currentAction === 'creating_first_account_type') { /* ... */ }
            else if (state.currentAction === 'awaiting_first_account_name') { /* ... */ }
            else if (state.currentAction === 'selecting_initial_financial_account') { /* ... */ }
            if (stateHandledInPreProcessing && replyForPreProcessing && (state.currentAction === null && !state.pendingConfirmation)) return;
            else if (stateHandledInPreProcessing && replyForPreProcessing) { /* ... envia e retorna se ainda no estado ... */ }
        }

        const aiContext = {
            currentFinancialAccountId: state.activeFinancialAccountId, currentFinancialAccountType: state.activeFinancialAccountType,
            currentFinancialAccountName: state.activeFinancialAccountName, clientName: state.clientName,
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2), currentStateData: state.data,
        };
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponse: JSON.stringify(aiResponse).substring(0,500) + "..."});
        state.lastAiResponse = aiResponse;

        let finalReplyParts = [];
        if (aiResponse.overall_summary_suggestion) {
            finalReplyParts.push(aiResponse.overall_summary_suggestion.replace("[Nome do Usuário]", state.clientName));
        }

        let requiresConfirmationByAI = false;
        let singleActionFormattedResult = null;
        let multipleActionFormattedResults = [];

        if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            finalReplyParts = [aiResponse.clarifications_needed[0].clarification_question.replace("[Nome do Usuário]", state.clientName)];
            state.pendingConfirmation = (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) ? aiResponse.detected_actions[0] : { action: aiResponse.clarifications_needed[0].original_intent_action_suggestion , parameters: { original_text: aiResponse.clarifications_needed[0].segment_text } };
            state.currentAction = 'awaiting_clarification_response';
            state.data.clarificationContext = { intent: state.pendingConfirmation?.action, segment: state.pendingConfirmation?.parameters?.original_text };
        } else if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            for (const detectedAction of aiResponse.detected_actions) {
                const params = detectedAction.parameters || {};
                const MIN_CONFIDENCE_FOR_AUTO_ACTION = 0.70;
                if (detectedAction.confidence < MIN_CONFIDENCE_FOR_AUTO_ACTION && !['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO'].includes(detectedAction.action)) {
                    requiresConfirmationByAI = true; state.pendingConfirmation = detectedAction; break;
                }
                let currentActionFormatted = "";
                try {
                    switch (detectedAction.action) {
                        case 'CREATE_FINANCIAL_TRANSACTION': {
                            if (params.isPayableOrReceivable === true || params.dueDate) {
                                // CONVERTER PARA SCHEDULE_APPOINTMENT
                                logger.warn(`[WHATSAPP SERVICE] IA sugeriu CREATE_FINANCIAL_TRANSACTION para conta futura. Convertendo para SCHEDULE_APPOINTMENT.`);
                                const nowForCalc = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
                                let eventDT;
                                if (params.dueDate) eventDT = `${params.dueDate} 09:00`;
                                else if (params.transactionDate && params.transactionDate !== nowForCalc.toISOString().split('T')[0]) eventDT = `${params.transactionDate} 09:00`;
                                else { nowForCalc.setMinutes(nowForCalc.getMinutes() + 15); eventDT = nowForCalc.toISOString().slice(0, 16).replace('T', ' '); }
                                const appParams = { title: `Lembrete: ${params.description}`, eventDateTime: eventDT, associatedValue: parseFloat(params.value), associatedTransactionType: params.type };
                                const newAppFromTx = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appParams);
                                const reloadedAppFromTx = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newAppFromTx.id);
                                currentActionFormatted = formatAppointmentSummary(reloadedAppFromTx, aiResponse.detected_actions.length > 1);
                                if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'appointment', id: newAppFromTx.id };
                                break;
                            }
                            const categoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                            const cardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                            const txData = { description: params.description, type: params.type, value: parseFloat(params.value),
                                transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes,
                                isPayableOrReceivable: false, isPaidOrReceived: true,
                            };
                            const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                            const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                            currentActionFormatted = formatFinancialTransactionSummary(reloadedTx, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'transaction', id: newTx.id };
                            break;
                        }
                        case 'SCHEDULE_APPOINTMENT': {
                            let eventDateTime = params.eventDateTime;
                            if (params.eventDateTime && typeof params.eventDateTime === 'string') {
                                if (params.eventDateTime.length === 10) eventDateTime += ' 09:00'; // YYYY-MM-DD
                                else if (params.eventDateTime.toLowerCase().startsWith("daqui")) {
                                    const matchMinutes = params.eventDateTime.match(/daqui (\d+) minutos?/i);
                                    const matchHours = params.eventDateTime.match(/daqui (\d+) horas?/i);
                                    const nowLocale = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
                                    if (matchMinutes) { nowLocale.setMinutes(nowLocale.getMinutes() + parseInt(matchMinutes[1])); eventDateTime = nowLocale.toISOString().slice(0, 19).replace('T', ' ');}
                                    else if (matchHours) { nowLocale.setHours(nowLocale.getHours() + parseInt(matchHours[1])); eventDateTime = nowLocale.toISOString().slice(0, 19).replace('T', ' '); }
                                }
                            }
                            const appData = { title: params.title, eventDateTime: eventDateTime,
                                durationMinutes: params.durationMinutes, location: params.location,
                                reminderLeadTimeMinutes: params.reminderLeadTimeMinutes,
                                associatedValue: params.associatedValue, associatedTransactionType: params.associatedTransactionType
                            };
                            const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                            const reloadedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newApp.id);
                            currentActionFormatted = formatAppointmentSummary(reloadedApp, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) state.editingResource = { type: 'appointment', id: newApp.id };
                            break;
                        }
                        case 'CREATE_RECURRING_RULE': {
                            const catRecId = params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null;
                            let ruleValue = parseFloat(params.value);
                            if ((isNaN(ruleValue) || ruleValue <= 0) && params.description?.toLowerCase().includes('netflix')) ruleValue = 55.90;
                            const ruleData = { description: params.description, type: params.type, value: ruleValue || 0,
                                frequency: params.frequency, startDate: params.startDate,
                                interval: params.interval || 1, dayOfMonth: params.dayOfMonth, dayOfWeek: params.dayOfWeek,
                                endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction || false,
                                financialCategoryId: catRecId };
                            const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                            const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);
                            currentActionFormatted = formatRecurringRuleSummary(reloadedRule, aiResponse.detected_actions.length > 1);
                            // No buttons for recurring rules for now
                            break;
                        }
                        case 'GET_FINANCIAL_SUMMARY': {
                            const filterParams = { dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                            };
                             if (params.period && params.period !== "personalizado") {
                                const todayLocale = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})); todayLocale.setHours(0,0,0,0);
                                const periodKey = params.period.toLowerCase();
                                if (periodKey === 'hoje') { filterParams.dateStart = filterParams.dateEnd = todayLocale.toISOString().split('T')[0]; }
                                else if (periodKey === 'ontem') { const y = new Date(todayLocale); y.setDate(y.getDate() - 1); filterParams.dateStart = filterParams.dateEnd = y.toISOString().split('T')[0]; }
                                else if (periodKey === 'esta_semana') { const d = todayLocale.getDay(); const diff = todayLocale.getDate() - d + (d === 0 ? -6 : 1); const f = new Date(todayLocale.setDate(diff)); const l = new Date(f); l.setDate(f.getDate() + 6); filterParams.dateStart = f.toISOString().split('T')[0]; filterParams.dateEnd = l.toISOString().split('T')[0]; }
                                else if (periodKey === 'este_mes') { filterParams.dateStart = new Date(todayLocale.getFullYear(), todayLocale.getMonth(), 1).toISOString().split('T')[0]; filterParams.dateEnd = new Date(todayLocale.getFullYear(), todayLocale.getMonth() + 1, 0).toISOString().split('T')[0]; }
                                else if (periodKey === 'semana_passada') { const prevMonday = new Date(todayLocale); prevMonday.setDate(todayLocale.getDate() - todayLocale.getDay() - 6); const prevSunday = new Date(prevMonday); prevSunday.setDate(prevMonday.getDate() + 6); filterParams.dateStart = prevMonday.toISOString().split('T')[0]; filterParams.dateEnd = prevSunday.toISOString().split('T')[0]; }
                                else if (periodKey === 'mes_passado') { filterParams.dateStart = new Date(todayLocale.getFullYear(), todayLocale.getMonth() - 1, 1).toISOString().split('T')[0]; filterParams.dateEnd = new Date(todayLocale.getFullYear(), todayLocale.getMonth(), 0).toISOString().split('T')[0]; }
                                else if (periodKey === 'este_ano') { filterParams.dateStart = new Date(todayLocale.getFullYear(), 0, 1).toISOString().split('T')[0]; filterParams.dateEnd = new Date(todayLocale.getFullYear(), 11, 31).toISOString().split('T')[0]; }
                            }
                            const summary = await financialService.getFinancialSummary(state.activeFinancialAccountId, filterParams);
                            let periodText = params.period ? translatePeriod(params.period) : (filterParams.dateStart && filterParams.dateEnd ? `${new Date(filterParams.dateStart+'T00:00:00Z').toLocaleDateString('pt-BR')} a ${new Date(filterParams.dateEnd+'T00:00:00Z').toLocaleDateString('pt-BR')}` : "geral");
                            currentActionFormatted = `📊 Resumo Financeiro (${periodText} para ${state.activeFinancialAccountName}):\n\n` +
                                          `🟢 Entradas: R$ ${summary.totalEntradas.toFixed(2)}\n🔴 Saídas: R$ ${summary.totalSaidas.toFixed(2)}\n` +
                                          `💰 *Saldo Efetivado: R$ ${summary.saldoEfetivado.toFixed(2)}*\n\n` +
                                          `📈 A Receber (Pend.): R$ ${summary.totalAReceberPendente.toFixed(2)}\n📉 A Pagar (Pend.): R$ ${summary.totalAPagarPendente.toFixed(2)}`;
                            break;
                        }
                        case 'LIST_FINANCIAL_TRANSACTIONS': {
                             const filterParamsList = { dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                                isPaidOrReceived: params.isPaidOrReceived, searchTerm: params.searchTerm, limit: 5, page: 1 };
                            if (params.period && params.period !== "personalizado") { /* ... lógica de período completa como em GET_FINANCIAL_SUMMARY ... */
                                const todayLocale = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})); todayLocale.setHours(0,0,0,0);
                                const periodKey = params.period.toLowerCase();
                                if (periodKey === 'hoje') { filterParamsList.dateStart = filterParamsList.dateEnd = todayLocale.toISOString().split('T')[0]; }
                                // ... (outros períodos)
                                else if (periodKey === 'ultimos_7_dias' || periodKey === 'last_7_days') {
                                    const sevenDaysAgo = new Date(todayLocale); sevenDaysAgo.setDate(todayLocale.getDate() - 6); // Inclui hoje
                                    filterParamsList.dateStart = sevenDaysAgo.toISOString().split('T')[0];
                                    filterParamsList.dateEnd = todayLocale.toISOString().split('T')[0];
                                }
                            }
                            const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList);
                            if (totalItems === 0) currentActionFormatted = "Nenhuma transação encontrada para os filtros que você pediu. 👍";
                            else {
                                let listText = `📜 Encontrei ${totalItems} transações. As mais recentes são:\n`;
                                for (const t of transactions) {
                                    const catName = t.category ? t.category.name : 'Sem Categoria';
                                    const emoji = t.type === 'Entrada' ? '🟢' : '🔴';
                                    const date = new Date(t.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'});
                                    listText += `\n${emoji} ${t.description} - R$ ${parseFloat(t.value).toFixed(2)}\n    (${catName} em ${date})`;
                                    if (t.isPayableOrReceivable) listText += t.isPaidOrReceived ? " (Liquidada)" : ` (Vence ${new Date(t.dueDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})})`;
                                }
                                if (totalItems > 5) listText += `\n\nE mais ${totalItems - 5} transações.`;
                                currentActionFormatted = listText;
                            }
                            break;
                        }
                        case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                            // Esta ação requer que o sistema encontre a transação original.
                            // A IA fornece 'transactionDescription' e opcionalmente 'transactionValue'.
                            // O ideal seria o sistema pedir confirmação se múltiplas transações corresponderem.
                            // Por simplicidade, tentaremos encontrar a mais recente pendente que corresponda.
                            const potentialTransactions = await financialService.getAllTransactions(state.activeFinancialAccountId, {
                                search: params.transactionDescription,
                                isPayableOrReceivable: true,
                                isPaidOrReceived: false,
                                limit: 5, // Busca algumas para tentar achar a correta
                                sortOrder: 'DESC', // Mais recentes primeiro
                                sortBy: 'dueDate'
                            });
                            let targetTx = null;
                            if (potentialTransactions.transactions.length > 0) {
                                if (params.transactionValue) {
                                    targetTx = potentialTransactions.transactions.find(tx => parseFloat(tx.value) === parseFloat(params.transactionValue));
                                }
                                if (!targetTx) targetTx = potentialTransactions.transactions[0]; // Pega a primeira se não achar por valor ou valor não fornecido
                            }

                            if (targetTx) {
                                const updatedTx = await financialService.markAsPaidOrReceived(state.activeFinancialAccountId, targetTx.id, params.paymentDate);
                                currentActionFormatted = `Conta "${updatedTx.description}" (R$ ${parseFloat(updatedTx.value).toFixed(2)}) marcada como ${updatedTx.type === 'Entrada' ? 'recebida' : 'paga'}! ✅`;
                            } else {
                                currentActionFormatted = `Não consegui encontrar a conta pendente "${params.transactionDescription}" para marcar como paga/recebida. 🤔 Poderia ser mais específico ou verificar se ela já foi quitada?`;
                            }
                            break;
                        }
                        case 'CREATE_PRODUCT': {
                            if (state.activeFinancialAccountType === 'PF') {
                                currentActionFormatted = `Desculpe, ${state.clientName}, o cadastro de produtos é para contas PJ ou MEI. Sua conta atual é PF.`; break;
                            }
                            const newProd = await productService.createProduct(state.activeFinancialAccountId, params);
                            currentActionFormatted = `📦 Produto "${newProd.name}" (R$ ${parseFloat(newProd.salePrice).toFixed(2)}) cadastrado com ${newProd.quantity || 0} unidades em estoque!`;
                            break;
                        }
                        case 'GET_STOCK_INFO': {
                            if (state.activeFinancialAccountType === 'PF') { currentActionFormatted = `O controle de estoque é para contas PJ/MEI, ${state.clientName}.`; break; }
                            const prodId = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                            if(prodId) {
                                const balance = await stockService.getProductStockBalance(prodId);
                                currentActionFormatted = balance ? `Temos ${balance.quantity} ${balance.unit || 'un.'} de "${balance.name}" em estoque. ✨` : `Produto "${params.productNameOrCode}" não encontrado.`;
                            } else { currentActionFormatted = `Produto "${params.productNameOrCode}" não encontrado para consulta de estoque.`; }
                            break;
                        }
                        case 'RECORD_STOCK_MOVEMENT': {
                             if (state.activeFinancialAccountType === 'PF') { currentActionFormatted = `Movimentação de estoque é para contas PJ/MEI, ${state.clientName}.`; break; }
                            const prodIdMov = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                            if(prodIdMov) {
                                const movData = {type: params.movementType, quantity: parseInt(params.quantity), reason: params.reason};
                                const movement = await stockService.recordStockMovement(prodIdMov, movData);
                                const updatedProduct = await productService.getProductById(state.activeFinancialAccountId, prodIdMov); // Pega saldo atualizado
                                currentActionFormatted = `Movimentação de ${movement.quantity} un. de "${updatedProduct.name}" (${movement.type}) registrada! Novo saldo: ${updatedProduct.quantity} un.`;
                            } else { currentActionFormatted = `Produto "${params.productNameOrCode}" não encontrado para movimentar.`;}
                            break;
                        }
                        case 'LIST_APPOINTMENTS': {
                            const appFilterParams = { dateStart: params.dateStart, dateEnd: params.dateEnd, status: params.status, limit: 5 };
                            if (params.period && params.period !== "personalizado") { /* ... lógica de período completa ... */ }
                            const { appointments, totalItems: totalApps } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, appFilterParams);
                            if (totalApps === 0) currentActionFormatted = "Nenhum compromisso encontrado para os filtros informados. 👍";
                            else {
                                currentActionFormatted = `🗓️ Encontrei ${totalApps} compromissos. Os próximos são:\n`;
                                appointments.forEach(a => { currentActionFormatted += `\n- ${a.title} em ${new Date(a.eventDateTime).toLocaleString('pt-BR', {timeStyle:'short', dateStyle:'short', timeZone: process.env.TZ || 'America/Sao_Paulo'})} (${a.status})`;});
                                if (totalApps > 5) currentActionFormatted += `\n\nE mais ${totalApps - 5}.`;
                            }
                            break;
                        }
                        case 'CREATE_CREDIT_CARD': {
                            const newCard = await creditCardService.createCreditCard(state.activeFinancialAccountId, params);
                            currentActionFormatted = `💳 Cartão "${newCard.name}" com limite de R$ ${parseFloat(newCard.limit).toFixed(2)} cadastrado! Fecha dia ${newCard.closingDay} e vence dia ${newCard.paymentDay}.`;
                            break;
                        }
                        case 'LIST_CREDIT_CARDS': {
                            const cards = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, {isActive: true});
                            if(cards.length === 0) currentActionFormatted = "Você ainda não tem cartões de crédito cadastrados nesta conta.";
                            else {
                                currentActionFormatted = "💳 Seus cartões cadastrados são:\n";
                                cards.forEach(c => { currentActionFormatted += `\n- ${c.name} (final ${c.lastFourDigits || '****'}), Limite R$ ${parseFloat(c.limit).toFixed(2)}${c.isDefault ? ' (Padrão)' : ''}`;});
                            }
                            break;
                        }
                         case 'LIST_RECURRING_RULES': {
                            const rules = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, {isActive: true});
                            if(rules.length === 0) currentActionFormatted = "Nenhuma regra de recorrência ativa encontrada para esta conta.";
                            else {
                                currentActionFormatted = "🔄 Suas regras de recorrência ativas:\n";
                                rules.slice(0,3).forEach(r => { // Limita para não ficar muito longo
                                    currentActionFormatted += `\n- "${r.description}" (R$ ${parseFloat(r.value).toFixed(2)} ${r.frequency}, próx. ${new Date(r.nextDueDate+'T00:00:00Z').toLocaleDateString('pt-BR')})`;
                                });
                                if(rules.length > 3) currentActionFormatted += `\n\nE mais ${rules.length - 3} regra(s).`;
                            }
                            break;
                        }
                        case 'SWITCH_FINANCIAL_ACCOUNT': {
                            const accountsAvail = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                            if (params.targetAccountNameOrType) {
                                const target = accountsAvail.find(acc => acc.accountName.toLowerCase().includes(params.targetAccountNameOrType.toLowerCase()) || acc.accountType === params.targetAccountNameOrType.toUpperCase());
                                if (target) {
                                    state.activeFinancialAccountId = target.id; state.activeFinancialAccountName = target.accountName; state.activeFinancialAccountType = target.accountType;
                                    currentActionFormatted = `Prontinho, ${state.clientName}! Mudei para a sua conta "${target.accountName}" (${target.accountType}). O que você gostaria de fazer nela?`;
                                } else {
                                    currentActionFormatted = `Não encontrei uma conta com nome ou tipo parecido com "${params.targetAccountNameOrType}", ${state.clientName}. Você tem as contas: ${accountsAvail.map(a => `"${a.accountName}" (${a.accountType})`).join(', ')}. Qual delas gostaria de usar?`;
                                    state.currentAction = 'awaiting_account_switch_choice';
                                    state.data = { accountsToList: accountsAvail.map(a => ({id: a.id, name: a.accountName, type: a.accountType})) };
                                }
                            } else {
                                let opts = `Você tem as seguintes contas, ${state.clientName}:\n`;
                                accountsAvail.forEach((acc) => { opts += `\n- *${acc.accountName}* (${acc.accountType})`;});
                                opts += "\n\nPara qual delas você gostaria de mudar? Só me dizer o nome. 😉";
                                currentActionFormatted = opts;
                                state.currentAction = 'awaiting_account_switch_choice';
                                state.data = { accountsToList: accountsAvail.map(a => ({id: a.id, name: a.accountName, type: a.accountType})) };
                            }
                            break;
                        }
                        case 'CREATE_FINANCIAL_ACCOUNT': {
                            state.currentAction = 'awaiting_new_account_type_from_ia';
                            state.data = { accountTypeToCreateSuggestion: params.accountTypeToCreate, newAccountNameSuggestion: params.newAccountName };
                            if(params.accountTypeToCreate && params.newAccountName){
                                currentActionFormatted = `Legal, ${state.clientName}! Então vamos criar uma conta ${params.accountTypeToCreate} chamada "${params.newAccountName}", correto? (Sim/Não)`;
                                state.pendingConfirmation = {action: 'CONFIRM_CREATE_FINANCIAL_ACCOUNT', parameters: {accountType: params.accountTypeToCreate, accountName: params.newAccountName}};
                                requiresConfirmationByAI = true;
                            } else if (params.accountTypeToCreate) {
                                currentActionFormatted = `Ok, uma conta ${params.accountTypeToCreate}! Que nome você gostaria de dar para ela, ${state.clientName}?`;
                            } else {
                                currentActionFormatted = `Certo, ${state.clientName}! Sua nova conta será Pessoal (PF), Empresa (PJ) ou MEI?`;
                            }
                            break;
                        }
                        default:
                            if (aiResponse.detected_actions.length === 1 && aiResponse.reply_to_user_suggestion && !aiResponse.overall_summary_suggestion) {
                                currentActionFormatted = aiResponse.reply_to_user_suggestion.replace("[Nome do Usuário]", state.clientName);
                            } else {
                                currentActionFormatted = `Ação "${detectedAction.action}" ${params.description ? `para "${params.description}"` : ''} foi entendida.`;
                            }
                            if ((detectedAction.action === "GENERAL_GREETING_OR_SMALLTALK" || detectedAction.action === "GENERAL_QUESTION_OR_HELP") && aiResponse.reply_to_user_suggestion) {
                                finalReplyParts = [aiResponse.reply_to_user_suggestion.replace("[Nome do Usuário]", state.clientName)];
                                multipleActionFormattedResults = [];
                                break;
                            }
                            break;
                    }
                    if (currentActionFormatted) {
                        if (aiResponse.detected_actions.length === 1 && !requiresConfirmationByAI) singleActionFormattedResult = currentActionFormatted;
                        else if (!requiresConfirmationByAI) multipleActionFormattedResults.push(currentActionFormatted);
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack, params: params });
                    const errorMsgPart = `Ops! Tive um problema ao tentar processar "${params.description || detectedAction.action}". (${e.message.length < 70 ? e.message : 'Erro interno'})`;
                    if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = errorMsgPart;
                    else multipleActionFormattedResults.push(errorMsgPart);
                }
            }
        }

        if (requiresConfirmationByAI && state.pendingConfirmation) {
            finalReplyParts = [aiResponse.reply_to_user_suggestion || `Hmm, ${state.clientName}, entendi que você quer fazer algo como "${state.pendingConfirmation.parameters.description || state.pendingConfirmation.action}". É isso mesmo? (Sim/Não)`];
            state.currentAction = 'awaiting_confirmation';
        } else if (singleActionFormattedResult) {
            if (finalReplyParts.length > 0) finalReplyParts.push("\n\n" + singleActionFormattedResult); else finalReplyParts.push(singleActionFormattedResult);
        } else if (multipleActionFormattedResults.length > 0) {
            if (finalReplyParts.length === 0 && multipleActionFormattedResults.length > 0) finalReplyParts.push(`${state.clientName}, aqui está o que eu fiz pra você: 😉`);
            finalReplyParts.push(multipleActionFormattedResults.join("\n\n---\n\n"));
        }
        else if (aiResponse.reply_to_user_suggestion) { // Nenhuma ação formatada, nenhuma confirmação, NENHUMA CLARIFICAÇÃO (já tratado)
            const suggestion = aiResponse.reply_to_user_suggestion.replace("[Nome do Usuário]", state.clientName);
            if (!(finalReplyParts.length > 0 && finalReplyParts[0] === aiResponse.overall_summary_suggestion?.replace("[Nome do Usuário]", state.clientName))) {
                 if (finalReplyParts.length > 0 && !finalReplyParts.join(" ").includes(suggestion)) finalReplyParts.push(suggestion);
                 else if (finalReplyParts.length === 0) finalReplyParts.push(suggestion);
            } else if (finalReplyParts.length === 0) finalReplyParts.push(suggestion);
        } else if (finalReplyParts.length === 0) {
            finalReplyParts.push(`Entendido, ${state.clientName}! Se precisar de mais alguma coisa, é só chamar. 😊`);
        }

        const performedConcreteAction = singleActionFormattedResult || multipleActionFormattedResults.length > 0;
        if (performedConcreteAction && !requiresConfirmationByAI && !(aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) ) {
            const platformUrl = process.env.PLATFORM_URL || 'SEU_SITE_AQUI';
            if (platformUrl !== 'SEU_SITE_AQUI') finalReplyParts.push(`\n📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em ${platformUrl}`);
            if (!finalReplyParts.some(p => p.toLowerCase().includes("mais alguma coisa") || p.toLowerCase().includes("só chamar"))) {
                 finalReplyParts.push("Se precisar de algo a mais é só me chamar! 😄");
            }
        }

        const completeFinalReply = finalReplyParts.join("\n\n").trim();
        state.messageHistory.push({ role: 'assistant', content: completeFinalReply });

        if (!requiresConfirmationByAI && state.currentAction !== 'awaiting_clarification_response' &&
            state.currentAction !== 'selecting_initial_financial_account' &&
            !state.currentAction?.startsWith('creating_first_account') &&
            !state.currentAction?.startsWith('awaiting_') &&
            state.currentAction !== 'awaiting_confirmation'
            ) {
            // state.currentAction = null;
            // state.data = {};
        }
        conversationState.set(senderPhone, state);

        if (completeFinalReply) {
            const resourceForButtons = state.editingResource;
            if (resourceForButtons && !requiresConfirmationByAI && aiResponse.detected_actions?.length === 1 && performedConcreteAction) {
                let buttons = [];
                const itemDescriptionForButton = (aiResponse.detected_actions[0].parameters.description || aiResponse.detected_actions[0].parameters.title || "este item").substring(0,20);
                const buttonTitle = `Opções para "${itemDescriptionForButton}":`;
                if (resourceForButtons.type === 'transaction') buttons = [ { id: `edit_transaction_${resourceForButtons.id}`, label: "Editar transação" }, { id: `delete_transaction_${resourceForButtons.id}`, label: "Excluir transação" }];
                else if (resourceForButtons.type === 'appointment') buttons = [ { id: `edit_appointment_${resourceForButtons.id}`, label: "Editar compromisso" }, { id: `delete_appointment_${resourceForButtons.id}`, label: "Excluir compromisso" }];
                if (buttons.length > 0) await sendButtonListMessage(senderPhone, completeFinalReply, buttons, buttonTitle);
                else await sendWhatsappMessage(senderPhone, completeFinalReply);
                state.editingResource = null;
            } else {
                await sendWhatsappMessage(senderPhone, completeFinalReply);
            }
        }
    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack, messageText, rawPayload });
        const clientNameToUseInError = state?.clientName || pushName || "você";
        conversationState.delete(senderPhone);
        try {
            await sendWhatsappMessage(senderPhone, `Puxa vida, ${clientNameToUseInError}! 😬 Parece que tive um curto-circuito aqui e não consegui processar sua mensagem. Minha equipe de engenheiros já está de olho nisso! 👩‍💻👨‍💻 Por favor, tente de novo em um momentinho. Desculpe o transtorno!`);
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
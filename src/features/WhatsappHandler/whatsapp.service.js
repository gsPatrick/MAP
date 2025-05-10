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

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8; // Pares de mensagens (usuário/assistente)
const MAX_STATE_HISTORY = 20; // Total de mensagens no estado

// --- Helper Functions ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    logger.debug(`[WHATSAPP SERVICE] Buscando categoria financeira por nome: "${name}" para conta ${financialAccountId}, tipo ${transactionType}`);
    let foundCategory = await systemService.findFinancialCategoryByNameAndType(name, transactionType, financialAccountId);
    if (foundCategory) return foundCategory.id;
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
    const clientName = client ? (client.name || "pessoa incrível") : "pessoa incrível";
    const newState = {
        currentAction: null,
        data: {},
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount ? defaultAccount.accountType : null,
        clientName: clientName,
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null, // Objeto: { type: 'transaction'/'appointment'/'etc', id: resourceId }
        lastAiResponse: null,
    };
    if (defaultAccount && client) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Bem-vindo(a) de volta à sua conta "${newState.activeFinancialAccountName}". Como posso te ajudar hoje? Estou pronto para anotar tudo! 📝` });
    } else if (client) {
         newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Como posso te ajudar hoje? Estou aqui para o que precisar! ✨` });
    }
    return newState;
}

// --- Funções de Formatação de Resumo (Caprichadas) ---
function formatFinancialTransactionSummary(transaction, forMulti = false, forEdit = false) {
    const dateFormatted = transaction.transactionDate
        ? new Date(transaction.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' })
        : 'Data não informada';

    let statusText = "";
    let statusEmoji = "";
    if (transaction.isPayableOrReceivable) {
        const dueDateFormatted = transaction.dueDate ? new Date(transaction.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';
        if (transaction.isPaidOrReceived) {
            statusText = transaction.type === 'Entrada' ? "Recebido!" : "Pago!";
            statusEmoji = "✅";
        } else {
            statusText = ` ${transaction.type === 'Entrada' ? 'A receber' : 'A pagar'} em ${dueDateFormatted}`;
            statusEmoji = "🗓️";
        }
    } else {
        statusText = transaction.type === 'Entrada' ? "Recebido!" : "Pago!";
        statusEmoji = "✅";
    }

    let categoryEmoji = transaction.type === 'Entrada' ? '📥' : '💸';
    if (transaction.category && transaction.category.name) {
        const catNameLower = transaction.category.name.toLowerCase();
        if (catNameLower.includes('lazer') || catNameLower.includes('jogo') || catNameLower.includes('entretenimento')) categoryEmoji = '🎮';
        else if (catNameLower.includes('alimentação') || catNameLower.includes('restaurante') || catNameLower.includes('ifood') || catNameLower.includes('mercado')) categoryEmoji = '🍔';
        else if (catNameLower.includes('salário') || catNameLower.includes('recebimento') || catNameLower.includes('presente')) categoryEmoji = '💰';
        else if (catNameLower.includes('transporte') || catNameLower.includes('uber') || catNameLower.includes('gasolina')) categoryEmoji = '🚗';
        else if (catNameLower.includes('saúde') || catNameLower.includes('farmácia') || catNameLower.includes('médico')) categoryEmoji = '🩺';
        else if (catNameLower.includes('casa') || catNameLower.includes('aluguel') || catNameLower.includes('moradia')) categoryEmoji = '🏡';
        else if (catNameLower.includes('educação') || catNameLower.includes('curso')) categoryEmoji = '📚';
        else if (catNameLower.includes('pet')) categoryEmoji = '🐾';
        else if (catNameLower.includes('investimento')) categoryEmoji = '📈';
        else if (catNameLower.includes('doação')) categoryEmoji = '👐';
        else if (catNameLower.includes('outros')) categoryEmoji = '📎';
    }
    if (transaction.creditCard && transaction.creditCard.name) categoryEmoji = '💳';


    let summary = "";
    if (!forMulti && !forEdit) summary += "📋 Resumo da Transação:\n\n";
    else if (forEdit) summary += "✅ Transação Editada:\n\n";


    summary += `${categoryEmoji} Descrição: ${transaction.description}\n`;
    summary += `💰 Valor: R$ ${parseFloat(transaction.value).toFixed(2)}\n`;
    if (transaction.category && transaction.category.name) {
        summary += `🏷️ Categoria: ${transaction.category.name}\n`;
    }
    if (transaction.creditCard && transaction.creditCard.name) {
        summary += `💳 Cartão: ${transaction.creditCard.name}${transaction.creditCard.lastFourDigits ? ` (**** ${transaction.creditCard.lastFourDigits})` : ''}\n`;
    }
    summary += `📅 Data: ${dateFormatted}\n`;
    summary += `\n${statusEmoji} Status: ${statusText}`;
    if (transaction.notes) summary += `\n📝 Obs: ${transaction.notes}`;
    return summary;
}

function formatAppointmentSummary(appointment, forMulti = false, forEdit = false) {
    const eventDateTimeFormatted = appointment.eventDateTime
        ? new Date(appointment.eventDateTime).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ || 'America/Sao_Paulo' })
        : 'Data/Hora não informada';

    let summary = "";
    if (!forMulti && !forEdit) summary += "📅 Resumo do Compromisso:\n\n";
    else if (forEdit) summary += "✅ Compromisso Atualizado:\n\n";


    summary += `📝 Título: ${appointment.title}\n`;
    summary += `🗓️ Data e Hora: ${eventDateTimeFormatted}\n`;
    if (appointment.durationMinutes) summary += `⏳ Duração: ${appointment.durationMinutes} min\n`;
    if (appointment.location) summary += `📍 Local: ${appointment.location}\n`;
    summary += `🚦 Status: ${appointment.status}`;
    if(appointment.reminderEnabled && appointment.reminderLeadTimeMinutes) {
        summary += `\n🔔 Lembrete: Sim (${appointment.reminderLeadTimeMinutes} min antes)`;
    } else if (appointment.reminderEnabled && !appointment.reminderLeadTimeMinutes) {
        summary += `\n🔔 Lembrete: Sim (Padrão)`;
    }
    if (appointment.notes) summary += `\n💬 Notas: ${appointment.notes}`;
    return summary;
}

function formatRecurringRuleSummary(rule, forMulti = false, forEdit = false) {
    const startDateFormatted = rule.startDate ? new Date(rule.startDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/I';
    const endDateFormatted = rule.endDate ? new Date(rule.endDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'Sem data final';
    const nextDateFormatted = rule.nextDueDate ? new Date(rule.nextDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';

    let categoryEmoji = rule.type === 'Entrada' ? '💰' : '💸';
     if (rule.category && rule.category.name) {
        const catNameLower = rule.category.name.toLowerCase();
        if (catNameLower.includes('assinatura') || catNameLower.includes('streaming') || catNameLower.includes('netflix')) categoryEmoji = '🎬';
        else if (catNameLower.includes('aluguel') || catNameLower.includes('condomínio')) categoryEmoji = '🏡';
        else if (catNameLower.includes('salário')) categoryEmoji = '💼';
    }

    let summary = "";
    if(!forMulti && !forEdit) summary += "🔄 Resumo da Recorrência:\n\n";
    else if (forEdit) summary += "✅ Recorrência Atualizada:\n\n";


    summary += `${categoryEmoji} Descrição: ${rule.description}\n`;
    summary += `💰 Valor: R$ ${parseFloat(rule.value).toFixed(2)} (${rule.type})\n`;
    if (rule.category && rule.category.name) {
        summary += `🏷️ Categoria: ${rule.category.name}\n`;
    }
    summary += `📅 Início: ${startDateFormatted}\n`;
    if(rule.endDate) summary += `🏁 Fim: ${endDateFormatted}\n`;
    summary += `🔁 Frequência: ${rule.frequency} (a cada ${rule.interval})\n`;
    if (rule.dayOfMonth) summary += `🗓️ Dia do Mês: ${rule.dayOfMonth}\n`;
    if (rule.dayOfWeek !== null && rule.dayOfWeek !== undefined) summary += `🗓️ Dia da Semana: ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][rule.dayOfWeek]}\n`;
    summary += `➡️ Próximo Vencimento: ${nextDateFormatted}\n`;
    summary += `🤖 Automático: ${rule.autoCreateTransaction ? 'Sim (Cria Transação)' : 'Não (Apenas Lembrete)'}\n`;
    summary += `🚦 Status da Regra: ${rule.isActive ? 'Ativa ✔️' : 'Inativa ❌'}`;
    return summary;
}

function formatProductSummary(product, forMulti = false, forEdit = false) {
    let summary = "";
    if(!forMulti && !forEdit) summary += "📦 Resumo do Produto:\n\n";
    else if (forEdit) summary += "✅ Produto Atualizado:\n\n";

    summary += `🏷️ Nome: ${product.name}\n`;
    if (product.code) summary += `🔢 Código: ${product.code}\n`;
    summary += `💲 Preço Venda: R$ ${parseFloat(product.salePrice).toFixed(2)}\n`;
    if (product.costPrice) summary += `📉 Preço Custo: R$ ${parseFloat(product.costPrice).toFixed(2)}\n`;
    summary += `📊 Estoque Atual: ${product.quantity} ${product.unit || 'UN'}\n`;
    if (product.minimumStock) summary += `🔔 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    summary += `🚦 Status: ${product.isActive ? 'Ativo ✔️' : 'Inativo ❌'}`;
    return summary;
}

function formatCreditCardSummary(card, forMulti = false, forEdit = false) {
    let summary = "";
    if(!forMulti && !forEdit) summary += "💳 Resumo do Cartão de Crédito:\n\n";
    else if (forEdit) summary += "✅ Cartão Atualizado:\n\n";

    summary += `✨ Nome: ${card.name}\n`;
    if(card.lastFourDigits) summary += ` końcówka: **** ${card.lastFourDigits}\n`;
    if(card.flag) summary += `🚩 Bandeira: ${card.flag}\n`;
    summary += `💰 Limite: R$ ${parseFloat(card.limit).toFixed(2)}\n`;
    summary += `🗓️ Dia Fechamento: ${card.closingDay}\n`;
    summary += `💸 Dia Pagamento: ${card.paymentDay}\n`;
    summary += `⭐ Padrão: ${card.isDefault ? 'Sim ✔️' : 'Não ❌'}\n`;
    summary += `🚦 Status: ${card.isActive ? 'Ativo ✔️' : 'Inativo ❌'}`;
    return summary;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    try {
        const client = await clientService.findOrCreateClientByPhone(senderPhone, { name: pushName }, true);
        if (!client) {
            await sendWhatsappMessage(senderPhone, "Desculpe, ${pushName || 'você'}, estou com um problema para identificar você no momento. Por favor, tente mais tarde. 😕");
            return;
        }

        state = conversationState.get(senderPhone) || initializeState(client);
        if (client.name && state.clientName !== client.name) {
            state.clientName = client.name; // Atualiza nome se mudou
        }
        const clientNameToUse = state.clientName; // Para consistência nas mensagens

        // Lógica para lidar com cliques em botões (ANTES de adicionar à história)
        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ${buttonId}`);
            let buttonClickHandled = true;
            let replyForButtonClick = "";

            if (buttonId.startsWith('edit_transaction_')) {
                const transactionId = buttonId.replace('edit_transaction_', '');
                state.editingResource = { type: 'transaction', id: transactionId };
                replyForButtonClick = `Claro, ${clientNameToUse}! 😉 Descreva na próxima mensagem o que você precisa que eu altere na transação (ID: ${transactionId}).`;
                state.currentAction = 'awaiting_transaction_edit_details';
            } else if (buttonId.startsWith('delete_transaction_')) {
                const transactionId = buttonId.replace('delete_transaction_', '');
                state.pendingConfirmation = { action: 'CONFIRM_DELETE_TRANSACTION', parameters: { transactionId: transactionId } };
                state.currentAction = 'awaiting_confirmation';
                replyForButtonClick = `Você tem certeza que quer excluir essa transação, ${clientNameToUse}? 😟 (Sim/Não)`;
            } else if (buttonId.startsWith('edit_appointment_')) {
                const appointmentId = buttonId.replace('edit_appointment_', '');
                state.editingResource = { type: 'appointment', id: appointmentId };
                replyForButtonClick = `Beleza, ${clientNameToUse}! ✨ Me diga na próxima mensagem o que você quer mudar no compromisso (ID: ${appointmentId}).`;
                state.currentAction = 'awaiting_appointment_edit_details';
            } else if (buttonId.startsWith('delete_appointment_')) {
                const appointmentId = buttonId.replace('delete_appointment_', '');
                state.pendingConfirmation = { action: 'CONFIRM_DELETE_APPOINTMENT', parameters: { appointmentId: appointmentId } };
                state.currentAction = 'awaiting_confirmation';
                replyForButtonClick = `Tem certeza que deseja excluir este compromisso, ${clientNameToUse}? 🤔 (Sim/Não)`;
            }
            // Adicionar para recorrências, produtos, cartões se tiver botões de editar/excluir para eles
            else {
                buttonClickHandled = false;
            }

            if (buttonClickHandled) {
                state.messageHistory.push({ role: 'user', content: `[CLIQUE NO BOTÃO: ${rawPayload.message || buttonId}]` }); // Loga o clique
                state.messageHistory.push({ role: 'assistant', content: replyForButtonClick });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForButtonClick);
                return;
            }
        }

        // Adiciona mensagem atual ao histórico
        state.messageHistory.push({ role: 'user', content: messageText });
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }

        // Lógica de seleção/criação de conta
        if (!state.activeFinancialAccountId) {
            const accounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
            const defaultAccount = accounts.find(acc => acc.isDefault) || (accounts.length > 0 ? accounts[0] : null);

            if (!defaultAccount && accounts.length === 0) {
                state.currentAction = 'creating_first_account_type';
                const welcomeMsg = `Olá ${clientNameToUse}! 😊 Bem-vindo(a) ao ${aiModelService.ASSISTANT_NAME}! Para começarmos com o pé direito, vamos configurar sua primeira conta. Ela é para suas finanças *Pessoais (PF)* 🧑‍💼, para sua *Empresa (PJ)* 🏢 ou para seu *MEI* 🚀?`;
                state.messageHistory.push({ role: 'assistant', content: welcomeMsg });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, welcomeMsg);
                return;
            } else if (accounts.length === 1 || (defaultAccount && accounts.length > 0)) {
                const accountToSet = defaultAccount || accounts[0];
                if(conversationState.has(senderPhone)){
                    state.activeFinancialAccountId = accountToSet.id;
                    state.activeFinancialAccountName = accountToSet.accountName;
                    state.activeFinancialAccountType = accountToSet.accountType;
                } else {
                    state = initializeState(client, accountToSet); // Inicializa com a conta
                }
                // Remove a última mensagem do usuário para não ser duplicada se esta for a primeira interação real
                // e a saudação de seleção de conta já vai guiar.
                const lastUserMsgIndex = state.messageHistory.map(m => m.role).lastIndexOf('user');
                if (lastUserMsgIndex > 0 && state.messageHistory[lastUserMsgIndex-1]?.role === 'assistant' && state.messageHistory[lastUserMsgIndex-1]?.content.includes("Como posso te ajudar")) {
                    // Não remove, pois a saudação já aconteceu
                } else if (lastUserMsgIndex !== -1) {
                     state.messageHistory.splice(lastUserMsgIndex, 1);
                }

                const greetingWithAccount = `Olá ${clientNameToUse}! 😊 Conta "${state.activeFinancialAccountName}" (${state.activeFinancialAccountType}) selecionada! Como posso te ajudar agora? Manda a braba! 🎤`;
                state.messageHistory.push({ role: 'assistant', content: greetingWithAccount });
                // Não adiciona a mensagem do usuário de novo aqui, ela já foi adicionada no início da função.

            } else { // Múltiplas contas, nenhuma default, precisa escolher
                state.currentAction = 'selecting_initial_financial_account';
                state.data = { accountsToList: accounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType})) };
                let accountOptionsText = `Olá ${clientNameToUse}! 👋 Notei que você tem algumas contas por aqui:\n`;
                accounts.forEach((acc) => { accountOptionsText += `\n- *${acc.accountName}* (${acc.accountType})`; });
                accountOptionsText += `\n\nQual delas você gostaria de usar agora? Só me dizer o nome dela. 😉 Estou no aguardo!`;
                state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, accountOptionsText);
                return;
            }
        }
        // Garante que nome e tipo da conta ativa estejam no estado
        if (state.activeFinancialAccountId && (!state.activeFinancialAccountName || !state.activeFinancialAccountType || state.data?.accountsToList)) {
            const accDetails = await clientService.getFinancialAccountById(state.activeFinancialAccountId);
            if (accDetails && accDetails.isActive) {
                state.activeFinancialAccountName = accDetails.accountName;
                state.activeFinancialAccountType = accDetails.accountType;
                delete state.data?.accountsToList;
            } else {
                logger.warn(`[WHATSAPP SERVICE] Conta ativa ID ${state.activeFinancialAccountId} não é mais válida para ${senderPhone}. Resetando estado de conta.`);
                state.activeFinancialAccountId = null; state.activeFinancialAccountName = null; state.activeFinancialAccountType = null;
                return processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload);
            }
        }

        logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id} (${clientNameToUse}), Conta: ${state.activeFinancialAccountName || 'N/A'}, Msg: "${messageText}"`);
        conversationState.set(senderPhone, state); // Salva estado antes da IA

        // === Lógica de Estado da Conversa (ANTES da IA) ===
        if (state.currentAction) {
            let stateHandledInPreProcessing = false;
            let replyForPreProcessing = "";

            if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                const lowerMsg = messageText.toLowerCase().trim();
                const actionToConfirm = state.pendingConfirmation.action;
                const paramsToConfirm = state.pendingConfirmation.parameters;

                if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    conversationState.set(senderPhone, state);

                    if (actionToConfirm === 'CONFIRM_DELETE_TRANSACTION') {
                        const success = await financialService.deleteTransaction(state.activeFinancialAccountId, paramsToConfirm.transactionId);
                        replyForPreProcessing = success ? `Transação removida com sucesso, ${clientNameToUse}! 👍 Se precisar de mais alguma coisa, é só chamar.` : "Não consegui excluir a transação. Pode ter sido um erro ou ela já foi removida.";
                    } else if (actionToConfirm === 'CONFIRM_DELETE_APPOINTMENT') {
                        const success = await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, paramsToConfirm.appointmentId, true);
                        replyForPreProcessing = success ? `Compromisso removido da sua agenda, ${clientNameToUse}! ✅ Fico à disposição se precisar de algo mais.` : "Não foi possível excluir o compromisso.";
                    } else if (actionToConfirm === 'CONFIRM_CREATE_FINANCIAL_ACCOUNT') {
                         const createdAcc = await clientService.createFinancialAccount(client.id, {
                            accountName: paramsToConfirm.accountName,
                            accountType: paramsToConfirm.accountType,
                            isDefault: (await clientService.getClientFinancialAccounts(client.id, {isActive: true})).length === 0
                        });
                        state.activeFinancialAccountId = createdAcc.id;
                        state.activeFinancialAccountName = createdAcc.accountName;
                        state.activeFinancialAccountType = createdAcc.accountType;
                        replyForPreProcessing = `Conta "${createdAcc.accountName}" (${createdAcc.accountType}) criada e já está selecionada, ${clientNameToUse}! 🎉 Como posso te ajudar agora?`;
                    }
                    // Adicionar mais 'else if' para outras ações que precisam de confirmação
                    else {
                        replyForPreProcessing = `Entendido, ${clientNameToUse}! Confirmado! 👍 Vou prosseguir.`;
                        // A IA reprocessará com o "sim" no histórico.
                    }
                    stateHandledInPreProcessing = true;
                    if(replyForPreProcessing) {
                         state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                         await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                         if (state.currentAction === null && !state.pendingConfirmation) return;
                    }

                } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) {
                    replyForPreProcessing = `Ok, ${clientNameToUse}, cancelado! Sem problemas. O que gostaria de fazer então? 😊`;
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    stateHandledInPreProcessing = true;
                    state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                    conversationState.set(senderPhone, state);
                    await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                    return;
                }
            }
            else if (state.currentAction === 'creating_first_account_type') {
                const typeChosen = messageText.toLowerCase();
                let accountTypeToCreate = null;
                if (typeChosen.includes('pessoal') || typeChosen.includes('pf')) accountTypeToCreate = 'PF';
                else if (typeChosen.includes('empresa') || typeChosen.includes('pj')) accountTypeToCreate = 'PJ';
                else if (typeChosen.includes('mei')) accountTypeToCreate = 'MEI';

                if (accountTypeToCreate) {
                    state.data.accountTypeToCreate = accountTypeToCreate;
                    state.currentAction = 'awaiting_first_account_name';
                    replyForPreProcessing = `Ótimo, ${clientNameToUse}! E qual nome você gostaria de dar para esta sua conta ${accountTypeToCreate}? 🏷️ (Ex: "Minhas Finanças", "Empresa ABC")`;
                    stateHandledInPreProcessing = true;
                } else {
                    replyForPreProcessing = `Não entendi bem o tipo, ${clientNameToUse}. 🤔 Pode ser Pessoal (PF), Empresa (PJ) ou MEI?`;
                }
            } else if (state.currentAction === 'awaiting_first_account_name') {
                const accountName = messageText.trim();
                if (accountName.length > 2 && accountName.length < 100) {
                    const newAccount = await clientService.createFinancialAccount(client.id, {
                        accountName: accountName,
                        accountType: state.data.accountTypeToCreate,
                        isDefault: true
                    });
                    state.activeFinancialAccountId = newAccount.id;
                    state.activeFinancialAccountName = newAccount.accountName;
                    state.activeFinancialAccountType = newAccount.accountType;
                    replyForPreProcessing = `Perfeito, ${clientNameToUse}! Sua conta "${newAccount.accountName}" (${newAccount.accountType}) foi criada e já está selecionada! 🎉 Como posso te ajudar agora com ela?`;
                    state.currentAction = null; state.data = {};
                    stateHandledInPreProcessing = true;
                } else {
                    replyForPreProcessing = `Esse nome parece um pouco curto ou longo demais, ${clientNameToUse}. Poderia me dizer um nome entre 3 e 100 letras para sua conta? ✍️`;
                }
            } else if (state.currentAction === 'selecting_initial_financial_account') {
                 const chosenAccountNameRaw = messageText.trim();
                 const accountToSelect = state.data.accountsToList.find(acc => acc.name.toLowerCase() === chosenAccountNameRaw.toLowerCase() || acc.name.toLowerCase().includes(chosenAccountNameRaw.toLowerCase()));
                 if (accountToSelect) {
                    state.activeFinancialAccountId = accountToSelect.id;
                    state.activeFinancialAccountName = accountToSelect.name;
                    state.activeFinancialAccountType = accountToSelect.type;
                    replyForPreProcessing = `Entendido, ${clientNameToUse}! Selecionei a conta "${state.activeFinancialAccountName}". Como posso ajudar? 🚀`;
                    state.currentAction = null; state.data = {};
                    stateHandledInPreProcessing = true;
                 } else {
                    let errorReply = `Hum, ${clientNameToUse}, não encontrei uma conta com o nome parecido com "${chosenAccountNameRaw}". 😕 Você tem estas opções:\n`;
                    state.data.accountsToList.forEach(acc => {errorReply += `\n- *${acc.name}* (${acc.type})`});
                    errorReply += "\n\nQual delas gostaria de usar? 🤔"
                    replyForPreProcessing = errorReply;
                 }
            }
            // Adicionar aqui tratamento para awaiting_transaction_edit_details, awaiting_appointment_edit_details, etc.
            // Se o currentAction for um desses, a mensagem atual é a descrição da alteração.
            // A IA deve pegar essa mensagem e o state.editingResource para processar a edição.
            // Não precisa de replyForPreProcessing aqui, a IA vai lidar.
            else if (state.currentAction === 'awaiting_transaction_edit_details' || state.currentAction === 'awaiting_appointment_edit_details') {
                // Não faz nada aqui, deixa a IA processar a mensagem como a descrição da edição.
                // A IA usará state.editingResource.id e state.editingResource.type
                stateHandledInPreProcessing = false; // Importante para que a IA seja chamada
                state.currentAction = null; // Limpa para a IA detectar a ação UPDATE
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
            clientName: clientNameToUse, // Usar o nome do estado
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
            currentStateData: state.data,
            editingResource: state.editingResource, // Passa para a IA saber se está editando algo
        };
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponse: JSON.stringify(aiResponse).substring(0,500) + "..."});
        state.lastAiResponse = aiResponse;

        let finalReplyParts = [];
        if (aiResponse.overall_summary_suggestion) {
            finalReplyParts.push(aiResponse.overall_summary_suggestion);
        }

        let requiresConfirmationByAI = false;
        let singleActionFormattedResult = null;
        let multipleActionFormattedResults = [];
        let actionWasAnEdit = false; // Flag para saber se a ação principal foi uma edição

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            for (const detectedAction of aiResponse.detected_actions) {
                const params = detectedAction.parameters || {};
                const MIN_CONFIDENCE_FOR_AUTO_ACTION = 0.70;

                if (detectedAction.confidence < MIN_CONFIDENCE_FOR_AUTO_ACTION &&
                    !['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO'].includes(detectedAction.action)) {
                    requiresConfirmationByAI = true;
                    state.pendingConfirmation = detectedAction;
                    break;
                }

                let currentActionFormatted = "";
                let resourceForButtons = null; // Para armazenar o recurso criado/editado para os botões
                let isEditAction = false;

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
                            const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                            currentActionFormatted = formatFinancialTransactionSummary(reloadedTx, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) resourceForButtons = { type: 'transaction', id: newTx.id, description: newTx.description };
                            break;
                        }
                        case 'UPDATE_FINANCIAL_TRANSACTION': {
                            isEditAction = true;
                            const transactionIdToUpdate = params.transactionIdToUpdate || state.editingResource?.id;
                            if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não encontrado.");

                            const updateTxData = { ...params }; // Copia todos os params
                            if (params.financialCategoryName) updateTxData.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || null);
                            if (params.creditCardName) updateTxData.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                            delete updateTxData.transactionIdToUpdate; delete updateTxData.financialCategoryName; delete updateTxData.creditCardName;

                            const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateTxData);
                            const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);
                            // A IA já deve ter gerado a mensagem caprichada, mas podemos ter um fallback aqui.
                            currentActionFormatted = aiResponse.reply_to_user_suggestion || formatFinancialTransactionSummary(reloadedUpdatedTx, false, true);
                            actionWasAnEdit = true; // Sinaliza que foi uma edição
                            break;
                        }
                        case 'SCHEDULE_APPOINTMENT': {
                            let eventDateTime = params.eventDateTime;
                            if (params.eventDateTime && params.eventDateTime.length === 10) {
                                eventDateTime += ' 09:00';
                            }
                            const appData = {
                                title: params.title, eventDateTime: eventDateTime,
                                durationMinutes: params.durationMinutes, location: params.location,
                                reminderLeadTimeMinutes: params.reminderLeadTimeMinutes, notes: params.notes
                            };
                            const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                            const reloadedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newApp.id);
                            currentActionFormatted = formatAppointmentSummary(reloadedApp, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) resourceForButtons = { type: 'appointment', id: newApp.id, description: newApp.title };
                            break;
                        }
                        case 'UPDATE_APPOINTMENT': {
                            isEditAction = true;
                            const appointmentIdToUpdate = params.appointmentIdToUpdate || state.editingResource?.id;
                            if (!appointmentIdToUpdate) throw new Error("ID do compromisso para atualizar não encontrado.");

                            const updateAppData = { ...params };
                            delete updateAppData.appointmentIdToUpdate;
                            const updatedApp = await appointmentService.updateAppointment(state.activeFinancialAccountId, appointmentIdToUpdate, updateAppData);
                            const reloadedUpdatedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, updatedApp.id);
                            currentActionFormatted = aiResponse.reply_to_user_suggestion || formatAppointmentSummary(reloadedUpdatedApp, false, true);
                            actionWasAnEdit = true;
                            break;
                        }
                        case 'CREATE_RECURRING_RULE': {
                            const catRecId = params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null;
                            let ruleValue = parseFloat(params.value);
                            if ((isNaN(ruleValue) || ruleValue <= 0) && params.description && params.description.toLowerCase().includes('netflix')) {
                                ruleValue = 55.90;
                                logger.info(`[WHATSAPP SERVICE] Valor para Netflix não fornecido, usando padrão ${ruleValue}`);
                            }
                            const ruleData = {
                                description: params.description, type: params.type, value: ruleValue || 0,
                                frequency: params.frequency, startDate: params.startDate,
                                interval: params.interval || 1, dayOfMonth: params.dayOfMonth, dayOfWeek: params.dayOfWeek,
                                endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction || false,
                                financialCategoryId: catRecId, notes: params.notes
                            };
                            const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                            const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);
                            currentActionFormatted = formatRecurringRuleSummary(reloadedRule, aiResponse.detected_actions.length > 1);
                            // if (aiResponse.detected_actions.length === 1) resourceForButtons = { type: 'recurring_rule', id: newRule.id, description: newRule.description }; // Se tiver botões
                            break;
                        }
                         case 'CREATE_PRODUCT': {
                            if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                currentActionFormatted = `Desculpe, ${clientNameToUse}, mas o cadastro de produtos é apenas para contas PJ ou MEI. Sua conta "${state.activeFinancialAccountName}" é do tipo ${state.activeFinancialAccountType}.`;
                                break;
                            }
                            const productData = {
                                name: params.name, salePrice: parseFloat(params.salePrice), code: params.code,
                                costPrice: params.costPrice ? parseFloat(params.costPrice) : null,
                                quantity: params.initialQuantity !== undefined ? parseInt(params.initialQuantity) : 0,
                                minimumStock: params.minimumStock !== undefined ? parseInt(params.minimumStock) : 0,
                                unit: params.unit
                            };
                            const newProd = await productService.createProduct(state.activeFinancialAccountId, productData);
                            currentActionFormatted = formatProductSummary(newProd, aiResponse.detected_actions.length > 1);
                            // if (aiResponse.detected_actions.length === 1) resourceForButtons = { type: 'product', id: newProd.id, description: newProd.name };
                            break;
                        }
                        case 'CREATE_CREDIT_CARD': {
                            const cardData = {
                                name: params.name, limit: parseFloat(params.limit),
                                closingDay: parseInt(params.closingDay), paymentDay: parseInt(params.paymentDay),
                                lastFourDigits: params.lastFourDigits, flag: params.flag,
                                isDefault: params.isDefault
                            };
                            const newCard = await creditCardService.createCreditCard(state.activeFinancialAccountId, cardData);
                            currentActionFormatted = formatCreditCardSummary(newCard, aiResponse.detected_actions.length > 1);
                            // if (aiResponse.detected_actions.length === 1) resourceForButtons = { type: 'credit_card', id: newCard.id, description: newCard.name };
                            break;
                        }
                        // ... Outros cases (GET_FINANCIAL_SUMMARY, LIST_*, MARK_AS_PAID, etc.)
                        case 'GET_FINANCIAL_SUMMARY': {
                            const filterParams = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                            };
                            if (params.period) {
                                const todayLocale = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
                                todayLocale.setHours(0,0,0,0);
                                switch(params.period.toLowerCase()) { // Normaliza para minúsculas
                                    case 'hoje': filterParams.dateStart = filterParams.dateEnd = todayLocale.toISOString().split('T')[0]; break;
                                    case 'ontem': const y = new Date(todayLocale); y.setDate(y.getDate() - 1); filterParams.dateStart = filterParams.dateEnd = y.toISOString().split('T')[0]; break;
                                    case 'esta_semana': case 'esta semana':
                                        const day = todayLocale.getDay(); const diff = todayLocale.getDate() - day + (day === 0 ? -6 : 1);
                                        const first = new Date(todayLocale.setDate(diff));
                                        const last = new Date(first); last.setDate(first.getDate() + 6);
                                        filterParams.dateStart = first.toISOString().split('T')[0]; filterParams.dateEnd = last.toISOString().split('T')[0]; break;
                                    case 'este_mes': case 'este mês':
                                        filterParams.dateStart = new Date(todayLocale.getFullYear(), todayLocale.getMonth(), 1).toISOString().split('T')[0];
                                        filterParams.dateEnd = new Date(todayLocale.getFullYear(), todayLocale.getMonth() + 1, 0).toISOString().split('T')[0]; break;
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
                                isPaidOrReceived: params.isPaidOrReceived, searchTerm: params.searchTerm || params.description, // A IA pode usar 'description' como searchTerm
                                limit: 5, page: 1, sortBy: params.sortBy || 'transactionDate', sortOrder: params.sortOrder || 'DESC'
                            };
                            // Adicionar lógica de período se necessário
                            const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList);
                            if (totalItems === 0) {
                                currentActionFormatted = `Nenhuma transação encontrada para os filtros que você pediu, ${clientNameToUse}. 👍 Tente outros filtros!`;
                            } else {
                                let listText = `📜 Encontrei ${totalItems} transações. As mais recentes são:\n`;
                                for (const t of transactions) {
                                    const catName = t.category ? t.category.name : 'Sem Categoria';
                                    const emoji = t.type === 'Entrada' ? '🟢' : '🔴';
                                    const date = new Date(t.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'});
                                    listText += `\n${emoji} ${t.description} - R$ ${parseFloat(t.value).toFixed(2)}\n    (${catName} em ${date})`;
                                    if (t.isPayableOrReceivable) {
                                        listText += t.isPaidOrReceived ? " (Liquidada ✅)" : ` (Vence ${new Date(t.dueDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})} 🗓️)`;
                                    }
                                }
                                if (totalItems > 5) listText += `\n\nE mais ${totalItems - 5} transações. Peça para ver mais se quiser! 😉`;
                                currentActionFormatted = listText;
                            }
                            break;
                        }
                        case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                            // A IA deve fornecer transactionDescription ou algo para identificar a transação.
                            // Idealmente, o usuário clicaria em um botão "Marcar como Paga" em uma transação listada.
                            // Se for por descrição, pode ser impreciso.
                            // Vamos assumir que a IA passou um ID se o fluxo de edição/botão estiver ativo
                            // Ou que ela está confiante na descrição para encontrar UMA transação.
                            let transactionToMark = null;
                            if (state.editingResource && state.editingResource.type === 'transaction') {
                                transactionToMark = await financialService.getTransactionById(state.activeFinancialAccountId, state.editingResource.id);
                            } else if (params.transactionDescription) {
                                const searchResults = await financialService.getAllTransactions(state.activeFinancialAccountId, {
                                    search: params.transactionDescription,
                                    isPayableOrReceivable: true,
                                    isPaidOrReceived: false, // Só pode marcar o que está pendente
                                    limit: 1,
                                    value: params.transactionValue // Filtra por valor se fornecido, para maior precisão
                                });
                                if (searchResults.transactions.length === 1) {
                                    transactionToMark = searchResults.transactions[0];
                                } else if (searchResults.transactions.length > 1) {
                                    currentActionFormatted = `Encontrei várias transações pendentes com essa descrição, ${clientNameToUse}. 🤔 Poderia ser mais específico ou usar a plataforma para marcar?`;
                                    break;
                                }
                            }

                            if (!transactionToMark) {
                                currentActionFormatted = `Não encontrei uma transação pendente clara para "${params.transactionDescription || 'a transação mencionada'}" para marcar como paga/recebida, ${clientNameToUse}. 😕`;
                            } else {
                                const updatedTx = await financialService.markAsPaidOrReceived(state.activeFinancialAccountId, transactionToMark.id, params.paymentDate);
                                currentActionFormatted = ` oba, ${clientNameToUse}! 🎉 Transação "${updatedTx.description}" marcada como ${updatedTx.type === 'Entrada' ? 'recebida' : 'paga'} com sucesso!`;
                            }
                            break;
                        }


                        default:
                            if (aiResponse.detected_actions.length === 1 && aiResponse.reply_to_user_suggestion && !aiResponse.overall_summary_suggestion) {
                                currentActionFormatted = aiResponse.reply_to_user_suggestion;
                            } else {
                                currentActionFormatted = `Ação "${detectedAction.action}" ${params.description ? `para "${params.description}"` : ''} foi entendida, ${clientNameToUse}.`;
                            }
                            if ((detectedAction.action === "GENERAL_GREETING_OR_SMALLTALK" || detectedAction.action === "GENERAL_QUESTION_OR_HELP") && aiResponse.reply_to_user_suggestion) {
                                finalReplyParts = [aiResponse.reply_to_user_suggestion]; // Substitui a saudação se houver
                                multipleActionFormattedResults = []; // Limpa outras ações se for só conversa
                                break; // Sai do loop de ações
                            }
                            break;
                    }

                    if (currentActionFormatted) {
                        if (aiResponse.detected_actions.length === 1 && !isEditAction) { // Se for edição, a IA já formatou a mensagem inteira
                            singleActionFormattedResult = currentActionFormatted;
                        } else if (!isEditAction) {
                            multipleActionFormattedResults.push(currentActionFormatted);
                        } else { // Foi uma edição, e a IA já deu a resposta completa
                            singleActionFormattedResult = currentActionFormatted; // Assume que a IA já fez o capricho
                        }
                    }
                    // Armazena o recurso para botões se aplicável
                    if (resourceForButtons && aiResponse.detected_actions.length === 1) {
                        state.editingResource = resourceForButtons; // Salva para possível uso de botões
                    }

                } catch (e) {
                    logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack, params: params });
                    const errorMsgPart = `Ops! 😬 Tive um problema ao tentar processar "${params.description || detectedAction.action}". (${e.message.length < 80 ? e.message : 'Erro interno, desculpe!'}). Pode tentar de novo ou com outros termos?`;
                    if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = errorMsgPart;
                    else multipleActionFormattedResults.push(errorMsgPart);
                }
            }
        }

        // --- Construção da Resposta Final ---
        if (requiresConfirmationByAI && state.pendingConfirmation) {
            const descToConfirm = state.pendingConfirmation.parameters?.description || state.pendingConfirmation.parameters?.title || state.pendingConfirmation.action;
            finalReplyParts = [aiResponse.reply_to_user_suggestion || `Hmm, ${clientNameToUse}, entendi que você quer fazer algo como "${descToConfirm}". É isso mesmo? (Sim/Não) 🤔`];
            state.currentAction = 'awaiting_confirmation';
        } else if (singleActionFormattedResult) {
            if (finalReplyParts.length > 0 && !actionWasAnEdit) { // Se já tem saudação e não é edição
                finalReplyParts.push(aiResponse.reply_to_user_suggestion || "Anotado! 📝"); // Frase de transição da IA ou fallback
                finalReplyParts.push(singleActionFormattedResult);
            } else { // Se não tem saudação, ou é uma edição (IA já formatou tudo)
                finalReplyParts = [singleActionFormattedResult];
            }
        } else if (multipleActionFormattedResults.length > 0) {
            if (finalReplyParts.length === 0) { // Se não houve saudação da IA (overall_summary_suggestion)
                finalReplyParts.push(`${clientNameToUse}, aqui está o que eu fiz pra você! 😉`);
            } else { // Já tem a saudação
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion || "Olha só o que aprontamos: ✨"); // Transição
            }
            finalReplyParts.push(multipleActionFormattedResults.join("\n\n---\n\n"));
        } else if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            finalReplyParts = [aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe: ${aiResponse.clarifications_needed[0].clarification_question}`];
            state.currentAction = 'awaiting_clarification_response';
            state.data.clarificationContext = { action: aiResponse.clarifications_needed[0].original_intent_action_suggestion };
        } else if (aiResponse.reply_to_user_suggestion) {
            if (finalReplyParts.length === 0 || (finalReplyParts.length === 1 && finalReplyParts[0] === aiResponse.overall_summary_suggestion)) {
                finalReplyParts = [aiResponse.reply_to_user_suggestion];
            } else if (!finalReplyParts.join(" ").includes(aiResponse.reply_to_user_suggestion)) {
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion);
            }
        } else {
            finalReplyParts.push(`Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊 Estou por aqui!`);
        }

        const performedConcreteAction = (singleActionFormattedResult || multipleActionFormattedResults.length > 0) && !aiResponse.clarifications_needed?.length && !requiresConfirmationByAI;
        if (performedConcreteAction) {
            const platformUrl = process.env.PLATFORM_URL || 'app.meuassessor.com';
            if (platformUrl !== 'app.meuassessor.com' || process.env.PLATFORM_URL) { // Evita URL padrão se não configurada
                 finalReplyParts.push(`\n📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}`);
            }
            if (!finalReplyParts.some(p => p.toLowerCase().includes("algo a mais") || p.toLowerCase().includes("só chamar") || p.toLowerCase().includes("à disposição"))) {
                 finalReplyParts.push(`Se precisar de algo a mais é só me chamar, ${clientNameToUse}! 😄`);
            }
        }

        const completeFinalReply = finalReplyParts.join("\n\n").trim();
        state.messageHistory.push({ role: 'assistant', content: completeFinalReply });

        // Lógica de limpeza de estado
        if (!requiresConfirmationByAI && state.currentAction !== 'awaiting_clarification_response' &&
            !state.currentAction?.startsWith('selecting_initial_financial_account') &&
            !state.currentAction?.startsWith('creating_first_account') &&
            !state.currentAction?.startsWith('awaiting_') && // Mantém estados de edição explícitos
            !state.editingResource // Não limpa se acabou de setar para botões
            ) {
            if (state.currentAction !== 'awaiting_confirmation') {
                // state.currentAction = null; // Limpar com cautela, a IA pode precisar do contexto
                // state.data = {};
            }
        }
        if (actionWasAnEdit) state.editingResource = null; // Limpa após uma edição bem sucedida pela IA

        conversationState.set(senderPhone, state);

        // Envio de Resposta Final
        if (completeFinalReply) {
            const resourceForButtonsContext = state.editingResource; // Pega o que foi setado antes de limpar se for o caso
            if (resourceForButtonsContext && !requiresConfirmationByAI && aiResponse.detected_actions?.length === 1 && !actionWasAnEdit) {
                let buttons = [];
                const buttonTitle = `Opções para "${(resourceForButtonsContext.description || "item").substring(0,20)}":`;
                if (resourceForButtonsContext.type === 'transaction') {
                    buttons = [
                        { id: `edit_transaction_${resourceForButtonsContext.id}`, label: "Editar Transação ✍️" },
                        { id: `delete_transaction_${resourceForButtonsContext.id}`, label: "Excluir Transação 🗑️" },
                    ];
                } else if (resourceForButtonsContext.type === 'appointment') {
                    buttons = [
                        { id: `edit_appointment_${resourceForButtonsContext.id}`, label: "Editar Compromisso ✍️" },
                        { id: `delete_appointment_${resourceForButtonsContext.id}`, label: "Excluir Compromisso 🗑️" },
                    ];
                }
                // Adicionar para recorrência, produto, cartão se tiver botões

                if (buttons.length > 0) {
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
        conversationState.delete(senderPhone); // Limpa estado em erro crítico para recomeçar
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
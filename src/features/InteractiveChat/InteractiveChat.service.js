// src/features/InteractiveChat/interactiveChat.service.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service');
const financialCategoryService = require('../FinancialCategory/financialCategory.service'); // Importar o novo serviço de categoria

const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');

const siteChatConversationState = new Map();
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;

// Funções auxiliares de formatação
function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const safeDateString = dateString.length === 10 ? `${dateString}T00:00:00Z` : dateString;
    try {
        return new Date(safeDateString).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    } catch (e) { return 'Data Inválida'; }
}
function formatTime(dateTimeString, includeSeconds = true) {
    if (!dateTimeString) return 'N/A';
    const options = { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' };
    if (includeSeconds) options.second = '2-digit';
    try {
        return new Date(dateTimeString).toLocaleTimeString('pt-BR', options);
    } catch (e) { return 'Hora Inválida'; }
}
function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(parseFloat(value))) return 'R$ --,--';
    return `R$${parseFloat(value).toFixed(2).replace('.', ',')}`;
}

function getPaymentMethodClarificationMessage(clientName, cards = []) {
    let message = `Opa, ${clientName}! 🚀 Quase lá! Só preciso saber como foi feito o pagamento:\n\n`;
    message += `💸 *Formas aceitas:*\n`;
    message += `• 💎 Pix\n`;
    message += `• 💵 Dinheiro\n`;

    if (cards && cards.length > 0) {
        message += `• 💳 Cartão de Crédito:\n`;
        cards.forEach((card, index) => {
            message += `  ${index + 1} - ${card.name}\n`;
        });
    }

    message += `\nQual dessas opções você utilizou? 😉`;
    return message;
}
function formatPlatformLink(customText = "") {
    const platformUrl = process.env.REACT_APP_BASE_URL || 'map-nocontrole.com.br';
    const defaultText = `📊 Para visualizar mais detalhes e relatórios, acesse outras áreas da plataforma. Qualquer coisa, estou por aqui! 😉`;
    return customText || defaultText;
}

// Funções de formatação de dados estruturados
function formatFinancialTransactionDataStructure(transaction) {
    if (!transaction) return "🎯 Resumo da Transação:\n\nDados não disponíveis.";
    let data = `🎯 Resumo da Transação:\n\n`;
    data += `📝 Descrição: ${transaction.description || 'N/A'}\n`;
    data += `💰 Valor: ${formatCurrency(transaction.value)}\n`;
    if (transaction.category && transaction.category.name) {
        data += `${transaction.type === 'Entrada' ? '💸' : (transaction.creditCardId ? '💳' : '🏷️')} Categoria: ${transaction.category.name}\n`;
    } else {
        data += `🏷️ Categoria: Não especificada\n`;
    }
    data += `📅 Data: ${formatDate(transaction.transactionDate)}\n`;

    if (transaction.creditCard && transaction.creditCard.name) {
        data += `💳 Cartão: ${transaction.creditCard.name}\n`;
    }

    if (transaction.isPayableOrReceivable && !transaction.creditCardId) {
        data += `🗓️ Vencimento: ${formatDate(transaction.dueDate)}\n`;
        data += `✅ Status: ${transaction.isPaidOrReceived ? (transaction.type === 'Entrada' ? 'Recebido' : 'Pago') : 'Pendente'}\n`;
        if (transaction.isPaidOrReceived && transaction.paymentDate) {
            data += `🧾 Data Pgto/Rec: ${formatDate(transaction.paymentDate)}\n`;
        }
    } else if (!transaction.creditCardId) {
        data += `✅ Status: ${transaction.type === 'Entrada' ? 'Recebido' : 'Pago'}\n`;
    } else {
        data += `✅ Status: Lançada no cartão\n`;
    }

    if (transaction.isParcel && transaction.parcelNumber && transaction.totalParcels && transaction.originalAccount) {
        data += `📦 Parcela: ${transaction.parcelNumber} de ${transaction.totalParcels}\n`;
        data += `🛒 Compra Original: ${transaction.originalAccount.description.replace(/ - Parcela \d+\/\d+$/, '').trim()}\n`;
    }

    if (transaction.notes) {
        data += `🗒️ Observações: ${transaction.notes}\n`;
    }
    return data.trim();
}
function formatAppointmentDataStructure(appointment) {
    if (!appointment) return "📅 Resumo do Compromisso:\n\nDados não disponíveis.";
    let data = `📅 Resumo do Compromisso:\n\n`;
    data += `💼 Descrição: ${appointment.title || 'N/A'}\n`;
    data += `📆 Data: ${formatDate(appointment.eventDateTime)}\n`;
    data += `🕔 Horário de início: ${formatTime(appointment.eventDateTime)}\n`;

    if (appointment.durationMinutes) {
        const endTime = new Date(new Date(appointment.eventDateTime).getTime() + appointment.durationMinutes * 60000);
        data += `🕔 Horário de término: ${formatTime(endTime)}\n`;
    }
    if (appointment.location) {
        data += `📍 Local: ${appointment.location}\n`;
    }
    if (appointment.status) {
        data += `🚦 Status: ${appointment.status}\n`;
    }
    if (appointment.associatedValue && appointment.associatedTransactionType) {
        data += `💰 Valor Associado: ${formatCurrency(appointment.associatedValue)} (${appointment.associatedTransactionType})\n`;
    }
    if (appointment.notes) {
        data += `🗒️ Observações: ${appointment.notes}\n`;
    }
    return data.trim();
}
function formatRecurringRuleDataStructure(rule) {
    if (!rule) return "🧾 Resumo da Transação Recorrente:\n\nDados não disponíveis.";
    let data = `🧾 Resumo da Transação Recorrente:\n\n`;
    data += `📜 Descrição: ${rule.description || 'N/A'}\n`;
    data += `💰 Valor: ${formatCurrency(rule.value)} (${rule.type})\n`;
    if (rule.category && rule.category.name) {
        data += `💼 Categoria: ${rule.category.name}\n`;
    } else {
        data += `💼 Categoria: Não especificada\n`;
    }
    data += `📅 Data inicial: ${formatDate(rule.startDate)}\n`;
    if (rule.endDate) {
        data += `📅 Data final: ${formatDate(rule.endDate)}\n`;
    }
    let frequencyText = rule.frequency ? (rule.frequency.charAt(0).toUpperCase() + rule.frequency.slice(1)) : 'N/A';
    if (rule.interval && rule.interval > 1) {
        const pluralMap = { daily: 'dias', weekly: 'semanas', monthly: 'meses', annually: 'anos', 'bi-weekly': 'quinzenas', quarterly: 'trimestres', 'semi-annually': 'semestres' };
        frequencyText = `A cada ${rule.interval} ${pluralMap[rule.frequency] || (rule.frequency ? rule.frequency.replace('ly', 's') : 'períodos')}`;
    } else if (rule.frequency) {
        const singleMap = { daily: 'Diária', weekly: 'Semanal', monthly: 'Mensal', annually: 'Anual', 'bi-weekly': 'Quinzenal', quarterly: 'Trimestral', 'semi-annually': 'Semestral' };
        frequencyText = singleMap[rule.frequency] || frequencyText;
    }
    data += `🔄 Frequência: ${frequencyText}\n`;

    if (rule.dayOfWeek !== null && rule.dayOfWeek !== undefined && (rule.frequency === 'weekly' || rule.frequency === 'bi-weekly')) {
        const days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
        data += `🗓️ Dia da Semana: ${days[rule.dayOfWeek]}\n`;
    }
    if (rule.dayOfMonth && rule.frequency === 'monthly') { // Mostra apenas se for mensal e tiver dayOfMonth
        data += `🗓️ Dia do Mês: ${rule.dayOfMonth}\n`;
    }
    data += `➡️ Próximo Vencimento: ${rule.nextDueDate ? formatDate(rule.nextDueDate) : 'N/A (Regra Inativa)'}\n`;
    data += `⚙️ Criação Automática: ${rule.autoCreateTransaction ? 'Sim' : 'Não (Apenas Lembrete)'}\n`;
    data += `🚦 Status da Regra: ${rule.isActive ? 'Ativa' : 'Inativa'}\n`;
    return data.trim();
}
function formatCreditCardListDataStructure(cards) {
    if (!cards || cards.length === 0) return "📋 Resumo dos Cartões:\n\nNenhum cartão de crédito cadastrado.";
    let data = `📋 Resumo dos Cartões:\n`;
    cards.forEach((card, index) => {
        data += `\n${index + 1}️⃣ Cartão: ${card.name || 'N/A'}\n`;
        if (card.flag) data += `🏷️ Bandeira: ${card.flag}\n`;
        if (card.lastFourDigits) data += `💳 Número: **** **** **** ${card.lastFourDigits}\n`;
        if (card.availableLimit !== undefined) {
            data += `💰 Limite disponível: ${formatCurrency(card.availableLimit)}\n`;
        } else {
            data += `💰 Limite Total: ${formatCurrency(card.limit)}\n`;
        }
        if (card.isDefault) data += `⭐ Cartão Padrão\n`;
    });
    return data.trim();
}
function formatCreditCardInvoiceDataStructure(invoiceDetails, listTransactions = true) {
    if (!invoiceDetails) return "🎯 Resumo da Fatura:\n\nDados da fatura não disponíveis.";
    let data = `🎯 Resumo da Fatura - Cartão ${invoiceDetails.cardName || 'N/A'}:\n\n`;
    data += `📅 Mês de Referência: ${invoiceDetails.invoiceReferenceMonthYear || 'N/A'}\n`;
    data += `💰 Total da fatura: ${formatCurrency(invoiceDetails.totalAmount)}\n`;
    if (invoiceDetails.availableLimitAfterInvoice !== undefined) {
        data += `💳 Limite disponível (após esta fatura): ${formatCurrency(invoiceDetails.availableLimitAfterInvoice)}\n`;
    } else if (invoiceDetails.cardTotalLimit !== undefined) {
        const available = parseFloat(invoiceDetails.cardTotalLimit) - parseFloat(invoiceDetails.totalAmount);
        data += `💳 Limite Total do Cartão: ${formatCurrency(invoiceDetails.cardTotalLimit)}\n`;
        data += `💳 Saldo Estimado Pós-Fatura: ${formatCurrency(available)}\n`;
    }
    data += `🗓️ Fechamento: ${formatDate(invoiceDetails.invoiceCycleEndDate)}\n`;
    data += `🗓️ Vencimento: ${formatDate(invoiceDetails.paymentDueDate)}\n`;

    if (listTransactions && invoiceDetails.transactions && invoiceDetails.transactions.length > 0) {
        data += `\n📄 Detalhamento das Compras:\n`;
        invoiceDetails.transactions.forEach((tx, index) => {
            let parcelInfo = "";
            if (tx.isParcel && tx.parcelNumber && tx.totalParcels) {
                parcelInfo = ` (${tx.parcelNumber}/${tx.totalParcels})`;
            } else {
                parcelInfo = ` — à vista`;
            }
            data += `\n${index + 1}️⃣ ${tx.description} — ${formatCurrency(tx.value)}${parcelInfo}`;
        });
    } else if (listTransactions && (!invoiceDetails.transactions || invoiceDetails.transactions.length === 0)) {
        data += `\n📄 Nenhuma transação encontrada para esta fatura.\n`;
    }
    return data.trim();
}
function formatAvailableLimitDataStructure(limitInfo) {
    if (!limitInfo) return "💳 Limite Disponível:\n\nDados de limite não disponíveis.";
    let data = `💳 Limite Disponível - Cartão ${limitInfo.cardName || 'N/A'}:\n\n`;
    data += `💰 Limite Total: ${formatCurrency(limitInfo.totalLimit)}\n`;
    data += `💸 Valor Utilizado (Fatura Aberta): ${formatCurrency(limitInfo.netUsedAmount)}\n`;
    data += `✅ Limite Disponível Agora: ${formatCurrency(limitInfo.availableLimit)}\n`;
    data += `🗓️ Próximo Fechamento: Dia ${limitInfo.closingDay}\n`;
    data += `🗓️ Dia de Pagamento: Dia ${limitInfo.paymentDay}\n`;
    return data.trim();
}
function formatParcelledAccountDataStructure(parcelParams, parcelResult) {
    if (!parcelResult || !parcelResult.parcels || parcelResult.parcels.length === 0) return "🎯 Resumo da Compra Parcelada:\n\nDados não disponíveis.";
    const firstParcel = parcelResult.parcels[0];
    let data = `🎯 Resumo da Compra Parcelada:\n\n`;
    data += `📝 Descrição: ${parcelParams.description || firstParcel.description.replace(/ - Parcela \d+\/\d+$/, '')}\n`;
    data += `💰 Valor Total: ${formatCurrency(parcelParams.totalValue)}\n`;
    data += `📦 Parcelas: ${parcelParams.numberOfParcels}x de ${formatCurrency(firstParcel.value)} (aprox.)\n`;
    if (parcelParams.creditCardName) {
        data += `💳 Cartão: ${parcelParams.creditCardName}\n`;
    } else if (firstParcel.creditCard && firstParcel.creditCard.name) {
        data += `💳 Cartão: ${firstParcel.creditCard.name}\n`;
    }
    if (parcelParams.financialCategoryName) { // Nome da categoria vindo da IA
        data += `🏷️ Categoria: ${parcelParams.financialCategoryName}\n`;
    } else if (firstParcel.category && firstParcel.category.name) { // Nome da categoria do objeto BD
        data += `🏷️ Categoria: ${firstParcel.category.name}\n`;
    }
    data += `📅 Data da Compra: ${formatDate(parcelParams.transactionDate || firstParcel.transactionDate)}\n`;
    data += `🗓️ Venc. 1ª Parcela: ${formatDate(parcelParams.initialDueDate || firstParcel.dueDate || firstParcel.transactionDate)}\n`;
    return data.trim();
}
function formatAccountSelectionDataStructure(accounts, currentAccountId = null) {
    if (!accounts || accounts.length === 0) return "🏷️ Perfis disponíveis:\n\nNenhum perfil financeiro encontrado.";
    let data = `🏷️ Perfis disponíveis:\n`;
    accounts.forEach((acc, index) => {
        data += `\n${index + 1}️⃣ ${acc.name} (${acc.type})${currentAccountId === acc.id ? ' (Selecionado ✨)' : ''}`;
    });
    return data.trim();
}
function formatProductDataStructure(product) {
    if (!product) return "📦 Resumo do Produto:\n\nDados do produto não disponíveis.";
    let data = `📦 Resumo do Produto:\n\n`;
    data += `🏷️ Nome: ${product.name}\n`;
    if (product.code) data += `🔢 Código: ${product.code}\n`;
    data += `💰 Preço de Venda: ${formatCurrency(product.salePrice)}\n`;
    if (product.costPrice) data += `💲 Preço de Custo: ${formatCurrency(product.costPrice)}\n`;
    data += `🛍️ Estoque Atual: ${product.quantity} ${product.unit || 'UN'}\n`;
    if (product.minimumStock) data += `📉 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    if (product.description && product.description.trim() !== "") data += `📄 Descrição Detalhada: ${product.description}\n`;
    return data.trim();
}
function formatMotivationalMessagePreferenceDataStructure(prefs) {
    let data = `💬 Preferências de Mensagem Motivacional:\n\n`;
    data += `🚦 Status: ${prefs.enableMotivationMessage ? 'Ativada ✅' : 'Desativada ❌'}\n`;
    if (prefs.enableMotivationMessage && prefs.motivationMessageTime) {
        data += `🕒 Horário Programado: ${prefs.motivationMessageTime.substring(0, 5)}\n`;
    }
    return data.trim();
}
function formatWaterReminderPreferenceDataStructure(prefs) {
    let data = `💧 Preferências de Lembrete de Água:\n\n`;
    data += `🚦 Status: ${prefs.enableWaterReminder ? 'Ativado ✅' : 'Desativado ❌'}\n`;
    if (prefs.enableWaterReminder) {
        let freqText = 'N/A';
        if (prefs.waterReminderFrequencyType === '2h') freqText = 'A cada 2 horas';
        else if (prefs.waterReminderFrequencyType === '3h') freqText = 'A cada 3 horas';
        else if (prefs.waterReminderFrequencyType === 'custom' && prefs.waterReminderCustomIntervalMinutes) {
            freqText = `Personalizado: a cada ${prefs.waterReminderCustomIntervalMinutes} minutos`;
        }
        data += `🔄 Frequência: ${freqText}\n`;
        data += `🌅 Início: ${prefs.waterReminderStartTime ? prefs.waterReminderStartTime.substring(0, 5) : 'N/A'}\n`;
        data += `🌃 Fim: ${prefs.waterReminderEndTime ? prefs.waterReminderEndTime.substring(0, 5) : 'N/A'}\n`;
        if (prefs.dailyGoalMl) {
            data += `🎯 Meta Diária: ${prefs.dailyGoalMl}ml\n`;
        }
    }
    return data.trim();
}

// Funções auxiliares de busca
async function findFinancialCategoryIdByNameForChat(name, financialAccountId, transactionType = null) { // Renomeado para evitar conflito
    if (!name || typeof name !== 'string' || name.trim() === '' || !financialAccountId) return null;
    // Se o campo 'type' foi removido de FinancialCategory, transactionType não é mais usado para filtrar
    const category = await financialCategoryService.findFinancialCategoryByNameAndTypeForAccount(name, null, financialAccountId);
    return category ? category.id : null;
}
async function findCreditCardIdByNameForChat(name, financialAccountId) { // Renomeado
    if (!name || typeof name !== 'string' || name.trim() === '' || !financialAccountId) return null;
    try {
        const card = await creditCardService.findCreditCardByName(financialAccountId, name);
        return card ? card.id : null;
    } catch (error) {
        if (error.statusCode === 404) {
            logger.warn(`[INTERACTIVE CHAT SERVICE HELPER] Cartão "${name}" não encontrado para conta ${financialAccountId}.`);
            return null;
        }
        logger.error(`[INTERACTIVE CHAT SERVICE HELPER] Erro ao buscar cartão ${name}: ${error.message}`);
        throw error; // Relança outros erros
    }
}
async function findProductIdByNameOrCodeForChat(nameOrCode, financialAccountId) { // Renomeado
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '' || !financialAccountId) return null;
    const productsResult = await productService.getAllProducts(financialAccountId, { search: nameOrCode, limit: 1 });
    if (productsResult.products && productsResult.products.length > 0) {
        return productsResult.products[0].id;
    }
    return null;
}


async function processSiteChatMessage(userSessionId, messageText, currentProfileContext, rawPayload = {}) {
    const startTime = Date.now();
    let state = siteChatConversationState.get(userSessionId);
    const clientNameFromContext = currentProfileContext?.ownerClientName?.split(" ")[0] || currentProfileContext?.name?.split(" ")[0] || "pessoa incrível";

    if (!currentProfileContext || !currentProfileContext.id) {
        logger.error(`[INTERACTIVE CHAT SERVICE] Tentativa de processar mensagem sem currentProfileContext válido para sessionId ${userSessionId}.`);
        return {
            replyText: `Ops! Parece que não consegui identificar seu perfil ativo (${currentProfileContext?.name || 'N/A'}). Por favor, tente recarregar a página ou selecione um perfil.`,
            suggestions: [],
            structuredData: null,
            error: true
        };
    }

    if (!state || state.activeFinancialAccountId !== currentProfileContext.id) { // Se estado não existe ou perfil mudou
        state = {
            currentAction: null,
            data: {},
            activeFinancialAccountId: currentProfileContext.id,
            activeFinancialAccountName: currentProfileContext.name,
            activeFinancialAccountType: currentProfileContext.type,
            clientName: clientNameFromContext,
            messageHistory: [],
            pendingConfirmation: null,
            editingResource: null,
            lastAiResponse: null,
        };
        logger.info(`[INTERACTIVE CHAT SERVICE] ${state.messageHistory.length === 0 ? 'Novo estado' : 'Estado reiniciado (perfil mudou)'} para sessionId: ${userSessionId}, Perfil: ${currentProfileContext.name}`);
    }

    // Adicionar mensagem ao histórico
    if (!(rawPayload && rawPayload.suggestionClickedValue)) {
        state.messageHistory.push({ role: 'user', content: messageText });
    }
    if (state.messageHistory.length > MAX_STATE_HISTORY) {
        state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
    }

    const aiContext = {
        currentFinancialAccountId: state.activeFinancialAccountId,
        currentFinancialAccountType: state.activeFinancialAccountType,
        currentFinancialAccountName: state.activeFinancialAccountName,
        clientName: state.clientName,
        conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
        editingResource: state.editingResource,
    };

    const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
    state.lastAiResponse = aiResponse;

    let aiMessageIntro = aiResponse.overall_summary_suggestion ||
        (aiResponse.reply_to_user_suggestion && (!aiResponse.detected_actions || aiResponse.detected_actions.length === 0 || aiResponse.detected_actions.every(a => (a.action || a.action_type)?.startsWith("GENERAL_")))
            ? aiResponse.reply_to_user_suggestion
            : `Ok, ${state.clientName}!`);
    if (typeof aiMessageIntro !== 'string' || aiMessageIntro.trim() === "") {
        aiMessageIntro = `Ok, ${state.clientName}!`;
    }

    let structuredDataBody = "";
    let platformLinkFooter = formatPlatformLink();
    let finalMessageToReturn = "";
    let suggestionsForFrontend = [];
    let actionWasAnEdit = false;
    let resourceForUiContext = null;
    let multipleActionBodiesList = [];

    // Limpa currentAction se a IA não pediu mais clarificações e a ação não é de edição ou escolha pendente
    if (state.currentAction && typeof state.currentAction === 'string' &&
        (state.currentAction.startsWith('awaiting_')) &&
        (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
        if (!state.currentAction.includes('_edit_') && !state.currentAction.includes('_choice') && state.currentAction !== 'awaiting_confirmation' && !state.currentAction.startsWith('awaiting_explicit_')) {
            state.currentAction = null;
        }
    }
    state.pendingConfirmation = null;


    if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
        for (const detectedAction of aiResponse.detected_actions) {
            const params = detectedAction.parameters || detectedAction;
            const actionName = detectedAction.action || detectedAction.action_type;
            if (!actionName) continue;

            let currentActionFormattedData = "";
            try {
                switch (actionName) {
                    case 'CREATE_FINANCIAL_TRANSACTION': {
                        const categoryId = await findFinancialCategoryIdByNameForChat(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                        const cardId = params.creditCardName ? await findCreditCardIdByNameForChat(params.creditCardName, state.activeFinancialAccountId) : null;
                        const txData = {
                            description: params.description, type: params.type, value: parseFloat(params.value),
                            paymentMethod: params.paymentMethod,
                            transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" })).toISOString().split('T')[0],
                            financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes,
                            isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : (cardId ? false : false)),
                            dueDate: cardId ? null : params.dueDate,
                            isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (cardId ? true : (!params.dueDate))
                        };

                        if (!txData.paymentMethod) {
                            const { cards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                            aiMessageIntro = getPaymentMethodClarificationMessage(state.clientName, cards);
                            currentActionFormattedData = "";
                            break;
                        }

                        if (!txData.description || !txData.type || isNaN(txData.value) || txData.value <= 0) {
                            throw new Error("Dados insuficientes ou inválidos para criar transação (descrição, tipo, valor).");
                        }
                        const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                        const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);

                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Sua transação foi registrada, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Registrei o seguinte para você, ${state.clientName}:`;
                        currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedTx);
                        if (aiResponse.detected_actions.length === 1) resourceForUiContext = { type: 'transaction', id: newTx.id, description: newTx.description };
                        break;
                    }
                    case 'UPDATE_FINANCIAL_TRANSACTION': {
                        const transactionIdToUpdate = state.editingResource?.type === 'transaction' && state.editingResource?.id
                            ? parseInt(state.editingResource.id, 10)
                            : (params.transactionIdToUpdate ? parseInt(params.transactionIdToUpdate, 10) : null);
                        if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não foi fornecido ou não está em contexto de edição.");

                        const updateDataTx = {};
                        if (params.hasOwnProperty('description')) updateDataTx.description = params.description;
                        if (params.hasOwnProperty('value')) updateDataTx.value = parseFloat(params.value);
                        if (params.hasOwnProperty('transactionDate')) updateDataTx.transactionDate = params.transactionDate;
                        if (params.hasOwnProperty('notes')) updateDataTx.notes = params.notes;
                        if (params.hasOwnProperty('dueDate')) updateDataTx.dueDate = params.dueDate;
                        if (params.hasOwnProperty('isPaidOrReceived')) updateDataTx.isPaidOrReceived = params.isPaidOrReceived;
                        if (params.financialCategoryName) updateDataTx.financialCategoryId = await findFinancialCategoryIdByNameForChat(params.financialCategoryName, state.activeFinancialAccountId, params.type || (await financialService.getTransactionById(state.activeFinancialAccountId, transactionIdToUpdate)).type);
                        if (params.creditCardName) updateDataTx.creditCardId = await findCreditCardIdByNameForChat(params.creditCardName, state.activeFinancialAccountId);
                        else if (params.hasOwnProperty('creditCardName') && params.creditCardName === null) updateDataTx.creditCardId = null;

                        if (Object.keys(updateDataTx).length === 0) throw new Error("Nenhum dado fornecido para atualizar a transação.");

                        const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateDataTx);
                        const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);

                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Transação atualizada com sucesso, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da transação, ${state.clientName}:`;
                        currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedUpdatedTx);
                        actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                        break;
                    }
                    case 'SCHEDULE_APPOINTMENT': {
                        const eventDateTime = params.eventDateTime;
                        if (!params.title || !eventDateTime) throw new Error("Título e data/hora são obrigatórios para agendar.");

                        const appointmentData = {
                            title: params.title,
                            eventDateTime: eventDateTime,
                            durationMinutes: params.durationMinutes ? parseInt(params.durationMinutes) : null,
                            location: params.location,
                            reminderLeadTimeMinutes: params.reminderLeadTimeMinutes ? parseInt(params.reminderLeadTimeMinutes) : 15,
                            notes: params.notes,
                            associatedValue: params.associatedValue ? parseFloat(params.associatedValue) : null,
                            associatedTransactionType: params.associatedTransactionType
                        };
                        const newAppt = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appointmentData);
                        const reloadedAppt = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newAppt.id);

                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Seu compromisso foi agendado, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Agendei o seguinte para você, ${state.clientName}:`;
                        currentActionFormattedData = formatAppointmentDataStructure(reloadedAppt);
                        if (aiResponse.detected_actions.length === 1) resourceForUiContext = { type: 'appointment', id: newAppt.id, description: newAppt.title };
                        break;
                    }
                    case 'UPDATE_APPOINTMENT': {
                        const appointmentIdToUpdate = state.editingResource?.type === 'appointment' && state.editingResource?.id
                            ? parseInt(state.editingResource.id, 10)
                            : (params.appointmentIdToUpdate ? parseInt(params.appointmentIdToUpdate, 10) : null);
                        if (!appointmentIdToUpdate) throw new Error("ID do compromisso para atualizar não foi fornecido.");

                        const updateDataAppt = {};
                        if (params.hasOwnProperty('title')) updateDataAppt.title = params.title;
                        if (params.hasOwnProperty('eventDateTime')) updateDataAppt.eventDateTime = params.eventDateTime;
                        if (params.hasOwnProperty('durationMinutes')) updateDataAppt.durationMinutes = parseInt(params.durationMinutes);
                        if (params.hasOwnProperty('location')) updateDataAppt.location = params.location;
                        if (params.hasOwnProperty('reminderLeadTimeMinutes')) updateDataAppt.reminderLeadTimeMinutes = parseInt(params.reminderLeadTimeMinutes);
                        if (params.hasOwnProperty('status')) updateDataAppt.status = params.status;
                        if (params.hasOwnProperty('notes')) updateDataAppt.notes = params.notes;
                        if (params.hasOwnProperty('associatedValue')) updateDataAppt.associatedValue = parseFloat(params.associatedValue);
                        if (params.hasOwnProperty('associatedTransactionType')) updateDataAppt.associatedTransactionType = params.associatedTransactionType;

                        if (Object.keys(updateDataAppt).length === 0) throw new Error("Nenhum dado fornecido para atualizar o compromisso.");

                        const updatedAppt = await appointmentService.updateAppointment(state.activeFinancialAccountId, appointmentIdToUpdate, updateDataAppt);
                        const reloadedUpdatedAppt = await appointmentService.getAppointmentById(state.activeFinancialAccountId, updatedAppt.id);

                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Compromisso atualizado, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do compromisso, ${state.clientName}:`;
                        currentActionFormattedData = formatAppointmentDataStructure(reloadedUpdatedAppt);
                        actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                        break;
                    }
                    case 'CREATE_PARCELLED_ACCOUNT': {
                        const catIdParcel = await findFinancialCategoryIdByNameForChat(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                        const cardIdParcel = params.creditCardName ? await findCreditCardIdByNameForChat(params.creditCardName, state.activeFinancialAccountId) : null;

                        if (params.creditCardName && !cardIdParcel) {
                            const errorMsg = `Hum, ${state.clientName}, não encontrei um cartão chamado "${params.creditCardName}" para registrar essa compra parcelada. 😕 Você pode cadastrar o cartão primeiro ou tentar com outro nome.`;
                            if (aiResponse.detected_actions.length === 1) { aiMessageIntro = errorMsg; currentActionFormattedData = ""; platformLinkFooter = ""; }
                            else { multipleActionBodiesList.push(errorMsg); }
                            break;
                        }

                        const parcelData = {
                            description: params.description, type: params.type,
                            totalValue: parseFloat(params.totalValue || params.value),
                            numberOfParcels: parseInt(params.numberOfParcels),
                            paymentMethod: params.paymentMethod,
                            initialDueDate: params.initialDueDate,
                            financialCategoryId: catIdParcel, creditCardId: cardIdParcel, notes: params.notes,
                            transactionDate: params.transactionDate || params.initialDueDate || new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" })).toISOString().split('T')[0]
                        };

                        if (!parcelData.paymentMethod) {
                            const { cards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                            aiMessageIntro = getPaymentMethodClarificationMessage(state.clientName, cards);
                            currentActionFormattedData = "";
                            break;
                        }

                        if (!parcelData.description || !parcelData.type || isNaN(parcelData.totalValue) || parcelData.totalValue <= 0 || isNaN(parcelData.numberOfParcels) || parcelData.numberOfParcels < 1 || !parcelData.initialDueDate) {
                            throw new Error("Dados insuficientes ou inválidos para compra parcelada (descrição, tipo, valor total, nº parcelas, data 1ª parcela).");
                        }
                        if (!params.transactionDate && params.initialDueDate) {
                            parcelData.transactionDate = params.initialDueDate;
                        }

                        const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData);

                        if (aiResponse.detected_actions.length === 1) { aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Sua compra parcelada foi registrada, ${state.clientName}!`; }
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sua compra parcelada foi registrada, ${state.clientName}:`;
                        currentActionFormattedData = formatParcelledAccountDataStructure(parcelData, parcelResult);
                        if (aiResponse.detected_actions.length === 1 && parcelResult.parcels && parcelResult.parcels.length > 0) {
                            const originalTxId = parcelResult.parcels[0].originalAccountId || parcelResult.parcels[0].id;
                            resourceForUiContext = { type: 'parcelled_account', id: originalTxId, description: parcelData.description };
                        }
                        break;
                    }
                    case 'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION': {
                        const accountIdToUpdateDesc = state.editingResource?.type === 'parcelled_account' && state.editingResource?.id
                            ? parseInt(state.editingResource.id, 10)
                            : (params.originalAccountIdToUpdate ? parseInt(params.originalAccountIdToUpdate, 10) : null);
                        if (!accountIdToUpdateDesc || !params.newDescription) throw new Error("ID da compra parcelada e nova descrição são obrigatórios.");

                        await financialService.updateParcelledAccountDescription(state.activeFinancialAccountId, accountIdToUpdateDesc, params.newDescription);

                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Descrição da compra parcelada atualizada para "${params.newDescription}", ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da compra parcelada, ${state.clientName}:`;
                        currentActionFormattedData = `📝 Descrição atualizada para: ${params.newDescription}`;
                        actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                        break;
                    }
                    case 'RECREATE_PARCELLED_ACCOUNT': {
                        const originalAccountIdToUpdate = state.editingResource?.type === 'parcelled_account' && state.editingResource?.id
                            ? parseInt(state.editingResource.id, 10)
                            : (params.originalAccountIdToUpdate ? parseInt(params.originalAccountIdToUpdate, 10) : null);
                        if (!originalAccountIdToUpdate) throw new Error("ID da compra parcelada original é obrigatório para recriar.");

                        const newCatIdParcel = await findFinancialCategoryIdByNameForChat(params.newFinancialCategoryName, state.activeFinancialAccountId, params.newType);
                        const newCardIdParcel = params.newCreditCardName ? await findCreditCardIdByNameForChat(params.newCreditCardName, state.activeFinancialAccountId) : null;

                        if (params.newCreditCardName && !newCardIdParcel) {
                            const errorMsgRec = `Hum, ${state.clientName}, não encontrei um cartão chamado "${params.newCreditCardName}" para registrar essa nova compra parcelada. 😕`;
                            if (aiResponse.detected_actions.length === 1) { aiMessageIntro = errorMsgRec; currentActionFormattedData = "A compra original não foi alterada. Você pode cadastrar o cartão ou tentar com outro nome."; platformLinkFooter = ""; }
                            else { multipleActionBodiesList.push(errorMsgRec); }
                            break;
                        }
                        const newParcelData = {
                            description: params.newDescription, type: params.newType || 'Saída', totalValue: parseFloat(params.newTotalValue),
                            numberOfParcels: parseInt(params.newNumberOfParcels),
                            paymentMethod: params.newPaymentMethod,
                            initialDueDate: params.newInitialDueDate,
                            financialCategoryId: newCatIdParcel, creditCardId: newCardIdParcel, notes: params.newNotes,
                            transactionDate: params.newTransactionDate || params.newInitialDueDate || new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" })).toISOString().split('T')[0]
                        };

                        if (!newParcelData.paymentMethod) {
                            const { cards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                            aiMessageIntro = getPaymentMethodClarificationMessage(state.clientName, cards);
                            currentActionFormattedData = "";
                            break;
                        }
                        if (!newParcelData.description || isNaN(newParcelData.totalValue) || newParcelData.totalValue <= 0 || isNaN(newParcelData.numberOfParcels) || newParcelData.numberOfParcels < 1 || !newParcelData.initialDueDate) {
                            throw new Error("Para recriar a compra parcelada, preciso de: nova descrição, novo valor total, novo nº de parcelas e nova data da 1ª parcela.");
                        }
                        if (!params.newTransactionDate && params.newInitialDueDate) {
                            newParcelData.transactionDate = params.newInitialDueDate;
                        }

                        const recreatedResult = await financialService.recreateParcelledAccount(state.activeFinancialAccountId, originalAccountIdToUpdate, newParcelData);

                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Compra parcelada atualizada com sucesso, ${state.clientName}! A antiga foi removida.`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a atualização da compra parcelada, ${state.clientName}:`;
                        currentActionFormattedData = formatParcelledAccountDataStructure(newParcelData, recreatedResult);
                        actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                        break;
                    }
                    case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                        if (!params.transactionDescription) throw new Error("Descrição da transação é obrigatória para marcar como paga/recebida.");
                        const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" })).toISOString().split('T')[0];
                        const categoryIdForMark = params.financialCategoryName ? await findFinancialCategoryIdByNameForChat(params.financialCategoryName, state.activeFinancialAccountId) : null;

                        const result = await financialService.markTransactionAsPaidOrReceived(
                            state.activeFinancialAccountId, params.transactionDescription,
                            params.transactionValue ? parseFloat(params.transactionValue) : null, paymentDate, categoryIdForMark
                        );
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Ótimo, ${state.clientName}! Transação marcada como liquidada.`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a liquidação da transação, ${state.clientName}:`;
                        currentActionFormattedData = `Transação "${result.description}" (${formatCurrency(result.value)}) foi marcada como ${result.type === 'Entrada' ? 'recebida' : 'paga'} em ${formatDate(result.paymentDate)}.`;
                        break;
                    }
                    case 'CREATE_RECURRING_RULE': {
                        const categoryIdRule = await findFinancialCategoryIdByNameForChat(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                        const ruleData = {
                            description: params.description, type: params.type, value: parseFloat(params.value),
                            paymentMethod: params.paymentMethod,
                            frequency: params.frequency, startDate: params.startDate,
                            interval: params.interval ? parseInt(params.interval) : 1,
                            dayOfMonth: params.dayOfMonth ? parseInt(params.dayOfMonth) : null,
                            dayOfWeek: params.dayOfWeek !== undefined && params.dayOfWeek !== null ? parseInt(params.dayOfWeek) : null,
                            endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction !== undefined ? params.autoCreateTransaction : false,
                            financialCategoryId: categoryIdRule, notes: params.notes,
                            isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : true,
                            isActive: params.isActive !== undefined ? params.isActive : true,
                        };

                        if (!ruleData.paymentMethod) {
                            const { cards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                            aiMessageIntro = getPaymentMethodClarificationMessage(state.clientName, cards);
                            currentActionFormattedData = "";
                            break;
                        }
                        if (!ruleData.description || !ruleData.type || isNaN(ruleData.value) || ruleData.value <= 0 || !ruleData.frequency || !ruleData.startDate) {
                            throw new Error("Dados insuficientes para criar regra recorrente (desc, tipo, valor, frequência, data início).");
                        }
                        const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                        const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);

                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Sua regra de recorrência foi criada, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Criei a seguinte regra de recorrência para você, ${state.clientName}:`;
                        currentActionFormattedData = formatRecurringRuleDataStructure(reloadedRule);
                        if (aiResponse.detected_actions.length === 1) resourceForUiContext = { type: 'recurring_rule', id: newRule.id, description: newRule.description };
                        break;
                    }
                    case 'CREATE_PRODUCT': {
                        const productData = {
                            name: params.name, salePrice: parseFloat(params.salePrice), code: params.code,
                            costPrice: params.costPrice ? parseFloat(params.costPrice) : null,
                            quantity: params.initialQuantity ? parseInt(params.initialQuantity) : 0, // Renomeado para 'quantity' no modelo
                            minimumStock: params.minimumStock ? parseInt(params.minimumStock) : 0,
                            unit: params.unit || 'UN', description: params.description
                        };
                        if (!productData.name || isNaN(productData.salePrice) || productData.salePrice <= 0) {
                            throw new Error("Nome e preço de venda são obrigatórios para o produto.");
                        }
                        const newProduct = await productService.createProduct(state.activeFinancialAccountId, productData);
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Produto "${newProduct.name}" cadastrado com sucesso, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Cadastrei o produto, ${state.clientName}:`;
                        currentActionFormattedData = formatProductDataStructure(newProduct);
                        if (aiResponse.detected_actions.length === 1) resourceForUiContext = { type: 'product', id: newProduct.id, description: newProduct.name };
                        break;
                    }
                    case 'GET_STOCK_INFO': { // GET_STOCK_INFO e RECORD_STOCK_MOVEMENT permanecem como antes, mas usam findProductIdByNameOrCodeForChat
                        if (!params.productNameOrCode) throw new Error("Nome ou código do produto é obrigatório para ver o estoque.");
                        const productIdStock = await findProductIdByNameOrCodeForChat(params.productNameOrCode, state.activeFinancialAccountId);
                        if (!productIdStock) throw new Error(`Produto "${params.productNameOrCode}" não encontrado nesta conta.`);

                        const stockInfo = await stockService.getProductStockBalance(productIdStock); //getProductStockBalance espera productId
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Aqui estão as informações de estoque para "${stockInfo.name}", ${state.clientName}:`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre o estoque de "${stockInfo.name}", ${state.clientName}:`;
                        currentActionFormattedData = `📦 ${stockInfo.name} (${stockInfo.code || 'Sem código'}):\n` +
                            `🛍️ Estoque Atual: ${stockInfo.quantity} ${stockInfo.unit || 'UN'}\n` +
                            `📉 Estoque Mínimo: ${stockInfo.minimumStock || 0} ${stockInfo.unit || 'UN'}`;
                        if (stockInfo.quantity <= (stockInfo.minimumStock || 0)) currentActionFormattedData += "\n⚠️ Atenção: Estoque baixo ou zerado!";
                        break;
                    }
                    case 'RECORD_STOCK_MOVEMENT': {
                        if (!params.productNameOrCode || !params.movementType || !params.quantity) throw new Error("Produto, tipo de movimento e quantidade são obrigatórios.");
                        const productIdMove = await findProductIdByNameOrCodeForChat(params.productNameOrCode, state.activeFinancialAccountId);
                        if (!productIdMove) throw new Error(`Produto "${params.productNameOrCode}" não encontrado.`);

                        const movementResult = await stockService.recordStockMovement(productIdMove, { // Passa productId direto
                            type: params.movementType,
                            quantity: parseInt(params.quantity),
                            reason: params.reason,
                        });
                        const updatedStockInfo = await stockService.getProductStockBalance(productIdMove);
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Movimentação de estoque registrada para "${updatedStockInfo.name}", ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a movimentação de estoque, ${state.clientName}:`;
                        currentActionFormattedData = `✅ Movimento de ${params.movementType.toLowerCase()} (${params.quantity} ${updatedStockInfo.unit || 'UN'}) para "${updatedStockInfo.name}" registrado.\n` +
                            `📦 Estoque Atual: ${updatedStockInfo.quantity} ${updatedStockInfo.unit || 'UN'}.`;
                        break;
                    }
                    case 'CREATE_CREDIT_CARD': {
                        const cardData = {
                            name: params.name, limit: parseFloat(params.limit),
                            closingDay: parseInt(params.closingDay), paymentDay: parseInt(params.paymentDay),
                            lastFourDigits: params.lastFourDigits, flag: params.flag,
                            isDefault: params.isDefault === undefined ? false : params.isDefault
                        };
                        if (!cardData.name || isNaN(cardData.limit) || cardData.limit <= 0 || isNaN(cardData.closingDay) || isNaN(cardData.paymentDay)) {
                            throw new Error("Dados insuficientes ou inválidos para criar cartão (nome, limite, dia fechamento/pagamento).");
                        }
                        const newCard = await creditCardService.createCreditCard(state.activeFinancialAccountId, cardData);
                        if (aiResponse.detected_actions.length === 1) { aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Seu novo cartão foi cadastrado, ${state.clientName}!`; }
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Seu novo cartão foi cadastrado, ${state.clientName}:`;
                        currentActionFormattedData = formatCreditCardListDataStructure([newCard]); // Usa a função de lista para um único cartão
                        if (aiResponse.detected_actions.length === 1) resourceForUiContext = { type: 'credit_card', id: newCard.id, description: newCard.name };
                        break;
                    }
                    case 'UPDATE_CREDIT_CARD': {
                        const cardIdToUpdate = state.editingResource?.type === 'credit_card' && state.editingResource?.id
                            ? parseInt(state.editingResource.id, 10)
                            : (params.cardIdToUpdate ? parseInt(params.cardIdToUpdate, 10) : null);
                        if (!cardIdToUpdate) throw new Error("ID do cartão para atualizar não foi fornecido.");
                        const updateDataCard = {};
                        if (params.hasOwnProperty('name')) updateDataCard.name = params.name;
                        if (params.hasOwnProperty('limit')) updateDataCard.limit = parseFloat(params.limit);
                        if (params.hasOwnProperty('closingDay')) updateDataCard.closingDay = parseInt(params.closingDay);
                        if (params.hasOwnProperty('paymentDay')) updateDataCard.paymentDay = parseInt(params.paymentDay);
                        if (params.hasOwnProperty('lastFourDigits')) updateDataCard.lastFourDigits = params.lastFourDigits;
                        if (params.hasOwnProperty('flag')) updateDataCard.flag = params.flag;
                        if (params.hasOwnProperty('isDefault')) updateDataCard.isDefault = params.isDefault;
                        if (params.hasOwnProperty('isActive')) updateDataCard.isActive = params.isActive;
                        if (Object.keys(updateDataCard).length === 0) throw new Error("Nenhum dado fornecido para atualizar o cartão.");
                        const updatedCard = await creditCardService.updateCreditCard(state.activeFinancialAccountId, cardIdToUpdate, updateDataCard);
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Cartão atualizado com sucesso, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do cartão, ${state.clientName}:`;
                        currentActionFormattedData = formatCreditCardListDataStructure([updatedCard]);
                        actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                        break;
                    }
                    case 'UPDATE_RECURRING_RULE': {
                        const ruleIdToUpdate = state.editingResource?.type === 'recurring_rule' && state.editingResource?.id
                            ? parseInt(state.editingResource.id, 10)
                            : (params.ruleIdToUpdate ? parseInt(params.ruleIdToUpdate, 10) : null);
                        if (!ruleIdToUpdate) throw new Error("ID da regra recorrente para atualizar não foi fornecido.");
                        const updateDataRule = {};
                        if (params.hasOwnProperty('description')) updateDataRule.description = params.description;
                        if (params.hasOwnProperty('type')) updateDataRule.type = params.type;
                        if (params.hasOwnProperty('value')) updateDataRule.value = parseFloat(params.value);
                        if (params.hasOwnProperty('frequency')) updateDataRule.frequency = params.frequency;
                        if (params.hasOwnProperty('startDate')) updateDataRule.startDate = params.startDate;
                        if (params.hasOwnProperty('interval')) updateDataRule.interval = parseInt(params.interval);
                        if (params.hasOwnProperty('dayOfMonth')) updateDataRule.dayOfMonth = params.dayOfMonth === null ? null : parseInt(params.dayOfMonth);
                        if (params.hasOwnProperty('dayOfWeek')) updateDataRule.dayOfWeek = params.dayOfWeek === null ? null : parseInt(params.dayOfWeek);
                        if (params.hasOwnProperty('endDate')) updateDataRule.endDate = params.endDate; else if (params.hasOwnProperty('endDate') && params.endDate === null) updateDataRule.endDate = null;
                        if (params.hasOwnProperty('autoCreateTransaction')) updateDataRule.autoCreateTransaction = params.autoCreateTransaction;
                        if (params.hasOwnProperty('isActive')) updateDataRule.isActive = params.isActive;
                        if (params.hasOwnProperty('notes')) updateDataRule.notes = params.notes;
                        if (params.financialCategoryName) updateDataRule.financialCategoryId = await findFinancialCategoryIdByNameForChat(params.financialCategoryName, state.activeFinancialAccountId, params.type || (await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, ruleIdToUpdate)).type);
                        else if (params.hasOwnProperty('financialCategoryName') && params.financialCategoryName === null) updateDataRule.financialCategoryId = null;
                        if (Object.keys(updateDataRule).length === 0) throw new Error("Nenhum dado fornecido para atualizar a regra.");
                        const updatedRule = await recurringTransactionService.updateRecurringRule(state.activeFinancialAccountId, ruleIdToUpdate, updateDataRule);
                        const reloadedUpdatedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, updatedRule.id);
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Regra de recorrência atualizada, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da regra, ${state.clientName}:`;
                        currentActionFormattedData = formatRecurringRuleDataStructure(reloadedUpdatedRule);
                        actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                        break;
                    }
                    case 'UPDATE_PRODUCT': {
                        const productIdToUpdate = state.editingResource?.type === 'product' && state.editingResource?.id
                            ? parseInt(state.editingResource.id, 10)
                            : (params.productIdToUpdate ? parseInt(params.productIdToUpdate, 10) : null);
                        if (!productIdToUpdate) throw new Error("ID do produto para atualizar não fornecido.");
                        const updateDataProd = {};
                        if (params.hasOwnProperty('name')) updateDataProd.name = params.name;
                        if (params.hasOwnProperty('salePrice')) updateDataProd.salePrice = parseFloat(params.salePrice);
                        if (params.hasOwnProperty('code')) updateDataProd.code = params.code;
                        if (params.hasOwnProperty('costPrice')) updateDataProd.costPrice = parseFloat(params.costPrice);
                        if (params.hasOwnProperty('minimumStock')) updateDataProd.minimumStock = parseInt(params.minimumStock);
                        if (params.hasOwnProperty('unit')) updateDataProd.unit = params.unit;
                        if (params.hasOwnProperty('description')) updateDataProd.description = params.description;
                        if (params.hasOwnProperty('isActive')) updateDataProd.isActive = params.isActive;
                        if (Object.keys(updateDataProd).length === 0) throw new Error("Nenhum dado para atualizar o produto.");
                        const updatedProduct = await productService.updateProduct(state.activeFinancialAccountId, productIdToUpdate, updateDataProd);
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Produto atualizado com sucesso, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do produto, ${state.clientName}:`;
                        currentActionFormattedData = formatProductDataStructure(updatedProduct);
                        actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                        break;
                    }
                    case 'LIST_APPOINTMENTS': {
                        const filterParamsAppt = {
                            dateStart: params.dateStart, dateEnd: params.dateEnd, status: params.status,
                            limit: params.limit || 5, page: params.page || 1,
                        };
                        const { appointments, totalItems: totalAppts } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, filterParamsAppt, params.period);
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || (totalAppts === 0 ? `Nenhum compromisso encontrado para os filtros, ${state.clientName}. 👍` : `📅 Encontrei ${totalAppts} compromissos. Os ${appointments.length > 1 ? appointments.length + " " : ""}próximos são:`);
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = totalAppts === 0 ? `Nenhum compromisso encontrado, ${state.clientName}.` : `Sobre os compromissos:`;
                        if (totalAppts === 0 && aiResponse.detected_actions.length === 1) currentActionFormattedData = "Tente outros filtros ou adicione novos compromissos!";
                        else if (totalAppts > 0) {
                            let listTextAppt = (aiResponse.detected_actions.length > 1 && multipleActionBodiesList.length > 0) ? "Compromissos Listados:\n" : "🎯 Detalhamento dos Compromissos:\n";
                            for (const appt of appointments) listTextAppt += `\n🗓️ ${appt.title} - ${formatDate(appt.eventDateTime)} às ${formatTime(appt.eventDateTime, false)} (ID: ${appt.id})${appt.status ? ` (Status: ${appt.status})` : ''}`;
                            currentActionFormattedData = listTextAppt.trim();
                            if (totalAppts > appointments.length) platformLinkFooter = formatPlatformLink(`E mais ${totalAppts - appointments.length} compromissos. Peça para ver mais ou veja tudo na plataforma!`);
                        } else currentActionFormattedData = "";
                        break;
                    }
                    case 'LIST_FINANCIAL_TRANSACTIONS': {
                        const filterParamsList = {
                            dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                            financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByNameForChat(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                            creditCardId: params.creditCardName ? await findCreditCardIdByNameForChat(params.creditCardName, state.activeFinancialAccountId) : null,
                            isPayableOrReceivable: params.isPayableOrReceivable, isPaidOrReceived: params.isPaidOrReceived,
                            search: params.searchTerm || params.description,
                            limit: params.limit || 7, page: params.page || 1,
                            sortBy: params.sortBy || 'transactionDate', sortOrder: params.sortOrder || 'DESC'
                        };
                        const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList, params.period);
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || (totalItems === 0 ? `Nenhuma transação encontrada para os filtros que você pediu, ${state.clientName}. 👍` : `📜 Encontrei ${totalItems} transações. As ${transactions.length > 1 ? transactions.length + " " : ""}mais recentes são:`);
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = totalItems === 0 ? `Nenhuma transação encontrada para os filtros, ${state.clientName}.` : `Sobre as transações:`;
                        if (totalItems === 0 && aiResponse.detected_actions.length === 1) currentActionFormattedData = "Tente outros filtros ou adicione novas transações!";
                        else if (totalItems > 0) {
                            let listText = (aiResponse.detected_actions.length > 1 && multipleActionBodiesList.length > 0) ? "Transações Listadas:\n" : "🎯 Detalhamento das Transações:\n";
                            for (const t of transactions) {
                                const catName = t.category ? t.category.name : 'Sem Categoria';
                                let emoji = t.type === 'Entrada' ? '🟢' : (t.creditCardId ? '💳' : '🔴');
                                if (t.isParcel && t.originalAccount) emoji = '📦';
                                const date = formatDate(t.transactionDate);
                                let descriptionText = t.description;
                                if (t.isParcel && t.parcelNumber && t.totalParcels && t.originalAccount) {
                                    const originalDesc = t.originalAccount.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                                    if (!descriptionText.toLowerCase().includes(`parcela ${t.parcelNumber}/${t.totalParcels}`)) descriptionText = `${originalDesc} - Pcl ${t.parcelNumber}/${t.totalParcels}`;
                                }
                                listText += `\n${emoji} ${descriptionText} - ${formatCurrency(t.value)}\n    (Cat: ${catName}, Data: ${date}, ID: ${t.id})`;
                                if (t.isPayableOrReceivable && !t.creditCardId) listText += t.isPaidOrReceived ? " (Liquidada ✅)" : ` (Vence ${formatDate(t.dueDate)} 🗓️)`;
                            }
                            currentActionFormattedData = listText.trim();
                            if (totalItems > transactions.length) platformLinkFooter = formatPlatformLink(`E mais ${totalItems - transactions.length} transações. Peça para ver mais ou veja tudo na plataforma!`);
                        } else currentActionFormattedData = "";
                        break;
                    }
                    case 'LIST_RECURRING_RULES': {
                        const filterParamsRules = { isActive: params.isActive !== undefined ? params.isActive : null, type: params.type, limit: params.limit || 5, page: params.page || 1 };
                        const rulesResult = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, filterParamsRules); // Service retorna array direto
                        const totalRules = rulesResult.length; // Assumindo que o service não pagina para este GET, ou ajustar
                        const rulesToDisplay = rulesResult.slice(0, filterParamsRules.limit);

                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || (totalRules === 0 ? `Nenhuma regra de recorrência encontrada, ${state.clientName}.` : `📋 Você tem ${totalRules} regra(s) de recorrência. As primeiras são:`);
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = totalRules === 0 ? `Nenhuma regra de recorrência encontrada, ${state.clientName}.` : `Sobre as regras de recorrência:`;
                        if (totalRules === 0 && aiResponse.detected_actions.length === 1) currentActionFormattedData = "Que tal criar uma? Diga, por exemplo: \"criar recorrência de aluguel, saída de 1500, mensal, todo dia 5\".";
                        else if (totalRules > 0) {
                            let listTextRules = (aiResponse.detected_actions.length > 1 && multipleActionBodiesList.length > 0) ? "Regras Listadas:\n" : "🎯 Detalhamento das Regras:\n";
                            for (const rule of rulesToDisplay) listTextRules += `\n🔄 ${rule.description} - ${formatCurrency(rule.value)} (${rule.type})\n    (Próx: ${formatDate(rule.nextDueDate)}, Freq: ${rule.frequency}, ID: ${rule.id})${!rule.isActive ? " (Inativa)" : ""}`;
                            currentActionFormattedData = listTextRules.trim();
                            if (totalRules > rulesToDisplay.length) platformLinkFooter = formatPlatformLink(`E mais ${totalRules - rulesToDisplay.length} regras. Peça para ver mais ou veja tudo na plataforma!`);
                        } else currentActionFormattedData = "";
                        break;
                    }
                    case 'GET_FINANCIAL_SUMMARY': {
                        const summaryData = await financialService.getFinancialSummary(state.activeFinancialAccountId, {
                            dateStart: params.dateStart, dateEnd: params.dateEnd,
                            financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByNameForChat(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                            type: params.type
                        });
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `📊 Aqui está seu resumo financeiro para o período, ${state.clientName}:`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre seu resumo financeiro, ${state.clientName}:`;
                        currentActionFormattedData = `Resumo da Conta: ${summaryData.accountName}\n` +
                            `Receitas: ${formatCurrency(summaryData.totalEntradas)}\n` +
                            `Despesas: ${formatCurrency(summaryData.totalSaidas)}\n` +
                            `Saldo Efetivado: ${formatCurrency(summaryData.saldoEfetivado)}\n` +
                            `A Receber (Pendente): ${formatCurrency(summaryData.totalAReceberPendente)}\n` +
                            `A Pagar (Pendente): ${formatCurrency(summaryData.totalAPagarPendente)}`;
                        break;
                    }
                    case 'GET_CREDIT_CARD_INVOICE': {
                        const cardNameForInvoice = params.creditCardName;
                        if (!cardNameForInvoice) throw new Error("Nome do cartão é obrigatório para ver a fatura.");
                        const cardIdForInvoice = await findCreditCardIdByNameForChat(cardNameForInvoice, state.activeFinancialAccountId);
                        if (!cardIdForInvoice) {
                            aiMessageIntro = `Hum, não consegui identificar o cartão "${cardNameForInvoice}", ${state.clientName}.`;
                            currentActionFormattedData = `Pode tentar de novo ou verificar se ele está cadastrado? 🤔`; platformLinkFooter = ""; break;
                        }
                        const periodOpts = { type: params.invoicePeriodType || 'aberta', month: params.invoiceMonth, year: params.invoiceYear };
                        const cardForLimit = await creditCardService.getCreditCardById(state.activeFinancialAccountId, cardIdForInvoice);
                        const invoiceDetails = await creditCardService.getCreditCardInvoiceDetails(state.activeFinancialAccountId, cardIdForInvoice, periodOpts);
                        if (cardForLimit) invoiceDetails.cardTotalLimit = cardForLimit.limit;
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `🛍️ ${state.clientName}, aqui está a fatura do seu cartão ${cardNameForInvoice}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a fatura do cartão ${cardNameForInvoice}:`;
                        currentActionFormattedData = formatCreditCardInvoiceDataStructure(invoiceDetails, params.listTransactions !== false);
                        break;
                    }
                    case 'GET_CREDIT_CARD_AVAILABLE_LIMIT': {
                        const cardNameForLimit = params.creditCardName;
                        if (!cardNameForLimit) throw new Error("Nome do cartão é obrigatório para ver o limite.");
                        const cardIdForLimit = await findCreditCardIdByNameForChat(cardNameForLimit, state.activeFinancialAccountId);
                        if (!cardIdForLimit) {
                            aiMessageIntro = `Não encontrei o cartão "${cardNameForLimit}", ${state.clientName}. Verifique o nome ou cadastre o cartão.`;
                            currentActionFormattedData = ""; platformLinkFooter = ""; break;
                        }
                        const limitInfo = await creditCardService.getAvailableCreditLimit(state.activeFinancialAccountId, cardIdForLimit);
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Aqui está o limite do seu cartão ${limitInfo.cardName}, ${state.clientName}:`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre o limite do cartão ${limitInfo.cardName}:`;
                        currentActionFormattedData = formatAvailableLimitDataStructure(limitInfo);
                        break;
                    }
                    case 'PAY_CREDIT_CARD_INVOICE': {
                        const cardNameToPay = params.creditCardName;
                        const paymentAmount = parseFloat(params.paymentAmount);
                        if (!cardNameToPay || isNaN(paymentAmount) || paymentAmount <= 0) throw new Error("Nome do cartão e valor do pagamento (maior que zero) são obrigatórios.");
                        const cardIdToPay = await findCreditCardIdByNameForChat(cardNameToPay, state.activeFinancialAccountId);
                        if (!cardIdToPay) {
                            aiMessageIntro = `Não encontrei o cartão "${cardNameToPay}" para registrar o pagamento da fatura, ${state.clientName}.`;
                            currentActionFormattedData = ""; platformLinkFooter = ""; break;
                        }
                        const paymentDateCard = params.paymentDate || new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" })).toISOString().split('T')[0];
                        let categoryIdPay = await findFinancialCategoryIdByNameForChat(params.financialCategoryName || "Pagamento de Fatura", state.activeFinancialAccountId, "Saída");
                        const paymentTransaction = await creditCardService.payCreditCardInvoice(
                            state.activeFinancialAccountId, cardIdToPay, paymentAmount, paymentDateCard,
                            params.originatingAccountDescription, categoryIdPay
                        );
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Pagamento da fatura do cartão "${cardNameToPay}" registrado, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre o pagamento da fatura, ${state.clientName}:`;
                        currentActionFormattedData = `✅ Pagamento de ${formatCurrency(paymentAmount)} para o cartão "${cardNameToPay}" registrado em ${formatDate(paymentDateCard)}.`;
                        if (paymentTransaction.category) currentActionFormattedData += `\nCategoria: ${paymentTransaction.category.name}.`;
                        break;
                    }
                    case 'SET_MOTIVATIONAL_MESSAGE_PREFERENCE': {
                        if (params.enable === undefined || (params.enable && !params.time)) throw new Error("Preciso saber se quer ativar/desativar e, se ativar, o horário (HH:MM).");
                        await systemService.updateSystemPreferences({
                            enableMotivationMessage: params.enable,
                            motivationMessageTime: params.enable ? params.time : null
                        });
                        const updatedPrefsMotiv = await systemService.getSystemPreferences();
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Preferências de mensagem motivacional atualizadas, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre as mensagens motivacionais, ${state.clientName}:`;
                        currentActionFormattedData = formatMotivationalMessagePreferenceDataStructure(updatedPrefsMotiv);
                        break;
                    }
                    case 'SET_WATER_REMINDER_PREFERENCE': {
                        if (params.enable === undefined || (params.enable && (!params.frequencyType || !params.startTime || !params.endTime))) {
                            throw new Error("Preciso saber se quer ativar/desativar e, se ativar, a frequência, horário de início e fim.");
                        }
                        if (params.enable && params.frequencyType === 'custom' && !params.customIntervalMinutes) {
                            throw new Error("Para frequência personalizada de lembrete de água, preciso do intervalo em minutos.");
                        }
                        await systemService.updateSystemPreferences({
                            enableWaterReminder: params.enable,
                            waterReminderFrequencyType: params.enable ? params.frequencyType : 'disabled',
                            waterReminderCustomIntervalMinutes: params.enable && params.frequencyType === 'custom' ? parseInt(params.customIntervalMinutes) : null,
                            waterReminderStartTime: params.enable ? params.startTime : null,
                            waterReminderEndTime: params.enable ? params.endTime : null,
                            dailyGoalMl: params.enable && params.dailyGoalMl ? parseInt(params.dailyGoalMl) : null
                        });
                        const updatedPrefsWater = await systemService.getSystemPreferences();
                        if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Preferências de lembrete de água atualizadas, ${state.clientName}!`;
                        else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre os lembretes de água, ${state.clientName}:`;
                        currentActionFormattedData = formatWaterReminderPreferenceDataStructure(updatedPrefsWater);
                        break;
                    }
                    case 'SWITCH_FINANCIAL_ACCOUNT': { // Adaptado para o chat do site
                        const targetAccountIdentifier = params.targetAccountNameOrType;
                        if (!targetAccountIdentifier) throw new Error("Preciso do nome ou tipo da conta para qual você quer mudar.");
                        // No chat do site, a troca de perfil é feita pelo usuário no Header.
                        // O chat pode apenas orientar.
                        aiMessageIntro = aiResponse.overall_summary_suggestion || `Entendido, ${state.clientName}!`;
                        currentActionFormattedData = `Para mudar de perfil/conta (ex: para "${targetAccountIdentifier}"), por favor, utilize o seletor de perfis que fica no topo da página, ao lado do seu nome. 😉`;
                        platformLinkFooter = ""; // Remove o link padrão
                        state.currentAction = null; // Não há ação pendente para o chat aqui
                        // Sugestão para o frontend indicar visualmente a troca
                        suggestionsForFrontend.push({ id: 'ui_focus_profile_selector', label: 'Mudar Perfil Agora (no topo)' });
                        break;
                    }
                    case 'CREATE_FINANCIAL_ACCOUNT': { // Adaptado
                        const accountTypeToCreate = params.accountTypeToCreate;
                        const newAccountName = params.newAccountName;
                        if (!accountTypeToCreate || !newAccountName) {
                            aiMessageIntro = `Para criar uma nova conta, ${state.clientName}, preciso saber o tipo (PF, PJ ou MEI) e um nome para ela.`;
                            currentActionFormattedData = `Por exemplo: "criar conta PJ Minha Consultoria" ou "abrir perfil PF Pessoal João".`;
                            platformLinkFooter = "";
                            // Aqui, o ideal seria a IA ter pedido clarificação se faltou tipo OU nome.
                            // Se chegou aqui com dados faltando, é um fallback.
                            break;
                        }
                        if (!['PF', 'PJ', 'MEI'].includes(accountTypeToCreate)) throw new Error("Tipo de conta inválido. Use PF, PJ ou MEI.");
                        if (newAccountName.length < 3 || newAccountName.length > 50) throw new Error("Nome da conta deve ter entre 3 e 50 caracteres.");

                        const ownerClientId = currentProfileContext.ownerClient?.id || (await clientService.findClientByPhone(currentProfileContext.phone))?.id;
                        if (!ownerClientId) { throw new Error("Não foi possível identificar o cliente proprietário para criar a conta."); }

                        // Validação de plano e limite de contas PJ/MEI (já existente no whatsapp.service)
                        const currentClientAccounts = await clientService.getClientFinancialAccounts(ownerClientId, { isActive: true });
                        const clientDataForPlanCheck = await clientAuthService.getClientProfile(ownerClientId); // Pega dados do cliente incluindo accessLevel

                        const existingPjMei = currentClientAccounts.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                        if ((accountTypeToCreate === 'PJ' || accountTypeToCreate === 'MEI') && existingPjMei) {
                            throw new Error(`Você já possui uma conta ${existingPjMei.accountType} ("${existingPjMei.accountName}"). Só é permitida uma conta empresarial (PJ/MEI) por vez.`);
                        }
                        if ((accountTypeToCreate === 'PJ' || accountTypeToCreate === 'MEI') &&
                            !(clientDataForPlanCheck.client.accessLevel?.startsWith('avancado') || clientDataForPlanCheck.client.accessLevel?.startsWith('vitalicio_avancado'))) {
                            throw new Error(`Para criar contas PJ ou MEI, você precisa de um Plano Avançado. Visite nossa página de planos!`);
                        }

                        const newFinancialAccount = await clientService.createFinancialAccount(ownerClientId, { accountName: newAccountName, accountType: accountTypeToCreate });

                        aiMessageIntro = aiResponse.overall_summary_suggestion || `Conta "${newFinancialAccount.accountName}" (${newFinancialAccount.accountType}) criada, ${state.clientName}!`;
                        currentActionFormattedData = `✨ Agora você pode selecioná-la no topo da página para começar a usar.`;
                        platformLinkFooter = ""; state.currentAction = null;
                        // O frontend (ProfileContext) precisará ser atualizado para refletir a nova conta.
                        // O chat pode sugerir ao usuário recarregar a lista de perfis ou o ProfileContext pode ouvir eventos.
                        suggestionsForFrontend.push({ id: 'ui_refresh_profiles', label: 'Atualizar lista de perfis' });
                        break;
                    }
                    case 'GENERAL_GREETING_OR_SMALLTALK':
                    case 'GENERAL_QUESTION_OR_HELP':
                    case 'ACTION_CONFIRMATION_YES':
                    case 'ACTION_CONFIRMATION_NO':
                        if (aiResponse.overall_summary_suggestion && aiResponse.overall_summary_suggestion !== aiResponse.reply_to_user_suggestion && aiResponse.detected_actions.length === 1) {
                            aiMessageIntro = aiResponse.overall_summary_suggestion;
                        } else if (aiResponse.reply_to_user_suggestion) {
                            aiMessageIntro = aiResponse.reply_to_user_suggestion;
                        } else {
                            aiMessageIntro = `Entendido, ${state.clientName}! 😊`;
                        }
                        currentActionFormattedData = "";
                        platformLinkFooter = (actionName === 'GENERAL_QUESTION_OR_HELP' && !(aiMessageIntro && aiMessageIntro.includes('map-nocontrole.com.br'))) ? formatPlatformLink("Se precisar de mais funcionalidades, explore outras áreas da plataforma!") : "";
                        if (actionName === 'ACTION_CONFIRMATION_YES' || actionName === 'ACTION_CONFIRMATION_NO') {
                            state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                        }
                        break;
                    default:
                        let defaultIntro = `Ok, ${state.clientName}!`;
                        if (aiResponse.detected_actions.length === 1 && aiResponse.overall_summary_suggestion) defaultIntro = aiResponse.overall_summary_suggestion;
                        else if (aiResponse.reply_to_user_suggestion) defaultIntro = aiResponse.reply_to_user_suggestion;
                        if (multipleActionBodiesList.length === 0 && (!(aiMessageIntro && aiMessageIntro.includes(state.clientName)) && aiMessageIntro !== aiResponse.overall_summary_suggestion && aiMessageIntro !== aiResponse.reply_to_user_suggestion)) {
                            aiMessageIntro = defaultIntro;
                        } else if (aiResponse.detected_actions.length > 1 && aiResponse.overall_summary_suggestion && aiMessageIntro !== aiResponse.overall_summary_suggestion) {
                            // Mantém intro da primeira ação
                        } else if (aiResponse.overall_summary_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro === `Ok, ${state.clientName}!`)) {
                            aiMessageIntro = aiResponse.overall_summary_suggestion;
                        }
                        currentActionFormattedData = `Ainda estou aprendendo a processar "${actionName.toLowerCase().replace(/_/g, " ")}" completamente. 😅 Minha equipe está trabalhando nisso!`;
                        logger.warn(`[INTERACTIVE CHAT SERVICE] Ação da IA não implementada no switch: ${actionName}`);
                        break;
                }
            } catch (e) {
                logger.error(`[INTERACTIVE CHAT SERVICE] Erro executando "${actionName}" para sessionId ${userSessionId} (Perfil: ${state.activeFinancialAccountName}): ${e.message}`, { stack: e.stack?.substring(0, 300), paramsUsed: params });
                let errorIntroPart = `Ops! 😬 Tive um problema ao tentar processar "${params?.description || actionName.toLowerCase().replace(/_/g, " ")}".`;
                let errorDataPart = `Detalhe do erro: ${e.message.length < 80 ? e.message : 'Erro interno, desculpe!'}\n\nPode tentar de novo ou com outros termos?`;

                if (aiResponse.detected_actions.length === 1) {
                    if (!(aiMessageIntro && typeof aiMessageIntro === 'string' && (aiMessageIntro.toLowerCase().includes("ops") || aiMessageIntro.toLowerCase().includes("problema")))) {
                        aiMessageIntro = errorIntroPart;
                    }
                    currentActionFormattedData = errorDataPart;
                } else {
                    multipleActionBodiesList.push(`❌ ${errorIntroPart}\n${errorDataPart}`);
                    currentActionFormattedData = "";
                }
            }
            if (currentActionFormattedData) {
                multipleActionBodiesList.push(currentActionFormattedData);
            }
        } // Fim do loop for

        if (multipleActionBodiesList.length > 0) {
            structuredDataBody = multipleActionBodiesList.join("\n\n---\n\n");
            if ((typeof aiMessageIntro === 'string' && (aiMessageIntro === `Ok, ${state.clientName}!` || !aiMessageIntro.includes(state.clientName))) && aiResponse.overall_summary_suggestion && !(aiMessageIntro && (aiMessageIntro.toLowerCase().includes("ops") || aiMessageIntro.toLowerCase().includes("problema")))) {
                aiMessageIntro = aiResponse.overall_summary_suggestion;
            }
        } else if (aiResponse.detected_actions.length === 0) {
            structuredDataBody = "";
            if (aiResponse.reply_to_user_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro === `Ok, ${state.clientName}!` || aiMessageIntro === aiResponse.overall_summary_suggestion)) {
                if (aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion || aiMessageIntro === `Ok, ${state.clientName}!`) {
                    aiMessageIntro = aiResponse.reply_to_user_suggestion;
                }
            }
        }
    } // Fim if (aiResponse.detected_actions)

    if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
        aiMessageIntro = aiResponse.reply_to_user_suggestion || `Opa, ${state.clientName}! Para continuarmos, preciso de um detalhe:`;
        structuredDataBody = aiResponse.clarifications_needed[0].clarification_question;
        platformLinkFooter = "";
        state.currentAction = 'awaiting_clarification_response';
        state.data.clarificationContext = {
            action: aiResponse.clarifications_needed[0].original_intent_action_suggestion,
            original_message: messageText,
            parameters_so_far: aiResponse.clarifications_needed[0].parameters_so_far || {}
        };
        // Poderia adicionar sugestões de resposta para clarificação aqui se a IA fornecer
        // Ex: se faltou categoria, suggestionsForFrontend.push(...categorias)
    } else if ((!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) && !structuredDataBody) {
        if (aiResponse.reply_to_user_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro === `Ok, ${state.clientName}!` || aiMessageIntro === aiResponse.overall_summary_suggestion)) {
            if (aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion || aiMessageIntro === `Ok, ${state.clientName}!`) {
                aiMessageIntro = aiResponse.reply_to_user_suggestion;
            }
        }
        if (multipleActionBodiesList.length === 0) structuredDataBody = "";
        if ((typeof aiMessageIntro === 'string' && aiMessageIntro === `Ok, ${state.clientName}!`) && !structuredDataBody && !aiResponse.overall_summary_suggestion && !aiResponse.reply_to_user_suggestion) {
            aiMessageIntro = `Entendido, ${state.clientName}! Se precisar de mais alguma coisa, é só chamar. 😊`;
        }
    }

    if (typeof aiMessageIntro !== 'string' || aiMessageIntro.trim() === "") {
        aiMessageIntro = `Pode repetir, ${state.clientName}? Não entendi muito bem.`;
    }
    finalMessageToReturn = aiMessageIntro.trim();
    if (structuredDataBody && structuredDataBody.trim() !== "") {
        finalMessageToReturn += `\n\n${structuredDataBody.trim()}`;
    }

    let noLinkCurrentAction = state.currentAction === 'awaiting_clarification_response';
    let noLinkDetectedAction = false;
    if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
        noLinkDetectedAction = aiResponse.detected_actions.some(da => {
            const actionNameCheck = da.action || da.action_type;
            return actionNameCheck?.startsWith("GENERAL_GREETING") || actionNameCheck?.startsWith("ACTION_CONFIRMATION_") || actionNameCheck === "SWITCH_FINANCIAL_ACCOUNT" || actionNameCheck === "CREATE_FINANCIAL_ACCOUNT";
        });
    }
    const noLinkConditions = noLinkCurrentAction || (finalMessageToReturn && finalMessageToReturn.includes('map-nocontrole.com.br')) || noLinkDetectedAction;

    if (platformLinkFooter && platformLinkFooter.trim() !== "" && !noLinkConditions) {
        finalMessageToReturn += `\n\n${platformLinkFooter.trim()}`;
    }
    finalMessageToReturn = finalMessageToReturn.replace(/\n{3,}/g, '\n\n').trim();

    if (finalMessageToReturn) {
        state.messageHistory.push({ role: 'assistant', content: finalMessageToReturn });
    }
    if (actionWasAnEdit || (state.editingResource && (!aiResponse.detected_actions || aiResponse.detected_actions.every(a => !(a.action || a.action_type)?.startsWith("UPDATE_") && (a.action || a.action_type) !== 'RECREATE_PARCELLED_ACCOUNT')))) {
        state.editingResource = null;
    }
    if (state.data.clarificationContext && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
        delete state.data.clarificationContext;
    }

    siteChatConversationState.set(userSessionId, state);

    const endTime = Date.now();
    logger.info(`[INTERACTIVE CHAT SERVICE] Processamento para ${userSessionId} finalizado em ${endTime - startTime}ms.`);
    logger.debug(`[INTERACTIVE CHAT SERVICE] Estado final da sessão ${userSessionId}:`, {
        currentAction: state.currentAction,
        activeFinancialAccountId: state.activeFinancialAccountId,
        editingResource: state.editingResource,
    });

    // Adiciona sugestões de botões se for uma única ação concreta de criação bem-sucedida
    if (resourceForUiContext && aiResponse.detected_actions && aiResponse.detected_actions.length === 1 &&
        !actionWasAnEdit && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {

        const actionNameCheck = aiResponse.detected_actions[0].action || aiResponse.detected_actions[0].action_type;
        const isConcreteCreation = !(actionNameCheck?.startsWith("GENERAL_") || actionNameCheck?.startsWith("LIST_") || actionNameCheck?.startsWith("GET_") || actionNameCheck?.startsWith("SWITCH_") || actionNameCheck?.startsWith("ACTION_CONFIRMATION_") || actionNameCheck?.startsWith("UPDATE_") || actionNameCheck === "RECREATE_PARCELLED_ACCOUNT");

        if (isConcreteCreation) {
            let tempSuggestions = [];
            let itemDescSugg = resourceForUiContext.description || "item";
            itemDescSugg = itemDescSugg.length > 20 ? itemDescSugg.substring(0, 17) + "..." : itemDescSugg;

            switch (resourceForUiContext.type) {
                case 'transaction': tempSuggestions = [{ id: `edit_transaction_${resourceForUiContext.id}`, label: `Editar "${itemDescSugg}"` }, { id: `delete_transaction_${resourceForUiContext.id}`, label: "Excluir" }]; break;
                case 'appointment': tempSuggestions = [{ id: `edit_appointment_${resourceForUiContext.id}`, label: `Editar "${itemDescSugg}"` }, { id: `delete_appointment_${resourceForUiContext.id}`, label: "Excluir" }]; break;
                case 'credit_card': tempSuggestions = [{ id: `edit_credit_card_${resourceForUiContext.id}`, label: `Editar Cartão "${itemDescSugg}"` }]; break; // Excluir cartão pode ter implicações
                case 'recurring_rule': tempSuggestions = [{ id: `edit_recurring_rule_${resourceForUiContext.id}`, label: `Editar Recorrência "${itemDescSugg}"` }, { id: `delete_recurring_rule_${resourceForUiContext.id}`, label: "Excluir" }]; break;
                case 'product': tempSuggestions = [{ id: `edit_product_${resourceForUiContext.id}`, label: `Editar Produto "${itemDescSugg}"` }]; break;
                case 'parcelled_account': tempSuggestions = [{ id: `edit_parcelled_account_${resourceForUiContext.id}`, label: `Alterar Compra "${itemDescSugg}"` }, { id: `delete_parcelled_account_${resourceForUiContext.id}`, label: "Excluir Compra" }]; break;
            }
            suggestionsForFrontend = tempSuggestions;
        }
    }


    return {
        replyText: finalMessageToReturn,
        suggestions: suggestionsForFrontend,
        error: false
    };
}

module.exports = { processSiteChatMessage };    
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
    foundCategory = await systemService.findFinancialCategoryByName(name, financialAccountId); // Fallback sem tipo
    if (foundCategory) {
        logger.info(`[WHATSAPP SERVICE] Categoria por nome "${name}" (tipo ${transactionType || 'qualquer'}) não encontrada exatamente. Usando correspondência por nome: "${foundCategory.name}" (ID: ${foundCategory.id})`);
        return foundCategory.id;
    }
    logger.warn(`[WHATSAPP SERVICE] Categoria financeira com nome "${name}" não encontrada.`);
    return null;
}

async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    // A função findCreditCardByName do creditCardService já lida com a busca e erros
    try {
        const card = await creditCardService.findCreditCardByName(financialAccountId, name); // Este método deve existir no creditCardService
        return card.id;
    } catch (e) {
        logger.warn(`[WHATSAPP SERVICE] Cartão de crédito com nome "${name}" não encontrado para a conta ${financialAccountId} via creditCardService: ${e.message}`);
        return null;
    }
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

// --- Funções de Formatação de Resumo (Caprichadas) ---
function formatFinancialTransactionSummary(transaction, clientName, forMulti = false, forEdit = false) {
    const dateFormatted = transaction.transactionDate
        ? new Date(transaction.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
        : 'Data não informada';

    let statusText = "";
    let statusEmoji = "";
    if (transaction.isPayableOrReceivable) {
        const dueDateFormatted = transaction.dueDate ? new Date(transaction.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) : 'N/A';
        if (transaction.isPaidOrReceived) {
            statusText = transaction.type === 'Entrada' ? "Recebido!" : "Pago!";
            statusEmoji = "✅";
        } else {
            statusText = ` ${transaction.type === 'Entrada' ? 'A receber' : 'A pagar'} em ${dueDateFormatted}`;
            statusEmoji = "🗓️";
        }
    } else { // Transações não "PayableOrReceivable" são consideradas efetivadas
        statusText = transaction.type === 'Entrada' ? "Recebido!" : "Pago!";
        statusEmoji = "✅";
    }

    let categoryEmoji = transaction.type === 'Entrada' ? '📥' : '💸';
    if (transaction.category && transaction.category.name) {
        const catNameLower = transaction.category.name.toLowerCase();
        if (catNameLower.includes('lazer') || catNameLower.includes('jogo') || catNameLower.includes('entretenimento') || catNameLower.includes('game')) categoryEmoji = '🎮';
        else if (catNameLower.includes('alimentação') || catNameLower.includes('restaurante') || catNameLower.includes('ifood') || catNameLower.includes('mercado') || catNameLower.includes('comida')) categoryEmoji = '🍔';
        else if (catNameLower.includes('salário') || catNameLower.includes('recebimento') || catNameLower.includes('presente') || catNameLower.includes('renda')) categoryEmoji = '💰';
        else if (catNameLower.includes('transporte') || catNameLower.includes('uber') || catNameLower.includes('gasolina') || catNameLower.includes('carro')) categoryEmoji = '🚗';
        else if (catNameLower.includes('saúde') || catNameLower.includes('farmácia') || catNameLower.includes('médico') || catNameLower.includes('saude')) categoryEmoji = '🩺';
        else if (catNameLower.includes('casa') || catNameLower.includes('aluguel') || catNameLower.includes('moradia') || catNameLower.includes('luz') || catNameLower.includes('água') || catNameLower.includes('agua')) categoryEmoji = '🏡';
        else if (catNameLower.includes('educação') || catNameLower.includes('curso') || catNameLower.includes('estudo')) categoryEmoji = '📚';
        else if (catNameLower.includes('pet') || catNameLower.includes('animal')) categoryEmoji = '🐾';
        else if (catNameLower.includes('investimento')) categoryEmoji = '📈';
        else if (catNameLower.includes('doação') || catNameLower.includes('dívida') || catNameLower.includes('divida')) categoryEmoji = '👐';
        else if (catNameLower.includes('outros')) categoryEmoji = '📎';
    }
    if (transaction.creditCard && transaction.creditCard.name) categoryEmoji = '💳';


    let summary = "";
    if (forEdit) summary += "✅ Transação Editada:\n\n";
    // Não adicionar título "Resumo da Transação" aqui, pois o overall_summary_suggestion da IA já deve cobrir a introdução.

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

function formatAppointmentSummary(appointment, clientName, forMulti = false, forEdit = false) {
    const displayTimeZone = process.env.TZ || 'America/Sao_Paulo';
    const eventDateTime = new Date(appointment.eventDateTime);

    const eventDateFormatted = eventDateTime.toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: displayTimeZone
    });
    const eventTimeFormatted = eventDateTime.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone
    });

    let summary = "";
    if (forEdit) summary += "✅ Compromisso Atualizado:\n\n";

    let titleEmoji = "📝";
    const titleLower = appointment.title?.toLowerCase() || "";
    if(titleLower.includes("pagar") || titleLower.includes("dívida") || titleLower.includes("divida") || (appointment.associatedValue && appointment.associatedTransactionType === 'Saída')) titleEmoji = "💸";
    else if(titleLower.includes("receber") || (appointment.associatedValue && appointment.associatedTransactionType === 'Entrada')) titleEmoji = "💰";
    else if(titleLower.includes("reunião") || titleLower.includes("reuniao")) titleEmoji = "🤝";
    else if(titleLower.includes("médico") || titleLower.includes("dentista") || titleLower.includes("medico")) titleEmoji = "🩺";
    else if(titleLower.includes("aniversário") || titleLower.includes("aniversario") || titleLower.includes("festa")) titleEmoji = "🎉";
    else if(titleLower.includes("viagem")) titleEmoji = "✈️";
    else if(titleLower.includes("estudar") || titleLower.includes("aula") || titleLower.includes("curso")) titleEmoji = "📚";


    summary += `${titleEmoji} Descrição: ${appointment.title}\n`;
    summary += `📆 Data: ${eventDateFormatted}\n`;
    summary += `🕑 Horário: ${eventTimeFormatted}\n`;

    if (appointment.durationMinutes) {
        const endTime = new Date(eventDateTime.getTime() + appointment.durationMinutes * 60000);
        const endTimeFormatted = endTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone });
        summary += `⏳ Duração: ${appointment.durationMinutes} min (até ${endTimeFormatted})\n`;
    }
    if (appointment.location) summary += `📍 Local: ${appointment.location}\n`;

    if (appointment.associatedValue && appointment.associatedTransactionType) {
        summary += `💲 Valor Associado: R$ ${parseFloat(appointment.associatedValue).toFixed(2)} (${appointment.associatedTransactionType})\n`;
    }

    summary += `🚦 Status: ${appointment.status}`;
    if(appointment.reminderEnabled && appointment.reminderLeadTimeMinutes) {
        summary += `\n🔔 Lembrete: Sim (${appointment.reminderLeadTimeMinutes} min antes)`;
    } else if (appointment.reminderEnabled && !appointment.reminderLeadTimeMinutes) {
        summary += `\n🔔 Lembrete: Sim (Padrão)`;
    }
    if (appointment.notes) summary += `\n💬 Notas: ${appointment.notes}`;
    return summary;
}

function formatRecurringRuleSummary(rule, clientName, forMulti = false, forEdit = false) {
    const startDateFormatted = rule.startDate ? new Date(rule.startDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'}) : 'N/I';
    const endDateFormatted = rule.endDate ? new Date(rule.endDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'}) : 'Sem data final';
    const nextDateFormatted = rule.nextDueDate ? new Date(rule.nextDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'}) : 'N/A (Verifique se está ativa)';

    let categoryEmoji = rule.type === 'Entrada' ? '💰' : '💸';
     if (rule.category && rule.category.name) {
        const catNameLower = rule.category.name.toLowerCase();
        if (catNameLower.includes('assinatura') || catNameLower.includes('streaming') || catNameLower.includes('netflix')) categoryEmoji = '🎬';
        else if (catNameLower.includes('aluguel') || catNameLower.includes('condomínio') || catNameLower.includes('condominio')) categoryEmoji = '🏡';
        else if (catNameLower.includes('salário') || catNameLower.includes('salario')) categoryEmoji = '💼';
        else if (catNameLower.includes('internet') || catNameLower.includes('telefone') || catNameLower.includes('celular')) categoryEmoji = '📱';
    }

    let summary = "";
    if (forEdit) summary += "✅ Recorrência Atualizada:\n\n";

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
    summary += `🤖 Ação Automática: ${rule.autoCreateTransaction ? 'Sim (Cria Transação Pendente)' : 'Não (Apenas Lembrete)'}\n`;
    summary += `🚦 Status da Regra: ${rule.isActive ? 'Ativa ✔️' : 'Inativa ❌'}`;
    if (rule.notes) summary += `\n📝 Obs: ${rule.notes}`;
    return summary;
}

function formatProductSummary(product, clientName, forMulti = false, forEdit = false) {
    let summary = "";
    if (forEdit) summary += "✅ Produto Atualizado:\n\n";

    summary += `🏷️ Nome: ${product.name}\n`;
    if (product.code) summary += `🔢 Código: ${product.code}\n`;
    summary += `💲 Preço Venda: R$ ${parseFloat(product.salePrice).toFixed(2)}\n`;
    if (product.costPrice) summary += `📉 Preço Custo: R$ ${parseFloat(product.costPrice).toFixed(2)}\n`;
    summary += `📊 Estoque Atual: ${product.quantity} ${product.unit || 'UN'}\n`;
    if (product.minimumStock && product.minimumStock > 0) {
        summary += `🔔 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}`;
        if (product.quantity <= product.minimumStock) summary += " ⚠️ Atenção! Estoque baixo!";
        summary += "\n";
    }
    summary += `🚦 Status: ${product.isActive ? 'Ativo ✔️' : 'Inativo ❌'}`;
    if (product.description) summary += `\n📜 Descrição: ${product.description}`;
    return summary;
}

function formatCreditCardSummary(card, clientName, forMulti = false, forEdit = false) {
    let summary = "";
    if (forEdit) summary += "✅ Cartão Atualizado:\n\n";

    summary += `✨ Nome: ${card.name}\n`;
    if(card.lastFourDigits) summary += `🔢 Final: **** ${card.lastFourDigits}\n`;
    if(card.flag) summary += `🚩 Bandeira: ${card.flag}\n`;
    summary += `💰 Limite: R$ ${parseFloat(card.limit).toFixed(2)}\n`;
    summary += `🗓️ Dia Fechamento: ${card.closingDay}\n`;
    summary += `💸 Dia Pagamento: ${card.paymentDay}\n`;
    summary += `⭐ Padrão: ${card.isDefault ? 'Sim ✔️' : 'Não ❌'}\n`;
    summary += `🚦 Status: ${card.isActive ? 'Ativo ✔️' : 'Inativo ❌'}`;
    return summary;
}

function formatCreditCardInvoiceSummary(invoiceDetails, clientName, listTransactions = true) {
    let summary = "";
    const invoiceMonthYear = new Date(invoiceDetails.invoiceEndDate + 'T00:00:00Z').toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    let profileName = "Pessoal";
    if (invoiceDetails.financialAccountType === 'PJ') profileName = "Empresarial (PJ)";
    else if (invoiceDetails.financialAccountType === 'MEI') profileName = "MEI";

    summary += `🧾 Fatura do Cartão ${invoiceDetails.cardName} – ${invoiceMonthYear}\n`;
    summary += `👤 Perfil: ${invoiceDetails.financialAccountName} [${profileName}]\n`;
    summary += `📆 Período da fatura: ${new Date(invoiceDetails.invoiceCycleStartDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {day: '2-digit', month:'2-digit', timeZone:'UTC'})} a ${new Date(invoiceDetails.invoiceCycleEndDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {day: '2-digit', month:'2-digit', timeZone:'UTC'})}\n`;
    summary += `💳 Vencimento: ${new Date(invoiceDetails.paymentDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })}\n`;
    summary += `💰 Valor Total: R$ ${invoiceDetails.totalAmount.toFixed(2)}\n`;

    if (listTransactions && invoiceDetails.transactions && invoiceDetails.transactions.length > 0) {
        summary += "\n📋 Lançamentos Detalhados:\n";
        const maxTxToList = 10;
        invoiceDetails.transactions.slice(0, maxTxToList).forEach(tx => {
            const txDate = new Date(tx.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
            let txDescription = tx.description;

            if (tx.isParcel && tx.parcelNumber && tx.totalParcels && tx.originalAccount) {
                const originalDesc = tx.originalAccount.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                if (!txDescription.toLowerCase().includes(`parcela ${tx.parcelNumber}/${tx.totalParcels}`)) {
                     txDescription = `${originalDesc} – Parcela ${tx.parcelNumber}/${tx.totalParcels}`;
                }
            }
            summary += `\n🗓️ ${txDate} – ${txDescription} – R$ ${parseFloat(tx.value).toFixed(2)}`;
            if (tx.category && tx.category.name) summary += ` [${tx.category.name}]`;
        });
        if (invoiceDetails.transactions.length > maxTxToList) {
            summary += `\n\n... e mais ${invoiceDetails.transactions.length - maxTxToList} lançamentos. Peça para ver todos se quiser! 😉`;
        }
    } else if (listTransactions && (!invoiceDetails.transactions || invoiceDetails.transactions.length === 0)) {
        summary += "\n🎉 Uhuul! Nenhum lançamento nesta fatura até o momento. Que tranquilidade!";
    }
    return summary;
}


function formatAvailableLimitSummary(limitInfo, clientName) {
    let summary = "";
    summary += `💳 Cartão: *${limitInfo.cardName}*\n`;
    summary += `💰 Limite Total: R$ ${limitInfo.totalLimit.toFixed(2)}\n`;
    summary += `📈 Usado na Fatura Aberta: R$ ${limitInfo.usedAmount.toFixed(2)}\n`;
    if (limitInfo.paymentsMadeForOpenInvoice > 0) {
        summary += `💸 Pagamentos Já Feitos (Fatura Aberta): R$ ${limitInfo.paymentsMadeForOpenInvoice.toFixed(2)}\n`;
        summary += `📊 Saldo Devedor Atual (Fatura Aberta): R$ ${limitInfo.netUsedAmount.toFixed(2)}\n`;
    }
    summary += `✨ *Limite Disponível para Novas Compras: R$ ${limitInfo.availableLimit.toFixed(2)}*\n\n`;
    summary += `🗓️ Próximo Fechamento: ${new Date(limitInfo.currentInvoiceCycle.end + 'T00:00:00Z').toLocaleDateString('pt-BR', {day:'2-digit', month:'2-digit', timeZone:'UTC'})}`;
    return summary;
}

function initializeState(client, defaultAccount = null) {
    const clientName = client ? (client.name || "pessoa incrível") : "pessoa incrível";

    let hasPaidAccess = false;
    let accessLevelText = 'gratuito';

    if (client) {
        accessLevelText = client.accessLevel || 'gratuito';
        if (client.accessLevel === 'mensal' || client.accessLevel === 'anual' || client.accessLevel === 'vitalicio') {
            hasPaidAccess = true;
            if (client.accessExpiresAt && (client.accessLevel === 'mensal' || client.accessLevel === 'anual')) {
                const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
                const today = new Date();
                today.setUTCHours(0,0,0,0);

                if (expiryDate < today) {
                    hasPaidAccess = false;
                    accessLevelText = `expirado (era ${client.accessLevel})`;
                } else {
                    accessLevelText += ` (expira em ${expiryDate.toLocaleDateString('pt-BR', {timeZone: 'UTC'})})`;
                }
            }
        }
    }

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
        currentAccessLevel: client ? client.accessLevel : 'gratuito',
        accessExpiresAt: client ? client.accessExpiresAt : null,
        hasPaidAccess: hasPaidAccess,
        isFirstInteractionWithAccounts: false,
        accountsToCreate: [],
        currentAccountCreationStep: null,
    };

    if (!newState.hasPaidAccess && client) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Para aproveitar ao máximo o ${aiModelService.ASSISTANT_NAME}, você precisa de um acesso 'mensal' ou 'anual'. Gostaria de saber como obtê-los? É rapidinho! ✨ (Responda 'sim' para saber mais)` });
        newState.currentAction = 'awaiting_plan_interest';
    } else if (defaultAccount && client && newState.hasPaidAccess) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Bem-vindo(a) de volta à sua conta "${newState.activeFinancialAccountName}" (Acesso: ${accessLevelText}). Como posso te ajudar hoje? Estou pronto para anotar tudo! 📝` });
    } else if (client && newState.hasPaidAccess) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 (Acesso: ${accessLevelText}). Como posso te ajudar hoje? Estou aqui para o que precisar! ✨` });
    } else if (!client) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá! Como posso te ajudar hoje?` });
    }
    return newState;
}

async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    try {
        let client = await clientService.findOrCreateClientByPhone(senderPhone, { name: pushName });
        if (!client) {
            await sendWhatsappMessage(senderPhone, `Desculpe, ${pushName || 'você'}, estou com um problema para identificar/registrar você. Por favor, tente mais tarde. 😕`);
            return;
        }
        const clientNameToUse = client.name || "pessoa incrível";

        const defaultAccount = await clientService.getActiveOrDefaultFinancialAccount(client.id);
        state = conversationState.get(senderPhone) || initializeState(client, defaultAccount);

        state.currentAccessLevel = client.accessLevel;
        state.accessExpiresAt = client.accessExpiresAt;
        state.hasPaidAccess = client.accessLevel && (client.accessLevel === 'mensal' || client.accessLevel === 'anual' || client.accessLevel === 'vitalicio');
        let accessLevelTextForState = client.accessLevel || 'gratuito';

        if (client.accessLevel === 'mensal' || client.accessLevel === 'anual') {
            if (client.accessExpiresAt) {
                const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
                const today = new Date();
                today.setUTCHours(0,0,0,0);
                if (expiryDate < today) {
                    state.hasPaidAccess = false;
                    accessLevelTextForState = `expirado (era ${client.accessLevel})`;
                } else {
                     accessLevelTextForState += ` (expira em ${expiryDate.toLocaleDateString('pt-BR', {timeZone: 'UTC'})})`;
                }
            } else {
                state.hasPaidAccess = false;
                logger.warn(`[WHATSAPP SERVICE] Cliente ${client.id} com acesso ${client.accessLevel} mas sem data de expiração. Considerado como sem acesso pago.`);
            }
        }

        if (client.name && state.clientName !== client.name) state.clientName = client.name;

        if (!(rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string')) {
            state.messageHistory.push({ role: 'user', content: messageText });
        }
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }
        conversationState.set(senderPhone, state);

        if (!state.hasPaidAccess) {
            if (state.currentAction === 'awaiting_plan_interest' || !state.currentAction) {
                const lowerMsg = messageText.toLowerCase().trim();
                if (state.currentAction === 'awaiting_plan_interest' && (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('quero') || lowerMsg.includes('planos') || lowerMsg.includes('obter'))) {
                    let planInfoMessage = `Que demais, ${clientNameToUse}! 🎉 Temos estas opções de acesso para você:\n\n`;
                    planInfoMessage += `*Acesso Mensal*\nLibera todas as funcionalidades por 30 dias.\nPreço: R$ 39,90\n\n`;
                    planInfoMessage += `*Acesso Anual*\nLibera todas as funcionalidades por 365 dias com um super desconto.\nPreço: R$ 399,00\n\n`;
                    const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                    planInfoMessage += `Para obter seu acesso, visite nosso site: ${siteUrl}\n\nApós confirmar, me mande um "oi" aqui para continuarmos! 😉`;
                    state.messageHistory.push({ role: 'assistant', content: planInfoMessage });
                    state.currentAction = 'showing_plans';
                    await sendWhatsappMessage(senderPhone, planInfoMessage);
                } else if (state.currentAction === 'awaiting_plan_interest' && !(lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('quero') || lowerMsg.includes('planos') || lowerMsg.includes('obter'))) {
                    const noInterestReply = `Tudo bem, ${clientNameToUse}! Se mudar de ideia sobre as opções de acesso, é só me chamar. 😊 Lembre-se que sem um acesso 'mensal' ou 'anual', as funcionalidades ficam limitadas. Para obter, acesse nosso site: ${process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"}`;
                    state.messageHistory.push({ role: 'assistant', content: noInterestReply });
                    state.currentAction = null;
                    await sendWhatsappMessage(senderPhone, noInterestReply);
                } else if (state.currentAction !== 'showing_plans' && state.currentAction !== 'awaiting_plan_interest') {
                    const lastAssistantMessage = state.messageHistory.filter(m => m.role === 'assistant').pop();
                    if (lastAssistantMessage && (lastAssistantMessage.content.includes("você precisa de um acesso") || lastAssistantMessage.content.includes("Seu acesso"))) {
                         await sendWhatsappMessage(senderPhone, lastAssistantMessage.content);
                         state.currentAction = 'awaiting_plan_interest';
                    } else {
                        const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                        const genericNoAccessMsg = `Olá ${clientNameToUse}! 😊 Para usar todas as funcionalidades do ${aiModelService.ASSISTANT_NAME}, você precisa de um acesso 'mensal' ou 'anual'. Acesse ${siteUrl} para obter o seu!`;
                        state.messageHistory.push({ role: 'assistant', content: genericNoAccessMsg });
                        state.currentAction = 'awaiting_plan_interest';
                        await sendWhatsappMessage(senderPhone, genericNoAccessMsg);
                    }
                }
            }
            conversationState.set(senderPhone, state);
            return;
        }

        const clientFinancialAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
        if (clientFinancialAccounts.length === 0 && !state.data.accountsSetupCompleted && state.hasPaidAccess) {
            state.isFirstInteractionWithAccounts = true;
            state.data.accountsSetupCompleted = false;
        }

        if (state.isFirstInteractionWithAccounts && state.currentAction !== 'awaiting_financial_account_selection') {
            let replyMsgGuiada = "";
            let nextStepActionGuiada = state.currentAction;

            if (!state.data.askedAboutAccountTypes && state.currentAction !== 'creating_guided_account_confirm_setup') {
                replyMsgGuiada = `Eba, ${clientNameToUse}! Que bom ter você por aqui com seu acesso '${accessLevelTextForState}'! 🎉\n\nPara organizar tudo direitinho, o ${aiModelService.ASSISTANT_NAME} trabalha com diferentes tipos de "contas financeiras". Você pode ter uma para suas finanças:\n\n🧑‍💼 *Pessoais (PF)*\n🏢 *Da sua Empresa (PJ)*\n🚀 *Do seu MEI*\n\nVamos configurar as que você precisa? (Responda "sim" para começar ou "não" para pular por agora)`;
                state.data.askedAboutAccountTypes = true;
                nextStepActionGuiada = 'creating_guided_account_confirm_setup';
            } else if (state.currentAction === 'creating_guided_account_confirm_setup') {
                if (messageText.toLowerCase().includes('sim') || messageText.toLowerCase().includes('s')) {
                    state.accountsToCreate = ['PF', 'PJ', 'MEI'];
                    const accountTypeToCreateNow = state.accountsToCreate.shift();
                    replyMsgGuiada = `Ótimo! Vamos começar com a conta de *Pessoa Física (PF)*. Qual nome você gostaria de dar para ela? (Ex: "Minhas Finanças", "Pessoal")`;
                    nextStepActionGuiada = `creating_guided_account_name_${accountTypeToCreateNow}`;
                } else {
                    replyMsgGuiada = `Sem problemas, ${clientNameToUse}! Você pode configurar suas contas financeiras a qualquer momento depois, ok? 😊 Por enquanto, como posso te ajudar?`;
                    state.isFirstInteractionWithAccounts = false;
                    state.data.accountsSetupCompleted = true;
                    nextStepActionGuiada = null;
                }
            } else if (state.currentAction && typeof state.currentAction === 'string' && state.currentAction.startsWith('creating_guided_account_name_')) {
                const currentTypeBeingNamed = state.currentAction.replace('creating_guided_account_name_', '');
                const accountName = messageText.trim();

                if (messageText.toLowerCase().includes('pular')) {
                    logger.info(`[WHATSAPP SERVICE] Cliente ${client.id} pulou criação da conta ${currentTypeBeingNamed}.`);
                     if (state.accountsToCreate.length > 0) {
                        const nextType = state.accountsToCreate.shift();
                        let typeTextNext = nextType === 'PJ' ? 'Empresa (PJ)' : (nextType === 'MEI' ? 'MEI' : 'Pessoa Física (PF)');
                        replyMsgGuiada = `Entendido! Pulamos a conta ${currentTypeBeingNamed}.\n\nVamos para a conta de *${typeTextNext}*. Qual nome você quer dar a ela? (Ou diga "pular" novamente)`;
                        nextStepActionGuiada = `creating_guided_account_name_${nextType}`;
                    } else {
                        replyMsgGuiada = `Entendido! Pulamos a conta ${currentTypeBeingNamed}.\n\nNão há mais tipos de conta para configurar por agora. Estou pronto para te ajudar! ${state.activeFinancialAccountId ? `O que gostaria de fazer na sua conta "${state.activeFinancialAccountName}"?` : 'Como posso te ajudar?'}`;
                        state.isFirstInteractionWithAccounts = false;
                        state.data.accountsSetupCompleted = true;
                        nextStepActionGuiada = null;
                    }
                } else if (accountName.length > 2 && accountName.length < 100) {
                    try {
                        const newFA = await clientService.createFinancialAccount(client.id, {
                            accountName: accountName,
                            accountType: currentTypeBeingNamed,
                            isDefault: clientFinancialAccounts.length === 0 && !state.activeFinancialAccountId
                        });
                        logger.info(`[WHATSAPP SERVICE] Conta guiada ${currentTypeBeingNamed} "${accountName}" criada para cliente ${client.id}`);
                        if (!state.activeFinancialAccountId) {
                            state.activeFinancialAccountId = newFA.id;
                            state.activeFinancialAccountName = newFA.accountName;
                            state.activeFinancialAccountType = newFA.accountType;
                        }
                        clientFinancialAccounts.push(newFA);

                        if (state.accountsToCreate.length > 0) {
                            const nextType = state.accountsToCreate.shift();
                            let typeTextNext = nextType === 'PJ' ? 'Empresa (PJ)' : (nextType === 'MEI' ? 'MEI' : 'Pessoa Física (PF)');
                            replyMsgGuiada = `Legal! Conta "${accountName}" (${currentTypeBeingNamed}) criada! 👍\n\nAgora, para a conta de *${typeTextNext}*. Qual nome você quer dar a ela? (Ou diga "pular" se não precisar desta)`;
                            nextStepActionGuiada = `creating_guided_account_name_${nextType}`;
                        } else {
                            replyMsgGuiada = `Perfeito! Conta "${accountName}" (${currentTypeBeingNamed}) criada! 👍\n\nTodas as contas que você indicou foram configuradas. Estou pronto para te ajudar a organizar suas finanças! O que você gostaria de fazer primeiro na sua conta "${state.activeFinancialAccountName || accountName}"?`;
                            state.isFirstInteractionWithAccounts = false;
                            state.data.accountsSetupCompleted = true;
                            nextStepActionGuiada = null;
                        }
                    } catch (createError) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao criar conta guiada ${currentTypeBeingNamed}: ${createError.message}`);
                        replyMsgGuiada = `Ops! Tive um problema ao criar a conta ${currentTypeBeingNamed} chamada "${accountName}". (${createError.message.substring(0,60)}). Que tal tentar outro nome ou pular esta por agora?`;
                    }
                } else {
                    replyMsgGuiada = `Esse nome parece um pouco curto ou longo demais. Para a conta de ${currentTypeBeingNamed}, poderia me dizer um nome entre 3 e 100 letras? Ou diga "pular". ✍️`;
                }
            }

            if (replyMsgGuiada) {
                state.currentAction = nextStepActionGuiada;
                state.messageHistory.push({ role: 'assistant', content: replyMsgGuiada });
                await sendWhatsappMessage(senderPhone, replyMsgGuiada);
                conversationState.set(senderPhone, state);
                return;
            }
        }

        if (!state.activeFinancialAccountId && clientFinancialAccounts.length > 0) {
            if (clientFinancialAccounts.length === 1) {
                const acc = clientFinancialAccounts[0];
                state.activeFinancialAccountId = acc.id;
                state.activeFinancialAccountName = acc.accountName;
                state.activeFinancialAccountType = acc.accountType;
                const selectMsg = `Beleza, ${clientNameToUse}! Notei que você tem a conta "${acc.accountName}" (${acc.accountType}). Já selecionei ela para você. Como posso ajudar? 🚀`;
                state.messageHistory.push({ role: 'assistant', content: selectMsg });
                state.currentAction = null; state.data.accountsToList = null;
                await sendWhatsappMessage(senderPhone, selectMsg);
            } else if (state.currentAction === 'selecting_initial_financial_account' || !state.data.accountsToList) {
                state.currentAction = 'selecting_initial_financial_account';
                state.data.accountsToList = clientFinancialAccounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                let accountOptionsText = `Olá ${clientNameToUse}! 👋 Você tem estas contas configuradas:\n`;
                state.data.accountsToList.forEach((acc, index) => { accountOptionsText += `\n${index + 1}. *${acc.name}* (${acc.type})`; });
                accountOptionsText += `\n\nQual delas você gostaria de usar agora? Me diga o *nome* ou o *número* da conta. 😉 Estou no aguardo!`;
                state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                await sendWhatsappMessage(senderPhone, accountOptionsText);
            } else {
                 const chosenIdentifier = messageText.trim();
                 let accountToSelect = null;
                 const chosenNumber = parseInt(chosenIdentifier, 10);

                 if (!isNaN(chosenNumber) && chosenNumber > 0 && chosenNumber <= state.data.accountsToList.length) {
                     accountToSelect = state.data.accountsToList[chosenNumber - 1];
                 } else {
                     accountToSelect = state.data.accountsToList.find(acc =>
                        acc.name.toLowerCase() === chosenIdentifier.toLowerCase() ||
                        acc.name.toLowerCase().includes(chosenIdentifier.toLowerCase())
                     );
                 }

                 if (accountToSelect) {
                    state.activeFinancialAccountId = accountToSelect.id;
                    state.activeFinancialAccountName = accountToSelect.name;
                    state.activeFinancialAccountType = accountToSelect.type;
                    const confirmSelectionMsg = `Entendido, ${clientNameToUse}! Selecionei a conta "${state.activeFinancialAccountName}". Como posso ajudar? 🚀`;
                    state.messageHistory.push({ role: 'assistant', content: confirmSelectionMsg });
                    state.currentAction = null; state.data.accountsToList = null;
                    await sendWhatsappMessage(senderPhone, confirmSelectionMsg);
                 } else {
                    let errorReply = `Hum, ${clientNameToUse}, não identifiquei essa conta. 😕 Você tem estas opções:\n`;
                    state.data.accountsToList.forEach((acc, index) => {errorReply += `\n${index + 1}. *${acc.name}* (${acc.type})`});
                    errorReply += "\n\nQual delas gostaria de usar (nome ou número)? 🤔"
                    state.messageHistory.push({ role: 'assistant', content: errorReply });
                    await sendWhatsappMessage(senderPhone, errorReply);
                 }
            }
            conversationState.set(senderPhone, state);
            if (state.currentAction === 'selecting_initial_financial_account' || !state.activeFinancialAccountId) return;

        } else if (!state.activeFinancialAccountId && clientFinancialAccounts.length === 0 && state.hasPaidAccess) {
            const noAccountsMsg = `Olá ${clientNameToUse}! Você tem acesso '${accessLevelTextForState}', mas parece que ainda não configuramos nenhuma conta financeira (PF, PJ ou MEI). Diga "criar conta" para começarmos! 😉`;
            state.messageHistory.push({ role: 'assistant', content: noAccountsMsg });
            state.currentAction = null;
            await sendWhatsappMessage(senderPhone, noAccountsMsg);
            conversationState.set(senderPhone, state);
            return;
        }

        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ID '${buttonId}', Texto: '${messageText}'`);
            let buttonClickHandledByServiceLogic = true;
            let replyForButtonClick = "";

            if (buttonId.startsWith('edit_transaction_')) {
                const transactionId = buttonId.replace('edit_transaction_', '');
                state.editingResource = { type: 'transaction', id: transactionId };
                replyForButtonClick = `Claro, ${clientNameToUse}! 😉 Descreva na próxima mensagem o que você precisa que eu altere na transação (ID: ${transactionId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                state.currentAction = 'awaiting_transaction_edit_details';
            } else if (buttonId.startsWith('delete_transaction_')) {
                const transactionId = buttonId.replace('delete_transaction_', '');
                try {
                    const success = await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId);
                    replyForButtonClick = success ? `Transação removida com sucesso, ${clientNameToUse}! 👍 Se precisar de mais alguma coisa, é só chamar.` : "Não consegui excluir a transação. Pode ter sido um erro ou ela já foi removida.";
                } catch (e) {
                    logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar excluir a transação. (${e.message.substring(0,50)})`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            } else if (buttonId.startsWith('edit_appointment_')) {
                const appointmentId = buttonId.replace('edit_appointment_', '');
                state.editingResource = { type: 'appointment', id: appointmentId };
                replyForButtonClick = `Beleza, ${clientNameToUse}! ✨ Me diga na próxima mensagem o que você quer mudar no compromisso (ID: ${appointmentId}).`;
                state.currentAction = 'awaiting_appointment_edit_details';
            } else if (buttonId.startsWith('delete_appointment_')) {
                const appointmentId = buttonId.replace('delete_appointment_', '');
                try {
                    const success = await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, true); // true para deletar
                    replyForButtonClick = success ? `Compromisso removido da sua agenda, ${clientNameToUse}! ✅ Fico à disposição se precisar de algo mais.` : "Não foi possível excluir o compromisso.";
                } catch (e) {
                     logger.error(`[WHATSAPP SERVICE] Erro ao excluir compromisso ${appointmentId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar excluir o compromisso. (${e.message.substring(0,50)})`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            }
            else {
                buttonClickHandledByServiceLogic = false;
            }

            if (buttonClickHandledByServiceLogic) {
                state.messageHistory.push({ role: 'assistant', content: replyForButtonClick });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForButtonClick);
                return;
            }
        }

        if (state.currentAction) {
             let stateHandledInPreProcessing = false;
            let replyForPreProcessing = "";

            if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                 const lowerMsg = messageText.toLowerCase().trim();
                 if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                    replyForPreProcessing = `Entendido, ${clientNameToUse}! Confirmado! 👍 Vou prosseguir com base nisso. O que mais posso fazer?`;
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    stateHandledInPreProcessing = true;
                } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) {
                    replyForPreProcessing = `Ok, ${clientNameToUse}, cancelado! Sem problemas. O que gostaria de fazer então? 😊`;
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    stateHandledInPreProcessing = true;
                }
            }
            else if (state.currentAction === 'awaiting_transaction_edit_details' || state.currentAction === 'awaiting_appointment_edit_details') {
                stateHandledInPreProcessing = false;
            }
            else if (state.currentAction === 'awaiting_clarification_response'){
                stateHandledInPreProcessing = false;
            }


            if (stateHandledInPreProcessing && replyForPreProcessing) {
                state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                if (state.currentAction === null && !state.pendingConfirmation) return;
            }
        }

        logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id} (${clientNameToUse}), Conta Ativa: ${state.activeFinancialAccountName || 'N/A'} (ID: ${state.activeFinancialAccountId || 'N/A'}), Msg: "${messageText}"`);
        if(!state.activeFinancialAccountId && state.hasPaidAccess) {
            logger.warn(`[WHATSAPP HANDLER] Cliente ${client.id} tem acesso pago mas NENHUMA conta financeira ativa no estado para IA. Isso não deveria acontecer se o fluxo de seleção/criação estiver correto.`);
        }

        const aiContext = {
            currentFinancialAccountId: state.activeFinancialAccountId,
            currentFinancialAccountType: state.activeFinancialAccountType,
            currentFinancialAccountName: state.activeFinancialAccountName,
            clientName: clientNameToUse,
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
            currentStateData: state.data,
            editingResource: state.editingResource,
            currentAccessLevel: state.currentAccessLevel,
            hasPaidAccess: state.hasPaidAccess,
        };
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponsePreview: JSON.stringify(aiResponse).substring(0,500) + "..."});
        state.lastAiResponse = aiResponse;

        if(state.currentAction && typeof state.currentAction === 'string' &&
           (state.currentAction.startsWith('awaiting_') || state.currentAction.startsWith('creating_guided_account_') || state.currentAction === 'selecting_initial_financial_account') ) {
            if (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0) {
                 state.currentAction = null;
            }
        }

        let finalReplyParts = [];
        if (aiResponse.overall_summary_suggestion) {
            finalReplyParts.push(aiResponse.overall_summary_suggestion);
        }

        state.pendingConfirmation = null;

        let singleActionFormattedResult = null;
        let multipleActionFormattedResults = [];
        let actionWasAnEdit = false;
        let resourceForButtonsContext = null;

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            for (const detectedAction of aiResponse.detected_actions) {
                const params = detectedAction.parameters || {};
                let currentActionFormatted = "";
                let isEditActionCurrentLoop = false;
                let actionBlockedNoAccessLoop = false;

                const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SWITCH_FINANCIAL_ACCOUNT', 'CREATE_FINANCIAL_ACCOUNT'];
                if (!state.hasPaidAccess && !publicActions.includes(detectedAction.action)) {
                    currentActionFormatted = `Sinto muito, ${clientNameToUse}, mas para realizar a ação de "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", você precisa de um acesso 'mensal' ou 'anual'. Para obter, acesse nosso site: ${process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"} e depois me chame aqui! 😉`;
                    state.currentAction = 'awaiting_plan_interest';
                    actionBlockedNoAccessLoop = true;
                }
                const accountRequiredActions = [
                    'CREATE_FINANCIAL_TRANSACTION', 'SCHEDULE_APPOINTMENT', 'CREATE_PARCELLED_ACCOUNT',
                    'UPDATE_FINANCIAL_TRANSACTION', 'UPDATE_APPOINTMENT', 'GET_FINANCIAL_SUMMARY',
                    'LIST_FINANCIAL_TRANSACTIONS', 'MARK_TRANSACTION_AS_PAID_RECEIVED',
                    'CREATE_RECURRING_RULE', 'CREATE_PRODUCT', 'GET_STOCK_INFO',
                    'RECORD_STOCK_MOVEMENT', 'LIST_APPOINTMENTS', 'CREATE_CREDIT_CARD',
                    'LIST_CREDIT_CARDS', 'LIST_RECURRING_RULES',
                    'GET_CREDIT_CARD_INVOICE', 'GET_CREDIT_CARD_AVAILABLE_LIMIT', 'PAY_CREDIT_CARD_INVOICE'
                ];
                if (accountRequiredActions.includes(detectedAction.action) && !state.activeFinancialAccountId) {
                    currentActionFormatted = `Opa, ${clientNameToUse}! Para eu poder "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", preciso que você selecione uma conta financeira primeiro. Se você já configurou alguma, me diga o nome dela. Se não, diga "criar conta"! 😊`;
                    state.currentAction = 'selecting_initial_financial_account';
                    actionBlockedNoAccessLoop = true;
                }

                if (actionBlockedNoAccessLoop) {
                    if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = currentActionFormatted;
                    else multipleActionFormattedResults.push(currentActionFormatted);
                    break;
                }

                try {
                    switch (detectedAction.action) {
                        case 'CREATE_FINANCIAL_TRANSACTION': {
                            const categoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                            const cardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                            const txData = {
                                description: params.description, type: params.type, value: parseFloat(params.value),
                                transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes,
                                isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : (cardId ? false : false)),
                                dueDate: cardId ? null : params.dueDate, 
                                isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (cardId ? true : (!params.dueDate))
                            };
                            const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                            const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                            currentActionFormatted = formatFinancialTransactionSummary(reloadedTx, clientNameToUse, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'transaction', id: newTx.id, description: newTx.description };
                            break;
                        }
                        case 'UPDATE_FINANCIAL_TRANSACTION': {
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true;
                            const transactionIdToUpdate = params.transactionIdToUpdate || state.editingResource?.id;
                            if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não foi fornecido pela IA ou não estava no contexto de edição.");

                            const updateTxData = { ...params };
                            if (params.financialCategoryName) updateTxData.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || null);
                            if (params.creditCardName) updateTxData.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                            delete updateTxData.transactionIdToUpdate; delete updateTxData.financialCategoryName; delete updateTxData.creditCardName;

                            const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateTxData);
                            const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatFinancialTransactionSummary(reloadedUpdatedTx, clientNameToUse, false, true);
                            state.editingResource = null;
                            break;
                        }
                        case 'SCHEDULE_APPOINTMENT': {
                            let eventDateTime = params.eventDateTime;
                            if (params.eventDateTime && params.eventDateTime.length === 10) {
                                eventDateTime += ' 09:00';
                            } else if (params.eventDateTime && params.eventDateTime.includes("T") && params.eventDateTime.endsWith("Z")) {
                                const d = new Date(params.eventDateTime);
                                const year = d.getFullYear(); const month = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
                                const hour = String(d.getHours()).padStart(2, '0'); const minute = String(d.getMinutes()).padStart(2, '0');
                                eventDateTime = `${year}-${month}-${day} ${hour}:${minute}`;
                            }

                            const appData = {
                                title: params.title, eventDateTime: eventDateTime,
                                durationMinutes: params.durationMinutes, location: params.location,
                                reminderLeadTimeMinutes: params.reminderLeadTimeMinutes, notes: params.notes,
                                associatedValue: params.associatedValue ? parseFloat(params.associatedValue) : null,
                                associatedTransactionType: params.associatedTransactionType || null,
                            };
                            const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                            const reloadedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newApp.id);
                            currentActionFormatted = formatAppointmentSummary(reloadedApp, clientNameToUse, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'appointment', id: newApp.id, description: newApp.title };
                            break;
                        }
                        case 'UPDATE_APPOINTMENT': {
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true;
                            const appointmentIdToUpdate = params.appointmentIdToUpdate || state.editingResource?.id;
                            if (!appointmentIdToUpdate) throw new Error("ID do compromisso para atualizar não fornecido pela IA ou não estava no contexto de edição.");

                            const updateAppData = { ...params };
                            if (params.eventDateTime && params.eventDateTime.length === 10) {
                                updateAppData.eventDateTime += ' 09:00';
                            } else if (params.eventDateTime && params.eventDateTime.includes("T") && params.eventDateTime.endsWith("Z")) {
                               const d = new Date(params.eventDateTime);
                                const year = d.getFullYear(); const month = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
                                const hour = String(d.getHours()).padStart(2, '0'); const minute = String(d.getMinutes()).padStart(2, '0');
                                updateAppData.eventDateTime = `${year}-${month}-${day} ${hour}:${minute}`;
                            }
                            delete updateAppData.appointmentIdToUpdate;
                            if (params.hasOwnProperty('associatedValue')) updateAppData.associatedValue = params.associatedValue ? parseFloat(params.associatedValue) : null;

                            const updatedApp = await appointmentService.updateAppointment(state.activeFinancialAccountId, appointmentIdToUpdate, updateAppData);
                            const reloadedUpdatedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, updatedApp.id);
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatAppointmentSummary(reloadedUpdatedApp, clientNameToUse, false, true);
                            state.editingResource = null;
                            break;
                        }
                        case 'CREATE_PARCELLED_ACCOUNT': {
                            const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                            const cardIdParcel = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;

                            if (params.creditCardName && !cardIdParcel) {
                                currentActionFormatted = `Hum, ${clientNameToUse}, não encontrei um cartão chamado "${params.creditCardName}" para registrar essa compra parcelada. 😕 Você pode cadastrar o cartão primeiro ou tentar com outro nome.`;
                                break;
                            }

                            const parcelData = {
                                description: params.description, type: params.type, totalValue: parseFloat(params.totalValue),
                                numberOfParcels: parseInt(params.numberOfParcels), initialDueDate: params.initialDueDate,
                                financialCategoryId: catIdParcel, creditCardId: cardIdParcel, notes: params.notes,
                                transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                            };
                            const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData);
                            if (!detectedAction.action_specific_reply_suggestion) {
                                currentActionFormatted = `Sua compra de ${params.description} no valor de R$ ${parseFloat(params.totalValue).toFixed(2)} em ${params.numberOfParcels}x `;
                                if (cardIdParcel) {
                                    currentActionFormatted += `no cartão ${params.creditCardName} `;
                                }
                                currentActionFormatted += `foi registrada com sucesso! 🥳`;
                                if (parcelResult.parcels.length > 0 && parcelResult.parcels[0].dueDate && !cardIdParcel) {
                                    currentActionFormatted += `\nA primeira parcela vence em ${new Date(parcelResult.parcels[0].dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'})}.`;
                                } else if (cardIdParcel) {
                                     const firstParcelDate = new Date(parcelResult.parcels[0].transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'});
                                    currentActionFormatted += `\nA primeira parcela (R$ ${parseFloat(parcelResult.parcels[0].value).toFixed(2)}) deve aparecer na fatura do seu cartão ${params.creditCardName} por volta de ${firstParcelDate}.`;
                                }
                            }
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
                                switch(params.period.toLowerCase().replace("_", " ")) {
                                    case 'hoje': filterParams.dateStart = filterParams.dateEnd = todayLocale.toISOString().split('T')[0]; break;
                                    case 'ontem': const y = new Date(todayLocale); y.setDate(y.getDate() - 1); filterParams.dateStart = filterParams.dateEnd = y.toISOString().split('T')[0]; break;
                                    case 'esta semana':
                                        const day = todayLocale.getDay(); const diff = todayLocale.getDate() - day + (day === 0 ? -6 : 1);
                                        const first = new Date(todayLocale.setDate(diff));
                                        const last = new Date(first); last.setDate(first.getDate() + 6);
                                        filterParams.dateStart = first.toISOString().split('T')[0]; filterParams.dateEnd = last.toISOString().split('T')[0]; break;
                                    case 'semana passada':
                                        const prevWeekEnd = new Date(todayLocale); prevWeekEnd.setDate(todayLocale.getDate() - todayLocale.getDay() -1);
                                        const prevWeekStart = new Date(prevWeekEnd); prevWeekStart.setDate(prevWeekEnd.getDate() - 6);
                                        filterParams.dateStart = prevWeekStart.toISOString().split('T')[0]; filterParams.dateEnd = prevWeekEnd.toISOString().split('T')[0]; break;
                                    case 'este mes': case 'este mês':
                                        filterParams.dateStart = new Date(todayLocale.getFullYear(), todayLocale.getMonth(), 1).toISOString().split('T')[0];
                                        filterParams.dateEnd = new Date(todayLocale.getFullYear(), todayLocale.getMonth() + 1, 0).toISOString().split('T')[0]; break;
                                    case 'mes passado': case 'mês passado':
                                        filterParams.dateStart = new Date(todayLocale.getFullYear(), todayLocale.getMonth() - 1, 1).toISOString().split('T')[0];
                                        filterParams.dateEnd = new Date(todayLocale.getFullYear(), todayLocale.getMonth(), 0).toISOString().split('T')[0]; break;
                                    case 'este ano':
                                        filterParams.dateStart = new Date(todayLocale.getFullYear(), 0, 1).toISOString().split('T')[0];
                                        filterParams.dateEnd = new Date(todayLocale.getFullYear(), 11, 31).toISOString().split('T')[0]; break;
                                }
                            }
                            const summaryData = await financialService.getFinancialSummary(state.activeFinancialAccountId, filterParams);
                            let periodText = params.period ? params.period.replace("_", " ") : (filterParams.dateStart && filterParams.dateEnd ? `${new Date(filterParams.dateStart+'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'})} a ${new Date(filterParams.dateEnd+'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'})}` : "geral");
                            currentActionFormatted = `📊 Resumo Financeiro (${periodText} para ${state.activeFinancialAccountName}):\n\n` +
                                          `🟢 Entradas: R$ ${summaryData.totalEntradas.toFixed(2)}\n` +
                                          `🔴 Saídas: R$ ${summaryData.totalSaidas.toFixed(2)}\n` +
                                          `💰 *Saldo Efetivado (Caixa): R$ ${summaryData.saldoEfetivado.toFixed(2)}*\n\n` +
                                          `📈 A Receber (Pend.): R$ ${summaryData.totalAReceberPendente.toFixed(2)}\n` +
                                          `📉 A Pagar (Pend.): R$ ${summaryData.totalAPagarPendente.toFixed(2)}`;
                            break;
                        }
                         case 'LIST_FINANCIAL_TRANSACTIONS': {
                             const filterParamsList = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                                creditCardId: params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null,
                                isPayableOrReceivable: params.isPayableOrReceivable,
                                isPaidOrReceived: params.isPaidOrReceived,
                                search: params.searchTerm || params.description,
                                limit: params.limit || 7, page: params.page || 1,
                                sortBy: params.sortBy || 'transactionDate', sortOrder: params.sortOrder || 'DESC'
                            };
                            const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList);
                            if (totalItems === 0) {
                                currentActionFormatted = `Nenhuma transação encontrada para os filtros que você pediu, ${clientNameToUse}. 👍 Tente outros filtros!`;
                            } else {
                                let listText = `📜 Encontrei ${totalItems} transações. As ${transactions.length > 1 ? transactions.length + " " : ""}mais recentes são:\n`;
                                for (const t of transactions) {
                                    const catName = t.category ? t.category.name : 'Sem Categoria';
                                    let emoji = t.type === 'Entrada' ? '🟢' : (t.creditCardId ? '💳' : '🔴');
                                    if (t.isParcel && t.originalAccount) emoji = '📦';

                                    const date = new Date(t.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {day:'2-digit',month:'2-digit',timeZone:'UTC'});
                                    let descriptionText = t.description;
                                    if (t.isParcel && t.parcelNumber && t.totalParcels && t.originalAccount) {
                                        const originalDesc = t.originalAccount.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                                         if (!descriptionText.toLowerCase().includes(`parcela ${t.parcelNumber}/${t.totalParcels}`)) {
                                            descriptionText = `${originalDesc} - Pcl ${t.parcelNumber}/${t.totalParcels}`;
                                         }
                                    }

                                    listText += `\n${emoji} ${descriptionText} - R$ ${parseFloat(t.value).toFixed(2)}\n    (Cat: ${catName}, Data: ${date}, ID: ${t.id})`;
                                    if (t.isPayableOrReceivable && !t.creditCardId) {
                                        listText += t.isPaidOrReceived ? " (Liquidada ✅)" : ` (Vence ${new Date(t.dueDate+'T00:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',timeZone:'UTC'})} 🗓️)`;
                                    }
                                }
                                if (totalItems > transactions.length) listText += `\n\nE mais ${totalItems - transactions.length} transações. Peça para ver mais se quiser! 😉`;
                                currentActionFormatted = listText;
                            }
                            break;
                        }
                        case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                            let transactionToMark = null;
                            if (params.transactionIdToUpdate && !isNaN(parseInt(params.transactionIdToUpdate))) {
                                transactionToMark = await financialService.getTransactionById(state.activeFinancialAccountId, parseInt(params.transactionIdToUpdate));
                            } else if (state.editingResource && state.editingResource.type === 'transaction') {
                                transactionToMark = await financialService.getTransactionById(state.activeFinancialAccountId, state.editingResource.id);
                            } else if (params.transactionDescription) {
                                const searchResults = await financialService.getAllTransactions(state.activeFinancialAccountId, {
                                    search: params.transactionDescription,
                                    isPayableOrReceivable: true,
                                    isPaidOrReceived: false,
                                    limit: 1,
                                    value: params.transactionValue ? parseFloat(params.transactionValue) : undefined
                                });
                                if (searchResults.transactions.length === 1) {
                                    transactionToMark = searchResults.transactions[0];
                                } else if (searchResults.transactions.length > 1) {
                                    currentActionFormatted = `Encontrei várias transações pendentes com essa descrição, ${clientNameToUse}. 🤔 Poderia ser mais específico (ex: mencionar o valor ou ID) ou usar a plataforma para marcar?`;
                                    break;
                                }
                            }

                            if (!transactionToMark) {
                                currentActionFormatted = `Não encontrei uma transação pendente clara para "${params.transactionDescription || 'a transação mencionada'}" para marcar como paga/recebida, ${clientNameToUse}. 😕 (ID Pesquisado: ${params.transactionIdToUpdate || 'N/A'})`;
                            } else {
                                const updatedTx = await financialService.markAsPaidOrReceived(state.activeFinancialAccountId, transactionToMark.id, params.paymentDate);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || `✨ Resumo do registro:\n\n🔄 Atualizamos o status da transação "${updatedTx.description}" e agora ela está como ${updatedTx.type === 'Entrada' ? '"recebida"' : '"paga"'}. A data marcada foi ${new Date(updatedTx.paymentDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})}. 🎉`;
                                state.editingResource = null;
                            }
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
                                endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction === undefined ? false : params.autoCreateTransaction,
                                financialCategoryId: catRecId, notes: params.notes,
                                isPayableOrReceivable: true,
                            };
                            const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                            const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);
                            currentActionFormatted = formatRecurringRuleSummary(reloadedRule, clientNameToUse, aiResponse.detected_actions.length > 1);
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
                            currentActionFormatted = formatProductSummary(newProd, clientNameToUse, aiResponse.detected_actions.length > 1);
                            break;
                        }
                        case 'GET_STOCK_INFO': {
                             if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                currentActionFormatted = `Ops, ${clientNameToUse}, a consulta de estoque é só para contas PJ ou MEI.`;
                                break;
                            }
                            const productId = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                             if(!productId) {
                                currentActionFormatted = `Hum... não encontrei nenhum produto parecido com "${params.productNameOrCode}" na sua conta ${state.activeFinancialAccountName}, ${clientNameToUse}. 🧐`;
                                break;
                            }
                            const stockBalance = await stockService.getProductStockBalance(productId);
                            currentActionFormatted = `📦 Estoque de *${stockBalance.name}* (${state.activeFinancialAccountName}):\n` +
                                                  `Disponível: ${stockBalance.quantity} ${stockBalance.unit || 'UN'}\n` +
                                                  (stockBalance.minimumStock ? `Mínimo: ${stockBalance.minimumStock} ${stockBalance.unit || 'UN'}` : '');
                            if(stockBalance.minimumStock && stockBalance.quantity <= stockBalance.minimumStock) currentActionFormatted += " 📉 Atenção, estoque baixo!";
                            break;
                        }
                        case 'RECORD_STOCK_MOVEMENT': {
                            if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                currentActionFormatted = `Sinto muito, ${clientNameToUse}, movimentação de estoque é para contas PJ ou MEI.`;
                                break;
                            }
                            const productIdStock = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                             if(!productIdStock) {
                                currentActionFormatted = `Não encontrei o produto "${params.productNameOrCode}" para movimentar o estoque, ${clientNameToUse}. 😬`;
                                break;
                            }
                            const movementData = {
                                type: params.movementType,
                                quantity: parseInt(params.quantity),
                                reason: params.reason
                            };
                            const movement = await stockService.recordStockMovement(productIdStock, movementData);
                            const updatedProduct = await productService.getProductById(state.activeFinancialAccountId, productIdStock);
                            currentActionFormatted = `📝 Movimentação de estoque para *${updatedProduct.name}* registrada!\n`+
                                                   `Tipo: ${movement.type}, Quantidade: ${movement.quantity}\n`+
                                                   `Novo Saldo: ${updatedProduct.quantity} ${updatedProduct.unit || 'UN'}`;
                            break;
                        }
                        case 'CREATE_CREDIT_CARD': {
                            const cardData = {
                                name: params.name, limit: parseFloat(params.limit),
                                closingDay: parseInt(params.closingDay), paymentDay: parseInt(params.paymentDay),
                                lastFourDigits: params.lastFourDigits, flag: params.flag,
                                isDefault: params.isDefault === undefined ? false : params.isDefault
                            };
                            const newCard = await creditCardService.createCreditCard(state.activeFinancialAccountId, cardData);
                            currentActionFormatted = formatCreditCardSummary(newCard, clientNameToUse, aiResponse.detected_actions.length > 1);
                            break;
                        }
                        case 'LIST_APPOINTMENTS': {
                            const filterAppList = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd, status: params.status,
                                limit: params.limit || 5, page: params.page || 1,
                                sortBy: params.sortBy || 'eventDateTime', sortOrder: params.sortOrder || 'ASC'
                            };
                             if (params.period) {
                                const todayLocaleApp = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
                                todayLocaleApp.setHours(0,0,0,0);
                                switch(params.period.toLowerCase().replace("_", " ")) {
                                    case 'hoje': filterAppList.specificDate = todayLocaleApp.toISOString().split('T')[0]; break;
                                    case 'amanha': const tomorrow = new Date(todayLocaleApp); tomorrow.setDate(tomorrow.getDate() + 1); filterAppList.specificDate = tomorrow.toISOString().split('T')[0]; break;
                                    case 'esta semana':
                                        const dayApp = todayLocaleApp.getDay(); const diffApp = todayLocaleApp.getDate() - dayApp + (dayApp === 0 ? -6 : 1);
                                        const firstApp = new Date(todayLocaleApp.setDate(diffApp));
                                        const lastApp = new Date(firstApp); lastApp.setDate(firstApp.getDate() + 6);
                                        filterAppList.dateStart = firstApp.toISOString().split('T')[0]; filterAppList.dateEnd = lastApp.toISOString().split('T')[0]; break;
                                    case 'proximos 7 dias':
                                        filterAppList.dateStart = todayLocaleApp.toISOString().split('T')[0];
                                        const sevenDays = new Date(todayLocaleApp); sevenDays.setDate(todayLocaleApp.getDate() + 6);
                                        filterAppList.dateEnd = sevenDays.toISOString().split('T')[0]; break;
                                }
                            }
                            const { appointments, totalItems: totalApps } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, filterAppList);
                            if (totalApps === 0) {
                                currentActionFormatted = `Você não tem compromissos agendados para os filtros informados, ${clientNameToUse}. Que tal agendar algo? 😉`;
                            } else {
                                let appListText = `🗓️ Você tem ${totalApps} compromissos. Os próximos são:\n`;
                                for (const app of appointments) {
                                    const eventDT = new Date(app.eventDateTime);
                                    const dateStr = eventDT.toLocaleDateString('pt-BR', {day:'2-digit', month:'2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo'});
                                    const timeStr = eventDT.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo'});
                                    appListText += `\n- ${app.title} em ${dateStr} às ${timeStr} (ID: ${app.id})`;
                                }
                                if (totalApps > appointments.length) appListText += `\n\nE mais ${totalApps - appointments.length}. Peça para ver mais ou filtre!`;
                                currentActionFormatted = appListText;
                            }
                            break;
                        }
                        case 'LIST_CREDIT_CARDS': {
                            const cards = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                            if(cards.length === 0) {
                                currentActionFormatted = `Você ainda não cadastrou nenhum cartão de crédito na conta "${state.activeFinancialAccountName}", ${clientNameToUse}. 💳 Que tal cadastrar um agora? Diga "criar cartão [nome] limite [valor] fecha dia [dia] paga dia [dia]".`;
                            } else {
                                let cardListText = `Estes são seus cartões de crédito ativos para "${state.activeFinancialAccountName}", ${clientNameToUse}:\n`;
                                cards.forEach(c => {
                                    cardListText += `\n- *${c.name}* (Limite: R$ ${parseFloat(c.limit).toFixed(2)})${c.isDefault ? ' ⭐Padrão' : ''}${c.lastFourDigits ? ` Final ${c.lastFourDigits}` : ''}`;
                                });
                                currentActionFormatted = cardListText;
                            }
                            break;
                        }
                        case 'LIST_RECURRING_RULES': {
                            const rules = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, { isActive: true });
                            if(rules.length === 0) {
                                currentActionFormatted = `Nenhuma regra de recorrência ativa encontrada para "${state.activeFinancialAccountName}", ${clientNameToUse}. 🔄 Para criar uma, diga "criar recorrência [descrição] valor [valor] todo [dia/mês/ano]".`;
                            } else {
                                let ruleListText = `Suas regras de recorrência ativas para "${state.activeFinancialAccountName}", ${clientNameToUse}:\n`;
                                rules.forEach(r => {
                                    const nextDue = new Date(r.nextDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'});
                                    ruleListText += `\n- ${r.description} (R$ ${parseFloat(r.value).toFixed(2)} ${r.type}, Próx: ${nextDue})`;
                                });
                                currentActionFormatted = ruleListText;
                            }
                            break;
                        }
                        case 'SWITCH_FINANCIAL_ACCOUNT': {
                            const targetAccountName = params.targetAccountNameOrType;
                            const allClientAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                            if (!targetAccountName) {
                                if (allClientAccounts.length <= 1 && state.activeFinancialAccountId) {
                                    currentActionFormatted = `Você só tem a conta "${state.activeFinancialAccountName}" configurada por enquanto, ${clientNameToUse}. Se quiser criar outra, me diga "criar conta"! 😉`;
                                } else {
                                    let accList = `Você tem estas contas, ${clientNameToUse}:\n`;
                                    allClientAccounts.forEach(acc => { accList += `\n- *${acc.accountName}* (${acc.accountType}) ${acc.id === state.activeFinancialAccountId ? ' (Selecionada ✨)' : ''}`; });
                                    accList += "\n\nPara qual delas você gostaria de mudar? Só me dizer o nome.";
                                    currentActionFormatted = accList;
                                    state.currentAction = 'selecting_initial_financial_account';
                                    state.data.accountsToList = allClientAccounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                                }
                            } else {
                                const foundAcc = allClientAccounts.find(acc => acc.accountName.toLowerCase() === targetAccountName.toLowerCase() || acc.accountType.toLowerCase() === targetAccountName.toLowerCase());
                                if (foundAcc && foundAcc.id !== state.activeFinancialAccountId) {
                                    state.activeFinancialAccountId = foundAcc.id;
                                    state.activeFinancialAccountName = foundAcc.accountName;
                                    state.activeFinancialAccountType = foundAcc.accountType;
                                    currentActionFormatted = `Prontinho, ${clientNameToUse}! Mudei para sua conta "${state.activeFinancialAccountName}". O que faremos agora? 😊`;
                                    state.currentAction = null;
                                } else if (foundAcc && foundAcc.id === state.activeFinancialAccountId) {
                                    currentActionFormatted = `Você já está usando a conta "${state.activeFinancialAccountName}", ${clientNameToUse}! 😉`;
                                } else {
                                    currentActionFormatted = `Não encontrei uma conta chamada ou do tipo "${targetAccountName}", ${clientNameToUse}. 😕 Tente de novo com o nome exato ou o tipo (PF, PJ, MEI).`;
                                }
                            }
                            break;
                        }
                        case 'CREATE_FINANCIAL_ACCOUNT': {
                            const typeToCreate = params.accountTypeToCreate;
                            const newAccName = params.newAccountName;
                            if (!typeToCreate) {
                                currentActionFormatted = `Para criar uma nova conta financeira, preciso saber o tipo: Pessoal (PF), Empresa (PJ) ou MEI? Qual você prefere, ${clientNameToUse}? 🤔`;
                                state.currentAction = 'creating_first_account_type';
                            } else if (!newAccName) {
                                currentActionFormatted = `Entendi que você quer criar uma conta do tipo ${typeToCreate}, ${clientNameToUse}. Qual nome você gostaria de dar para ela? ✍️`;
                                state.currentAction = 'awaiting_first_account_name';
                                state.data.accountTypeToCreate = typeToCreate;
                            } else {
                                try {
                                    const newFA = await clientService.createFinancialAccount(client.id, { accountName: newAccName, accountType: typeToCreate });
                                    currentActionFormatted = `Conta "${newFA.accountName}" (${newFA.accountType}) criada com sucesso, ${clientNameToUse}! 🎉 Ela já está selecionada. O que vamos fazer?`;
                                    state.activeFinancialAccountId = newFA.id;
                                    state.activeFinancialAccountName = newFA.accountName;
                                    state.activeFinancialAccountType = newFA.accountType;
                                    state.currentAction = null; state.data = {};
                                } catch(e) {
                                    currentActionFormatted = `Ops, não consegui criar a conta "${newAccName}" (${typeToCreate}). ${e.message.substring(0,70)}. Tente um nome diferente.`;
                                    state.currentAction = 'awaiting_first_account_name';
                                    state.data.accountTypeToCreate = typeToCreate;
                                }
                            }
                            break;
                        }
                        case 'GET_CREDIT_CARD_INVOICE': {
                            const cardIdForInvoice = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                            if (!cardIdForInvoice) {
                                currentActionFormatted = `Hum, não consegui identificar o cartão "${params.creditCardName}", ${clientNameToUse}. Pode tentar de novo ou verificar se ele está cadastrado? 🤔`;
                                break;
                            }
                            const periodOpts = {
                                type: params.invoicePeriodType || 'aberta',
                                month: params.invoiceMonth,
                                year: params.invoiceYear
                            };
                            const invoiceDetails = await creditCardService.getCreditCardInvoiceDetails(state.activeFinancialAccountId, cardIdForInvoice, periodOpts);
                            currentActionFormatted = formatCreditCardInvoiceSummary(invoiceDetails, clientNameToUse, params.listTransactions !== false);
                            break;
                        }
                        case 'GET_CREDIT_CARD_AVAILABLE_LIMIT': {
                            const cardIdForLimit = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                            if (!cardIdForLimit) {
                                currentActionFormatted = `Não encontrei o cartão "${params.creditCardName}" para verificar o limite, ${clientNameToUse}. 😬`;
                                break;
                            }
                            const limitInfo = await creditCardService.getAvailableCreditLimit(state.activeFinancialAccountId, cardIdForLimit);
                            currentActionFormatted = formatAvailableLimitSummary(limitInfo, clientNameToUse);
                            break;
                        }
                        case 'PAY_CREDIT_CARD_INVOICE': {
                            const cardIdForPayment = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                            if (!cardIdForPayment) {
                                currentActionFormatted = `Não identifiquei o cartão "${params.creditCardName}" para registrar o pagamento da fatura, ${clientNameToUse}. 🧐`;
                                break;
                            }
                            const paymentAmount = parseFloat(params.paymentAmount);
                            const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];

                            const paymentDescription = `Pagamento Fatura ${params.creditCardName} - R$ ${paymentAmount.toFixed(2)}`;
                            const categoryName = params.financialCategoryName || "Pagamento de Fatura";
                            const paymentCategoryId = await findFinancialCategoryIdByName(categoryName, state.activeFinancialAccountId, 'Saída');

                            try {
                                const paymentTx = await financialService.createTransaction(state.activeFinancialAccountId, {
                                    description: paymentDescription,
                                    type: 'Saída',
                                    value: paymentAmount,
                                    transactionDate: paymentDate,
                                    financialCategoryId: paymentCategoryId,
                                    isPayableOrReceivable: false,
                                    isPaidOrReceived: true,
                                });
                                currentActionFormatted = `Pagamento da fatura do cartão ${params.creditCardName} no valor de R$ ${paymentAmount.toFixed(2)} registrado com sucesso na sua conta ${state.activeFinancialAccountName}! 🎉 Bom demais ter as contas em dia!`;
                            } catch (e) {
                                logger.error(`Erro ao registrar pagamento de fatura para cartão ${params.creditCardName} na conta ${state.activeFinancialAccountName}: ${e.message}`);
                                currentActionFormatted = `Ops! Tive um problema ao tentar registrar o pagamento da fatura do ${params.creditCardName}. (${e.message.substring(0,60)}) 😥`;
                            }
                            break;
                        }
                        case 'GENERAL_GREETING_OR_SMALLTALK':
                        case 'GENERAL_QUESTION_OR_HELP':
                        case 'ACTION_CONFIRMATION_YES':
                        case 'ACTION_CONFIRMATION_NO':
                            if(messageText.toLowerCase().includes("pagar fatura de um item") || messageText.toLowerCase().includes("antecipar fatura") || messageText.toLowerCase().includes("pagar antecipado")){
                                currentActionFormatted = `Entendo que você quer fazer um pagamento específico ou antecipar algo da fatura, ${clientNameToUse}. Essa é uma função mais avançada que ainda estou aprendendo a fazer direitinho! 😅 Por enquanto, posso te mostrar a fatura total, o limite, ou registrar o pagamento total da fatura. O que prefere?`;
                            } else if (aiResponse.reply_to_user_suggestion) {
                                currentActionFormatted = aiResponse.reply_to_user_suggestion;
                            } else {
                                currentActionFormatted = `Entendido, ${clientNameToUse}! 😊`;
                            }

                            if (detectedAction.action === 'ACTION_CONFIRMATION_YES' || detectedAction.action === 'ACTION_CONFIRMATION_NO') {
                                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                            }
                            if (aiResponse.reply_to_user_suggestion && !(messageText.toLowerCase().includes("pagar fatura de um item") || messageText.toLowerCase().includes("antecipar fatura"))) {
                                if(finalReplyParts.length > 0 && finalReplyParts[0] === aiResponse.reply_to_user_suggestion) {
                                     multipleActionFormattedResults = [];
                                     singleActionFormattedResult = null; 
                                } else {
                                    finalReplyParts = [aiResponse.reply_to_user_suggestion];
                                    multipleActionFormattedResults = [];
                                }
                            }
                            break;
                        default:
                            if (aiResponse.detected_actions.length === 1 && aiResponse.reply_to_user_suggestion && !aiResponse.overall_summary_suggestion) {
                                currentActionFormatted = aiResponse.reply_to_user_suggestion;
                            } else {
                                currentActionFormatted = `Ação "${detectedAction.action}" ${params.description ? `para "${params.description}"` : ''} foi entendida, ${clientNameToUse}, mas ainda não sei como processá-la completamente. 😅 Minha equipe está trabalhando para me deixar mais esperto!`;
                                logger.warn(`[WHATSAPP SERVICE] Ação da IA não implementada no switch: ${detectedAction.action}`);
                            }
                            break;
                    }

                    if (actionBlockedNoAccessLoop) continue;

                    if (detectedAction.action_specific_reply_suggestion) {
                        currentActionFormatted = detectedAction.action_specific_reply_suggestion;
                    }

                    if (currentActionFormatted) {
                        if (aiResponse.detected_actions.length === 1 && !isEditActionCurrentLoop) {
                            singleActionFormattedResult = currentActionFormatted;
                        } else if (!isEditActionCurrentLoop) {
                            multipleActionFormattedResults.push(currentActionFormatted);
                        } else {
                            singleActionFormattedResult = currentActionFormatted;
                        }
                    }

                } catch (e) {
                    logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack?.substring(0,300), params: params });
                    if (detectedAction.action === 'CREATE_CREDIT_CARD' && e.statusCode === 409 && e.message.toLowerCase().includes('já existe um cartão com o nome')) {
                        singleActionFormattedResult = `Opa, ${clientNameToUse}! 😅 Parece que você já tem um cartão chamado "*${params.name}*" cadastrado nessa conta. Que tal dar outro nome ou verificar seus cartões existentes com "listar cartões"?`;
                        finalReplyParts = []; 
                    } else {
                        const errorMsgPart = `Ops! 😬 Tive um problema ao tentar processar "${params.description || detectedAction.action.toLowerCase().replace(/_/g," ")}". (${e.message.length < 80 ? e.message : 'Erro interno, desculpe!'}). Pode tentar de novo ou com outros termos?`;
                        if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = errorMsgPart;
                        else multipleActionFormattedResults.push(errorMsgPart);
                    }
                }
            }
        }

        if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            finalReplyParts = [aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe: ${aiResponse.clarifications_needed[0].clarification_question}`];
            state.currentAction = 'awaiting_clarification_response';
            state.data.clarificationContext = {
                action: aiResponse.clarifications_needed[0].original_intent_action_suggestion,
                original_message: messageText,
                parameters_so_far: aiResponse.clarifications_needed[0].parameters_so_far || {}
            };
            singleActionFormattedResult = null;
            multipleActionFormattedResults = [];
        } else if (singleActionFormattedResult) {
            if (finalReplyParts.length > 0 && !actionWasAnEdit) {
                if (aiResponse.reply_to_user_suggestion &&
                    aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion &&
                    (!singleActionFormattedResult.toLowerCase().includes(aiResponse.reply_to_user_suggestion.substring(0, 20).toLowerCase())) &&
                    aiResponse.reply_to_user_suggestion !== singleActionFormattedResult &&
                    finalReplyParts.indexOf(aiResponse.reply_to_user_suggestion) === -1 ) {
                    finalReplyParts.push(aiResponse.reply_to_user_suggestion);
                }
                 if (finalReplyParts.indexOf(singleActionFormattedResult) === -1) {
                    finalReplyParts.push(singleActionFormattedResult);
                 }
            } else {
                 if(finalReplyParts.length > 0 && aiResponse.detected_actions[0]?.action.startsWith("GENERAL_")){
                    if(aiResponse.reply_to_user_suggestion !== singleActionFormattedResult && finalReplyParts.indexOf(singleActionFormattedResult) === -1){
                         finalReplyParts.push(singleActionFormattedResult);
                    }
                } else if (finalReplyParts.indexOf(singleActionFormattedResult) === -1) {
                    finalReplyParts.push(singleActionFormattedResult);
                } else if (finalReplyParts.length === 0) {
                     finalReplyParts = [singleActionFormattedResult];
                }
            }
        } else if (multipleActionFormattedResults.length > 0) {
            if (finalReplyParts.length === 0) {
                finalReplyParts.push(`${clientNameToUse}, aqui está o que eu fiz pra você! 😉`);
            } else if (aiResponse.reply_to_user_suggestion && finalReplyParts.indexOf(aiResponse.reply_to_user_suggestion) === -1) {
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion);
            }
            finalReplyParts.push(multipleActionFormattedResults.join("\n\n---\n\n"));
        } else if (aiResponse.reply_to_user_suggestion) {
            if (finalReplyParts.length === 0 || (finalReplyParts.length === 1 && finalReplyParts[0] === aiResponse.overall_summary_suggestion)) {
                finalReplyParts = [aiResponse.reply_to_user_suggestion];
            } else if (finalReplyParts.indexOf(aiResponse.reply_to_user_suggestion) === -1) {
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion);
            }
        } else if (finalReplyParts.length === 0) {
            finalReplyParts.push(`Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊 Estou por aqui!`);
        }

        finalReplyParts = finalReplyParts.filter((item, index, self) =>
            item && typeof item === 'string' && item.trim() !== "" && self.findIndex(t => t && typeof t === 'string' && t.trim() === item.trim()) === index
        );

        const performedConcreteAction = (aiResponse.detected_actions && aiResponse.detected_actions.length > 0 &&
                                       aiResponse.detected_actions.some(a => !a.action.startsWith("GENERAL_") && !a.action.startsWith("LIST_") && !a.action.startsWith("GET_") && !a.action.startsWith("SWITCH_") )
                                      ) &&
                                       (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0);

        let completeFinalReply = finalReplyParts.join("\n\n").trim();

        if (performedConcreteAction && state.hasPaidAccess) {
            const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
            const dashboardMessage = `📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}`;
            if (completeFinalReply && !completeFinalReply.includes(platformUrl)) {
                completeFinalReply += `\n\n${dashboardMessage}`;
            }
            const helpMessage = "Se precisar de algo a mais é só me chamar! 😃📈";
            if(completeFinalReply && !completeFinalReply.includes(helpMessage.substring(0,20))){
                 completeFinalReply += `\n\n${helpMessage}`;
            }
        }

        completeFinalReply = completeFinalReply.replace(/\n{3,}/g, '\n\n');

        state.messageHistory.push({ role: 'assistant', content: completeFinalReply });

        if (actionWasAnEdit || (state.editingResource && aiResponse.detected_actions?.every(a => !a.action.startsWith("UPDATE_")))) {
            state.editingResource = null;
        }
        if (state.data.clarificationContext && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
            delete state.data.clarificationContext;
        }

        conversationState.set(senderPhone, state);

        if (completeFinalReply) {
            if (resourceForButtonsContext && aiResponse.detected_actions?.length === 1 && !actionWasAnEdit && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
                let buttons = [];
                let buttonItemDesc = "item";
                if (resourceForButtonsContext.description && typeof resourceForButtonsContext.description === 'string') {
                    buttonItemDesc = resourceForButtonsContext.description.length > 20 ? resourceForButtonsContext.description.substring(0, 17) + "..." : resourceForButtonsContext.description;
                }
                const buttonTitle = `Opções para "${buttonItemDesc}":`;

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

                if (buttons.length > 0) {
                    await sendButtonListMessage(senderPhone, completeFinalReply, buttons, buttonTitle, "Clique aqui 👇");
                } else {
                    await sendWhatsappMessage(senderPhone, completeFinalReply);
                }
                state.editingResource = resourceForButtonsContext;

            } else {
                await sendWhatsappMessage(senderPhone, completeFinalReply);
                if(state.editingResource && !resourceForButtonsContext) state.editingResource = null;
            }
        }

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000), messageText, rawPayload });
        const clientNameToUseInError = state ? state.clientName : (pushName || "você");
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
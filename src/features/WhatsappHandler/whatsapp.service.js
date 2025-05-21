// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service'); // Para setClientCredentials
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service'); // Para categorias
const subscriptionService = require('../Subscription/subscription.service'); // Para verificar planos

const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;

// --- Helper Functions (sem alterações diretas, mas usadas) ---
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
    try {
        const card = await creditCardService.findCreditCardByName(financialAccountId, name);
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

// --- Funções de Formatação de Resumo (sem alterações diretas, mas usadas) ---
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
    } else {
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
    const invoiceMonthYear = invoiceDetails.invoiceReferenceMonthYear;
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

function formatParcelledAccountSummary(params, parcelResult, clientName, forEdit = false) {
    let summary = "";
    let actionText = "registrada";
    if (forEdit) {
        actionText = "atualizada";
    }
    
    summary += `Sua compra de ${params.newDescription || params.description} no valor de R$ ${parseFloat(params.newTotalValue || params.totalValue).toFixed(2)} em ${params.newNumberOfParcels || params.numberOfParcels}x `;
    if (params.newCreditCardName || params.creditCardName) {
        summary += `no cartão ${params.newCreditCardName || params.creditCardName} `;
    }
    summary += `foi ${actionText} com sucesso! 🥳`;

    if (parcelResult.parcels && parcelResult.parcels.length > 0) {
        const firstParcel = parcelResult.parcels[0];
        if ((params.newCreditCardName || params.creditCardName) && firstParcel.transactionDate) {
            const firstParcelDate = new Date(firstParcel.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
            summary += `\nA primeira parcela (R$ ${parseFloat(firstParcel.value).toFixed(2)}) deve aparecer na fatura do seu cartão ${params.newCreditCardName || params.creditCardName} por volta de ${firstParcelDate}.`;
        } else if (!(params.newCreditCardName || params.creditCardName) && firstParcel.dueDate) {
            summary += `\nA primeira parcela vence em ${new Date(firstParcel.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })}.`;
        }
    }
    return summary;
}

// --- Initialize State ---
function initializeState(client, defaultAccount = null) {
    const clientName = client ? (client.name || "pessoa incrível") : "pessoa incrível";

    let hasPaidAccess = false;
    let accessLevelText = 'gratuito';
    let clientAccessLevel = 'gratuito';
    let clientAccessExpiresAt = null;

    if (client) {
        clientAccessLevel = client.accessLevel || 'gratuito';
        clientAccessExpiresAt = client.accessExpiresAt;
        accessLevelText = clientAccessLevel;

        if (clientAccessLevel === 'mensal' || clientAccessLevel === 'anual' || clientAccessLevel === 'vitalicio') {
            hasPaidAccess = true;
            if (clientAccessExpiresAt && (clientAccessLevel === 'mensal' || clientAccessLevel === 'anual')) {
                const expiryDate = new Date(clientAccessExpiresAt + 'T00:00:00Z');
                const today = new Date();
                today.setUTCHours(0, 0, 0, 0);

                if (expiryDate < today) {
                    hasPaidAccess = false;
                    accessLevelText = `expirado (era ${clientAccessLevel})`;
                } else {
                    accessLevelText += ` (expira em ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
                }
            }
        }
    }

    const newState = {
        currentAction: null,
        data: {}, // Para armazenar dados temporários do fluxo de onboarding
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount ? defaultAccount.accountType : null,
        clientName: clientName,
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null,
        lastAiResponse: null,
        
        // Onboarding flags
        needsPlan: !hasPaidAccess, // Novo: indica se precisa de plano
        needsCredentialsSetup: client ? (!client.email || !client.passwordHash) : true, // Novo: se precisa de email/senha
        needsPfAccountSetup: true, // Novo: se precisa configurar conta PF
        offeredPjMeiSetup: false, // Novo: se já foi oferecido configurar PJ/MEI
        
        // Mantém os dados do cliente para referência
        currentAccessLevel: clientAccessLevel,
        accessExpiresAt: clientAccessExpiresAt,
        hasPaidAccess: hasPaidAccess, // Mantém o status calculado
    };
    
    // Mensagem inicial é agora tratada no fluxo principal do processIncomingMessage
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
        const clientNameToUse = client.name && client.name.trim() !== "" ? client.name.split(" ")[0] : (pushName || "pessoa incrível");

        const defaultAccount = await clientService.getActiveOrDefaultFinancialAccount(client.id);
        state = conversationState.get(senderPhone) || initializeState(client, defaultAccount);

        // Atualizar estado com os dados mais recentes do cliente
        state.clientName = clientNameToUse;
        state.currentAccessLevel = client.accessLevel || 'gratuito';
        state.accessExpiresAt = client.accessExpiresAt;

        let currentHasPaidAccess = false;
        let currentAccessLevelText = state.currentAccessLevel;
        if (state.currentAccessLevel === 'mensal' || state.currentAccessLevel === 'anual' || state.currentAccessLevel === 'vitalicio') {
            currentHasPaidAccess = true;
            if (state.accessExpiresAt && (state.currentAccessLevel === 'mensal' || state.currentAccessLevel === 'anual')) {
                const expiryDate = new Date(state.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0, 0, 0, 0);
                if (expiryDate < today) {
                    currentHasPaidAccess = false;
                    currentAccessLevelText = `expirado (era ${state.currentAccessLevel})`;
                } else {
                    currentAccessLevelText += ` (expira em ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
                }
            }
        }
        state.hasPaidAccess = currentHasPaidAccess;
        state.needsPlan = !currentHasPaidAccess;
        state.needsCredentialsSetup = (!client.email || !client.passwordHash);


        if (!(rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string')) {
            state.messageHistory.push({ role: 'user', content: messageText });
        }
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }
        conversationState.set(senderPhone, state); // Salva estado atualizado

        // ---- FLUXO DE ONBOARDING ----
        // 1. SEM PLANO
        if (state.needsPlan) {
            const lowerMsg = messageText.toLowerCase().trim();
            let noPlanReply = "";
            if (state.currentAction === 'awaiting_plan_interest_after_no_plan' && (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('quero'))) {
                const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                noPlanReply = `Que demais, ${clientNameToUse}! 🎉 Temos estas opções de acesso para você:\n\n` +
                              `*Plano Básico Mensal/Anual:* Ideal para suas finanças pessoais (PF)! 🧑‍💼\n` +
                              `*Plano Avançado Mensal/Anual:* Perfeito para quem quer gerenciar tanto o pessoal (PF) quanto o empresarial (PJ/MEI)! 🚀\n\n` +
                              `Para ver os detalhes e escolher o seu, visite nosso site: ${siteUrl}\n\n` +
                              `Assim que estiver tudo certo, me manda um "oi" aqui para ativarmos sua conta! 😉`;
                state.currentAction = 'showing_plans_info';
            } else {
                const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                noPlanReply = `Olá ${clientNameToUse}! 👋 Para botar a mão na massa com o ${aiModelService.ASSISTANT_NAME}, você precisa de um plano ativo. ` +
                              `Dá uma olhadinha nas opções iradas que temos pra você em ${siteUrl}! ` +
                              `Gostaria de saber mais sobre os planos por aqui? (Responda "sim")\n\n`+
                              `Assim que assinar, me manda um "oi" pra gente começar! 🚀`;
                state.currentAction = 'awaiting_plan_interest_after_no_plan';
            }
            state.messageHistory.push({ role: 'assistant', content: noPlanReply });
            await sendWhatsappMessage(senderPhone, noPlanReply);
            conversationState.set(senderPhone, state);
            return;
        }

        // 2. COM PLANO, MAS SEM CREDENCIAIS (email/senha)
        if (state.hasPaidAccess && state.needsCredentialsSetup) {
            let credentialsReply = "";
            if (!state.data.askedEmail) {
                credentialsReply = `Olá ${clientNameToUse}! Que demais ter você por aqui com seu acesso '${currentAccessLevelText}'! 🎉 Para começarmos com o pé direito e você ter acesso ao nosso app web, qual o seu melhor e-mail? 📧`;
                state.currentAction = 'awaiting_initial_email';
                state.data.askedEmail = true;
            } else if (state.currentAction === 'awaiting_initial_email') {
                const emailInput = messageText.trim();
                if (emailInput.includes('@') && emailInput.includes('.')) { // Validação básica
                    state.data.tempEmail = emailInput;
                    credentialsReply = `Show! E-mail anotado: ${emailInput} ✅ Agora, crie uma senha segura (pelo menos 6 caracteres) para proteger suas informações. 🔒`;
                    state.currentAction = 'awaiting_initial_password';
                } else {
                    credentialsReply = `Hum... esse e-mail não parece válido, ${clientNameToUse}. 🤔 Poderia me enviar um e-mail como "exemplo@dominio.com"?`;
                }
            } else if (state.currentAction === 'awaiting_initial_password') {
                const passwordInput = messageText.trim();
                if (passwordInput.length >= 6) {
                    state.data.tempPassword = passwordInput;
                    credentialsReply = `Senha guardada a sete chaves! 🗝️ Para te conhecer melhor, como você gostaria de ser chamado(a)? (Seu nome completo, por favor) 😊`;
                    state.currentAction = 'awaiting_initial_name';
                } else {
                    credentialsReply = `Essa senha parece um pouquinho curta, ${clientNameToUse}. 😬 Para sua segurança, ela precisa ter pelo menos 6 caracteres. Pode tentar outra?`;
                }
            } else if (state.currentAction === 'awaiting_initial_name') {
                const nameInput = messageText.trim();
                if (nameInput.length >= 3) {
                    try {
                        await clientAuthService.setClientCredentials(senderPhone, state.data.tempPassword, nameInput, state.data.tempEmail);
                        client = await clientService.findClientByPhone(senderPhone); // Recarrega dados do cliente
                        state.clientName = client.name.split(" ")[0]; // Atualiza nome no estado
                        state.needsCredentialsSetup = false; // Marca como concluído
                        logger.info(`[WHATSAPP ONBOARDING] Credenciais definidas para ${senderPhone}.`);
                        // Remove dados temporários
                        delete state.data.askedEmail; delete state.data.tempEmail; delete state.data.tempPassword;
                        state.currentAction = null; // Limpa ação para próximo passo
                        // A próxima iteração do loop (ou a continuação dele) pegará o próximo passo (PF setup)
                    } catch (e) {
                        logger.error(`[WHATSAPP ONBOARDING] Erro ao definir credenciais para ${senderPhone}: ${e.message}`);
                        credentialsReply = `Puxa, ${clientNameToUse}, algo deu errado ao salvar seus dados (${e.message.substring(0,60)}). 😥 Vamos tentar o nome novamente?`;
                        // Mantém currentAction para tentar o nome de novo
                    }
                } else {
                    credentialsReply = `Para um toque mais pessoal, ${clientNameToUse}, poderia me dizer seu nome completo? ✨`;
                }
            }

            if (credentialsReply) {
                state.messageHistory.push({ role: 'assistant', content: credentialsReply });
                await sendWhatsappMessage(senderPhone, credentialsReply);
                conversationState.set(senderPhone, state);
                return;
            }
            // Se chegou aqui após o nome, significa que setCredentials foi chamado, então precisa continuar o fluxo
        }
        
        // 3. COM PLANO E CREDENCIAIS, VERIFICAR CONTAS FINANCEIRAS
        const clientFinancialAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });

        if (state.hasPaidAccess && !state.needsCredentialsSetup) {
            // 3.1. CONFIGURAR CONTA PESSOAL (PF), se ainda não tiver NENHUMA conta.
            if (clientFinancialAccounts.length === 0 && state.needsPfAccountSetup) {
                let pfReply = "";
                if (!state.data.askedPfName) {
                    pfReply = `Maravilha, ${clientNameToUse}! Tudo configurado! ✨ Para começar, vamos criar sua primeira conta financeira para seus gastos pessoais (PF). Que nome bacana podemos dar pra ela? (Ex: "Minhas Finanças", "Pessoal da Silva") 📝`;
                    state.currentAction = 'creating_pf_account_name';
                    state.data.askedPfName = true;
                } else if (state.currentAction === 'creating_pf_account_name') {
                    const pfAccountName = messageText.trim();
                    if (pfAccountName.length >= 3 && pfAccountName.length <= 50) {
                        try {
                            const newPfAccount = await clientService.createFinancialAccount(client.id, {
                                accountName: pfAccountName,
                                accountType: 'PF',
                                isDefault: true // Primeira conta é default
                            });
                            clientFinancialAccounts.push(newPfAccount); // Adiciona à lista local
                            state.activeFinancialAccountId = newPfAccount.id;
                            state.activeFinancialAccountName = newPfAccount.accountName;
                            state.activeFinancialAccountType = newPfAccount.accountType;
                            state.needsPfAccountSetup = false; // PF configurada
                            pfReply = `Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameToUse}! 🏦 Ela já está selecionada para gente começar!`;
                            logger.info(`[WHATSAPP ONBOARDING] Conta PF "${pfAccountName}" criada para ${senderPhone}.`);
                            state.currentAction = null; // Limpa ação para próximo passo
                        } catch (e) {
                            logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta PF "${pfAccountName}" para ${senderPhone}: ${e.message}`);
                            pfReply = `Ops! 😬 Tive um probleminha para criar a conta "${pfAccountName}" (${e.message.substring(0,60)}). Que tal tentar outro nome?`;
                        }
                    } else {
                        pfReply = `Esse nome parece um pouco curto ou longo demais, ${clientNameToUse}. Para sua conta Pessoal, poderia me dizer um nome entre 3 e 50 letras? ✍️`;
                    }
                }
                if (pfReply) {
                    state.messageHistory.push({ role: 'assistant', content: pfReply });
                    await sendWhatsappMessage(senderPhone, pfReply);
                    conversationState.set(senderPhone, state);
                    if (state.currentAction === 'creating_pf_account_name') return; // Se ainda está esperando nome PF
                }
            }

            // 3.2. OFERECER CONTA EMPRESARIAL (PJ/MEI) se plano avançado e PF já configurada.
            const hasAdvancedAccess = state.currentAccessLevel.startsWith('avancado');
            const hasPjOrMeiAccount = clientFinancialAccounts.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');

            if (hasAdvancedAccess && !state.needsPfAccountSetup && !hasPjOrMeiAccount && !state.offeredPjMeiSetup) {
                let pjMeiReply = "";
                if (!state.data.askedPjMeiIntent) {
                    pjMeiReply = `Você tem acesso ao nosso plano avançado, ${clientNameToUse}! 🤩 Isso significa que, além da sua conta pessoal, você pode gerenciar uma conta para sua empresa (PJ) ou MEI. Quer configurar uma agora? (Responda "sim" ou "não") ✨`;
                    state.currentAction = 'confirm_pj_mei_setup';
                    state.data.askedPjMeiIntent = true;
                } else if (state.currentAction === 'confirm_pj_mei_setup') {
                    const lowerMsg = messageText.toLowerCase().trim();
                    if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('quero')) {
                        pjMeiReply = `Legal! Essa conta empresarial será para uma *Empresa (PJ)* ou para um *Microempreendedor Individual (MEI)*? 🤔 Responda "PJ" ou "MEI".`;
                        state.currentAction = 'awaiting_pj_mei_type';
                    } else {
                        pjMeiReply = `Entendido, ${clientNameToUse}! Sem problemas. Se decidir configurar uma conta empresarial depois, é só me avisar! 😉\n\nAgora, sua conta "${state.activeFinancialAccountName}" está pronta para uso! O que você gostaria de fazer?`;
                        state.offeredPjMeiSetup = true; // Marca como oferecido (e recusado)
                        state.currentAction = null;
                    }
                } else if (state.currentAction === 'awaiting_pj_mei_type') {
                    const typeInput = messageText.trim().toUpperCase();
                    if (typeInput === 'PJ' || typeInput === 'MEI') {
                        state.data.tempPjMeiType = typeInput;
                        pjMeiReply = `Entendido! E qual o nome que daremos para essa sua potência ${typeInput}? (Ex: "Minha Super Empresa", "MEI Consultoria") 🏢🚀`;
                        state.currentAction = 'creating_pj_mei_account_name';
                    } else {
                        pjMeiReply = `Por favor, ${clientNameToUse}, me diga se é "PJ" ou "MEI" para sua conta empresarial. 😊`;
                    }
                } else if (state.currentAction === 'creating_pj_mei_account_name') {
                    const companyName = messageText.trim();
                    const companyType = state.data.tempPjMeiType;
                    if (companyName.length >= 3 && companyName.length <= 50) {
                        try {
                            const newPjMeiAccount = await clientService.createFinancialAccount(client.id, {
                                accountName: companyName,
                                accountType: companyType,
                                isDefault: false // PJ/MEI não será default inicialmente
                            });
                            clientFinancialAccounts.push(newPjMeiAccount);
                            // Não muda a conta ativa para PJ/MEI automaticamente, mantém a PF como padrão inicial.
                            pjMeiReply = `Show de bola, ${clientNameToUse}! 🎊 Sua conta ${companyType} "${companyName}" foi criada!\n\nAgora você tem a conta "${state.activeFinancialAccountName}" (PF) e "${companyName}" (${companyType}). A conta "${state.activeFinancialAccountName}" continua selecionada. Se quiser mudar, é só dizer "mudar para conta [nome da conta]".\n\nO que vamos fazer agora?`;
                            state.offeredPjMeiSetup = true; // PJ/MEI configurado
                            logger.info(`[WHATSAPP ONBOARDING] Conta ${companyType} "${companyName}" criada para ${senderPhone}.`);
                            state.currentAction = null; delete state.data.tempPjMeiType;
                        } catch (e) {
                            logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta ${companyType} "${companyName}" para ${senderPhone}: ${e.message}`);
                            pjMeiReply = `Eita! 😬 Tive um probleminha para criar a conta ${companyType} "${companyName}" (${e.message.substring(0,60)}). Que tal tentar outro nome?`;
                        }
                    } else {
                        pjMeiReply = `Esse nome para sua ${companyType} parece um pouco curto ou longo demais, ${clientNameToUse}. Poderia me dizer um nome entre 3 e 50 letras? ✍️`;
                    }
                }
                if (pjMeiReply) {
                    state.messageHistory.push({ role: 'assistant', content: pjMeiReply });
                    await sendWhatsappMessage(senderPhone, pjMeiReply);
                    conversationState.set(senderPhone, state);
                    if (state.currentAction && state.currentAction !== null) return; // Se ainda está no fluxo PJ/MEI
                }
            }
        }

        // ---- FIM DO FLUXO DE ONBOARDING ----
        // Se chegou aqui, o onboarding básico (plano, credenciais, contas) está OK.
        // Ou o usuário já tinha tudo configurado.

        // SELEÇÃO DE CONTA ATIVA, SE NECESSÁRIO
        if (state.hasPaidAccess && !state.activeFinancialAccountId && clientFinancialAccounts.length > 0) {
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
            } else { // Usuário respondeu ao pedido de seleção de conta
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
        } else if (state.hasPaidAccess && !state.activeFinancialAccountId && clientFinancialAccounts.length === 0) {
            // Isso não deveria acontecer se o fluxo de criação guiada funcionou, mas é um fallback.
            const noAccountsMsg = `Olá ${clientNameToUse}! Você tem acesso '${currentAccessLevelText}', mas parece que ainda não configuramos nenhuma conta financeira (PF, PJ ou MEI). Diga "criar conta pessoal" para começarmos! 😉`;
            state.messageHistory.push({ role: 'assistant', content: noAccountsMsg });
            state.currentAction = null; // Deixa a IA pegar a próxima mensagem
            await sendWhatsappMessage(senderPhone, noAccountsMsg);
            conversationState.set(senderPhone, state);
            return;
        }

        // ---- PROCESSAMENTO NORMAL COM IA (APÓS ONBOARDING) ----
        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ID '${buttonId}', Texto: '${messageText}'`);
            let buttonClickHandledByServiceLogic = true;
            let replyForButtonClick = "";
            let resourceTypeForEditMessage = "item";

            if (buttonId.startsWith('edit_transaction_')) {
                const transactionId = buttonId.replace('edit_transaction_', '');
                state.editingResource = { type: 'transaction', id: transactionId };
                resourceTypeForEditMessage = "transação";
                replyForButtonClick = `Claro, ${clientNameToUse}! 😉 Descreva na próxima mensagem o que você precisa que eu altere na ${resourceTypeForEditMessage} (ID: ${transactionId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                state.currentAction = 'awaiting_transaction_edit_details';
            } else if (buttonId.startsWith('delete_transaction_')) {
                const transactionId = buttonId.replace('delete_transaction_', '');
                try {
                    await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId);
                    replyForButtonClick = `Transação removida com sucesso, ${clientNameToUse}! 👍 Se precisar de mais alguma coisa, é só chamar.`;
                } catch (e) { 
                    logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar excluir a transação. (${e.message.substring(0,70)})`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            } else if (buttonId.startsWith('edit_appointment_')) {
                const appointmentId = buttonId.replace('edit_appointment_', '');
                state.editingResource = { type: 'appointment', id: appointmentId };
                resourceTypeForEditMessage = "compromisso";
                replyForButtonClick = `Beleza, ${clientNameToUse}! ✨ Me diga na próxima mensagem o que você quer mudar no ${resourceTypeForEditMessage} (ID: ${appointmentId}).`;
                state.currentAction = 'awaiting_appointment_edit_details';
            } else if (buttonId.startsWith('delete_appointment_')) {
                const appointmentId = buttonId.replace('delete_appointment_', '');
                try {
                    await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, true);
                    replyForButtonClick = `Compromisso removido da sua agenda, ${clientNameToUse}! ✅ Fico à disposição se precisar de algo mais.`;
                } catch (e) { 
                    logger.error(`[WHATSAPP SERVICE] Erro ao excluir compromisso ${appointmentId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar excluir o compromisso. (${e.message.substring(0,70)})`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            }
            else if (buttonId.startsWith('edit_credit_card_')) {
                const cardId = buttonId.replace('edit_credit_card_', '');
                state.editingResource = { type: 'credit_card', id: cardId };
                resourceTypeForEditMessage = "cartão de crédito";
                replyForButtonClick = `Entendido, ${clientNameToUse}! 💳 O que você gostaria de alterar no ${resourceTypeForEditMessage} (ID: ${cardId})? Pode me dizer, por exemplo: "mudar o limite para 3000" ou "atualizar o dia de fechamento para 25".`;
                state.currentAction = 'awaiting_credit_card_edit_details';
            } else if (buttonId.startsWith('delete_credit_card_')) {
                const cardId = buttonId.replace('delete_credit_card_', '');
                try {
                    await creditCardService.deleteCreditCard(state.activeFinancialAccountId, cardId);
                    replyForButtonClick = `Cartão de crédito removido com sucesso, ${clientNameToUse}! 🗑️`;
                } catch (e) {
                    logger.error(`[WHATSAPP SERVICE] Erro ao excluir cartão ${cardId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar excluir o cartão. ${e.message.includes("transações") ? "Ele ainda tem transações associadas." : `(${e.message.substring(0,70)})` }`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            } else if (buttonId.startsWith('edit_recurring_rule_')) {
                const ruleId = buttonId.replace('edit_recurring_rule_', '');
                state.editingResource = { type: 'recurring_rule', id: ruleId };
                resourceTypeForEditMessage = "regra de recorrência";
                replyForButtonClick = `Certo, ${clientNameToUse}! 🔄 O que vamos ajustar na ${resourceTypeForEditMessage} (ID: ${ruleId})? Por exemplo: "mudar o valor para 60" ou "alterar a frequência para mensal".`;
                state.currentAction = 'awaiting_recurring_rule_edit_details';
            } else if (buttonId.startsWith('delete_recurring_rule_')) {
                const ruleId = buttonId.replace('delete_recurring_rule_', '');
                try {
                    await recurringTransactionService.deleteRecurringRule(state.activeFinancialAccountId, ruleId);
                    replyForButtonClick = `Regra de recorrência removida, ${clientNameToUse}! 👍`;
                } catch (e) { 
                    logger.error(`[WHATSAPP SERVICE] Erro ao excluir regra ${ruleId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar excluir a regra. (${e.message.substring(0,70)})`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            }
            else if (buttonId.startsWith('edit_parcelled_account_')) {
                const originalAccountId = buttonId.replace('edit_parcelled_account_', '');
                const parcelGroupInfo = await financialService.getTransactionById(state.activeFinancialAccountId, originalAccountId);
                let originalDescriptionForEdit = "sua compra parcelada";
                if (parcelGroupInfo && parcelGroupInfo.isParcel && parcelGroupInfo.originalAccountId === parcelGroupInfo.id) {
                    originalDescriptionForEdit = parcelGroupInfo.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                } else if (parcelGroupInfo) {
                    originalDescriptionForEdit = parcelGroupInfo.description;
                }

                state.editingResource = { 
                    type: 'parcelled_account', 
                    id: originalAccountId,
                    originalDescription: originalDescriptionForEdit
                };
                replyForButtonClick = `Ok, ${clientNameToUse}! Você quer editar a compra parcelada de "${originalDescriptionForEdit}".\n\nO que gostaria de alterar? Você pode me dizer os novos detalhes, como por exemplo: "mudar para R$250 em 5x no cartão XP com nova descrição 'Presente Dia das Mães'".\n\nLembre-se que alterar valor, número de parcelas ou o cartão irá refazer essa compra com os novos dados. Se quiser mudar apenas a descrição, diga "mudar descrição para [nova descrição]".`;
                state.currentAction = 'awaiting_parcelled_account_full_edit_details';
            } else if (buttonId.startsWith('delete_parcelled_account_')) {
                const originalAccountId = buttonId.replace('delete_parcelled_account_', '');
                try {
                    const success = await financialService.deleteParcelledAccountGroup(state.activeFinancialAccountId, originalAccountId);
                    replyForButtonClick = success ? `Compra parcelada e todas as suas parcelas foram removidas, ${clientNameToUse}! 👍` : `Não consegui remover essa compra parcelada. Pode ter ocorrido um erro.`;
                } catch (e) {
                    logger.error(`[WHATSAPP SERVICE] Erro ao excluir grupo de parcelas ${originalAccountId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar remover essa compra parcelada. (${e.message.substring(0,70)})`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            }
            else {
                buttonClickHandledByServiceLogic = false; // Nenhum ID de botão conhecido foi tratado
            }

            if (buttonClickHandledByServiceLogic) {
                state.messageHistory.push({ role: 'assistant', content: replyForButtonClick });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForButtonClick);
                return; // Importante: Sai após tratar o clique do botão
            }
        }

        if (state.currentAction) { // Se ainda estiver em um fluxo multi-etapa que NÃO é de onboarding
             let stateHandledInPreProcessing = false;
            let replyForPreProcessing = "";

            if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                 const lowerMsg = messageText.toLowerCase().trim();
                 if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                    if (state.pendingConfirmation.action === 'RECREATE_PARCELLED_ACCOUNT' && state.pendingConfirmation.parameters) {
                        try {
                            const { financialAccountId, originalAccountIdToDelete, newParcelData } = state.pendingConfirmation.parameters;
                            const oldParcelInfo = await financialService.getTransactionById(financialAccountId, originalAccountIdToDelete);
                            const oldDescription = oldParcelInfo ? oldParcelInfo.description.replace(/ - Parcela \d+\/\d+$/, '').trim() : "compra anterior";

                            const recreatedResult = await financialService.recreateParcelledAccount(financialAccountId, originalAccountIdToDelete, newParcelData);
                            
                            let successMsg = aiResponse?.lastAiResponse?.detected_actions?.find(a => a.action === 'RECREATE_PARCELLED_ACCOUNT')?.action_specific_reply_suggestion;
                            if (!successMsg) {
                                successMsg = `🎉 Sensacional, ${clientNameToUse}! Sua compra parcelada de "${oldDescription}" foi atualizada para os novos detalhes:\n\n${formatParcelledAccountSummary(newParcelData, recreatedResult, clientNameToUse, true)}`;
                            }
                            replyForPreProcessing = successMsg;
                            state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                            stateHandledInPreProcessing = true;
                        } catch(e) {
                            logger.error(`[WHATSAPP SERVICE] Erro ao recriar compra parcelada após confirmação: ${e.message}`);
                            replyForPreProcessing = `Puxa, ${clientNameToUse}, algo deu errado ao tentar atualizar sua compra parcelada. 😥 (${e.message.substring(0,70)}). A compra original não foi alterada. Quer tentar de novo os detalhes ou cancelar?`;
                            state.currentAction = 'awaiting_confirmation'; 
                            stateHandledInPreProcessing = true;
                        }
                    } else {
                        replyForPreProcessing = `Entendido, ${clientNameToUse}! Confirmado! 👍 Vou prosseguir com base nisso. O que mais posso fazer?`;
                        state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                        stateHandledInPreProcessing = true;
                    }
                } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) {
                    replyForPreProcessing = `Ok, ${clientNameToUse}, cancelado! Sem problemas. O que gostaria de fazer então? 😊`;
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    stateHandledInPreProcessing = true;
                }
            }
            else if (state.currentAction === 'awaiting_transaction_edit_details' || 
                     state.currentAction === 'awaiting_appointment_edit_details' ||
                     state.currentAction === 'awaiting_credit_card_edit_details' || 
                     state.currentAction === 'awaiting_recurring_rule_edit_details' ||
                     state.currentAction === 'awaiting_parcelled_account_full_edit_details' ||
                     state.currentAction === 'awaiting_parcelled_account_description_edit'
                    ) {
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
                 if (!state.currentAction.includes('_edit_') && !state.currentAction.includes('_choice')) { 
                    state.currentAction = null;
                 }
            }
        }
        
        finalReplyParts = [];
        if (aiResponse.overall_summary_suggestion) {
            finalReplyParts.push(aiResponse.overall_summary_suggestion);
        }

        state.pendingConfirmation = null;

        singleActionFormattedResult = null;
        multipleActionFormattedResults = [];
        actionWasAnEdit = false;
        resourceForButtonsContext = null;

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            for (const detectedAction of aiResponse.detected_actions) {
                const params = detectedAction.parameters || {};
                let currentActionFormatted = "";
                let isEditActionCurrentLoop = false;
                let actionBlockedNoAccessLoop = false; // Flag para bloquear ação dentro do loop

                const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SWITCH_FINANCIAL_ACCOUNT', 'CREATE_FINANCIAL_ACCOUNT'];
                if (!state.hasPaidAccess && !publicActions.includes(detectedAction.action)) {
                    currentActionFormatted = `Sinto muito, ${clientNameToUse}, mas para realizar a ação de "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", você precisa de um acesso 'mensal' ou 'anual'. Para obter, acesse nosso site: ${process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"} e depois me chame aqui! 😉`;
                    state.currentAction = 'awaiting_plan_interest_after_no_plan'; // Reverte para o fluxo de plano
                    actionBlockedNoAccessLoop = true;
                }
                const accountRequiredActions = [
                    'CREATE_FINANCIAL_TRANSACTION', 'SCHEDULE_APPOINTMENT', 'CREATE_PARCELLED_ACCOUNT',
                    'UPDATE_FINANCIAL_TRANSACTION', 'UPDATE_APPOINTMENT', 'GET_FINANCIAL_SUMMARY',
                    'LIST_FINANCIAL_TRANSACTIONS', 'MARK_TRANSACTION_AS_PAID_RECEIVED',
                    'CREATE_RECURRING_RULE', 'CREATE_PRODUCT', 'GET_STOCK_INFO',
                    'RECORD_STOCK_MOVEMENT', 'LIST_APPOINTMENTS', 'CREATE_CREDIT_CARD',
                    'LIST_CREDIT_CARDS', 'LIST_RECURRING_RULES', 'UPDATE_CREDIT_CARD', 'UPDATE_RECURRING_RULE', 'UPDATE_PRODUCT',
                    'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION', 'RECREATE_PARCELLED_ACCOUNT',
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
                    break; // Sai do loop de ações se uma ação foi bloqueada
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
                            currentActionFormatted = formatFinancialTransactionSummary(reloadedTx, clientNameToUse);
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
                            state.currentAction = null;   
                            break;
                        }
                        case 'SCHEDULE_APPOINTMENT': {
                            let eventDateTime = params.eventDateTime;
                            if (params.eventDateTime && params.eventDateTime.length === 10) { // Apenas data YYYY-MM-DD
                                eventDateTime += ' 09:00'; // Adiciona um horário padrão
                            } else if (params.eventDateTime && params.eventDateTime.includes("T") && params.eventDateTime.endsWith("Z")) { // Formato ISO UTC
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
                            currentActionFormatted = formatAppointmentSummary(reloadedApp, clientNameToUse);
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
                            state.currentAction = null;
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
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatParcelledAccountSummary(params, parcelResult, clientNameToUse);
                            if (aiResponse.detected_actions.length === 1 && parcelResult.parcels && parcelResult.parcels.length > 0) {
                                const originalTxId = parcelResult.parcels[0].originalAccountId || parcelResult.parcels[0].id;
                                resourceForButtonsContext = { type: 'parcelled_account', id: originalTxId, description: params.description };
                            }
                            break;
                        }
                        case 'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION': {
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true;
                            const originalAccountIdToUpdate = params.originalAccountIdToUpdate || state.editingResource?.id;
                            if (!originalAccountIdToUpdate) throw new Error("ID da compra parcelada para atualizar a descrição não foi fornecido.");
                        
                            const newDescription = params.newDescription;
                            if (!newDescription || newDescription.trim() === '') {
                                currentActionFormatted = `Por favor, me diga a nova descrição para esta compra parcelada, ${clientNameToUse}. 😊`;
                                state.currentAction = 'awaiting_parcelled_account_description_edit'; 
                                state.editingResource = { type: 'parcelled_account', id: originalAccountIdToUpdate }; 
                                break; 
                            }
                            await financialService.updateParcelledAccountDescription(state.activeFinancialAccountId, originalAccountIdToUpdate, newDescription);
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion || `A descrição da sua compra parcelada foi atualizada para "${newDescription}" em todas as parcelas! ✨`;
                            state.editingResource = null;
                            state.currentAction = null;
                            break;
                        }
                        case 'RECREATE_PARCELLED_ACCOUNT': {
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true;
                            const originalAccountIdToRecreate = params.originalAccountIdToUpdate || state.editingResource?.id;
                            if (!originalAccountIdToRecreate) throw new Error("ID da compra parcelada original não fornecido para recriação.");
                        
                            const newParcelData = {
                                description: params.newDescription,
                                type: params.newType || 'Saída',
                                totalValue: parseFloat(params.newTotalValue),
                                numberOfParcels: parseInt(params.newNumberOfParcels),
                                initialDueDate: params.newInitialDueDate,
                                transactionDate: params.newTransactionDate || params.newInitialDueDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                financialCategoryId: params.newFinancialCategoryName ? await findFinancialCategoryIdByName(params.newFinancialCategoryName, state.activeFinancialAccountId, params.newType || 'Saída') : null,
                                creditCardId: params.newCreditCardName ? await findCreditCardIdByName(params.newCreditCardName, state.activeFinancialAccountId) : null,
                                notes: params.newNotes,
                            };
                        
                            if (!newParcelData.description || !newParcelData.totalValue || !newParcelData.numberOfParcels || !newParcelData.initialDueDate || ( (params.newCreditCardName) && !newParcelData.creditCardId) ) {
                                currentActionFormatted = `Para refazer essa compra parcelada, preciso de todos os detalhes: nova descrição, valor total, número de parcelas, data da primeira parcela e o cartão (se houver). Parece que algo ficou faltando. Vamos tentar de novo?`;
                                state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                                state.editingResource = { type: 'parcelled_account', id: originalAccountIdToRecreate, originalData: state.editingResource?.originalData };
                                break;
                            }
                            if (params.newCreditCardName && !newParcelData.creditCardId){
                                currentActionFormatted = `Hum, não encontrei um cartão chamado "${params.newCreditCardName}" para esta nova compra parcelada. 😕 Pode verificar o nome ou cadastrar o cartão?`;
                                state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                                state.editingResource = { type: 'parcelled_account', id: originalAccountIdToRecreate, originalData: state.editingResource?.originalData };
                                break;
                            }
                        
                            const confirmationMessage = `Ok, ${clientNameToUse}! Você quer alterar a compra para:\n` +
                                                        `Descrição: ${newParcelData.description}\n` +
                                                        `Valor Total: R$ ${newParcelData.totalValue.toFixed(2)} em ${newParcelData.numberOfParcels}x\n` +
                                                        `Primeira Parcela: ${new Date(newParcelData.initialDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'})}\n` +
                                                        (newParcelData.creditCardId ? `Cartão: ${params.newCreditCardName}\n` : '') +
                                                        `Isso substituirá a compra original. Confirmar? (Sim/Não)`;
                            
                            state.pendingConfirmation = {
                                action: 'RECREATE_PARCELLED_ACCOUNT',
                                parameters: { 
                                    financialAccountId: state.activeFinancialAccountId,
                                    originalAccountIdToDelete: originalAccountIdToRecreate,
                                    newParcelData: newParcelData
                                },
                                messageToConfirm: confirmationMessage
                            };
                            currentActionFormatted = confirmationMessage;
                            state.currentAction = 'awaiting_confirmation';
                            break;
                        }
                        case 'UPDATE_PRODUCT': { 
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true;
                            const productIdToUpdate = params.productIdToUpdate || state.editingResource?.id;
                            if (!productIdToUpdate) throw new Error("ID do produto para atualizar não fornecido pela IA ou não estava no contexto de edição.");

                            const updateProdData = { ...params };
                            delete updateProdData.productIdToUpdate;

                            const updatedProd = await productService.updateProduct(state.activeFinancialAccountId, productIdToUpdate, updateProdData);
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatProductSummary(updatedProd, clientNameToUse, false, true);
                            state.editingResource = null;
                            state.currentAction = null;
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
                            currentActionFormatted = formatRecurringRuleSummary(reloadedRule, clientNameToUse);
                            if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'recurring_rule', id: newRule.id, description: newRule.description };
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
                            currentActionFormatted = formatProductSummary(newProd, clientNameToUse);
                            if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'product', id: newProd.id, description: newProd.name };
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
                            currentActionFormatted = formatCreditCardSummary(newCard, clientNameToUse);
                            if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'credit_card', id: newCard.id, description: newCard.name };
                            break;
                        }
                        case 'UPDATE_CREDIT_CARD': {
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true;
                            const cardIdToUpdate = params.cardIdToUpdate || state.editingResource?.id;
                            if (!cardIdToUpdate) throw new Error("ID do cartão para atualizar não fornecido pela IA ou não estava no contexto de edição.");

                            const updateCardData = { ...params };
                            delete updateCardData.cardIdToUpdate;

                            const updatedCard = await creditCardService.updateCreditCard(state.activeFinancialAccountId, cardIdToUpdate, updateCardData);
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatCreditCardSummary(updatedCard, clientNameToUse, false, true);
                            state.editingResource = null;
                            state.currentAction = null;
                            break;
                        }
                        case 'UPDATE_RECURRING_RULE': {
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true;
                            const ruleIdToUpdate = params.ruleIdToUpdate || state.editingResource?.id;
                            if (!ruleIdToUpdate) throw new Error("ID da regra de recorrência para atualizar não fornecido pela IA ou não estava no contexto de edição.");

                            const updateRuleData = { ...params };
                            delete updateRuleData.ruleIdToUpdate;

                            const updatedRule = await recurringTransactionService.updateRecurringRule(state.activeFinancialAccountId, ruleIdToUpdate, updateRuleData);
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatRecurringRuleSummary(updatedRule, clientNameToUse, false, true);
                            state.editingResource = null;
                            state.currentAction = null;
                            break;
                        }
                        case 'UPDATE_PRODUCT': { // Já tratado acima.
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true;
                            const productIdToUpdate = params.productIdToUpdate || state.editingResource?.id;
                            if (!productIdToUpdate) throw new Error("ID do produto para atualizar não fornecido pela IA ou não estava no contexto de edição.");

                            const updateProdData = { ...params };
                            delete updateProdData.productIdToUpdate;

                            const updatedProd = await productService.updateProduct(state.activeFinancialAccountId, productIdToUpdate, updateProdData);
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatProductSummary(updatedProd, clientNameToUse, false, true);
                            state.editingResource = null;
                            state.currentAction = null;
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
                                    state.currentAction = 'selecting_initial_financial_account'; // Reutiliza o estado
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
                        case 'CREATE_FINANCIAL_ACCOUNT': { // Este fluxo é para quando o usuário pede explicitamente, não o guiado.
                            const typeToCreate = params.accountTypeToCreate;
                            const newAccName = params.newAccountName;

                            const existingPjMei = clientFinancialAccounts.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                            if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && existingPjMei) {
                                currentActionFormatted = `Opa, ${clientNameToUse}! Você já tem uma conta empresarial (${existingPjMei.accountType}) chamada "${existingPjMei.accountName}". No momento, só é possível ter uma conta PJ ou MEI. 😉`;
                                break;
                            }

                            if (!typeToCreate) {
                                currentActionFormatted = `Para criar uma nova conta financeira, preciso saber o tipo: Pessoal (PF), Empresa (PJ) ou MEI? Qual você prefere, ${clientNameToUse}? 🤔`;
                                state.currentAction = 'awaiting_explicit_account_type';
                            } else if (!newAccName) {
                                currentActionFormatted = `Entendi que você quer criar uma conta do tipo ${typeToCreate}, ${clientNameToUse}. Qual nome você gostaria de dar para ela? ✍️`;
                                state.currentAction = 'awaiting_explicit_account_name';
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
                                    state.currentAction = 'awaiting_explicit_account_name';
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
                        } else { // Se for uma ação de edição única
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
                 if(finalReplyParts.length > 0 && aiResponse.detected_actions && aiResponse.detected_actions.length > 0 && aiResponse.detected_actions[0]?.action.startsWith("GENERAL_")){
                    if(aiResponse.reply_to_user_suggestion !== singleActionFormattedResult && finalReplyParts.indexOf(singleActionFormattedResult) === -1){
                         finalReplyParts.push(singleActionFormattedResult);
                    }
                } else if (finalReplyParts.indexOf(singleActionFormattedResult) === -1) {
                    finalReplyParts.push(singleActionFormattedResult);
                } else if (finalReplyParts.length === 0) { // Se overall_summary_suggestion era nulo
                     finalReplyParts = [singleActionFormattedResult];
                }
            }
        } else if (multipleActionFormattedResults.length > 0) {
            if (finalReplyParts.length === 0) { // Se overall_summary_suggestion era nulo
                finalReplyParts.push(`${clientNameToUse}, aqui está o que eu fiz pra você! 😉`);
            } else if (aiResponse.reply_to_user_suggestion && finalReplyParts.indexOf(aiResponse.reply_to_user_suggestion) === -1) {
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion);
            }
            finalReplyParts.push(multipleActionFormattedResults.join("\n\n---\n\n"));
        } else if (aiResponse.reply_to_user_suggestion) { // Se nenhuma ação concreta, mas há uma sugestão de resposta
            if (finalReplyParts.length === 0 || (finalReplyParts.length === 1 && finalReplyParts[0] === aiResponse.overall_summary_suggestion)) {
                finalReplyParts = [aiResponse.reply_to_user_suggestion];
            } else if (finalReplyParts.indexOf(aiResponse.reply_to_user_suggestion) === -1) {
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion);
            }
        } else if (finalReplyParts.length === 0) { // Fallback se nada foi adicionado
            finalReplyParts.push(`Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊 Estou por aqui!`);
        }

        // Limpar duplicatas e strings vazias
        finalReplyParts = finalReplyParts.filter((item, index, self) =>
            item && typeof item === 'string' && item.trim() !== "" && self.findIndex(t => t && typeof t === 'string' && t.trim() === item.trim()) === index
        );

        const performedConcreteAction = (aiResponse.detected_actions && aiResponse.detected_actions.length > 0 &&
                                       aiResponse.detected_actions.some(a => !a.action.startsWith("GENERAL_") && !a.action.startsWith("LIST_") && !a.action.startsWith("GET_") && !a.action.startsWith("SWITCH_") )
                                      ) &&
                                       (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0);

        let completeFinalReply = finalReplyParts.join("\n\n").trim();

        if (performedConcreteAction && state.hasPaidAccess) { // Só adiciona se fez algo e tem acesso
            const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
            const dashboardMessage = `📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}`;
            if (completeFinalReply && !completeFinalReply.includes(platformUrl)) {
                completeFinalReply += `\n\n${dashboardMessage}`;
            }
            const helpMessage = "Se precisar de algo a mais é só me chamar! 😃📈";
            if(completeFinalReply && !completeFinalReply.includes(helpMessage.substring(0,20))){ // Evitar duplicar se já estiver
                 completeFinalReply += `\n\n${helpMessage}`;
            }
        }

        completeFinalReply = completeFinalReply.replace(/\n{3,}/g, '\n\n'); // Normaliza quebras de linha excessivas

        state.messageHistory.push({ role: 'assistant', content: completeFinalReply });

        if (actionWasAnEdit || (state.editingResource && (!aiResponse.detected_actions || aiResponse.detected_actions.every(a => !a.action.startsWith("UPDATE_") && a.action !== 'RECREATE_PARCELLED_ACCOUNT')))) {
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
                    buttonItemDesc = resourceForButtonsContext.description.length > 24 ? resourceForButtonsContext.description.substring(0, 21) + "..." : resourceForButtonsContext.description;
                }
                const buttonTitle = `Opções para "${buttonItemDesc}":`;

                switch(resourceForButtonsContext.type) {
                    case 'transaction':
                        buttons = [
                            { id: `edit_transaction_${resourceForButtonsContext.id}`, label: "Editar Transação ✍️" },
                            { id: `delete_transaction_${resourceForButtonsContext.id}`, label: "Excluir Transação 🗑️" },
                        ];
                        break;
                    case 'appointment':
                        buttons = [
                            { id: `edit_appointment_${resourceForButtonsContext.id}`, label: "Editar Compromisso ✍️" },
                            { id: `delete_appointment_${resourceForButtonsContext.id}`, label: "Excluir Compromisso 🗑️" },
                        ];
                        break;
                    case 'credit_card':
                        buttons = [
                            { id: `edit_credit_card_${resourceForButtonsContext.id}`, label: "Editar Cartão ✍️" },
                            { id: `delete_credit_card_${resourceForButtonsContext.id}`, label: "Excluir Cartão 🗑️" },
                        ];
                        break;
                    case 'recurring_rule':
                        buttons = [
                            { id: `edit_recurring_rule_${resourceForButtonsContext.id}`, label: "Editar Recorrência ✍️" },
                            { id: `delete_recurring_rule_${resourceForButtonsContext.id}`, label: "Excluir Recorrência 🗑️" },
                        ];
                        break;
                    case 'product':
                        buttons = [
                            { id: `edit_product_${resourceForButtonsContext.id}`, label: "Editar Produto ✍️" },
                            { id: `delete_product_${resourceForButtonsContext.id}`, label: "Excluir Produto 🗑️" },
                        ];
                        break;
                    case 'parcelled_account': // Compra parcelada
                        buttons = [
                            { id: `edit_parcelled_account_${resourceForButtonsContext.id}`, label: "Alterar Compra Parcelada ✍️" },
                            { id: `delete_parcelled_account_${resourceForButtonsContext.id}`, label: "Excluir Compra Parcelada 🗑️" },
                        ];
                        break;
                }

                if (buttons.length > 0) {
                    await sendButtonListMessage(senderPhone, completeFinalReply, buttons, buttonTitle, "Clique aqui 👇");
                } else {
                    await sendWhatsappMessage(senderPhone, completeFinalReply);
                }
            } else {
                await sendWhatsappMessage(senderPhone, completeFinalReply);
                 // Se teve um recurso em edição, mas a IA não forneceu ação de update e não gerou botões, limpa o recurso.
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
        if (state) conversationState.set(senderPhone, state); // Garante que o estado final seja salvo
    }
}

module.exports = { processIncomingMessage };
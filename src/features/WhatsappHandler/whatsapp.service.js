// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
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
let pushNameFromPayload = null;


// --- Funções Auxiliares de Busca ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const category = await systemService.findFinancialCategoryByNameAndType(name, transactionType, financialAccountId);
    return category ? category.id : null;
}

async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    try {
        const card = await creditCardService.findCreditCardByName(financialAccountId, name);
        return card ? card.id : null;
    } catch (error) {
        if (error.statusCode === 404) {
            logger.warn(`[WHATSAPP SERVICE HELPER] Cartão "${name}" não encontrado para conta ${financialAccountId} via findCreditCardIdByName.`);
            return null; // Retorna null suavemente se não encontrar
        }
        // Relança outros erros para serem tratados no fluxo principal
        logger.error(`[WHATSAPP SERVICE HELPER] Erro inesperado ao buscar cartão ${name}: ${error.message}`);
        throw error;
    }
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    const productsResult = await productService.getAllProducts(financialAccountId, { search: nameOrCode, limit: 1 });
    if (productsResult.products && productsResult.products.length > 0) {
        return productsResult.products[0].id;
    }
    return null;
}

// --- Funções de Formatação Auxiliares ---
function formatDate(dateString) {
    if (!dateString) return 'N/A';
    // Garante que a string de data seja interpretada corretamente como UTC se for apenas YYYY-MM-DD
    const safeDateString = dateString.length === 10 ? `${dateString}T00:00:00Z` : dateString;
    try {
        // Formata para pt-BR, mas considera a data como UTC para evitar problemas de fuso ao formatar apenas a data.
        return new Date(safeDateString).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    } catch (e) {
        logger.warn(`[FORMAT DATE] Data inválida recebida: ${dateString}`);
        return 'Data Inválida';
    }
}

function formatTime(dateTimeString, includeSeconds = true) {
    if (!dateTimeString) return 'N/A';
    // Assume que dateTimeString é um timestamp ISO ou algo que o construtor Date entenda.
    // O timezone para formatação será o do ambiente ou São Paulo.
    const options = { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' };
    if (includeSeconds) options.second = '2-digit';
    try {
        return new Date(dateTimeString).toLocaleTimeString('pt-BR', options);
    } catch (e) {
        logger.warn(`[FORMAT TIME] Data/Hora inválida recebida: ${dateTimeString}`);
        return 'Hora Inválida';
    }
}

function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(parseFloat(value))) return 'R$ --,--';
    return `R$${parseFloat(value).toFixed(2).replace('.', ',')}`;
}

function formatPlatformLink(customText = "") {
    const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
    const defaultText = `📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}. Qualquer coisa, estou por aqui! 😉`;
    return customText || defaultText;
}

// --- Funções de Formatação ANTIGAS (Completas, para referência e correção de chamadas) ---
// Estas funções são mantidas para referência caso sejam chamadas por código não mostrado,
// mas as novas "format...DataStructure" são preferidas para as mensagens ao usuário.
function formatOldFinancialTransactionSummary(transaction, clientName, forMulti = false, forEdit = false) {
    if (!transaction) return "Dados da transação não disponíveis.";
    const date = formatDate(transaction.transactionDate);
    let summary = forEdit ? `📝 Transação Editada:\n` : (forMulti ? "" : `🎯 Resumo da Transação:\n`);
    summary += `Descrição: ${transaction.description}\n`;
    summary += `Valor: ${formatCurrency(transaction.value)}\n`;
    summary += `Tipo: ${transaction.type}\n`;
    if (transaction.category) summary += `Categoria: ${transaction.category.name}\n`;
    if (transaction.creditCard) summary += `Cartão: ${transaction.creditCard.name}\n`;
    summary += `Data: ${date}\n`;
    if (transaction.isPayableOrReceivable && !transaction.creditCardId) {
        summary += `Vencimento: ${formatDate(transaction.dueDate)}\n`;
        summary += `Status: ${transaction.isPaidOrReceived ? (transaction.type === 'Entrada' ? 'Recebida ✅' : 'Paga ✅') : 'Pendente ⏳'}\n`;
        if(transaction.isPaidOrReceived && transaction.paymentDate) summary += `Data Pgto/Rec: ${formatDate(transaction.paymentDate)}\n`;
    } else if (!transaction.isPayableOrReceivable && !transaction.creditCardId) { // Transação à vista (não cartão)
         summary += `Status: ${transaction.isPaidOrReceived ? (transaction.type === 'Entrada' ? 'Recebida ✅' : 'Paga ✅') : 'Pendente ⏳'}\n`;
    } else if (transaction.creditCardId) { // Transação no cartão (sempre "paga" na origem, lançada na fatura)
         summary += `Status: Lançada no cartão ✅\n`;
    }
    if(transaction.isParcel && transaction.parcelNumber && transaction.totalParcels){
        summary += `Parcela: ${transaction.parcelNumber}/${transaction.totalParcels}\n`;
        if(transaction.originalAccount && transaction.originalAccount.description){
            // Remove o sufixo " - Parcela X/Y" da descrição original para mostrar o nome da compra
            summary += `Compra Original: ${transaction.originalAccount.description.replace(/ - Parcela \d+\/\d+$/, '').trim()}\n`;
        }
    }
    if(transaction.notes && transaction.notes.trim() !== "") summary += `Notas: ${transaction.notes}\n`;
    if(!forMulti && !forEdit) summary += `\nID: ${transaction.id}`; // ID apenas para resumo individual não-edição
    return summary.trim();
}

function formatOldAppointmentSummary(appointment, clientName, forMulti = false, forEdit = false) {
    if (!appointment) return "Dados do compromisso não disponíveis.";
    const dateStr = formatDate(appointment.eventDateTime);
    const timeStr = formatTime(appointment.eventDateTime);

    let summary = forEdit ? `📅 Compromisso Editado:\n` : (forMulti ? "" : `📅 Resumo do Compromisso:\n`);
    summary += `Título: ${appointment.title}\n`;
    summary += `Data: ${dateStr} às ${timeStr}\n`;
    if (appointment.durationMinutes) summary += `Duração: ${appointment.durationMinutes} min\n`;
    if (appointment.location) summary += `Local: ${appointment.location}\n`;
    if (appointment.status) summary += `Status: ${appointment.status}\n`; // Ex: Scheduled, Confirmed, Cancelled
    if (appointment.associatedValue && appointment.associatedTransactionType) {
        summary += `Valor Associado: ${formatCurrency(appointment.associatedValue)} (${appointment.associatedTransactionType})\n`;
    }
    if (appointment.notes && appointment.notes.trim() !== "") summary += `Notas: ${appointment.notes}\n`;
    if(!forMulti && !forEdit) summary += `\nID: ${appointment.id}`;
    return summary.trim();
}

function formatOldRecurringRuleSummary(rule, clientName, forMulti = false, forEdit = false) {
    if (!rule) return "Dados da recorrência não disponíveis.";
    let summary = forEdit ? `🔄 Recorrência Editada:\n` : (forMulti ? "" : `🧾 Resumo da Recorrência:\n`);
    summary += `Descrição: ${rule.description}\n`;
    summary += `Valor: ${formatCurrency(rule.value)} (${rule.type})\n`;
    if(rule.category) summary += `Categoria: ${rule.category.name}\n`;
    let frequencyDisplay = rule.frequency ? (rule.frequency.charAt(0).toUpperCase() + rule.frequency.slice(1)) : 'N/A';
    if (rule.interval && rule.interval > 1) {
        // Mapeia para plural
        const pluralMap = { daily: 'dias', weekly: 'semanas', monthly: 'meses', annually: 'anos', 'bi-weekly': 'quinzenas', quarterly: 'trimestres', 'semi-annually': 'semestres' };
        frequencyDisplay = `A cada ${rule.interval} ${pluralMap[rule.frequency] || (rule.frequency ? rule.frequency.replace('ly', 's') : 'períodos')}`;
    } else if (rule.frequency) {
         // Mapeia para forma singular mais amigável
         const singleMap = { daily: 'Diária', weekly: 'Semanal', monthly: 'Mensal', annually: 'Anual', 'bi-weekly': 'Quinzenal', quarterly: 'Trimestral', 'semi-annually': 'Semestral' };
         frequencyDisplay = singleMap[rule.frequency] || frequencyDisplay;
    }
    summary += `Frequência: ${frequencyDisplay}\n`;
    summary += `Início: ${formatDate(rule.startDate)}\n`;
    if(rule.endDate) summary += `Fim: ${formatDate(rule.endDate)}\n`;
    if(rule.dayOfWeek !== null && rule.dayOfWeek !== undefined) { // Dia da semana (0=Domingo, 6=Sábado)
        const days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
        summary += `Dia da Semana: ${days[rule.dayOfWeek]}\n`;
    }
    if(rule.dayOfMonth) summary += `Dia do Mês: ${rule.dayOfMonth}\n`;
    summary += `Próximo Vencimento: ${rule.nextDueDate ? formatDate(rule.nextDueDate) : 'N/A (Regra Inativa)'}\n`;
    summary += `Criação Automática: ${rule.autoCreateTransaction ? 'Sim' : 'Não (Lembrete)'}\n`;
    summary += `Status da Regra: ${rule.isActive ? 'Ativa' : 'Inativa'}\n`;
    if(!forMulti && !forEdit) summary += `\nID: ${rule.id}`;
    return summary.trim();
}

function formatOldProductSummary(product, clientName, forMulti = false, forEdit = false) {
    if (!product) return "Dados do produto não disponíveis.";
    let summary = forEdit ? `📦 Produto Editado:\n\n` : (forMulti ? "" : `📦 Resumo do Produto:\n\n`);
    summary += `🏷️ Nome: ${product.name}\n`;
    if(product.code) summary += `🔢 Código: ${product.code}\n`;
    summary += `💰 Preço de Venda: ${formatCurrency(product.salePrice)}\n`;
    if(product.costPrice) summary += `💲 Preço de Custo: ${formatCurrency(product.costPrice)}\n`;
    summary += `🛍️ Estoque Atual: ${product.quantity} ${product.unit || 'UN'}\n`;
    if(product.minimumStock) summary += `📉 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    if(product.description && product.description.trim() !== "") summary += `📄 Descrição Detalhada: ${product.description}\n`;
    if(!forMulti && !forEdit) summary += `\n🆔 ID: ${product.id}`;
    return summary.trim();
}

function formatOldCreditCardSummary(card, clientName, forMulti = false, forEdit = false) {
    if (!card) return "Dados do cartão não disponíveis.";
    let summary = forEdit ? `💳 Cartão Editado:\n\n` : (forMulti ? "" : `💳 Resumo do Cartão de Crédito:\n\n`);
    summary += `🏦 Nome: ${card.name}\n`;
    summary += `💰 Limite: ${formatCurrency(card.limit)}\n`;
    summary += `🗓️ Dia de Fechamento: ${card.closingDay}\n`;
    summary += `💵 Dia de Pagamento: ${card.paymentDay}\n`;
    if(card.lastFourDigits) summary += `🔢 Final: ${card.lastFourDigits}\n`;
    if(card.flag) summary += `🏳️ Bandeira: ${card.flag}\n`;
    summary += `⭐ Padrão: ${card.isDefault ? 'Sim' : 'Não'}\n`;
    summary += `🚦 Status: ${card.isActive ? 'Ativo' : 'Inativo'}\n`;
    if(!forMulti && !forEdit) summary += `\n🆔 ID: ${card.id}`;
    return summary.trim();
}

function formatOldParcelledAccountSummary(params, parcelResult, clientName, forEdit = false){
    if (!parcelResult || !parcelResult.parcels || parcelResult.parcels.length === 0) return "Dados da compra parcelada não disponíveis.";
    const firstParcel = parcelResult.parcels[0];
    let summary = forEdit ? `🛍️ Compra Parcelada Editada:\n` : `🛍️ Compra Parcelada Registrada:\n`;
    summary += `Descrição: ${params.description || firstParcel.description.replace(/ - Parcela \d+\/\d+$/, '')}\n`;
    summary += `Valor Total: R$ ${parseFloat(params.totalValue).toFixed(2)}\n`;
    summary += `Parcelas: ${params.numberOfParcels}x de R$ ${parseFloat(firstParcel.value).toFixed(2)} (aprox.)\n`;
    if(params.creditCardName) summary += `Cartão: ${params.creditCardName}\n`; // Usa o nome do cartão dos parâmetros se disponível
    else if(firstParcel.creditCard) summary += `Cartão: ${firstParcel.creditCard.name}\n`;
    if(params.financialCategoryName) summary += `Categoria: ${params.financialCategoryName}\n`; // Usa o nome da categoria dos parâmetros se disponível
    else if(firstParcel.category) summary += `Categoria: ${firstParcel.category.name}\n`;
    summary += `Data da Compra: ${formatDate(params.transactionDate || firstParcel.transactionDate)}\n`;
    summary += `Venc. 1ª Parcela: ${formatDate(params.initialDueDate || firstParcel.dueDate || firstParcel.transactionDate)}\n`; // Usa initialDueDate dos params se disponível
    return summary.trim();
}


// --- Novas Funções de Formatação para "Estrutura de Dados" (usando as funções auxiliares) ---
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

    if (transaction.isPayableOrReceivable && !transaction.creditCardId) { // Contas a pagar/receber (não cartão)
        data += `🗓️ Vencimento: ${formatDate(transaction.dueDate)}\n`;
        data += `✅ Status: ${transaction.isPaidOrReceived ? (transaction.type === 'Entrada' ? 'Recebido' : 'Pago') : 'Pendente'}\n`;
        if (transaction.isPaidOrReceived && transaction.paymentDate) {
            data += `🧾 Data Pgto/Rec: ${formatDate(transaction.paymentDate)}\n`;
        }
    } else if (!transaction.creditCardId) { // Transações à vista (não cartão)
        data += `✅ Status: ${transaction.type === 'Entrada' ? 'Recebido' : 'Pago'}\n`;
    } else { // Transações no cartão (sempre "paga" na origem, lançada na fatura)
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
    if (rule.dayOfMonth && rule.frequency === 'monthly') {
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
        if (card.availableLimit !== undefined) { // Se o service calculou o limite disponível
            data += `💰 Limite disponível: ${formatCurrency(card.availableLimit)}\n`;
        } else { // Senão, mostra o limite total
            data += `💰 Limite Total: ${formatCurrency(card.limit)}\n`;
        }
        if (card.isDefault) data += `⭐ Cartão Padrão\n`;
    });
    return data.trim();
}

function formatCreditCardInvoiceDataStructure(invoiceDetails, listTransactions = true) {
    if (!invoiceDetails) return "🎯 Resumo da Fatura:\n\nDados da fatura não disponíveis.";
    let data = `🎯 Resumo da Fatura - Cartão ${invoiceDetails.cardName || 'N/A'}\n\n`;
    data += `📅 Mês de Referência: ${invoiceDetails.invoiceReferenceMonthYear || 'N/A'}\n`; // Ex: "Maio/2024"
    data += `💰 Total da fatura: ${formatCurrency(invoiceDetails.totalAmount)}\n`;
    // Mostra limite disponível APÓS essa fatura se calculado, senão, mostra total do cartão e saldo estimado.
    if(invoiceDetails.availableLimitAfterInvoice !== undefined) {
        data += `💳 Limite disponível (após esta fatura): ${formatCurrency(invoiceDetails.availableLimitAfterInvoice)}\n`;
    } else if (invoiceDetails.cardTotalLimit !== undefined) { // Se temos o limite total do cartão
        const available = parseFloat(invoiceDetails.cardTotalLimit) - parseFloat(invoiceDetails.totalAmount);
        data += `💳 Limite Total do Cartão: ${formatCurrency(invoiceDetails.cardTotalLimit)}\n`;
        data += `💳 Saldo Estimado Pós-Fatura: ${formatCurrency(available)}\n`;
    }
    data += `🗓️ Fechamento: ${formatDate(invoiceDetails.invoiceCycleEndDate)}\n`; // invoiceCycleEndDate é a data de fechamento
    data += `🗓️ Vencimento: ${formatDate(invoiceDetails.paymentDueDate)}\n`; // paymentDueDate é a data de vencimento


    if (listTransactions && invoiceDetails.transactions && invoiceDetails.transactions.length > 0) {
        data += `\n📄 Detalhamento das Compras:\n`;
        invoiceDetails.transactions.forEach((tx, index) => {
            let parcelInfo = "";
            if (tx.isParcel && tx.parcelNumber && tx.totalParcels) {
                parcelInfo = ` (${tx.parcelNumber}/${tx.totalParcels})`; // Ex: (1/12)
            } else {
                parcelInfo = ` — à vista`; // Indica que é à vista
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
    data += `💸 Valor Utilizado (Fatura Aberta): ${formatCurrency(limitInfo.netUsedAmount)}\n`; // Usado na fatura atual
    data += `✅ Limite Disponível Agora: ${formatCurrency(limitInfo.availableLimit)}\n`;
    data += `🗓️ Próximo Fechamento: Dia ${limitInfo.closingDay}\n`;
    data += `🗓️ Dia de Pagamento: Dia ${limitInfo.paymentDay}\n`;
    return data.trim();
}

function formatParcelledAccountDataStructure(parcelParams, parcelResult) {
    // parcelParams: o que a IA enviou (com nomes de cartão/categoria)
    // parcelResult: o que o BD retornou (com IDs e valores calculados)
    if (!parcelResult || !parcelResult.parcels || parcelResult.parcels.length === 0) return "🎯 Resumo da Compra Parcelada:\n\nDados não disponíveis.";

    const firstParcel = parcelResult.parcels[0]; // Pega a primeira parcela para o valor individual
    let data = `🎯 Resumo da Compra Parcelada:\n\n`;
    data += `📝 Descrição: ${parcelParams.description || firstParcel.description.replace(/ - Parcela \d+\/\d+$/, '')}\n`;
    data += `💰 Valor Total: ${formatCurrency(parcelParams.totalValue)}\n`;
    data += `📦 Parcelas: ${parcelParams.numberOfParcels}x de ${formatCurrency(firstParcel.value)} (aprox.)\n`;
    if (parcelParams.creditCardName) { // Usa o nome do cartão dos parâmetros originais se disponível
        data += `💳 Cartão: ${parcelParams.creditCardName}\n`;
    } else if (firstParcel.creditCard && firstParcel.creditCard.name) { // Senão, tenta pegar do objeto do resultado
        data += `💳 Cartão: ${firstParcel.creditCard.name}\n`;
    }
    if (parcelParams.financialCategoryName) { // Usa o nome da categoria dos parâmetros originais se disponível
        data += `🏷️ Categoria: ${parcelParams.financialCategoryName}\n`;
    } else if (firstParcel.category && firstParcel.category.name) { // Senão, tenta pegar do objeto do resultado
        data += `🏷️ Categoria: ${firstParcel.category.name}\n`;
    }
    data += `📅 Data da Compra: ${formatDate(parcelParams.transactionDate || firstParcel.transactionDate)}\n`;
    data += `🗓️ Venc. 1ª Parcela: ${formatDate(parcelParams.initialDueDate || firstParcel.dueDate || firstParcel.transactionDate)}\n`;
    return data.trim();
}

function formatListClientAccountsDataStructure(accounts, currentAccountId = null) {
    if (!accounts || accounts.length === 0) return "🏷️ Perfis cadastrados:\n\nNenhum perfil/conta financeira cadastrado.";
    let data = `🏷️ Perfis cadastrados:\n`;
    accounts.forEach((acc, index) => {
        data += `\n${index + 1}️⃣ ${acc.name} (${acc.type})${currentAccountId === acc.id ? ' (Selecionada ✨)' : ''}`;
    });
    return data.trim();
}

function formatProductDataStructure(product) {
    if (!product) return "📦 Resumo do Produto:\n\nDados do produto não disponíveis.";
    let data = `📦 Resumo do Produto:\n\n`;
    data += `🏷️ Nome: ${product.name}\n`;
    if(product.code) data += `🔢 Código: ${product.code}\n`;
    data += `💰 Preço de Venda: ${formatCurrency(product.salePrice)}\n`;
    if(product.costPrice) data += `💲 Preço de Custo: ${formatCurrency(product.costPrice)}\n`;
    data += `🛍️ Estoque Atual: ${product.quantity} ${product.unit || 'UN'}\n`;
    if(product.minimumStock) data += `📉 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    if(product.description && product.description.trim() !== "") data += `📄 Descrição Detalhada: ${product.description}\n`;
    return data.trim();
}

function formatMotivationalMessagePreferenceDataStructure(prefs) {
    let data = `💬 Preferências de Mensagem Motivacional:\n\n`;
    data += `🚦 Status: ${prefs.enableMotivationMessage ? 'Ativada ✅' : 'Desativada ❌'}\n`;
    if (prefs.enableMotivationMessage && prefs.motivationMessageTime) {
        data += `🕒 Horário Programado: ${prefs.motivationMessageTime.substring(0,5)}\n`; // HH:MM
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
        data += `🌅 Início: ${prefs.waterReminderStartTime ? prefs.waterReminderStartTime.substring(0,5) : 'N/A'}\n`; // HH:MM
        data += `🌃 Fim: ${prefs.waterReminderEndTime ? prefs.waterReminderEndTime.substring(0,5) : 'N/A'}\n`;     // HH:MM
        if (prefs.dailyGoalMl) {
            data += `🎯 Meta Diária: ${prefs.dailyGoalMl}ml\n`;
        }
    }
    return data.trim();
}


// --- Funções de Onboarding (Seguindo os novos padrões) ---
function getOnboardingWelcomeNoPlanMessage(clientName) {
    const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
    const aiIntro = `🚀 Olá, ${clientName}! Preparado para simplificar suas finanças e ter tudo na palma da mão? Vamos juntos nessa jornada! 💪✨`;
    const dataStructure = `🎯 Planos MAP no Controle:\n\n` +
                          `📅 Opções disponíveis: Mensal e Anual\n` +
                          `🏷️ Para: Finanças pessoais e empresariais\n` +
                          `🌐 Página de planos: ${siteUrl}`;
    const linkText = `🤔 Quer saber mais detalhes por aqui? É só dizer "sim"! Ou, se preferir, já pode garantir seu plano no link acima. Assim que ativar, me chama com um "oi" que começamos a mágica! ✨`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForEmailMessage(clientName, planDetailsText) {
    const aiIntro = `🎉 E aí, ${clientName}! Seja muito bem-vindo ao seu ${planDetailsText}! 🚀`;
    const dataStructure = `📋 Detalhes do Plano:\n\n` +
                          `🗓️ Validade: ${planDetailsText.includes('válido até') ? planDetailsText.split('válido até ')[1].replace(')!','').trim() : (planDetailsText.toLowerCase().includes('vitalício') ? 'Vitalício' : 'N/A')}\n`+
                          `💼 Tipo: ${planDetailsText.split(' (')[0].trim()}\n` + // Pega o nome do plano antes do "(válido até..."
                          `🌐 Acesso: Configuração do login para o app web`;
    const linkText = `📧 Para finalizar seu cadastro, me diga qual é o melhor e-mail para usarmos no acesso. Assim você poderá conferir tudo detalhado quando quiser!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForPasswordMessage(clientName, email) {
    const aiIntro = `👍 Perfeito, ${clientName}! Seu e-mail ${email} foi anotado com sucesso! 🎉`;
    const dataStructure = `🔐 Próximo passo:\n\n` +
                          `✍️ Crie uma senha bem legal e segura, com pelo menos 6 caracteres, para proteger suas informações com total segurança.`;
    const linkText = `🛡️ Segurança em primeiro lugar para manter tudo protegido!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForFullNameMessage(clientName) {
    const aiIntro = `🔐 Senha guardada com todo carinho e segurança! 🗝️`;
    const dataStructure = `😊 Agora, para a gente se conhecer melhor, qual nome completo podemos usar no seu perfil?`;
    const linkText = `📊 Assim seu cadastro fica completinho e personalizado para você!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForPFAccountNameMessage(clientName) {
    const aiIntro = `🎉 Uhuul, ${clientName}! Tudo certo com seu acesso e credenciais! 🚀`;
    const dataStructure = `📋 Próximo passo:\n\n` +
                          `📝 Vamos criar sua primeira conta financeira para seus gastos pessoais (PF).\n\n`+
                          `💡 Qual nome você gostaria de dar para ela? Algo como "Minhas Contas" ou "Pessoal do(a) ${clientName}" seria bem legal!`;
    return `${aiIntro}\n\n${dataStructure}`;
}

function getOnboardingConfirmPJAccountSetupMessage(clientName, pfAccountName, planDetailsText) {
    const aiIntro = `🏦 Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientName}! 🎉 Ela já está selecionada para você começar a usar.`;
    const dataStructure = `🚀 Próximo passo:\n\n` +
                          `📈 Como você tem o ${planDetailsText.split(' (')[0].trim()}, que tal configurarmos também uma conta para sua empresa (PJ) ou MEI?`; // Pega nome do plano
    const linkText = `✨ Responda "sim" para configurar ou "não" para pular essa etapa.`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForPJTypeMessage(clientName) {
    const aiIntro = `👍 Excelente, ${clientName}! Sua nova conta será para qual tipo?`;
    const dataStructure = `🏢 Empresa (PJ) ou 👩‍💼 Microempreendedor Individual (MEI)?`;
    const linkText = `📲 Me diga "PJ" ou "MEI" para que eu possa configurar certinho para você!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForCompanyNameMessage(clientName, companyType) {
    const aiIntro = `🎉 Show, ${clientName}! Conta do tipo ${companyType} selecionada. 🚀`;
    const dataStructure = `🏢 Agora, me conta: qual nome incrível vamos dar para essa sua potência empresarial?`;
    const linkText = `💡 Pode ser algo como "Tech Solutions LTDA" ou "Consultoria ${clientName} MEI", use sua criatividade!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingCompanyCreatedMessage(clientName, companyType, companyName, activePersonalAccountName) {
    const aiIntro = `🎊 Sensacional, ${clientName}! Sua conta ${companyType} "${companyName}" foi criada e está pronta para brilhar! ✨`;
    const dataStructure = `🏦 Sua conta "${activePersonalAccountName}" continua selecionada no momento.\n\n` +
                          `🔄 Para mudar para a conta da empresa, é só me dizer: "mudar para conta ${companyName}".`;
    const linkText = `💪 E aí, o que vamos fazer agora? Estou pronto para a ação!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function formatAccountSelectionMessage(clientName, planDetailsText, accounts) {
    let aiIntro = `👋 Que bom te ver por aqui, ${clientName}! Seu ${planDetailsText} está a todo vapor! 🚀`;
    let dataStructure = `🏦 Contas configuradas:\n`;
    accounts.forEach((acc, index) => {
        dataStructure += `\n${index + 1}️⃣ ${acc.name} (${acc.type})`;
    });
    let linkText = `🤔 Qual delas vamos usar hoje? Me diga o nome ou o número da conta para começarmos! 😉`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}


// --- Initialize or Update State ---
async function initializeOrUpdateState(client, existingState = null, clientAccountsFromDb = []) {
    const clientName = client.name && client.name.trim() !== "" && client.name.trim().toLowerCase() !== "unknown" && client.name.trim().toLowerCase() !== "null"
        ? client.name.split(" ")[0] // Pega o primeiro nome
        : (pushNameFromPayload || "pessoa incrível"); // Fallback

    let hasPaidAccess = false;
    let clientAccessLevel = client.accessLevel || 'gratuito'; // Nível de acesso base do cliente
    let clientAccessExpiresAt = client.accessExpiresAt;
    let accessLevelTextForUser = "Nenhum plano ativo"; // Texto que o usuário verá
    let onboardingStage = existingState?.data?.onboardingStage || 'awaiting_plan_confirmation';

    if (client.accessLevel && client.accessLevel !== 'gratuito') {
        if (client.accessLevel.startsWith('vitalicio_')) {
            hasPaidAccess = true;
            accessLevelTextForUser = client.accessLevel.replace('vitalicio_', 'Vitalício ').replace(/_/g, ' ').trim();
            accessLevelTextForUser = accessLevelTextForUser.charAt(0).toUpperCase() + accessLevelTextForUser.slice(1);
        } else if (client.accessExpiresAt) {
            const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z'); // Garante UTC
            const today = new Date(); today.setUTCHours(0, 0, 0, 0); // Data de hoje em UTC
            if (expiryDate >= today) {
                hasPaidAccess = true;
                let planNamePart = client.accessLevel.replace(/_/g, ' ');
                planNamePart = planNamePart.charAt(0).toUpperCase() + planNamePart.slice(1);
                accessLevelTextForUser = `${planNamePart} (válido até ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
            } else {
                // Plano expirou
                let planNamePart = client.accessLevel.replace(/_/g, ' ');
                planNamePart = planNamePart.charAt(0).toUpperCase() + planNamePart.slice(1);
                accessLevelTextForUser = `Plano ${planNamePart} expirado`;
                clientAccessLevel = 'gratuito'; // Downgrade no nível de acesso localmente para a sessão
            }
        } else {
            // Tem accessLevel mas não tem data de expiração (e não é vitalício) - considera como gratuito para segurança
            logger.warn(`[WHATSAPP SERVICE - Initialize/UpdateState] Cliente ${client.id} com accessLevel ${client.accessLevel} mas sem accessExpiresAt. Considerando como sem plano pago.`);
            clientAccessLevel = 'gratuito';
        }
    } else {
         accessLevelTextForUser = "Nenhum plano ativo";
    }
   
    // Lógica de transição de estágio de onboarding baseada no status de acesso PAGO
    if (hasPaidAccess) {
        // Se tinha acesso pago e o estágio de onboarding não reflete isso OU se o estágio anterior foi com 'sem acesso pago'
        if (onboardingStage === 'awaiting_plan_confirmation' || (existingState && !existingState.hasPaidAccess_whenStageLastSet) ) {
            if (!client.email || !client.passwordHash) {
                onboardingStage = 'setting_up_credentials_email';
            } else {
                const hasPf = clientAccountsFromDb.some(acc => acc.accountType === 'PF');
                if (!hasPf) {
                     onboardingStage = 'setting_up_pf_account_name';
                } else {
                     const hasPjMei = clientAccountsFromDb.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                     const planTier = clientAccessLevel.startsWith('avancado') || clientAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                    
                     // Apenas entra na confirmação de PJ/MEI se o plano for avançado, não tiver conta PJ/MEI
                     // E não estiver já em algum estágio de criação de PJ/MEI
                     if (planTier === 'avancado' && !hasPjMei &&
                         existingState?.data?.onboardingStage !== 'confirming_pj_mei_setup' &&
                         existingState?.data?.onboardingStage !== 'awaiting_pj_mei_type' &&
                         existingState?.data?.onboardingStage !== 'creating_pj_mei_account_name') {
                        onboardingStage = 'confirming_pj_mei_setup';
                     } else if (existingState?.data?.onboardingStage !== 'onboarding_complete') { // Se já passou por tudo, marca como completo
                        onboardingStage = 'onboarding_complete';
                     }
                     // Se já está 'onboarding_complete', mantém.
                }
            }
        }
    } else { // Se não tem acesso pago (ou expirou)
        onboardingStage = 'awaiting_plan_confirmation';
    }

    // Define conta default SE onboarding completo e tem acesso pago
    const defaultAccount = (onboardingStage === 'onboarding_complete' && hasPaidAccess && clientAccountsFromDb.length > 0)
        ? (clientAccountsFromDb.find(a=>a.isDefault) || clientAccountsFromDb[0]) // Pega default ou a primeira
        : null;

    if (existingState) {
        // Atualiza dados do cliente no estado existente
        existingState.clientName = clientName;
        existingState.currentAccessLevel = clientAccessLevel; // Nível de acesso atual (pode ter sido 'gratuito' se expirou)
        existingState.accessExpiresAt = clientAccessExpiresAt;
        existingState.hasPaidAccess = hasPaidAccess; // Flag se tem acesso pago VÁLIDO
        existingState.accessLevelTextForUser = accessLevelTextForUser; // Texto para o usuário
       
        // Se o onboardingStage mudou E NÃO FOI para 'onboarding_complete', reseta currentAction
        // para evitar que uma ação de um estágio anterior interfira no novo.
        if (existingState.data.onboardingStage !== onboardingStage && onboardingStage !== 'onboarding_complete') {
            existingState.currentAction = null;
        }
        existingState.data.onboardingStage = onboardingStage;
        existingState.hasPaidAccess_whenStageLastSet = hasPaidAccess; // Guarda o status de acesso pago no momento que o estágio foi setado

        // Lógica para definir conta ativa no estado
        if (onboardingStage === 'onboarding_complete' && hasPaidAccess) {
            if (!existingState.activeFinancialAccountId && defaultAccount) { // Se não tem conta ativa e existe uma default
                existingState.activeFinancialAccountId = defaultAccount.id;
                existingState.activeFinancialAccountName = defaultAccount.accountName;
                existingState.activeFinancialAccountType = defaultAccount.accountType;
            }
            // Se já tem uma conta ativa e ela ainda existe em clientAccountsFromDb, mantém.
            // (A menos que o usuário peça para trocar, o que é tratado em outro lugar)
        } else { // Se não completou onboarding ou não tem acesso pago, não define conta ativa
            existingState.activeFinancialAccountId = null;
            existingState.activeFinancialAccountName = null;
            existingState.activeFinancialAccountType = null;
        }
       
        logger.debug(`[WHATSAPP SERVICE - UpdateState] Estado atualizado para cliente ${client.id}: `, {
            onboardingStage: existingState.data.onboardingStage,
            currentAction: existingState.currentAction,
            hasPaidAccess: existingState.hasPaidAccess,
            activeAccountId: existingState.activeFinancialAccountId,
            accessLevelTextForUser: existingState.accessLevelTextForUser,
        });
        return existingState;
    }

    // Novo estado
    const newState = {
        currentAction: null, // Ação atual do usuário (ex: 'awaiting_input_email')
        data: { onboardingStage }, // Dados temporários para o fluxo atual (ex: email, senha temporários)
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount ? defaultAccount.accountType : null,
        clientName: clientName,
        messageHistory: [],
        pendingConfirmation: null, // Para guardar dados de uma ação que precisa de "sim/não" do usuário
        editingResource: null, // Para guardar {type: 'transaction', id: 123} quando o usuário pede para editar algo
        lastAiResponse: null, // Guarda a última resposta completa da IA
        currentAccessLevel: clientAccessLevel, // Nível de acesso original do cliente ou 'gratuito'
        accessExpiresAt: clientAccessExpiresAt, // Data de expiração
        hasPaidAccess: hasPaidAccess,           // Se tem acesso pago e válido
        accessLevelTextForUser: accessLevelTextForUser, // Texto do plano para o usuário
        hasPaidAccess_whenStageLastSet: hasPaidAccess, // Status de acesso ao setar este estágio
    };
   
    logger.debug(`[WHATSAPP SERVICE - InitializeState] Novo estado criado para cliente ${client.id}: `, {
        onboardingStage: newState.data.onboardingStage,
        hasPaidAccess: newState.hasPaidAccess,
        accessLevelTextForUser: newState.accessLevelTextForUser,
    });
    return newState;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    pushNameFromPayload = pushName; // Guarda o nome do remetente do payload (pode ser null)
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state; // Estado da conversa para este usuário

    try {
        // 1. Obter ou criar cliente e estado da conversa
        let client = await clientService.findClientByPhone(senderPhone);
        let isNewUserForSessionLogic = !conversationState.has(senderPhone); // Se não tem estado na memória
        let clientFinancialAccountsForOnboarding = [];

        if (!client) {
            logger.info(`[WHATSAPP SERVICE] Cliente com telefone ${senderPhone} não encontrado no banco. Criando novo...`);
            client = await clientService.createClient({ phone: senderPhone, name: pushName }); // Usa pushName se disponível
            logger.info(`[WHATSAPP SERVICE] Novo Cliente criado: ID ${client.id}, Telefone: ${client.phone}, Nome: ${client.name}`);
            state = await initializeOrUpdateState(client, null, []); // Novo estado, sem contas ainda
            isNewUserForSessionLogic = true;
        } else {
            const existingState = conversationState.get(senderPhone);
            // Busca contas ANTES de atualizar o estado para que o onboardingStage seja determinado corretamente
            clientFinancialAccountsForOnboarding = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
            state = await initializeOrUpdateState(client, existingState, clientFinancialAccountsForOnboarding);
            if (!existingState) isNewUserForSessionLogic = true; // Se não tinha estado na memória, é novo para a lógica da sessão
        }
       
        const clientNameToUse = state.clientName; // Nome do cliente para usar nas mensagens

        // 2. Adicionar mensagem ao histórico do estado (se não for clique de botão)
        // O clique de botão tem `messageText` como o label do botão, não uma nova mensagem do usuário.
        // A mensagem original que continha os botões já estaria no histórico.
        if (!(rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string')) {
            state.messageHistory.push({ role: 'user', content: messageText });
        }
        if (state.messageHistory.length > MAX_STATE_HISTORY) { // Limita tamanho do histórico
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }
       
        let onboardingReply = ""; // Mensagem de resposta do fluxo de onboarding
        const lowerMessageText = messageText.toLowerCase().trim(); // Mensagem do usuário em minúsculas
       
        logger.debug(`[WHATSAPP ONBOARDING ENTRY] Cliente: ${client.id}, Stage: ${state.data.onboardingStage}, currentAction: ${state.currentAction}, hasPaidAccess: ${state.hasPaidAccess}, accessLevelText: ${state.accessLevelTextForUser}`);

        // ---- FLUXO DE ONBOARDING ----
        // Processa o estágio atual de onboarding. Se uma resposta for gerada (onboardingReply),
        // ela será enviada e, se o onboarding não estiver completo e uma ação estiver pendente,
        // o fluxo retorna para aguardar a próxima mensagem do usuário para essa ação de onboarding.

        if (state.data.onboardingStage === 'awaiting_plan_confirmation') {
            // Sempre envia mensagem de boas-vindas/plano se está neste estágio
            onboardingReply = getOnboardingWelcomeNoPlanMessage(clientNameToUse);
            state.currentAction = 'awaiting_plan_interest_generic'; // Aguardando resposta sobre interesse no plano
        } else if (state.data.onboardingStage === 'setting_up_credentials_email') {
            // Se a ação não é esperar email, ou se é um novo usuário na sessão, envia o pedido de email
            if (state.currentAction !== 'awaiting_input_email_for_credentials' || isNewUserForSessionLogic) {
                 onboardingReply = getOnboardingAskForEmailMessage(clientNameToUse, state.accessLevelTextForUser);
                 state.currentAction = 'awaiting_input_email_for_credentials';
            } else { // Se já estava esperando email, processa a mensagem atual como o email
                const emailInput = messageText.trim();
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (emailRegex.test(emailInput)) {
                    state.data.tempEmail = emailInput; // Guarda email temporariamente
                    onboardingReply = getOnboardingAskForPasswordMessage(clientNameToUse, emailInput);
                    state.data.onboardingStage = 'setting_up_credentials_password'; // Avança
                    state.currentAction = 'awaiting_input_password_for_credentials';
                } else {
                    onboardingReply = `Opa, ${clientNameToUse}! Esse e-mail não me pareceu muito certo... 🤔 Poderia tentar de novo, por favor? Algo como "seu_nome@exemplo.com".`;
                    // Mantém currentAction e onboardingStage para tentar de novo o email
                }
            }
        } else if (state.data.onboardingStage === 'setting_up_credentials_password') {
            const passwordInput = messageText.trim();
            if (passwordInput.length >= 6) {
                state.data.tempPassword = passwordInput; // Guarda senha temporariamente
                onboardingReply = getOnboardingAskForFullNameMessage(clientNameToUse);
                state.data.onboardingStage = 'setting_up_credentials_name'; // Avança
                state.currentAction = 'awaiting_input_name_for_credentials';
            } else {
                onboardingReply = `Para sua segurança, ${clientNameToUse}, a senha precisa ter pelo menos 6 caracteres. 😉 Pode me dizer uma senha um pouquinho maior?`;
            }
        } else if (state.data.onboardingStage === 'setting_up_credentials_name') {
            const nameInput = messageText.trim();
            if (nameInput.length >= 3 && nameInput.includes(" ")) { // Validação simples de nome e sobrenome
                try {
                    await clientAuthService.setClientCredentials(senderPhone, state.data.tempPassword, nameInput, state.data.tempEmail);
                    client = await clientService.findClientByPhone(senderPhone); // Recarrega cliente com nome atualizado
                    state.clientName = client.name.split(" ")[0]; // Atualiza nome no estado da sessão
                    logger.info(`[WHATSAPP ONBOARDING] Credenciais definidas para ${senderPhone}.`);
                    delete state.data.tempEmail; delete state.data.tempPassword; // Limpa dados temporários
                   
                    // Verifica se precisa criar conta PF
                    clientFinancialAccountsForOnboarding = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                    const hasPf = clientFinancialAccountsForOnboarding.some(acc => acc.accountType === 'PF');
                    if (!hasPf) {
                        state.data.onboardingStage = 'setting_up_pf_account_name';
                        onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
                        state.currentAction = 'awaiting_input_pf_name';
                    } else {
                        // Se já tem PF, verifica se precisa de PJ/MEI (plano avançado)
                        const hasPjMei = clientFinancialAccountsForOnboarding.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                        const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                        if (planTier === 'avancado' && !hasPjMei) {
                            state.data.onboardingStage = 'confirming_pj_mei_setup';
                            const pfAccName = clientFinancialAccountsForOnboarding.find(a => a.accountType === 'PF')?.accountName || "Pessoal";
                            onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, pfAccName, state.accessLevelTextForUser);
                            state.currentAction = 'awaiting_pj_mei_confirm';
                        } else {
                            state.data.onboardingStage = 'onboarding_complete';
                            const aiIntro = `Uhuul, ${clientNameToUse}! Tudo certo com seu acesso e credenciais! 🎉`;
                            const dataStructure = `💼 Seu plano ${state.accessLevelTextForUser} está pronto para uso!`;
                            const linkText = `Como posso te ajudar agora? 🚀`;
                            onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                            state.currentAction = null; // Onboarding completo
                        }
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP ONBOARDING] Erro ao definir credenciais para ${senderPhone}: ${e.message}`);
                    if (e.message && e.message.toLowerCase().includes('email já está em uso')) {
                         onboardingReply = `Puxa, ${clientNameToUse}, parece que o e-mail "${state.data.tempEmail}" já está sendo usado por outra pessoa. 😬 Você teria outro e-mail para cadastrarmos?`;
                         state.data.onboardingStage = 'setting_up_credentials_email'; // Volta para pedir email
                         state.currentAction = 'awaiting_input_email_for_credentials';
                         delete state.data.tempEmail; delete state.data.tempPassword; // Limpa dados temporários
                    } else {
                        onboardingReply = `Xi, ${clientNameToUse}, algo não saiu como o esperado ao salvar seus dados (${e.message.substring(0,60)}). 😥 Vamos tentar seu nome completo de novo?`;
                        // Mantém estágio e ação para tentar o nome novamente
                    }
                }
            } else {
                onboardingReply = `Para um toque mais pessoal, ${clientNameToUse}, poderia me dizer seu nome completo? ✨ Assim fica mais bacana no seu perfil!`;
            }
        } else if (state.data.onboardingStage === 'setting_up_pf_account_name') {
            if (state.currentAction !== 'awaiting_input_pf_name' || isNewUserForSessionLogic) { // Se não estava esperando o nome da conta PF, pede
                onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
                state.currentAction = 'awaiting_input_pf_name';
            } else { // Processa a msg como nome da conta PF
                const pfAccountName = messageText.trim();
                if (pfAccountName.length >= 3 && pfAccountName.length <= 50) {
                    try {
                        const newPfAccount = await clientService.createFinancialAccount(client.id, {
                            accountName: pfAccountName, accountType: 'PF', isDefault: true // Primeira PF é default
                        });
                        // Define a conta recém-criada como ativa na sessão
                        state.activeFinancialAccountId = newPfAccount.id;
                        state.activeFinancialAccountName = newPfAccount.accountName;
                        state.activeFinancialAccountType = newPfAccount.accountType;
                        logger.info(`[WHATSAPP ONBOARDING] Conta PF "${pfAccountName}" criada para ${senderPhone}.`);
                       
                        const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                        if (planTier === 'avancado') {
                            state.data.onboardingStage = 'confirming_pj_mei_setup';
                            onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, pfAccountName, state.accessLevelTextForUser);
                            state.currentAction = 'awaiting_pj_mei_confirm';
                        } else {
                            state.data.onboardingStage = 'onboarding_complete';
                            const aiIntro = `Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameToUse}! 🏦`;
                            const dataStructure = `Ela já está selecionada e seu plano ${state.accessLevelTextForUser} está pronto para uso!`;
                            const linkText = `Como posso te ajudar agora? 🚀`;
                            onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                            state.currentAction = null;
                        }
                    } catch (e) {
                        logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta PF "${pfAccountName}" para ${senderPhone}: ${e.message}`);
                        onboardingReply = `Opa! 😬 Tive um probleminha para criar a conta "${pfAccountName}" (${e.message.substring(0,60)}). Que tal a gente tentar um nome diferente?`;
                    }
                } else {
                    onboardingReply = `Esse nome parece um pouquinho curto ou um cadinho longo demais, ${clientNameToUse}. Para sua conta Pessoal, que tal um nome entre 3 e 50 letras? Assim fica perfeito! ✍️`;
                }
            }
        } else if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
             if (state.currentAction !== 'awaiting_pj_mei_confirm' || isNewUserForSessionLogic) {
                // Busca a conta PF para usar o nome na mensagem
                const pfAccount = (await clientService.getClientFinancialAccounts(client.id, { isActive: true })).find(a => a.accountType === 'PF');
                onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, pfAccount?.accountName || "Pessoal", state.accessLevelTextForUser);
                state.currentAction = 'awaiting_pj_mei_confirm';
            } else {
                const userResponseLower = lowerMessageText;
                let wantsPjMei = false;
                let pjMeiType = null;
   
                // Verifica se a resposta indica "sim" ou já especifica o tipo PJ/MEI
                if (userResponseLower.includes("sim") || userResponseLower === "pj" || userResponseLower === "mei" || userResponseLower.includes("quero") || userResponseLower.includes("bora")) {
                    wantsPjMei = true;
                    if (userResponseLower.includes("pj")) pjMeiType = "PJ";
                    else if (userResponseLower.includes("mei")) pjMeiType = "MEI";
                }
   
                if (wantsPjMei) {
                    if (pjMeiType) { // Se já especificou o tipo (ex: "sim, quero pj")
                        state.data.tempPjMeiType = pjMeiType;
                        onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameToUse, pjMeiType);
                        state.data.onboardingStage = 'creating_pj_mei_account_name';
                        state.currentAction = 'awaiting_input_pj_mei_name';
                    } else { // Se disse apenas "sim", pergunta o tipo
                        onboardingReply = getOnboardingAskForPJTypeMessage(clientNameToUse);
                        state.data.onboardingStage = 'awaiting_pj_mei_type';
                        state.currentAction = 'awaiting_input_pj_mei_type';
                    }
                } else { // Se respondeu "não" ou algo não relacionado
                    const aiIntro = `Tranquilo, ${clientNameToUse}! Sem pressa. Se mais pra frente você quiser adicionar sua conta empresarial, é só me avisar! 😉`;
                    const dataStructure = `Sua conta "${state.activeFinancialAccountName || 'Pessoal'}" está prontinha para uso com seu plano ${state.accessLevelTextForUser}!`;
                    const linkText = `O que você gostaria de fazer primeiro? Estou a postos! 🚀`;
                    onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = null;
                }
            }
        } else if (state.data.onboardingStage === 'awaiting_pj_mei_type') {
            const typeInput = messageText.trim().toUpperCase();
            if (typeInput === 'PJ' || typeInput === 'MEI') {
                state.data.tempPjMeiType = typeInput;
                onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameToUse, typeInput);
                state.data.onboardingStage = 'creating_pj_mei_account_name';
                state.currentAction = 'awaiting_input_pj_mei_name';
            } else {
                onboardingReply = `Por favor, ${clientNameToUse}, me diga se é "PJ" ou "MEI" para sua conta empresarial. Assim a gente configura tudo certinho! 😊`;
            }
        } else if (state.data.onboardingStage === 'creating_pj_mei_account_name') {
            const companyName = messageText.trim();
            const companyType = state.data.tempPjMeiType; // Tipo guardado no passo anterior
            if (companyName.length >= 3 && companyName.length <= 50) {
                try {
                    await clientService.createFinancialAccount(client.id, {
                        accountName: companyName, accountType: companyType, isDefault: false // PJ/MEI não é default inicialmente
                    });
                    // Pega o nome da conta pessoal ativa para a mensagem
                    const personalAccountName = state.activeFinancialAccountName || (await clientService.getClientFinancialAccounts(client.id, {isActive:true})).find(a => a.accountType === 'PF')?.accountName || "Pessoal";
                    onboardingReply = getOnboardingCompanyCreatedMessage(clientNameToUse, companyType, companyName, personalAccountName);
                    logger.info(`[WHATSAPP ONBOARDING] Conta ${companyType} "${companyName}" criada para ${senderPhone}.`);
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = null; delete state.data.tempPjMeiType;
                } catch (e) {
                    logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta ${companyType} "${companyName}" para ${senderPhone}: ${e.message}`);
                    onboardingReply = `Eita! 😬 Parece que não consegui criar a conta ${companyType} "${companyName}" (${e.message.substring(0,60)}). Será que podemos tentar um nome um pouquinho diferente?`;
                }
            } else {
                onboardingReply = `Para o nome da sua ${companyType}, ${clientNameToUse}, que tal algo entre 3 e 50 letras? Assim fica bem bacana! 🌟`;
            }
        }


        // Se houve uma resposta de onboarding, envia e atualiza o estado.
        // Se o onboarding NÃO estiver completo E uma ação de onboarding estiver pendente (currentAction não nulo),
        // então retorna para aguardar a próxima mensagem do usuário para essa ação de onboarding.
        if (onboardingReply) {
            state.messageHistory.push({ role: 'assistant', content: onboardingReply });
            await sendWhatsappMessage(senderPhone, onboardingReply);
            conversationState.set(senderPhone, state);
            // Se o onboarding não está completo E há uma ação de onboarding pendente, não prossegue para a IA.
            if (state.data.onboardingStage !== 'onboarding_complete' && state.currentAction !== null) {
                return;
            }
        }
       
        // ---- FIM DO FLUXO DE ONBOARDING / INÍCIO DO FLUXO NORMAL COM IA ----
        // Só continua se o onboarding estiver completo OU se não houve onboardingReply (implica que já passou ou não se aplica)
        if (state.data.onboardingStage === 'onboarding_complete' || !onboardingReply) {
           
            // Se o onboarding acabou de completar e tinha uma currentAction de onboarding, limpa ela.
            if (state.data.onboardingStage === 'onboarding_complete' && state.currentAction &&
                (state.currentAction.startsWith('awaiting_input_') || state.currentAction.startsWith('awaiting_pj_mei_') || state.currentAction.startsWith('awaiting_plan_'))) {
                state.currentAction = null;
            }
           
            // Verificação PÓS-ONBOARDING: Se o onboarding está completo mas NENHUMA conta financeira está ativa na sessão
            // Isso pode acontecer se o usuário completou o onboarding, saiu e voltou, e o estado foi recriado sem conta ativa.
            if (state.data.onboardingStage === 'onboarding_complete' && !state.activeFinancialAccountId) {
                const accountsForSelection = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                if (accountsForSelection.length > 0) {
                    if (accountsForSelection.length === 1) { // Se só tem UMA conta, seleciona automaticamente
                        const acc = accountsForSelection[0];
                        state.activeFinancialAccountId = acc.id;
                        state.activeFinancialAccountName = acc.accountName;
                        state.activeFinancialAccountType = acc.accountType;
                        const aiIntro = `Tudo pronto, ${clientNameToUse}! 🎉`;
                        const dataStructure = `Sua conta "${acc.accountName}" (${acc.accountType}) já está selecionada com seu plano ${state.accessLevelTextForUser}.`;
                        const linkText = `Como posso te ajudar a organizar suas finanças hoje? 🚀`;
                        const selectMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                        state.messageHistory.push({ role: 'assistant', content: selectMsg });
                        state.currentAction = null; // Limpa qualquer ação anterior de seleção
                        if(state.data) state.data.accountsToList = null; // Limpa lista temporária
                        await sendWhatsappMessage(senderPhone, selectMsg);
                    } else if (state.currentAction !== 'selecting_account_flow_active') { // Se tem MÚLTIPLAS contas e não está no fluxo de seleção
                        state.currentAction = 'selecting_account_flow_active'; // Inicia fluxo de seleção
                        state.data.accountsToList = accountsForSelection.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                        const accountOptionsText = formatAccountSelectionMessage(clientNameToUse, state.accessLevelTextForUser, state.data.accountsToList);
                        state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                        await sendWhatsappMessage(senderPhone, accountOptionsText);
                    } else { // Está no fluxo de seleção (currentAction === 'selecting_account_flow_active'), processa a msg atual como escolha
                        const chosenIdentifier = messageText.trim();
                        let accountToSelect = null;
                        const chosenNumber = parseInt(chosenIdentifier, 10);

                        if (state.data.accountsToList && !isNaN(chosenNumber) && chosenNumber > 0 && chosenNumber <= state.data.accountsToList.length) {
                            accountToSelect = state.data.accountsToList[chosenNumber - 1];
                        } else if (state.data.accountsToList) {
                            accountToSelect = state.data.accountsToList.find(acc =>
                                acc.name.toLowerCase() === chosenIdentifier.toLowerCase() ||
                                acc.name.toLowerCase().includes(chosenIdentifier.toLowerCase()) // Permite nomes parciais
                            );
                        }

                        if (accountToSelect) {
                            state.activeFinancialAccountId = accountToSelect.id;
                            state.activeFinancialAccountName = accountToSelect.name;
                            state.activeFinancialAccountType = accountToSelect.type;
                            const aiIntro = `Maravilha, ${clientNameToUse}!`;
                            const dataStructure = `Selecionei a conta "${state.activeFinancialAccountName}" para você.`;
                            const linkText = `Como posso te ajudar a colocar tudo em ordem agora? 🚀`;
                            const confirmSelectionMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                            state.messageHistory.push({ role: 'assistant', content: confirmSelectionMsg });
                            state.currentAction = null; // Finaliza fluxo de seleção
                            if(state.data) state.data.accountsToList = null; // Limpa lista temporária
                            await sendWhatsappMessage(senderPhone, confirmSelectionMsg);
                        } else {
                            let errorReplyIntro = `Hummm, ${clientNameToUse}, não consegui identificar essa conta. 😕`;
                            let errorReplyData = "Poderia escolher uma da lista?\n";
                            if (state.data.accountsToList) {
                                state.data.accountsToList.forEach((acc, index) => {errorReplyData += `\n${index + 1}️⃣ *${acc.name}* (${acc.type})`});
                            }
                            let errorReplyLink = "\n\nÉ só me dizer o nome ou o número. Estou aqui para ajudar! 🤔";
                            const fullErrorReply = `${errorReplyIntro}\n\n${errorReplyData}\n${errorReplyLink}`;
                            state.messageHistory.push({ role: 'assistant', content: fullErrorReply });
                            await sendWhatsappMessage(senderPhone, fullErrorReply);
                            // Mantém currentAction = 'selecting_account_flow_active' para nova tentativa
                        }
                    }
                    // Se o fluxo de seleção de conta ainda está ativo ou se nenhuma conta foi selecionada, retorna
                    conversationState.set(senderPhone, state);
                    if (state.currentAction === 'selecting_account_flow_active' || !state.activeFinancialAccountId) return;
                } else { // Onboarding completo, mas NENHUMA conta financeira existe no BD. Direciona para criar PF.
                    const aiIntro = `Olá ${clientNameToUse}! Seu plano ${state.accessLevelTextForUser} está tinindo, mas não encontrei nenhuma conta financeira.`;
                    const dataStructure = `Vamos criar sua conta Pessoal agora?`;
                    const linkText = `Diga "criar conta pessoal"! 😉`;
                    const noAccountsMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                    state.messageHistory.push({ role: 'assistant', content: noAccountsMsg });
                    state.data.onboardingStage = 'setting_up_pf_account_name'; // Volta para o estágio de criar conta PF
                    state.currentAction = 'awaiting_input_pf_name';
                    await sendWhatsappMessage(senderPhone, noAccountsMsg);
                    conversationState.set(senderPhone, state);
                    return;
                }
            }


            // ---- PROCESSAMENTO COM IA (continuação) ----
            // Se foi um clique de botão, trata a lógica específica do botão
            if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
                const buttonId = rawPayload.selectedButtonId;
                // messageText aqui é o label do botão
                logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ID '${buttonId}', Texto (label): '${messageText}'`);
                let buttonClickHandledByServiceLogic = true; // Flag para indicar se o clique foi tratado aqui ou deve ir para IA
                let aiMessageIntroForButton = "";
                let structuredDataBodyForButton = "";
                let platformLinkFooterForButton = formatPlatformLink();

                let resourceTypeForEditMessage = "item"; // Default
   
                if (buttonId.startsWith('edit_transaction_')) {
                    const transactionId = buttonId.replace('edit_transaction_', '');
                    state.editingResource = { type: 'transaction', id: transactionId };
                    resourceTypeForEditMessage = "transação";
                    aiMessageIntroForButton = `Claro, ${clientNameToUse}! 😉`;
                    structuredDataBodyForButton = `Descreva na próxima mensagem o que você precisa que eu altere na ${resourceTypeForEditMessage} (ID: ${transactionId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                    platformLinkFooterForButton = ""; // Não adiciona link, pois espera input
                    state.currentAction = 'awaiting_transaction_edit_details';
                } else if (buttonId.startsWith('delete_transaction_')) {
                    const transactionId = buttonId.replace('delete_transaction_', '');
                    try {
                        await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId);
                        aiMessageIntroForButton = `Transação removida com sucesso, ${clientNameToUse}! 👍`;
                        structuredDataBodyForButton = "Se precisar de mais alguma coisa, é só chamar.";
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a transação.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                } else if (buttonId.startsWith('edit_appointment_')) {
                    const appointmentId = buttonId.replace('edit_appointment_', '');
                    state.editingResource = { type: 'appointment', id: appointmentId };
                    resourceTypeForEditMessage = "compromisso";
                    aiMessageIntroForButton = `Beleza, ${clientNameToUse}! ✨`;
                    structuredDataBodyForButton = `Me diga na próxima mensagem o que você quer mudar no ${resourceTypeForEditMessage} (ID: ${appointmentId}).`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_appointment_edit_details';
                } else if (buttonId.startsWith('delete_appointment_')) {
                    const appointmentId = buttonId.replace('delete_appointment_', '');
                    try {
                        await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, true); // true para deletar
                        aiMessageIntroForButton = `Compromisso removido da sua agenda, ${clientNameToUse}! ✅`;
                        structuredDataBodyForButton = "Fico à disposição se precisar de algo mais.";
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir compromisso ${appointmentId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir o compromisso.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                // Adicione aqui outros handlers de botões (crédito, recorrência, etc.) seguindo o padrão acima
                else if (buttonId.startsWith('edit_credit_card_')) {
                    const cardId = buttonId.replace('edit_credit_card_', '');
                    state.editingResource = { type: 'credit_card', id: cardId };
                    resourceTypeForEditMessage = "cartão de crédito";
                    aiMessageIntroForButton = `Entendido, ${clientNameToUse}! 💳`;
                    structuredDataBodyForButton = `O que você gostaria de alterar no ${resourceTypeForEditMessage} (ID: ${cardId})? Pode me dizer, por exemplo: "mudar o limite para 3000" ou "atualizar o dia de fechamento para 25".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_credit_card_edit_details';
                } else if (buttonId.startsWith('delete_credit_card_')) {
                    const cardId = buttonId.replace('delete_credit_card_', '');
                    try {
                        await creditCardService.deleteCreditCard(state.activeFinancialAccountId, cardId);
                        aiMessageIntroForButton = `Cartão de crédito removido com sucesso, ${clientNameToUse}! 🗑️`;
                        structuredDataBodyForButton = "";
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir cartão ${cardId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir o cartão.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.includes("transações") ? "Ele ainda tem transações associadas." : `(${e.message.substring(0,70)})` }`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                } else if (buttonId.startsWith('edit_recurring_rule_')) {
                    const ruleId = buttonId.replace('edit_recurring_rule_', '');
                    state.editingResource = { type: 'recurring_rule', id: ruleId };
                    resourceTypeForEditMessage = "regra de recorrência";
                    aiMessageIntroForButton = `Certo, ${clientNameToUse}! 🔄`;
                    structuredDataBodyForButton = `O que vamos ajustar na ${resourceTypeForEditMessage} (ID: ${ruleId})? Por exemplo: "mudar o valor para 60" ou "alterar a frequência para mensal".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_recurring_rule_edit_details';
                } else if (buttonId.startsWith('delete_recurring_rule_')) {
                    const ruleId = buttonId.replace('delete_recurring_rule_', '');
                    try {
                        await recurringTransactionService.deleteRecurringRule(state.activeFinancialAccountId, ruleId);
                        aiMessageIntroForButton = `Regra de recorrência removida, ${clientNameToUse}! 👍`;
                        structuredDataBodyForButton = "";
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir regra ${ruleId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a regra.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                else if (buttonId.startsWith('edit_parcelled_account_')) {
                    const originalAccountId = buttonId.replace('edit_parcelled_account_', '');
                    // Busca a transação original para pegar a descrição e outros dados
                    const parcelGroupInfo = await financialService.getTransactionById(state.activeFinancialAccountId, originalAccountId);
                    let originalDescriptionForEdit = "sua compra parcelada";
                    if (parcelGroupInfo && parcelGroupInfo.isParcel && parcelGroupInfo.originalAccountId === parcelGroupInfo.id) { // É a transação "mãe" do grupo
                        originalDescriptionForEdit = parcelGroupInfo.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                    } else if (parcelGroupInfo) { // É uma parcela individual, mas usamos a descrição dela como base
                        originalDescriptionForEdit = parcelGroupInfo.description;
                    }
       
                    state.editingResource = {
                        type: 'parcelled_account',
                        id: originalAccountId, // ID da transação original (mãe do grupo)
                        originalDescription: originalDescriptionForEdit // Descrição original para exibir ao usuário
                        // Poderia adicionar aqui os dados originais (valor, parcelas, cartão) para a IA ter mais contexto, se necessário
                    };
                    aiMessageIntroForButton = `Ok, ${clientNameToUse}! Você quer editar a compra parcelada de "${originalDescriptionForEdit}".`;
                    structuredDataBodyForButton = `O que gostaria de alterar? Você pode me dizer os novos detalhes, como por exemplo: "mudar para R$250 em 5x no cartão XP com nova descrição 'Presente Dia das Mães'".\n\nLembre-se que alterar valor, número de parcelas ou o cartão irá refazer essa compra com os novos dados. Se quiser mudar apenas a descrição, diga "mudar descrição para [nova descrição]".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                } else if (buttonId.startsWith('delete_parcelled_account_')) {
                    const originalAccountId = buttonId.replace('delete_parcelled_account_', '');
                    try {
                        const success = await financialService.deleteParcelledAccountGroup(state.activeFinancialAccountId, originalAccountId);
                        aiMessageIntroForButton = success ? `Compra parcelada e todas as suas parcelas foram removidas, ${clientNameToUse}! 👍` : `Não consegui remover essa compra parcelada. Pode ter ocorrido um erro.`;
                        structuredDataBodyForButton = "";
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir grupo de parcelas ${originalAccountId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar remover essa compra parcelada.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                // ... outros botões
                else {
                    buttonClickHandledByServiceLogic = false; // Botão não reconhecido, deixa a IA processar o texto do botão
                }
       
                if (buttonClickHandledByServiceLogic) {
                    const finalMsg = `${aiMessageIntroForButton}${structuredDataBodyForButton ? `\n\n${structuredDataBodyForButton}` : ''}${platformLinkFooterForButton ? `\n\n${platformLinkFooterForButton}` : ''}`.trim();
                    state.messageHistory.push({ role: 'assistant', content: finalMsg });
                    await sendWhatsappMessage(senderPhone, finalMsg);
                    conversationState.set(senderPhone, state);
                    return; // Interrompe o fluxo aqui, pois o clique do botão foi tratado
                }
            }
       
            // Se currentAction está definido (ex: aguardando confirmação, detalhes de edição) e não é um clique de botão novo
            // Isso permite que a IA processe a resposta do usuário a uma pergunta anterior do sistema.
            if (state.currentAction && state.data.onboardingStage === 'onboarding_complete') { // Garante que não é onboarding
                let stateHandledInPreProcessing = false; // Flag para indicar se a ação foi tratada aqui
                let preProcAiIntro = "";
                let preProcDataStructure = "";
                let preProcPlatformLink = formatPlatformLink();
       
                if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                     const lowerMsgForConfirm = messageText.toLowerCase().trim(); // a msg do usuário
                     if (lowerMsgForConfirm === 'sim' || lowerMsgForConfirm === 's' || lowerMsgForConfirm.includes('correto') || lowerMsgForConfirm.includes('ok') || lowerMsgForConfirm.includes('pode')) {
                        // Lógica para executar a ação pendente
                        // Exemplo para RECREATE_PARCELLED_ACCOUNT (se fosse o caso de confirmação)
                        if (state.pendingConfirmation.action === 'RECREATE_PARCELLED_ACCOUNT' && state.pendingConfirmation.parameters) {
                            try {
                                const { financialAccountId, originalAccountIdToDelete, newParcelData } = state.pendingConfirmation.parameters;
                                const recreatedResult = await financialService.recreateParcelledAccount(financialAccountId, originalAccountIdToDelete, newParcelData);
                               
                                preProcAiIntro = state.lastAiResponse?.overall_summary_suggestion || `🎉 Sensacional, ${clientNameToUse}! Sua compra parcelada foi atualizada!`;
                                preProcDataStructure = formatParcelledAccountDataStructure(newParcelData, recreatedResult); // Usa os parâmetros originais para formatação
                                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                                stateHandledInPreProcessing = true;
                            } catch(e) {
                                logger.error(`[WHATSAPP SERVICE] Erro ao recriar compra parcelada após confirmação: ${e.message}`);
                                preProcAiIntro = `Puxa, ${clientNameToUse}, algo deu errado ao tentar atualizar sua compra parcelada. 😥`;
                                preProcDataStructure = `Detalhe: ${e.message.substring(0,70)}.\nA compra original não foi alterada. Quer tentar de novo os detalhes ou cancelar?`;
                                preProcPlatformLink = "";
                                state.currentAction = 'awaiting_confirmation'; // Permanece esperando se erro
                                stateHandledInPreProcessing = true;
                            }
                        } else {
                            // Para outras confirmações genéricas (se houver)
                            preProcAiIntro = `Entendido, ${clientNameToUse}! Confirmado! 👍`;
                            preProcDataStructure = "Vou prosseguir com base nisso. O que mais posso fazer?";
                            preProcPlatformLink = "";
                            state.currentAction = null; state.pendingConfirmation = null; // Limpa após confirmação
                            stateHandledInPreProcessing = true;
                        }
                    } else if (lowerMsgForConfirm === 'não' || lowerMsgForConfirm === 'n' || lowerMsgForConfirm.includes('incorreto') || lowerMsgForConfirm.includes('cancela')) {
                        preProcAiIntro = `Ok, ${clientNameToUse}, cancelado! Sem problemas.`;
                        preProcDataStructure = "O que gostaria de fazer então? 😊";
                        preProcPlatformLink = "";
                        state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                        stateHandledInPreProcessing = true;
                    }
                    // Se não for sim/não claro, deixa a IA reinterpretar a mensagem do usuário
                }
                // Adicionar aqui lógicas para outros currentAction que não dependem da IA para a próxima resposta direta
                // Ex: se state.currentAction for 'awaiting_explicit_account_type_from_ai' (usado em CREATE_FINANCIAL_ACCOUNT)
                else if (state.currentAction === 'awaiting_explicit_account_type_from_ai') { // Usado por CREATE_FINANCIAL_ACCOUNT via IA
                    const typeInput = messageText.trim().toUpperCase();
                    if (typeInput === 'PF' || typeInput === 'PJ' || typeInput === 'MEI') {
                        state.data.accountTypeToCreate = typeInput; // Guarda o tipo
                        const formattedMsg = getOnboardingAskForCompanyNameMessage(clientNameToUse, typeInput); // Reusa msg de onboarding
                        preProcAiIntro = formattedMsg.split('\n\n')[0];
                        preProcDataStructure = formattedMsg.split('\n\n')[1];
                        preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
                        state.currentAction = 'awaiting_explicit_account_name_from_ai'; // Próximo passo
                    } else {
                        // Pede o tipo novamente
                        const formattedMsg = getOnboardingAskForPJTypeMessage(clientNameToUse); // Reusa msg de onboarding
                        preProcAiIntro = formattedMsg.split('\n\n')[0];
                        preProcDataStructure = formattedMsg.split('\n\n')[1];
                        preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
                        // Mantém currentAction = 'awaiting_explicit_account_type_from_ai'
                    }
                    stateHandledInPreProcessing = true;
                } else if (state.currentAction === 'awaiting_explicit_account_name_from_ai') {
                    const newAccName = messageText.trim();
                    const typeToCreate = state.data.accountTypeToCreate; // Pega tipo guardado
                    if (newAccName.length >= 3 && newAccName.length <= 50) {
                        try {
                            // Verifica se já existe PJ/MEI ou se o plano permite
                            const currentClientAccountsForCreate = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                            const existingPjMei = currentClientAccountsForCreate.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                            if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && existingPjMei) {
                                preProcAiIntro = `Opa, ${clientNameToUse}! Você já tem uma conta empresarial (${existingPjMei.accountType}) chamada "${existingPjMei.accountName}".`;
                                preProcDataStructure = "Só podemos ter uma conta PJ ou MEI por vez. 😉";
                                preProcPlatformLink = "";
                            } else if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado')) {
                                preProcAiIntro = `Ah, ${clientNameToUse}! Para criar uma conta empresarial (${typeToCreate}), você precisa de um dos nossos Planos Avançados. 🚀`;
                                preProcDataStructure = `Confira em ${process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"} e depois me avise! 😉`;
                                preProcPlatformLink = "";
                                state.data.onboardingStage = 'awaiting_plan_confirmation'; // Volta para o fluxo de plano
                            } else {
                                const newFA = await clientService.createFinancialAccount(client.id, { accountName: newAccName, accountType: typeToCreate });
                                const formattedMsg = getOnboardingCompanyCreatedMessage(clientNameToUse, newFA.accountType, newFA.accountName, state.activeFinancialAccountName || "Pessoal");
                                preProcAiIntro = formattedMsg.split('\n\n')[0];
                                preProcDataStructure = formattedMsg.split('\n\n')[1];
                                preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
                                // Define a nova conta como ativa
                                state.activeFinancialAccountId = newFA.id;
                                state.activeFinancialAccountName = newFA.accountName;
                                state.activeFinancialAccountType = newFA.accountType;
                            }
                        } catch(e) {
                            preProcAiIntro = `Ops, não consegui criar a conta "${newAccName}" (${typeToCreate}).`;
                            preProcDataStructure = `Detalhe: ${e.message.substring(0,70)}.\nTente um nome diferente.`;
                            preProcPlatformLink = "";
                        }
                    } else {
                         preProcAiIntro = `Esse nome parece um pouco curto ou longo demais, ${clientNameToUse}.`;
                         preProcDataStructure = `Para sua conta ${typeToCreate}, que tal um nome entre 3 e 50 letras? ✍️`;
                         preProcPlatformLink = "";
                         // Mantém currentAction para tentar nome de novo
                    }
                    // Se não deu erro de validação de nome, limpa a ação e o tipo guardado
                    if (newAccName.length >= 3 && newAccName.length <= 50) {
                        state.currentAction = null; delete state.data.accountTypeToCreate;
                    }
                    stateHandledInPreProcessing = true;
                }
       
       
                if (stateHandledInPreProcessing) {
                    const finalMsg = `${preProcAiIntro}${preProcDataStructure ? `\n\n${preProcDataStructure}` : ''}${preProcPlatformLink ? `\n\n${preProcPlatformLink}` : ''}`.trim();
                    state.messageHistory.push({ role: 'assistant', content: finalMsg });
                    await sendWhatsappMessage(senderPhone, finalMsg);
                    conversationState.set(senderPhone, state);
                    // Se a ação foi resolvida e não há mais pendências, retorna
                    if (state.currentAction === null && !state.pendingConfirmation &&
                        !(state.currentAction?.startsWith('awaiting_explicit_'))) { // Não retorna se ainda está em um fluxo de pedir nome/tipo
                            return;
                    }
                }
            }
       
            logger.info(`[WHATSAPP HANDLER - PÓS-ONBOARDING] Cliente: ${client.id} (${clientNameToUse}), Plano: ${state.currentAccessLevel}, Conta Ativa: ${state.activeFinancialAccountName || 'N/A'} (ID: ${state.activeFinancialAccountId || 'N/A'}), Msg: "${messageText}"`);
            // Segurança: se por algum motivo chegou aqui com onboarding completo, acesso pago, mas sem conta ativa, força seleção/criação.
            if(!state.activeFinancialAccountId && state.hasPaidAccess && state.data.onboardingStage === 'onboarding_complete') {
                 logger.error(`[WHATSAPP HANDLER CRITICAL - PÓS-ONBOARDING] Cliente ${client.id} tem acesso pago e onboarding completo, mas NENHUMA conta financeira ativa no estado ANTES DE CHAMAR A IA.`);
                 // Tenta resolver como no início do bloco "if (state.data.onboardingStage === 'onboarding_complete' || !onboardingReply)"
                 let noActiveAccountForAIMsg = "";
                 const clientAccountsForAI = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                 if (clientAccountsForAI.length > 0) {
                     noActiveAccountForAIMsg = formatAccountSelectionMessage(clientNameToUse, state.accessLevelTextForUser, clientAccountsForAI.map(a => ({id: a.id, name: a.accountName, type: a.accountType})));
                     state.currentAction = 'selecting_account_flow_active'; // Força seleção
                     state.data.accountsToList = clientAccountsForAI.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                 } else {
                     // Se não tem contas mesmo, direciona para criar PF
                     const aiIntro = `Olá ${clientNameToUse}! Seu plano ${state.accessLevelTextForUser} está tinindo, mas não encontrei nenhuma conta financeira.`;
                     const dataStructure = `Vamos criar sua conta Pessoal agora?`;
                     const linkText = `Diga "criar conta pessoal"! 😉`;
                     noActiveAccountForAIMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                     state.data.onboardingStage = 'setting_up_pf_account_name';
                     state.currentAction = 'awaiting_input_pf_name';
                 }
                 state.messageHistory.push({ role: 'assistant', content: noActiveAccountForAIMsg });
                 await sendWhatsappMessage(senderPhone, noActiveAccountForAIMsg);
                 conversationState.set(senderPhone, state);
                 return; // Importante retornar para não chamar a IA sem conta.
            }
       
       
            const aiContext = {
                currentFinancialAccountId: state.activeFinancialAccountId,
                currentFinancialAccountType: state.activeFinancialAccountType,
                currentFinancialAccountName: state.activeFinancialAccountName,
                clientName: clientNameToUse,
                conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2), // Histórico para IA
                currentStateData: state.data, // Dados como clarificationContext, etc.
                editingResource: state.editingResource,
                currentAccessLevel: state.currentAccessLevel, // Para IA saber o nível do plano
                hasPaidAccess: state.hasPaidAccess, // Para IA saber se tem acesso válido
            };
            const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
            logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponsePreview: JSON.stringify(aiResponse).substring(0,500) + "..."});
            state.lastAiResponse = aiResponse; // Guarda a última resposta da IA completa
       
            // Se currentAction era de um fluxo de espera (ex: edição, clarificação) e a IA não pediu mais clarificações,
            // limpa currentAction para não ficar preso.
            if(state.currentAction && typeof state.currentAction === 'string' &&
               (state.currentAction.startsWith('awaiting_')) &&
               state.data.onboardingStage === 'onboarding_complete' && // Garante que não é onboarding
               (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0) ) {
                    // Não limpa se for um fluxo de edição ou escolha que precisa de mais input,
                    // ou se a IA confirmou uma ação pendente
                    if (!state.currentAction.includes('_edit_') && !state.currentAction.includes('_choice') && state.currentAction !== 'awaiting_confirmation' && !state.currentAction.startsWith('awaiting_explicit_')) {
                        state.currentAction = null;
                    }
            }
           
            let aiMessageIntro = aiResponse.overall_summary_suggestion ||
                                (aiResponse.reply_to_user_suggestion && (!aiResponse.detected_actions || aiResponse.detected_actions.length === 0 || aiResponse.detected_actions.every(a => (a.action || a.action_type)?.startsWith("GENERAL_")))
                                    ? aiResponse.reply_to_user_suggestion
                                    : `Ok, ${clientNameToUse}!`);
            if (typeof aiMessageIntro !== 'string' || aiMessageIntro.trim() === "") {
                aiMessageIntro = `Ok, ${clientNameToUse}!`; // Fallback absoluto
            }

            let structuredDataBody = "";
            let platformLinkFooter = formatPlatformLink();
            let finalMessageToSend = "";
       
            state.pendingConfirmation = null; // Limpa confirmação pendente antes de processar novas ações
            actionWasAnEdit = false; // Flag para saber se a ação foi uma edição bem-sucedida
            resourceForButtonsContext = null; // Para decidir se mostra botões de editar/excluir
            let multipleActionBodiesList = []; // Para acumular corpos de múltiplas ações

            if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
                for (const detectedAction of aiResponse.detected_actions) {
                    // *** ALTERAÇÃO PRINCIPAL AQUI ***
                    // Se detectedAction.parameters existir, usa ele. Senão, usa o próprio detectedAction.
                    const params = detectedAction.parameters || detectedAction;
                    // *******************************

                    const actionName = detectedAction.action || detectedAction.action_type; // Nome da ação
                    if (!actionName) { // Pula se a ação não tiver nome (improvável, mas seguro)
                        logger.warn('[WHATSAPP HANDLER] Ação detectada pela IA sem nome (action/action_type). Pulando.', { detectedAction });
                        continue;
                    }
                    // Verifica se a ação é permitida pelo plano/contexto
                    let currentActionBlocked = false; // Flag para bloquear a execução desta ação específica
                    let currentActionFormattedData = ""; // Dados formatados para esta ação (ou msg de bloqueio)

                    // 1. Verifica acesso pago para ações não públicas
                    const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SWITCH_FINANCIAL_ACCOUNT', 'CREATE_FINANCIAL_ACCOUNT', 'SET_MOTIVATIONAL_MESSAGE_PREFERENCE', 'SET_WATER_REMINDER_PREFERENCE'];
                    if (!state.hasPaidAccess && !publicActions.includes(actionName)) {
                        const noPlanIntro = getOnboardingWelcomeNoPlanMessage(clientNameToUse).split('\n\n')[0]; // Pega só a intro da msg de plano
                        const noPlanData = getOnboardingWelcomeNoPlanMessage(clientNameToUse).split('\n\n').slice(1).join('\n\n'); // Pega o resto
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(noPlanIntro)) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = noPlanIntro;
                        currentActionFormattedData = noPlanData;
                        platformLinkFooter = ""; // Não mostra link da plataforma, mostra link dos planos
                        state.data.onboardingStage = 'awaiting_plan_confirmation'; // Reverte para o estágio de plano
                        currentActionBlocked = true;
                    }
                    // 2. Verifica se a conta financeira está ativa para ações que a requerem
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
                    if (accountRequiredActions.includes(actionName) && !state.activeFinancialAccountId && !currentActionBlocked) {
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Opa, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Opa, ${clientNameToUse}! Para eu poder "${actionName.toLowerCase().replace(/_/g, " ")}", preciso que você selecione uma conta financeira primeiro.`;
                        currentActionFormattedData = `Se você já configurou alguma, me diga o nome dela. Se não, diga "criar conta pessoal"! 😊`;
                        platformLinkFooter = ""; state.currentAction = 'selecting_account_flow_active'; currentActionBlocked = true;
                    }
                    // 3. Verifica se a conta é PJ/MEI para ações específicas e se o plano permite
                    const pjMeiActions = ['CREATE_PRODUCT', 'GET_STOCK_INFO', 'RECORD_STOCK_MOVEMENT', 'UPDATE_PRODUCT'];
                     if (pjMeiActions.includes(actionName) && state.activeFinancialAccountType && !['PJ', 'MEI'].includes(state.activeFinancialAccountType)  && !currentActionBlocked) {
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Desculpe, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Desculpe, ${clientNameToUse}, mas "${actionName.toLowerCase().replace(/_/g, " ")}" é apenas para contas PJ ou MEI.`;
                        currentActionFormattedData = `Sua conta "${state.activeFinancialAccountName}" é do tipo ${state.activeFinancialAccountType}. Você pode criar uma conta empresarial ou mudar para ela! 😉`;
                        platformLinkFooter = ""; currentActionBlocked = true;
                    } else if (pjMeiActions.includes(actionName) && state.activeFinancialAccountType && ['PJ', 'MEI'].includes(state.activeFinancialAccountType) && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado') && !currentActionBlocked) {
                        const siteUrlPjMei = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                         if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Ah, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Ah, ${clientNameToUse}! Para usar as funcionalidades de ${state.activeFinancialAccountType === 'PJ' ? 'Empresa (PJ)' : 'MEI'}, como "${actionName.toLowerCase().replace(/_/g, " ")}", você precisa de um dos nossos Planos Avançados. 🚀`;
                        currentActionFormattedData = `Eles são perfeitos para quem quer ir além! Confira em ${siteUrlPjMei} e depois me avise para continuarmos! 😉`;
                        platformLinkFooter = ""; state.data.onboardingStage = 'awaiting_plan_confirmation'; currentActionBlocked = true;
                    }
       
       
                    if (currentActionBlocked) {
                        if (currentActionFormattedData) multipleActionBodiesList.push(currentActionFormattedData);
                        continue; // Pula para a próxima ação detectada, se houver
                    }

                    // Executa a ação
                    try {
                        switch (actionName) {
                            case 'CREATE_FINANCIAL_TRANSACTION': {
                                const categoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                                const cardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                                const txData = {
                                    description: params.description, type: params.type, value: parseFloat(params.value),
                                    transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                    financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes,
                                    // Define isPayableOrReceivable e isPaidOrReceived com base nos inputs ou defaults lógicos
                                    isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : (cardId ? false : false)), // Se tem dueDate é a pagar/receber; Se é cartão à vista, não é a pagar/receber.
                                    dueDate: cardId ? null : params.dueDate, // Cartão à vista não tem dueDate aqui (vai pra fatura)
                                    isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (cardId ? true : (!params.dueDate)) // Cartão à vista é 'pago' na origem; Sem vencimento é 'pago/recebido'
                                };
                                if (!txData.description || !txData.type || isNaN(txData.value) || txData.value <= 0) {
                                    throw new Error("Dados insuficientes ou inválidos para criar transação (descrição, tipo, valor).");
                                }
                                const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                                const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id); // Recarrega para ter dados completos (categoria, cartão)
                               
                                // Define a mensagem de introdução da IA
                                if (aiResponse.detected_actions.length === 1) { // Ação única
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Sua transação foi registrada, ${clientNameToUse}!`;
                                } else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) { // Primeira de múltiplas ações
                                     aiMessageIntro = `Registrei o seguinte para você, ${clientNameToUse}:`; // Intro genérica para múltiplas ações
                                }
                                // Senão (é uma ação subsequente de múltiplas), mantém o aiMessageIntro da primeira ação (overall_summary)

                                currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedTx);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'transaction', id: newTx.id, description: newTx.description };
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
                                if (params.financialCategoryName) updateDataTx.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || (await financialService.getTransactionById(state.activeFinancialAccountId, transactionIdToUpdate)).type);
                                if (params.creditCardName) updateDataTx.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                else if (params.hasOwnProperty('creditCardName') && params.creditCardName === null) updateDataTx.creditCardId = null; // Remover cartão

                                if (Object.keys(updateDataTx).length === 0) throw new Error("Nenhum dado fornecido para atualizar a transação.");

                                const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateDataTx);
                                const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Transação atualizada com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da transação, ${clientNameToUse}:`;
                                currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedUpdatedTx);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'SCHEDULE_APPOINTMENT': {
                                const eventDateTime = params.eventDateTime; // "YYYY-MM-DD HH:MM"
                                if (!params.title || !eventDateTime) throw new Error("Título e data/hora são obrigatórios para agendar.");

                                const appointmentData = {
                                    title: params.title,
                                    eventDateTime: eventDateTime,
                                    durationMinutes: params.durationMinutes ? parseInt(params.durationMinutes) : null,
                                    location: params.location,
                                    reminderLeadTimeMinutes: params.reminderLeadTimeMinutes ? parseInt(params.reminderLeadTimeMinutes) : 15,
                                    notes: params.notes,
                                    associatedValue: params.associatedValue ? parseFloat(params.associatedValue) : null,
                                    associatedTransactionType: params.associatedTransactionType // "Entrada" ou "Saída"
                                };
                                const newAppt = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appointmentData);
                                const reloadedAppt = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newAppt.id);

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Seu compromisso foi agendado, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Agendei o seguinte para você, ${clientNameToUse}:`;
                                currentActionFormattedData = formatAppointmentDataStructure(reloadedAppt);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'appointment', id: newAppt.id, description: newAppt.title };
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

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Compromisso atualizado, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do compromisso, ${clientNameToUse}:`;
                                currentActionFormattedData = formatAppointmentDataStructure(reloadedUpdatedAppt);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'CREATE_PARCELLED_ACCOUNT': {
                                const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                                const cardIdParcel = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;

                                if (params.creditCardName && !cardIdParcel) { // Se especificou nome do cartão mas não foi encontrado
                                    const errorMsg = `Hum, ${clientNameToUse}, não encontrei um cartão chamado "${params.creditCardName}" para registrar essa compra parcelada. 😕 Você pode cadastrar o cartão primeiro ou tentar com outro nome.`;
                                    if (aiResponse.detected_actions.length === 1) { aiMessageIntro = errorMsg; currentActionFormattedData = ""; platformLinkFooter = ""; }
                                    else { multipleActionBodiesList.push(errorMsg); } // Se for parte de múltiplas ações
                                    break; // Interrompe esta ação específica
                                }

                                const parcelData = {
                                    description: params.description,
                                    type: params.type,
                                    totalValue: parseFloat(params.totalValue || params.value), // IA pode usar 'value' ou 'totalValue'
                                    numberOfParcels: parseInt(params.numberOfParcels),
                                    initialDueDate: params.initialDueDate, // Data da primeira parcela (ou data da compra se não especificado)
                                    financialCategoryId: catIdParcel,
                                    creditCardId: cardIdParcel,
                                    notes: params.notes,
                                    transactionDate: params.transactionDate || params.initialDueDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0] // Data da compra
                                };
                                 // Validação crucial
                                 if (!parcelData.description || !parcelData.type || isNaN(parcelData.totalValue) || parcelData.totalValue <=0 || isNaN(parcelData.numberOfParcels) || parcelData.numberOfParcels < 1 || !parcelData.initialDueDate) {
                                     throw new Error("Dados insuficientes ou inválidos para compra parcelada (descrição, tipo, valor total, nº parcelas, data 1ª parcela).");
                                 }
                                 // Se transactionDate não foi explicitamente dada pela IA e initialDueDate foi, usa initialDueDate como data da compra.
                                 if (!params.transactionDate && params.initialDueDate) {
                                     parcelData.transactionDate = params.initialDueDate;
                                 }


                                const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData);

                                if (aiResponse.detected_actions.length === 1) { aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Sua compra parcelada foi registrada, ${clientNameToUse}!`;}
                                else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sua compra parcelada foi registrada, ${clientNameToUse}:`;

                                currentActionFormattedData = formatParcelledAccountDataStructure(parcelData, parcelResult); // Passa parcelData (IA) e parcelResult (BD)

                                if (aiResponse.detected_actions.length === 1 && parcelResult.parcels && parcelResult.parcels.length > 0) {
                                    const originalTxId = parcelResult.parcels[0].originalAccountId || parcelResult.parcels[0].id;
                                    resourceForButtonsContext = { type: 'parcelled_account', id: originalTxId, description: parcelData.description };
                                }
                                break;
                            }
                            case 'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION': {
                                const accountIdToUpdateDesc = state.editingResource?.type === 'parcelled_account' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.originalAccountIdToUpdate ? parseInt(params.originalAccountIdToUpdate, 10) : null);
                                if (!accountIdToUpdateDesc || !params.newDescription) throw new Error("ID da compra parcelada e nova descrição são obrigatórios.");

                                await financialService.updateParcelledAccountDescription(state.activeFinancialAccountId, accountIdToUpdateDesc, params.newDescription);

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Descrição da compra parcelada atualizada para "${params.newDescription}", ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da compra parcelada, ${clientNameToUse}:`;
                                currentActionFormattedData = `📝 Descrição atualizada para: ${params.newDescription}`;
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'RECREATE_PARCELLED_ACCOUNT': {
                                const originalAccountIdToUpdate = state.editingResource?.type === 'parcelled_account' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.originalAccountIdToUpdate ? parseInt(params.originalAccountIdToUpdate, 10) : null);
                                if (!originalAccountIdToUpdate) throw new Error("ID da compra parcelada original é obrigatório para recriar.");

                                const newCatIdParcel = await findFinancialCategoryIdByName(params.newFinancialCategoryName, state.activeFinancialAccountId, params.newType);
                                const newCardIdParcel = params.newCreditCardName ? await findCreditCardIdByName(params.newCreditCardName, state.activeFinancialAccountId) : null;

                                if (params.newCreditCardName && !newCardIdParcel) {
                                    const errorMsgRec = `Hum, ${clientNameToUse}, não encontrei um cartão chamado "${params.newCreditCardName}" para registrar essa nova compra parcelada. 😕`;
                                    if (aiResponse.detected_actions.length === 1) { aiMessageIntro = errorMsgRec; currentActionFormattedData = "A compra original não foi alterada. Você pode cadastrar o cartão ou tentar com outro nome."; platformLinkFooter = ""; }
                                    else { multipleActionBodiesList.push(errorMsgRec); }
                                    break;
                                }
                                const newParcelData = {
                                    description: params.newDescription, type: params.newType || 'Saída', totalValue: parseFloat(params.newTotalValue),
                                    numberOfParcels: parseInt(params.newNumberOfParcels), initialDueDate: params.newInitialDueDate,
                                    financialCategoryId: newCatIdParcel, creditCardId: newCardIdParcel, notes: params.newNotes,
                                    transactionDate: params.newTransactionDate || params.newInitialDueDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0]
                                };
                                if (!newParcelData.description || isNaN(newParcelData.totalValue) || newParcelData.totalValue <= 0 || isNaN(newParcelData.numberOfParcels) || newParcelData.numberOfParcels < 1 || !newParcelData.initialDueDate) {
                                     throw new Error("Para recriar a compra parcelada, preciso de: nova descrição, novo valor total, novo nº de parcelas e nova data da 1ª parcela.");
                                 }
                                 if (!params.newTransactionDate && params.newInitialDueDate) {
                                     newParcelData.transactionDate = params.newInitialDueDate;
                                 }

                                const recreatedResult = await financialService.recreateParcelledAccount(state.activeFinancialAccountId, originalAccountIdToUpdate, newParcelData);

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Compra parcelada atualizada com sucesso, ${clientNameToUse}! A antiga foi removida.`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a atualização da compra parcelada, ${clientNameToUse}:`;
                                currentActionFormattedData = formatParcelledAccountDataStructure(newParcelData, recreatedResult);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                                if (!params.transactionDescription) throw new Error("Descrição da transação é obrigatória para marcar como paga/recebida.");
                                const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
                                const categoryIdForMark = params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId) : null; // Tipo não é crucial aqui para buscar categoria de pagamento

                                const result = await financialService.markTransactionAsPaidOrReceived(
                                    state.activeFinancialAccountId,
                                    params.transactionDescription,
                                    params.transactionValue ? parseFloat(params.transactionValue) : null,
                                    paymentDate,
                                    categoryIdForMark
                                );
                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Ótimo, ${clientNameToUse}! Transação marcada como liquidada.`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a liquidação da transação, ${clientNameToUse}:`;
                                currentActionFormattedData = `Transação "${result.description}" (${formatCurrency(result.value)}) foi marcada como ${result.type === 'Entrada' ? 'recebida' : 'paga'} em ${formatDate(result.paymentDate)}.`;
                                break;
                            }
                            case 'CREATE_RECURRING_RULE': {
                                const categoryIdRule = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                                const ruleData = {
                                    description: params.description, type: params.type, value: parseFloat(params.value),
                                    frequency: params.frequency, startDate: params.startDate,
                                    interval: params.interval ? parseInt(params.interval) : 1,
                                    dayOfMonth: params.dayOfMonth ? parseInt(params.dayOfMonth) : null,
                                    dayOfWeek: params.dayOfWeek !== undefined && params.dayOfWeek !== null ? parseInt(params.dayOfWeek) : null,
                                    endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction !== undefined ? params.autoCreateTransaction : false,
                                    financialCategoryId: categoryIdRule, notes: params.notes
                                };
                                if (!ruleData.description || !ruleData.type || isNaN(ruleData.value) || ruleData.value <=0 || !ruleData.frequency || !ruleData.startDate) {
                                    throw new Error("Dados insuficientes para criar regra recorrente (desc, tipo, valor, frequência, data início).");
                                }
                                const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                                const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Sua regra de recorrência foi criada, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Criei a seguinte regra de recorrência para você, ${clientNameToUse}:`;
                                currentActionFormattedData = formatRecurringRuleDataStructure(reloadedRule);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'recurring_rule', id: newRule.id, description: newRule.description };
                                break;
                            }
                            case 'CREATE_PRODUCT': {
                                // Validação de tipo de conta e plano já feita antes do switch
                                const productData = {
                                    name: params.name, salePrice: parseFloat(params.salePrice), code: params.code,
                                    costPrice: params.costPrice ? parseFloat(params.costPrice) : null,
                                    initialQuantity: params.initialQuantity ? parseInt(params.initialQuantity) : 0,
                                    minimumStock: params.minimumStock ? parseInt(params.minimumStock) : 0,
                                    unit: params.unit || 'UN'
                                };
                                if (!productData.name || isNaN(productData.salePrice) || productData.salePrice <= 0) {
                                     throw new Error("Nome e preço de venda são obrigatórios para o produto.");
                                 }
                                const newProduct = await productService.createProduct(state.activeFinancialAccountId, productData);
                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Produto "${newProduct.name}" cadastrado com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Cadastrei o produto, ${clientNameToUse}:`;
                                currentActionFormattedData = formatProductDataStructure(newProduct);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'product', id: newProduct.id, description: newProduct.name };
                                break;
                            }
                            case 'GET_STOCK_INFO': {
                                if(!params.productNameOrCode) throw new Error("Nome ou código do produto é obrigatório para ver o estoque.");
                                const stockInfo = await stockService.getProductStockInfoByNameOrCode(state.activeFinancialAccountId, params.productNameOrCode);
                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Aqui estão as informações de estoque para "${stockInfo.name}", ${clientNameToUse}:`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre o estoque de "${stockInfo.name}", ${clientNameToUse}:`;
                                currentActionFormattedData = `📦 ${stockInfo.name} (${stockInfo.code || 'Sem código'}):\n` +
                                                            `🛍️ Estoque Atual: ${stockInfo.quantity} ${stockInfo.unit || 'UN'}\n` +
                                                            `📉 Estoque Mínimo: ${stockInfo.minimumStock || 0} ${stockInfo.unit || 'UN'}`;
                                if (stockInfo.quantity <= (stockInfo.minimumStock || 0)) currentActionFormattedData += "\n⚠️ Atenção: Estoque baixo ou zerado!";
                                break;
                            }
                            case 'RECORD_STOCK_MOVEMENT': {
                                if(!params.productNameOrCode || !params.movementType || !params.quantity) throw new Error("Produto, tipo de movimento e quantidade são obrigatórios.");
                                const productId = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                                if(!productId) throw new Error(`Produto "${params.productNameOrCode}" não encontrado.`);

                                await stockService.recordStockMovement(state.activeFinancialAccountId, productId, {
                                    movementType: params.movementType, // "Entrada", "Saída", "Ajuste"
                                    quantity: parseInt(params.quantity),
                                    reason: params.reason,
                                    // transactionId: null // Se fosse vinculado a uma venda/compra específica
                                });
                                const updatedStockInfo = await stockService.getProductStockInfoById(state.activeFinancialAccountId, productId);
                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Movimentação de estoque registrada para "${updatedStockInfo.name}", ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a movimentação de estoque, ${clientNameToUse}:`;
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
                                if (!cardData.name || isNaN(cardData.limit) || cardData.limit <= 0 || isNaN(cardData.closingDay) || isNaN(cardData.paymentDay) ) {
                                    throw new Error("Dados insuficientes ou inválidos para criar cartão (nome, limite, dia fechamento/pagamento).");
                                }
                                const newCard = await creditCardService.createCreditCard(state.activeFinancialAccountId, cardData);
                                if (aiResponse.detected_actions.length === 1) { aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Seu novo cartão foi cadastrado, ${clientNameToUse}!`; }
                                else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Seu novo cartão foi cadastrado, ${clientNameToUse}:`;
                                // Usa a formatação antiga pois a nova (DataStructure) é para lista.
                                currentActionFormattedData = formatOldCreditCardSummary(newCard, clientNameToUse, false, false);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'credit_card', id: newCard.id, description: newCard.name };
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

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Cartão atualizado com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do cartão, ${clientNameToUse}:`;
                                currentActionFormattedData = formatOldCreditCardSummary(updatedCard, clientNameToUse, false, true); // forEdit = true
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'UPDATE_RECURRING_RULE': {
                                const ruleIdToUpdate = state.editingResource?.type === 'recurring_rule' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.ruleIdToUpdate ? parseInt(params.ruleIdToUpdate, 10) : null);
                                if (!ruleIdToUpdate) throw new Error("ID da regra recorrente para atualizar não foi fornecido.");

                                const updateDataRule = {};
                                // Preencher updateDataRule com os campos de params...
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
                                if (params.financialCategoryName) updateDataRule.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || (await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, ruleIdToUpdate)).type);
                                else if (params.hasOwnProperty('financialCategoryName') && params.financialCategoryName === null) updateDataRule.financialCategoryId = null;


                                if (Object.keys(updateDataRule).length === 0) throw new Error("Nenhum dado fornecido para atualizar a regra.");

                                const updatedRule = await recurringTransactionService.updateRecurringRule(state.activeFinancialAccountId, ruleIdToUpdate, updateDataRule);
                                const reloadedUpdatedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, updatedRule.id);

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Regra de recorrência atualizada, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da regra, ${clientNameToUse}:`;
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
                                // Preencher updateDataProd com os campos de params...
                                if (params.hasOwnProperty('name')) updateDataProd.name = params.name;
                                if (params.hasOwnProperty('salePrice')) updateDataProd.salePrice = parseFloat(params.salePrice);
                                if (params.hasOwnProperty('code')) updateDataProd.code = params.code;
                                if (params.hasOwnProperty('costPrice')) updateDataProd.costPrice = parseFloat(params.costPrice);
                                if (params.hasOwnProperty('minimumStock')) updateDataProd.minimumStock = parseInt(params.minimumStock);
                                if (params.hasOwnProperty('unit')) updateDataProd.unit = params.unit;
                                if (params.hasOwnProperty('description')) updateDataProd.description = params.description; // Descrição do produto
                                if (params.hasOwnProperty('isActive')) updateDataProd.isActive = params.isActive;

                                if (Object.keys(updateDataProd).length === 0) throw new Error("Nenhum dado para atualizar o produto.");

                                const updatedProduct = await productService.updateProduct(state.activeFinancialAccountId, productIdToUpdate, updateDataProd);

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Produto atualizado com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do produto, ${clientNameToUse}:`;
                                currentActionFormattedData = formatProductDataStructure(updatedProduct);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'LIST_APPOINTMENTS': {
                                const filterParamsAppt = {
                                    dateStart: params.dateStart, dateEnd: params.dateEnd, status: params.status,
                                    limit: params.limit || 5, page: params.page || 1,
                                    // period: params.period // O service lida com 'period' internamente
                                };
                                const { appointments, totalItems: totalAppts } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, filterParamsAppt, params.period);

                                if (aiResponse.detected_actions.length === 1) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalAppts === 0 ? `Nenhum compromisso encontrado para os filtros, ${clientNameToUse}. 👍` : `📅 Encontrei ${totalAppts} compromissos. Os ${appointments.length > 1 ? appointments.length + " " : ""}próximos são:`);
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = totalAppts === 0 ? `Nenhum compromisso encontrado, ${clientNameToUse}.` : `Sobre os compromissos:`;
                                }

                                if (totalAppts === 0 && aiResponse.detected_actions.length === 1) {
                                    currentActionFormattedData = "Tente outros filtros ou adicione novos compromissos!";
                                } else if (totalAppts > 0) {
                                    let listTextAppt = (aiResponse.detected_actions.length > 1 && multipleActionBodiesList.length > 0) ? "Compromissos Listados:\n" : "🎯 Detalhamento dos Compromissos:\n";
                                    for (const appt of appointments) {
                                        listTextAppt += `\n🗓️ ${appt.title} - ${formatDate(appt.eventDateTime)} às ${formatTime(appt.eventDateTime, false)} (ID: ${appt.id})`;
                                        if (appt.status) listTextAppt += ` (Status: ${appt.status})`;
                                    }
                                    currentActionFormattedData = listTextAppt.trim();
                                    if (totalAppts > appointments.length) platformLinkFooter = formatPlatformLink(`E mais ${totalAppts - appointments.length} compromissos. Peça para ver mais ou veja tudo na plataforma!`);
                                } else {
                                    currentActionFormattedData = ""; // Se não tem items mas não é ação única
                                }
                                break;
                            }
                            case 'LIST_CREDIT_CARDS': {
                                const { cards, totalItems: totalCards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { includeSummary: true }); // includeSummary para limite disponível

                                if (aiResponse.detected_actions.length === 1) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalCards === 0 ? `Você ainda não tem cartões cadastrados, ${clientNameToUse}. Que tal adicionar um?` : `💳 Você tem ${totalCards} cartão(ões) cadastrado(s):`);
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = totalCards === 0 ? `Nenhum cartão cadastrado, ${clientNameToUse}.` : `Sobre seus cartões:`;
                                }

                                if (totalCards > 0) {
                                    currentActionFormattedData = formatCreditCardListDataStructure(cards);
                                } else if (aiResponse.detected_actions.length === 1) { // Ação única e sem cartões
                                    currentActionFormattedData = "Diga, por exemplo: \"cadastrar cartão Nubank com limite de 2000, fechamento dia 20 e pagamento dia 28\".";
                                } else {
                                    currentActionFormattedData = "";
                                }
                                break;
                            }
                            case 'LIST_FINANCIAL_TRANSACTIONS': {
                                const filterParamsList = {
                                    dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                    financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                                    creditCardId: params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null,
                                    isPayableOrReceivable: params.isPayableOrReceivable, isPaidOrReceived: params.isPaidOrReceived,
                                    search: params.searchTerm || params.description, // IA pode usar searchTerm ou description
                                    limit: params.limit || 7, page: params.page || 1,
                                    sortBy: params.sortBy || 'transactionDate', sortOrder: params.sortOrder || 'DESC'
                                };
                                const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList, params.period);
                               
                                if (aiResponse.detected_actions.length === 1) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalItems === 0 ? `Nenhuma transação encontrada para os filtros que você pediu, ${clientNameToUse}. 👍` : `📜 Encontrei ${totalItems} transações. As ${transactions.length > 1 ? transactions.length + " " : ""}mais recentes são:`);
                                } else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = totalItems === 0 ? `Nenhuma transação encontrada para os filtros, ${clientNameToUse}.` : `Sobre as transações:`;
                                }

                                if (totalItems === 0 && aiResponse.detected_actions.length === 1) {
                                    currentActionFormattedData = "Tente outros filtros ou adicione novas transações!";
                                } else if (totalItems > 0) {
                                    let listText = (aiResponse.detected_actions.length > 1 && multipleActionBodiesList.length > 0) ? "Transações Listadas:\n" : "🎯 Detalhamento das Transações:\n";
                                    for (const t of transactions) {
                                        const catName = t.category ? t.category.name : 'Sem Categoria';
                                        let emoji = t.type === 'Entrada' ? '🟢' : (t.creditCardId ? '💳' : '🔴');
                                        if (t.isParcel && t.originalAccount) emoji = '📦'; // Emoji de pacote para parcelas
                                        const date = formatDate(t.transactionDate);
                                        let descriptionText = t.description;
                                        // Adiciona info da parcela na descrição se for parcela
                                        if (t.isParcel && t.parcelNumber && t.totalParcels && t.originalAccount) {
                                            const originalDesc = t.originalAccount.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                                             if (!descriptionText.toLowerCase().includes(`parcela ${t.parcelNumber}/${t.totalParcels}`)) { // Evita duplicar se já estiver
                                                descriptionText = `${originalDesc} - Pcl ${t.parcelNumber}/${t.totalParcels}`;
                                             }
                                        }
                                        listText += `\n${emoji} ${descriptionText} - ${formatCurrency(t.value)}\n    (Cat: ${catName}, Data: ${date}, ID: ${t.id})`;
                                        if (t.isPayableOrReceivable && !t.creditCardId) { // Se for conta a pagar/receber (não cartão)
                                            listText += t.isPaidOrReceived ? " (Liquidada ✅)" : ` (Vence ${formatDate(t.dueDate)} 🗓️)`;
                                        }
                                    }
                                    currentActionFormattedData = listText.trim();
                                    if (totalItems > transactions.length) platformLinkFooter = formatPlatformLink(`E mais ${totalItems - transactions.length} transações. Peça para ver mais ou veja tudo na plataforma!`);
                                } else {
                                    currentActionFormattedData = ""; // Se não tem items mas não é ação única
                                }
                                break;
                            }
                            case 'LIST_RECURRING_RULES': {
                                const filterParamsRules = {
                                    isActive: params.isActive !== undefined ? params.isActive : null, // true, false ou null (todos)
                                    type: params.type,
                                    limit: params.limit || 5, page: params.page || 1
                                };
                                const { rules, totalItems: totalRules } = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, filterParamsRules);

                                if (aiResponse.detected_actions.length === 1) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalRules === 0 ? `Nenhuma regra de recorrência encontrada, ${clientNameToUse}.` : `📋 Você tem ${totalRules} regra(s) de recorrência:`);
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = totalRules === 0 ? `Nenhuma regra de recorrência encontrada, ${clientNameToUse}.` : `Sobre as regras de recorrência:`;
                                }

                                if (totalRules === 0 && aiResponse.detected_actions.length === 1) {
                                    currentActionFormattedData = "Que tal criar uma? Diga, por exemplo: \"criar recorrência de aluguel, saída de 1500, mensal, todo dia 5\".";
                                } else if (totalRules > 0) {
                                    let listTextRules = (aiResponse.detected_actions.length > 1 && multipleActionBodiesList.length > 0) ? "Regras Listadas:\n" : "🎯 Detalhamento das Regras:\n";
                                    for (const rule of rules) {
                                        listTextRules += `\n🔄 ${rule.description} - ${formatCurrency(rule.value)} (${rule.type})\n    (Próx: ${formatDate(rule.nextDueDate)}, Freq: ${rule.frequency}, ID: ${rule.id})`;
                                        if(!rule.isActive) listTextRules += " (Inativa)";
                                    }
                                    currentActionFormattedData = listTextRules.trim();
                                    if (totalRules > rules.length) platformLinkFooter = formatPlatformLink(`E mais ${totalRules - rules.length} regras. Peça para ver mais ou veja tudo na plataforma!`);
                                } else {
                                    currentActionFormattedData = "";
                                }
                                break;
                            }
                            case 'SWITCH_FINANCIAL_ACCOUNT': {
                                const targetAccountIdentifier = params.targetAccountNameOrType;
                                if (!targetAccountIdentifier) throw new Error("Preciso do nome ou tipo da conta para qual você quer mudar.");

                                const accounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                                if (accounts.length <= 1 && accounts[0]?.id === state.activeFinancialAccountId) {
                                    aiMessageIntro = `Você só tem a conta "${accounts[0]?.name || 'N/A'}" (${accounts[0]?.type}) configurada e ela já está selecionada, ${clientNameToUse}. 😊`;
                                    currentActionFormattedData = ""; platformLinkFooter = "";
                                    break;
                                } else if (accounts.length === 0) {
                                    aiMessageIntro = `Você ainda não tem nenhuma conta configurada, ${clientNameToUse}. Não há para onde mudar por enquanto. Que tal criar uma?`;
                                    currentActionFormattedData = ""; platformLinkFooter = "";
                                    state.data.onboardingStage = 'setting_up_pf_account_name'; // Direciona para criar
                                    state.currentAction = 'awaiting_input_pf_name';
                                    break;
                                }

                                let foundAccount = accounts.find(acc =>
                                    acc.accountName.toLowerCase() === targetAccountIdentifier.toLowerCase() ||
                                    acc.accountType.toLowerCase() === targetAccountIdentifier.toLowerCase() ||
                                    (acc.id && acc.id.toString() === targetAccountIdentifier) // Permite ID também
                                );
                                // Se não achou por nome/tipo exato, tenta por inclusão no nome
                                if (!foundAccount) {
                                    foundAccount = accounts.find(acc => acc.accountName.toLowerCase().includes(targetAccountIdentifier.toLowerCase()));
                                }

                                if (foundAccount && foundAccount.id !== state.activeFinancialAccountId) {
                                    state.activeFinancialAccountId = foundAccount.id;
                                    state.activeFinancialAccountName = foundAccount.accountName;
                                    state.activeFinancialAccountType = foundAccount.accountType;
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || `Prontinho, ${clientNameToUse}! Mudei para a conta "${foundAccount.accountName}" (${foundAccount.accountType}).`;
                                    currentActionFormattedData = "O que vamos fazer por aqui agora?";
                                    platformLinkFooter = ""; // Sem link da plataforma, só confirmação
                                } else if (foundAccount && foundAccount.id === state.activeFinancialAccountId) {
                                    aiMessageIntro = `Você já está usando a conta "${foundAccount.accountName}", ${clientNameToUse}! 😉`;
                                    currentActionFormattedData = ""; platformLinkFooter = "";
                                } else {
                                    aiMessageIntro = `Não encontrei uma conta chamada ou do tipo "${targetAccountIdentifier}", ${clientNameToUse}. 😕`;
                                    let accountListForMsg = "Suas contas são:\n";
                                    accounts.forEach(a => accountListForMsg += `\n- ${a.accountName} (${a.accountType})`);
                                    currentActionFormattedData = accountListForMsg;
                                    platformLinkFooter = "";
                                    state.currentAction = 'selecting_account_flow_active'; // Deixa no fluxo de seleção
                                    state.data.accountsToList = accounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                                }
                                // Se a troca foi bem sucedida ou se já estava na conta, currentAction é null
                                if (foundAccount) state.currentAction = null;
                                break;
                            }
                            case 'CREATE_FINANCIAL_ACCOUNT': {
                                const accountTypeToCreate = params.accountTypeToCreate; // PF, PJ, MEI
                                const newAccountName = params.newAccountName;

                                if (!accountTypeToCreate) { // Se a IA não conseguiu inferir o tipo
                                    state.currentAction = 'awaiting_explicit_account_type_from_ai'; // Pede tipo explicitamente
                                    aiMessageIntro = `Entendido, ${clientNameToUse}! Você quer criar uma nova conta.`;
                                    currentActionFormattedData = `Ela será para Pessoa Física (PF), Pessoa Jurídica (PJ) ou MEI?`;
                                    platformLinkFooter = "";
                                    break;
                                }
                                if (!newAccountName) { // Se a IA pegou o tipo mas não o nome
                                    state.currentAction = 'awaiting_explicit_account_name_from_ai';
                                    state.data.accountTypeToCreate = accountTypeToCreate; // Guarda o tipo
                                    const msgParts = getOnboardingAskForCompanyNameMessage(clientNameToUse, accountTypeToCreate).split('\n\n'); // Reusa msg
                                    aiMessageIntro = msgParts[0];
                                    currentActionFormattedData = msgParts[1];
                                    platformLinkFooter = msgParts[2] || "";
                                    break;
                                }
                                // Se chegou aqui, IA forneceu tipo E nome. Valida e cria.
                                if (!['PF', 'PJ', 'MEI'].includes(accountTypeToCreate)) throw new Error("Tipo de conta inválido. Use PF, PJ ou MEI.");
                                if (newAccountName.length < 3 || newAccountName.length > 50) throw new Error("Nome da conta deve ter entre 3 e 50 caracteres.");

                                const currentClientAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                                const existingPjMei = currentClientAccounts.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');

                                if ((accountTypeToCreate === 'PJ' || accountTypeToCreate === 'MEI') && existingPjMei) {
                                    throw new Error(`Você já possui uma conta ${existingPjMei.accountType} ("${existingPjMei.accountName}"). Só é permitida uma conta empresarial (PJ/MEI) por vez.`);
                                }
                                if ((accountTypeToCreate === 'PJ' || accountTypeToCreate === 'MEI') && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado')) {
                                    state.data.onboardingStage = 'awaiting_plan_confirmation'; // Reverte para fluxo de plano
                                    throw new Error(`Para criar contas PJ ou MEI, você precisa de um Plano Avançado. Confira nossos planos! (Link no app ou site)`);
                                }

                                const newFinancialAccount = await clientService.createFinancialAccount(client.id, { accountName: newAccountName, accountType: accountTypeToCreate });
                                // Define a nova conta como ativa
                                state.activeFinancialAccountId = newFinancialAccount.id;
                                state.activeFinancialAccountName = newFinancialAccount.accountName;
                                state.activeFinancialAccountType = newFinancialAccount.accountType;

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Conta "${newFinancialAccount.accountName}" (${newFinancialAccount.accountType}) criada e selecionada, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Criei e selecionei a conta, ${clientNameToUse}:`;
                                currentActionFormattedData = `✨ Conta: ${newFinancialAccount.accountName}\n✨ Tipo: ${newFinancialAccount.accountType}`;
                                platformLinkFooter = ""; state.currentAction = null;
                                break;
                            }
                            case 'GET_CREDIT_CARD_INVOICE': {
                                const cardNameForInvoice = params.creditCardName;
                                if (!cardNameForInvoice) throw new Error("Nome do cartão é obrigatório para ver a fatura.");
                                const cardIdForInvoice = await findCreditCardIdByName(cardNameForInvoice, state.activeFinancialAccountId);
                                if (!cardIdForInvoice) {
                                    aiMessageIntro = `Hum, não consegui identificar o cartão "${cardNameForInvoice}", ${clientNameToUse}.`;
                                    currentActionFormattedData = `Pode tentar de novo ou verificar se ele está cadastrado? 🤔`;
                                    platformLinkFooter = "";
                                    break;
                                }
                                const periodOpts = { type: params.invoicePeriodType || 'aberta', month: params.invoiceMonth, year: params.invoiceYear };
                                const cardForLimit = await creditCardService.getCreditCardById(state.activeFinancialAccountId, cardIdForInvoice); // Para pegar o limite total do cartão
                                const invoiceDetails = await creditCardService.getCreditCardInvoiceDetails(state.activeFinancialAccountId, cardIdForInvoice, periodOpts);
                                if(cardForLimit) invoiceDetails.cardTotalLimit = cardForLimit.limit; // Adiciona limite total para cálculo de disponível

                                if (aiResponse.detected_actions.length === 1) { aiMessageIntro = aiResponse.overall_summary_suggestion || `🛍️ ${clientNameToUse}, aqui está a fatura do seu cartão ${cardNameForInvoice}!`; }
                                else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a fatura do cartão ${cardNameForInvoice}:`;
                                currentActionFormattedData = formatCreditCardInvoiceDataStructure(invoiceDetails, params.listTransactions !== false);
                                break;
                            }
                            case 'GET_CREDIT_CARD_AVAILABLE_LIMIT': {
                                const cardNameForLimit = params.creditCardName;
                                if (!cardNameForLimit) throw new Error("Nome do cartão é obrigatório para ver o limite.");
                                const cardIdForLimit = await findCreditCardIdByName(cardNameForLimit, state.activeFinancialAccountId);
                                if (!cardIdForLimit) {
                                    aiMessageIntro = `Não encontrei o cartão "${cardNameForLimit}", ${clientNameToUse}. Verifique o nome ou cadastre o cartão.`;
                                    currentActionFormattedData = ""; platformLinkFooter = "";
                                    break;
                                }
                                const limitInfo = await creditCardService.getCreditCardAvailableLimit(state.activeFinancialAccountId, cardIdForLimit);

                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Aqui está o limite do seu cartão ${limitInfo.cardName}, ${clientNameToUse}:`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre o limite do cartão ${limitInfo.cardName}:`;
                                currentActionFormattedData = formatAvailableLimitDataStructure(limitInfo);
                                break;
                            }
                            case 'PAY_CREDIT_CARD_INVOICE': {
                                const cardNameToPay = params.creditCardName;
                                const paymentAmount = parseFloat(params.paymentAmount);
                                if (!cardNameToPay || isNaN(paymentAmount) || paymentAmount <= 0) throw new Error("Nome do cartão e valor do pagamento (maior que zero) são obrigatórios.");

                                const cardIdToPay = await findCreditCardIdByName(cardNameToPay, state.activeFinancialAccountId);
                                if (!cardIdToPay) {
                                    aiMessageIntro = `Não encontrei o cartão "${cardNameToPay}" para registrar o pagamento da fatura, ${clientNameToUse}.`;
                                    currentActionFormattedData = ""; platformLinkFooter = "";
                                    break;
                                }
                                const paymentDateCard = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
                                // Tenta encontrar a categoria "Pagamento de Fatura" ou usa a fornecida pela IA
                                let categoryIdPay = await findFinancialCategoryIdByName(params.financialCategoryName || "Pagamento de Fatura", state.activeFinancialAccountId, "Saída");
                                // Se não achou "Pagamento de Fatura" E a IA não forneceu outra, pode deixar null ou criar uma categoria padrão.
                                // Por agora, se financialCategoryName for null e "Pagamento de Fatura" não existir, categoryIdPay será null.

                                const paymentTransaction = await creditCardService.payCreditCardInvoice(
                                    state.activeFinancialAccountId, cardIdToPay, paymentAmount, paymentDateCard,
                                    params.originatingAccountDescription, // Descrição da conta de origem do pagamento (opcional)
                                    categoryIdPay // ID da categoria
                                );
                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Pagamento da fatura do cartão "${cardNameToPay}" registrado, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre o pagamento da fatura, ${clientNameToUse}:`;
                                currentActionFormattedData = `✅ Pagamento de ${formatCurrency(paymentAmount)} para o cartão "${cardNameToPay}" registrado em ${formatDate(paymentDateCard)}.`;
                                if (paymentTransaction.category) currentActionFormattedData += `\nCategoria: ${paymentTransaction.category.name}.`;
                                break;
                            }
                            case 'SET_MOTIVATIONAL_MESSAGE_PREFERENCE': {
                                if (params.enable === undefined || (params.enable && !params.time)) throw new Error("Preciso saber se quer ativar/desativar e, se ativar, o horário (HH:MM).");
                                await systemService.updateSystemPreferences({ // CORREÇÃO AQUI
                                    enableMotivationMessage: params.enable,
                                    motivationMessageTime: params.enable ? params.time : null
                                });
                                const updatedPrefsMotiv = await systemService.getSystemPreferences(); // CORREÇÃO AQUI
                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Preferências de mensagem motivacional atualizadas, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre as mensagens motivacionais, ${clientNameToUse}:`;
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
                                await systemService.updateSystemPreferences({ // CORREÇÃO AQUI
                                    enableWaterReminder: params.enable,
                                    waterReminderFrequencyType: params.enable ? params.frequencyType : 'disabled',
                                    waterReminderCustomIntervalMinutes: params.enable && params.frequencyType === 'custom' ? parseInt(params.customIntervalMinutes) : null,
                                    waterReminderStartTime: params.enable ? params.startTime : null,
                                    waterReminderEndTime: params.enable ? params.endTime : null,
                                    dailyGoalMl: params.enable && params.dailyGoalMl ? parseInt(params.dailyGoalMl) : null
                                });
                                const updatedPrefsWater = await systemService.getSystemPreferences(); // CORREÇÃO AQUI
                                if (aiResponse.detected_actions.length === 1) aiMessageIntro = aiResponse.overall_summary_suggestion || `Preferências de lembrete de água atualizadas, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre os lembretes de água, ${clientNameToUse}:`;
                                currentActionFormattedData = formatWaterReminderPreferenceDataStructure(updatedPrefsWater);
                                break;
                            }
                            // Casos para GENERAL*, ACTION_CONFIRMATION*
                            case 'GENERAL_GREETING_OR_SMALLTALK':
                            case 'GENERAL_QUESTION_OR_HELP':
                            case 'ACTION_CONFIRMATION_YES':
                            case 'ACTION_CONFIRMATION_NO':
                                // Se overall_summary_suggestion for específico (não fallback da IA) e diferente do reply_to_user, usa overall.
                                // Senão, usa reply_to_user_suggestion se existir.
                                // Senão, usa um fallback genérico.
                                if (aiResponse.overall_summary_suggestion && aiResponse.overall_summary_suggestion !== aiResponse.reply_to_user_suggestion && aiResponse.detected_actions.length === 1) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion;
                                } else if (aiResponse.reply_to_user_suggestion) {
                                    aiMessageIntro = aiResponse.reply_to_user_suggestion;
                                } else {
                                    aiMessageIntro = `Entendido, ${clientNameToUse}! 😊`; // Fallback
                                }
                                 currentActionFormattedData = ""; // Sem corpo de dados estruturado para estas
                                 platformLinkFooter = (actionName === 'GENERAL_QUESTION_OR_HELP' && !(aiMessageIntro && aiMessageIntro.includes('app.mapnocontrole.com.br'))) ? formatPlatformLink("Se precisar de mais funcionalidades, explore nossa plataforma!") : "";

                                if (actionName === 'ACTION_CONFIRMATION_YES' || actionName === 'ACTION_CONFIRMATION_NO') {
                                    // Se a confirmação foi tratada na lógica de pré-processamento (state.currentAction === 'awaiting_confirmation'),
                                    // currentAction, pendingConfirmation e editingResource já terão sido limpos lá.
                                    // Se chegou aqui, é uma confirmação genérica da IA, então limpa também.
                                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                                }
                                break;
                            default:
                                // Ação não explicitamente tratada no switch
                                let defaultIntro = `Ok, ${clientNameToUse}!`;
                                if (aiResponse.detected_actions.length === 1 && aiResponse.overall_summary_suggestion) defaultIntro = aiResponse.overall_summary_suggestion;
                                else if (aiResponse.reply_to_user_suggestion) defaultIntro = aiResponse.reply_to_user_suggestion;
                               
                                // Se aiMessageIntro não foi definido por uma ação anterior (múltiplas ações)
                                // E não é uma mensagem de erro já definida
                                // E não é o overall_summary_suggestion já capturado
                                // E não é o reply_to_user_suggestion já capturado
                                // Usa o defaultIntro.
                                if (multipleActionBodiesList.length === 0 &&
                                    (!(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && aiMessageIntro !== aiResponse.overall_summary_suggestion && aiMessageIntro !== aiResponse.reply_to_user_suggestion)) {
                                     aiMessageIntro = defaultIntro;
                                } else if (aiResponse.detected_actions.length > 1 && aiResponse.overall_summary_suggestion && aiMessageIntro !== aiResponse.overall_summary_suggestion) {
                                    // Mantém o intro específico se já definido para a primeira ação de múltiplas
                                } else if (aiResponse.overall_summary_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro === `Ok, ${clientNameToUse}!`)) {
                                    // Se overall_summary_suggestion existe e aiMessageIntro é fallback, usa overall_summary
                                    aiMessageIntro = aiResponse.overall_summary_suggestion;
                                }


                                currentActionFormattedData = `Ainda estou aprendendo a processar "${actionName.toLowerCase().replace(/_/g," ")}" completamente. 😅 Minha equipe está trabalhando nisso!`;
                                logger.warn(`[WHATSAPP SERVICE] Ação da IA não implementada no switch de formatação: ${actionName}`);
                                break;
                        }
                    } catch (e) {
                         logger.error(`[WHATSAPP HANDLER] Erro executando "${actionName}" para ${senderPhone}: ${e.message}`, { stack: e.stack?.substring(0,300), paramsUsed: params }); // Loga os parâmetros que foram usados
                         let errorIntroPart = `Ops! 😬 Tive um problema ao tentar processar "${params.description || actionName.toLowerCase().replace(/_/g," ")}".`;
                         let errorDataPart = `Detalhe do erro: ${e.message.length < 80 ? e.message : 'Erro interno, desculpe!'}\n\nPode tentar de novo ou com outros termos?`;
                        
                         if (aiResponse.detected_actions.length === 1) { // Se for ação única
                            // Só sobrescreve aiMessageIntro se não for já uma mensagem de erro/problema
                            if (!(aiMessageIntro && typeof aiMessageIntro === 'string' && (aiMessageIntro.toLowerCase().includes("ops") || aiMessageIntro.toLowerCase().includes("problema")))) {
                                aiMessageIntro = errorIntroPart;
                            }
                            currentActionFormattedData = errorDataPart;
                         } else { // Se for parte de múltiplas ações, adiciona o erro à lista
                            multipleActionBodiesList.push(`❌ ${errorIntroPart}\n${errorDataPart}`);
                            currentActionFormattedData = ""; // Não define como corpo principal
                         }
                    }

                    // Adiciona os dados formatados (ou mensagem de erro da ação) à lista
                    if (currentActionFormattedData && !currentActionBlocked) { // Não adiciona se foi bloqueado
                        multipleActionBodiesList.push(currentActionFormattedData);
                    }
                } // Fim do loop for detected_actions

                // Monta o corpo da mensagem com base na lista de ações processadas
                if (multipleActionBodiesList.length > 0) {
                    structuredDataBody = multipleActionBodiesList.join("\n\n---\n\n"); // Separador para múltiplas ações
                    // Se aiMessageIntro ainda for o fallback genérico E houver um overall_summary_suggestion E não for uma mensagem de erro já definida
                    if ((typeof aiMessageIntro === 'string' && (aiMessageIntro === `Ok, ${clientNameToUse}!` || !aiMessageIntro.includes(clientNameToUse))) &&
                        aiResponse.overall_summary_suggestion &&
                        !(aiMessageIntro && (aiMessageIntro.toLowerCase().includes("ops") || aiMessageIntro.toLowerCase().includes("problema")) ) ) {
                        aiMessageIntro = aiResponse.overall_summary_suggestion;
                    }
                } else if (aiResponse.detected_actions.length === 0) { // Nenhuma ação detectada (e nenhuma bloqueada resultou em dados)
                    structuredDataBody = "";
                    // Se não há ações, e aiMessageIntro é fallback, e há reply_to_user_suggestion, usa ele.
                    if (aiResponse.reply_to_user_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro === `Ok, ${clientNameToUse}!`)) {
                        // Apenas sobrescreve se reply_to_user_suggestion for diferente do overall_summary_suggestion
                        // (caso overall_summary já tenha sido usado para aiMessageIntro) OU se aiMessageIntro é o fallback
                        if (aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion || aiMessageIntro === `Ok, ${clientNameToUse}!`) {
                            aiMessageIntro = aiResponse.reply_to_user_suggestion;
                        }
                    }
                }
            } // Fim if (aiResponse.detected_actions)
       
            // Se há clarificações necessárias
            if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
                aiMessageIntro = aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe:`;
                structuredDataBody = aiResponse.clarifications_needed[0].clarification_question;
                platformLinkFooter = ""; // Não adiciona link da plataforma em clarificações
                state.currentAction = 'awaiting_clarification_response'; // Define ação para esperar resposta à clarificação
                // Guarda o contexto da clarificação para uso futuro (opcional, mas pode ser útil)
                state.data.clarificationContext = {
                    action: aiResponse.clarifications_needed[0].original_intent_action_suggestion, // Ação que a IA estava tentando
                    original_message: messageText,
                    parameters_so_far: aiResponse.clarifications_needed[0].parameters_so_far || {} // Parâmetros já coletados
                };
            } else if ((!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) && !structuredDataBody) {
                // Se não houve ação detectada, nem clarificação, nem corpo de dados estruturado já montado.
                // Usa reply_to_user_suggestion se existir e for diferente do que já está em aiMessageIntro (ou se aiMessageIntro for fallback)
                if (aiResponse.reply_to_user_suggestion &&
                    (typeof aiMessageIntro !== 'string' || aiMessageIntro === `Ok, ${clientNameToUse}!` || aiMessageIntro === aiResponse.overall_summary_suggestion )) {
                    if (aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion || aiMessageIntro === `Ok, ${clientNameToUse}!`) {
                        aiMessageIntro = aiResponse.reply_to_user_suggestion;
                    }
                }
                if(multipleActionBodiesList.length === 0) structuredDataBody = ""; // Garante que está vazio se não houve ações

                // Fallback final se aiMessageIntro ainda for o genérico e não houver corpo de dados.
                if ((typeof aiMessageIntro === 'string' && aiMessageIntro === `Ok, ${clientNameToUse}!`) && !structuredDataBody && !aiResponse.overall_summary_suggestion && !aiResponse.reply_to_user_suggestion) {
                    aiMessageIntro = `Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊`;
                }
            }
       
            // Montagem final da mensagem
            if (typeof aiMessageIntro !== 'string' || aiMessageIntro.trim() === "") {
                aiMessageIntro = `Ok, ${clientNameToUse}!`; // Último fallback para intro
            }

            finalMessageToSend = aiMessageIntro.trim();
            if (structuredDataBody && structuredDataBody.trim() !== "") {
                finalMessageToSend += `\n\n${structuredDataBody.trim()}`;
            }
           
            // Condições para NÃO adicionar o link da plataforma
            let noLinkCurrentAction = state.currentAction === 'awaiting_clarification_response' || state.currentAction === 'selecting_account_flow_active' || state.currentAction?.startsWith('awaiting_explicit_');
            let noLinkDetectedAction = false;
            if(aiResponse.detected_actions && aiResponse.detected_actions.length > 0){
                noLinkDetectedAction = aiResponse.detected_actions.some(da => {
                    const actionNameCheck = da.action || da.action_type;
                    // Não adiciona link para saudações simples, confirmações, ou quando já está em fluxo de pergunta de conta/plano
                    return actionNameCheck?.startsWith("GENERAL_GREETING") || actionNameCheck?.startsWith("ACTION_CONFIRMATION_") || actionNameCheck === "SWITCH_FINANCIAL_ACCOUNT" || actionNameCheck === "CREATE_FINANCIAL_ACCOUNT";
                });
            }
            const noLinkConditions = noLinkCurrentAction ||
                                     (finalMessageToSend && finalMessageToSend.includes('https://app.mapnocontrole.com.br')) || // Já tem o link
                                     (finalMessageToSend && finalMessageToSend.includes('https://mapnocontrole.com.br/planos')) || // Já tem link de planos
                                     (state.data.onboardingStage === 'awaiting_plan_confirmation' && !state.hasPaidAccess) || // Se está mostrando msg de plano
                                     noLinkDetectedAction;


            if (platformLinkFooter && platformLinkFooter.trim() !== "" && !noLinkConditions ) {
                 finalMessageToSend += `\n\n${platformLinkFooter.trim()}`;
            }
            finalMessageToSend = finalMessageToSend.replace(/\n{3,}/g, '\n\n').trim(); // Limpa espaços extras
       
            // Envia a mensagem se houver algo para enviar
            if (finalMessageToSend) {
                state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });
            }
       
            // Limpa estado de edição se uma ação de edição foi realizada com sucesso, ou se não houve ação de edição
            if (actionWasAnEdit || (state.editingResource && (!aiResponse.detected_actions || aiResponse.detected_actions.every(a => !(a.action || a.action_type)?.startsWith("UPDATE_") && (a.action || a.action_type) !== 'RECREATE_PARCELLED_ACCOUNT')))) {
                state.editingResource = null;
            }
            // Limpa contexto de clarificação se não há mais clarificações pedidas
            if (state.data.clarificationContext && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
                delete state.data.clarificationContext;
            }
       
            // Envio da mensagem com ou sem botões
            if (finalMessageToSend) {
                // Verifica se uma ação CONCRETA (não lista, não get, não saudação, não switch) e NÃO EDIÇÃO foi feita com sucesso
                const performedConcreteAction = (aiResponse.detected_actions && aiResponse.detected_actions.length > 0 &&
                                           aiResponse.detected_actions.some(a => {
                                               const actionNameCheck = a.action || a.action_type;
                                               return !(actionNameCheck?.startsWith("GENERAL_") || actionNameCheck?.startsWith("LIST_") || actionNameCheck?.startsWith("GET_") || actionNameCheck?.startsWith("SWITCH_") || actionNameCheck?.startsWith("ACTION_CONFIRMATION_"));
                                           })) &&
                                           (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0); // E não pediu clarificação

                // Verifica se foi UMA ÚNICA ação concreta e que NÃO FOI UMA EDIÇÃO
                const singleConcreteNonEditAction = performedConcreteAction && aiResponse.detected_actions.filter(a => {
                    const actionNameCheck = a.action || a.action_type;
                    return !(actionNameCheck?.startsWith("GENERAL_") ||
                             actionNameCheck?.startsWith("LIST_") ||
                             actionNameCheck?.startsWith("GET_") ||
                             actionNameCheck?.startsWith("SWITCH_") ||
                             actionNameCheck?.startsWith("ACTION_CONFIRMATION_") ||
                             actionNameCheck?.startsWith("UPDATE_") || // Exclui UPDATES
                             actionNameCheck === "RECREATE_PARCELLED_ACCOUNT"); // Exclui RECREATE (que é um tipo de update)
                }).length === 1;

                // Se resourceForButtonsContext foi definido E foi uma única ação concreta de criação (não edição), mostra botões
                if (resourceForButtonsContext && singleConcreteNonEditAction) {
                    let buttons = [];
                    let buttonItemDesc = "item"; // Descrição default para o botão
                    if (resourceForButtonsContext.description && typeof resourceForButtonsContext.description === 'string') {
                        buttonItemDesc = resourceForButtonsContext.description.length > 24 ? resourceForButtonsContext.description.substring(0, 21) + "..." : resourceForButtonsContext.description;
                    }
                    const buttonTitle = `Opções para "${buttonItemDesc}":`; // Título da lista de botões
       
                    switch(resourceForButtonsContext.type) {
                        case 'transaction': buttons = [ { id: `edit_transaction_${resourceForButtonsContext.id}`, label: "Editar Transação ✍️" }, { id: `delete_transaction_${resourceForButtonsContext.id}`, label: "Excluir Transação 🗑️" }, ]; break;
                        case 'appointment': buttons = [ { id: `edit_appointment_${resourceForButtonsContext.id}`, label: "Editar Compromisso ✍️" }, { id: `delete_appointment_${resourceForButtonsContext.id}`, label: "Excluir Compromisso 🗑️" }, ]; break;
                        case 'credit_card': buttons = [ { id: `edit_credit_card_${resourceForButtonsContext.id}`, label: "Editar Cartão ✍️" }, { id: `delete_credit_card_${resourceForButtonsContext.id}`, label: "Excluir Cartão 🗑️" }, ]; break;
                        case 'recurring_rule': buttons = [ { id: `edit_recurring_rule_${resourceForButtonsContext.id}`, label: "Editar Recorrência ✍️" }, { id: `delete_recurring_rule_${resourceForButtonsContext.id}`, label: "Excluir Recorrência 🗑️" }, ]; break;
                        case 'product': buttons = [ { id: `edit_product_${resourceForButtonsContext.id}`, label: "Editar Produto ✍️" }, /* { id: `delete_product_${resourceForButtonsContext.id}`, label: "Excluir Produto 🗑️" }, */ ]; break; // Excluir produto pode ser complexo, talvez remover botão por ora
                        case 'parcelled_account': buttons = [ { id: `edit_parcelled_account_${resourceForButtonsContext.id}`, label: "Alterar Compra Parcelada ✍️" }, { id: `delete_parcelled_account_${resourceForButtonsContext.id}`, label: "Excluir Compra Parcelada 🗑️" }, ]; break;
                    }
       
                    if (buttons.length > 0) {
                        await sendButtonListMessage(senderPhone, finalMessageToSend, buttons, buttonTitle, "Ver Opções 👇");
                    } else {
                        await sendWhatsappMessage(senderPhone, finalMessageToSend);
                    }
                } else { // Se não for para mostrar botões (múltiplas ações, edição, etc.)
                    await sendWhatsappMessage(senderPhone, finalMessageToSend);
                    // Se editingResource ainda existe, não houve ação de edição bem sucedida, e não é um resourceForButtons, limpa.
                    if(state.editingResource && !resourceForButtonsContext && !actionWasAnEdit) state.editingResource = null;
                }
            }
        } // Fim if (state.data.onboardingStage === 'onboarding_complete' || !onboardingReply)

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000), messageText, rawPayload });
        const clientNameToUseInError = state ? state.clientName : (pushNameFromPayload || "você");
        const errorIntro = `Puxa vida, ${clientNameToUseInError}! 😬 Parece que tive um curto-circuito feio aqui...`;
        const errorData = `🎯 Ocorrência Inesperada:\n\nNão consegui processar sua mensagem.\nMinha equipe de engenheiros já foi notificada! 👩‍💻👨‍💻`;
        const errorLink = formatPlatformLink("Por favor, tente de novo em um momentinho ou acesse a plataforma.");
        try {
            await sendWhatsappMessage(senderPhone, `${errorIntro}\n\n${errorData}\n\n${errorLink}`);
        } catch (sendError) {
            logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro crítico para ${senderPhone}: ${sendError.message}`);
        }
    } finally {
        const endTime = Date.now();
        logger.info(`[WHATSAPP HANDLER] Processamento para ${senderPhone} finalizado em ${endTime - startTime}ms.`);
        if (state) { // Garante que 'state' existe antes de tentar acessá-lo
            logger.debug(`[WHATSAPP HANDLER] Estado final da sessão para ${senderPhone}:`, {
                currentAction: state.currentAction,
                onboardingStage: state.data?.onboardingStage, // Usa optional chaining para data
                hasPaidAccess: state.hasPaidAccess,
                activeFinancialAccountId: state.activeFinancialAccountId,
                accessLevelTextForUser: state.accessLevelTextForUser,
                tempData: state.data ? JSON.parse(JSON.stringify(state.data)) : {} // Clona se existir
            });
            conversationState.set(senderPhone, state); // Salva o estado atualizado
        }
        pushNameFromPayload = null; // Limpa para a próxima mensagem
    }
}

module.exports = { processIncomingMessage };
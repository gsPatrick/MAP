// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const businessClientService = require('../BusinessClient/BusinessClient.service');
const sharedAccessService = require('../SharedAccess/sharedAccess.service');
const systemService = require('../System/system.service');
const financialCategoryService = require('../FinancialCategory/financialCategory.service'); // << IMPORTANTE: Adicionar este
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');



// Importa as funções de envio e download do serviço de WhatsApp genérico
const { sendWhatsappMessage, sendButtonListMessage, downloadZapiMedia } = require('../../services/whatsappService');
// Importa o serviço do modelo de IA, que agora inclui a transcrição
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');
const path = require('path'); // Necessário para extrair nome de arquivo da URL de mídia

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;
let pushNameFromPayload = null;


// --- Funções Auxiliares de Busca ---
async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    try {
        const card = await creditCardService.findCreditCardByName(financialAccountId, name);
        return card ? card.id : null;
    } catch (error) {
        if (error.statusCode === 404) {
            logger.warn(`[WHATSAPP SERVICE HELPER] Cartão "${name}" não encontrado para conta ${financialAccountId} via findCreditCardIdByName.`);
            return null;
        }
        logger.error(`[WHATSAPP SERVICE HELPER] Erro inesperado ao buscar cartão ${name}: ${error.message}`);
        throw error;
    }
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    const productsResult = await productService.getAllProducts(financialAccountId, { search: nameOrCode, limit: 1, isActive: true });
    if (productsResult.products && productsResult.products.length > 0) {
        return productsResult.products[0].id;
    }
    return null;
}

async function findBusinessClientIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const clientsResult = await businessClientService.getAllBusinessClients(financialAccountId, { search: name, limit: 1, isActive: true });
    if (clientsResult.businessClients && clientsResult.businessClients.length > 0) {
        return clientsResult.businessClients[0].id;
    }
    return null;
}


// --- Funções de Formatação Auxiliares ---
function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const safeDateString = dateString.length === 10 ? `${dateString}T00:00:00Z` : dateString;
    try {
        return new Date(safeDateString).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    } catch (e) {
        logger.warn(`[FORMAT DATE] Data inválida recebida: ${dateString}`);
        return 'Data Inválida';
    }
}

function formatTime(dateTimeString, includeSeconds = false) {
    if (!dateTimeString) return 'N/A';
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

// >>> INÍCIO DA MODIFICAÇÃO 2 <<<
function formatPlanName(accessLevelString) {
    if (!accessLevelString || typeof accessLevelString !== 'string') {
        return 'Nenhum plano';
    }

    // Dicionário para traduzir e formatar os nomes dos planos
    const planTranslations = {
        'basico': 'Básico',
        'avancado': 'Avançado',
        'mensal': 'Mensal',
        'anual': 'Anual',
        'vitalicio': 'Vitalício'
    };

    return accessLevelString
        .split('_') // Separa por underscore: 'avancado_mensal' -> ['avancado', 'mensal']
        .map(part => planTranslations[part] || (part.charAt(0).toUpperCase() + part.slice(1))) // Traduz cada parte ou apenas capitaliza se não encontrar
        .join(' '); // Junta com espaço: ['Avançado', 'Mensal'] -> 'Avançado Mensal'
}
// >>> FIM DA MODIFICAÇÃO 2 <<<

// >>> INÍCIO DA MODIFICAÇÃO 1 <<<
function formatPlatformLink(customText = null) {
    const platformUrl = process.env.PLATFORM_URL || 'map-nocontrole.com.br/painel';
    const defaultText = `📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}. Qualquer coisa, estou por aqui! 😉`;
    return customText || defaultText;
}
// >>> FIM DA MODIFICAÇÃO 1 <<<

const statusTranslations = {
    Scheduled: "Agendado(a) 🗓️",
    Confirmed: "Confirmado(a) ✅",
    Cancelled: "Cancelado(a) ❌",
    Completed: "Concluído(a) ✔️",
    Pending: "Pendente ⏳",
    Paid: "Pago(a) ✅",
    Received: "Recebido(a) ✅",
    Active: "Ativo(a) ✅",
    Inactive: "Inativo(a) ❌",
    Overdue: "Vencido(a) ⏰",
    Accepted: "Ativo ✅", 
};

function translateStatus(statusKey, defaultText = null) {
    return statusTranslations[statusKey] || defaultText || statusKey;
}


// --- Novas Funções de Formatação para "Estrutura de Dados" ---
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
        data += `🚦 Status: ${transaction.isPaidOrReceived ? translateStatus(transaction.type === 'Entrada' ? 'Received' : 'Paid') : translateStatus('Pending')}\n`;
        if (transaction.isPaidOrReceived && transaction.paymentDate) {
            data += `🧾 Data Pgto/Rec: ${formatDate(transaction.paymentDate)}\n`;
        }
    } else if (!transaction.creditCardId) {
        data += `🚦 Status: ${translateStatus(transaction.type === 'Entrada' ? 'Received' : 'Paid')}\n`;
    } else {
         data += `🚦 Status: Lançada no cartão ✅\n`;
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

function formatAppointmentDataStructure(appointment, forReminder = false, clientNameForReminder = "Você") {
    if (!appointment) return "📅 Resumo do Compromisso:\n\nDados não disponíveis.";
    
    let introEmoji = "📅";
    let introText = "Resumo do Compromisso";
    let forWhom = "";
    
    // Tenta pegar o nome do cliente associado à financialAccount do compromisso
    if (appointment?.financialAccount?.client?.name && appointment.financialAccount.client.name.toLowerCase() !== 'unknown' && appointment.financialAccount.client.name.toLowerCase() !== 'null') {
        forWhom = `(${appointment.financialAccount.client.name.split(" ")[0]})`;
    } else if (clientNameForReminder && clientNameForReminder !== "Você") { // Fallback para o nome passado (geralmente o ator)
        forWhom = `(${clientNameForReminder})`;
    }


    if (forReminder) {
        introEmoji = "🔔 LEMBRETE";
        introText = `Compromisso Próximo ${forWhom}`; 
    } else {
        introText = `Resumo do Compromisso ${forWhom}`;
    }


    let data = `${introEmoji} ${introText}:\n\n`;
    data += `💼 Título: *${appointment.title || 'N/A'}*\n`;
    data += `📆 Data: ${formatDate(appointment.eventDateTime)}\n`;
    data += `🕔 Horário: ${formatTime(appointment.eventDateTime)}\n`;

    if (appointment.durationMinutes) {
        const endTime = new Date(new Date(appointment.eventDateTime).getTime() + appointment.durationMinutes * 60000);
        data += `🕔 Término Estimado: ${formatTime(endTime)}\n`;
    }
    if (appointment.location) {
        data += `📍 Local: ${appointment.location}\n`;
    }
    if (appointment.status) {
        data += `🚦 Status: ${translateStatus(appointment.status)}\n`;
    }
    if (appointment.associatedValue && appointment.associatedTransactionType) {
        data += `💰 Valor Associado: ${formatCurrency(appointment.associatedValue)} (${appointment.associatedTransactionType})\n`;
    }
    if (appointment.businessClients && appointment.businessClients.length > 0) {
        data += `👥 Clientes Associados: ${appointment.businessClients.map(c => c.name).join(', ')}\n`;
    }
    if (appointment.notes) {
        data += `🗒️ Observações: ${appointment.notes}\n`;
    }
    return data.trim();
}

function formatRecurringRuleDataStructure(rule) {
    if (!rule) return "🧾 Resumo da Transação Recorrente:\n\nDados não disponíveis.";
    let data = `🧾 Resumo da Transação Recorrente:\n\n`;
    data += `📜 Descrição: *${rule.description || 'N/A'}*\n`;
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
    let frequencyText;
    const freqMap = { daily: 'Diária', weekly: 'Semanal', 'bi-weekly': 'Quinzenal', monthly: 'Mensal', quarterly: 'Trimestral', 'semi-annually': 'Semestral', annually: 'Anual' };
    frequencyText = freqMap[rule.frequency] || rule.frequency;

    if (rule.interval && rule.interval > 1) {
        const pluralPeriodMap = { daily: 'dias', weekly: 'semanas', 'bi-weekly': 'quinzenas', monthly: 'meses', quarterly: 'trimestres', 'semi-annually': 'semestres', annually: 'anos' };
        frequencyText = `A cada ${rule.interval} ${pluralPeriodMap[rule.frequency] || (rule.frequency ? rule.frequency.replace('ly', 's') : 'períodos')}`;
    }
    data += `🔄 Frequência: ${frequencyText}\n`;

    if (rule.dayOfWeek !== null && rule.dayOfWeek !== undefined && (rule.frequency === 'weekly' || rule.frequency === 'bi-weekly')) {
        const days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
        data += `🗓️ Dia da Semana: ${days[rule.dayOfWeek]}\n`;
    }
    if (rule.dayOfMonth && rule.frequency === 'monthly') {
        data += `🗓️ Dia do Mês: ${rule.dayOfMonth}\n`;
    }
    data += `➡️ Próximo Vencimento: ${rule.nextDueDate ? formatDate(rule.nextDueDate) : 'N/A (Regra Inativa ou Concluída)'}\n`;
    data += `⚙️ Criação Automática: ${rule.autoCreateTransaction ? 'Sim (Gera transação)' : 'Não (Apenas Lembrete)'}\n`;
    data += `🚦 Status da Regra: ${translateStatus(rule.isActive ? 'Active' : 'Inactive')}\n`;

    return data.trim();
}

function formatCreditCardDataStructure(card) {
    if (!card) return "💳 Resumo do Cartão:\n\nDados não disponíveis.";
    let data = `💳 Resumo do Cartão de Crédito:\n\n`;
    data += `🏦 Nome: *${card.name || 'N/A'}*\n`;
    data += `💰 Limite Total: ${formatCurrency(card.limit)}\n`;
    if (card.availableLimit !== undefined) {
        data += `💰 Limite Disponível: ${formatCurrency(card.availableLimit)}\n`;
    }
    data += `🗓️ Dia de Fechamento: ${card.closingDay}\n`;
    data += `💵 Dia de Pagamento: ${card.paymentDay}\n`;
    if(card.lastFourDigits) data += `🔢 Final do Cartão: ${card.lastFourDigits}\n`;
    if(card.flag) data += `🏳️ Bandeira: ${card.flag}\n`;
    data += `⭐ Cartão Padrão: ${card.isDefault ? 'Sim ✅' : 'Não ❌'}\n`;
    data += `🚦 Status: ${translateStatus(card.isActive ? 'Active' : 'Inactive')}\n`;
    return data.trim();
}

function formatCreditCardListDataStructure(cards) {
    if (!cards || cards.length === 0) return "📋 Resumo dos Cartões:\n\nNenhum cartão de crédito cadastrado.";
    let data = `📋 Seus Cartões de Crédito:\n`;
    cards.forEach((card, index) => {
        data += `\n${index + 1}️⃣ Cartão: *${card.name || 'N/A'}*\n`;
        if (card.flag) data += `   🏷️ Bandeira: ${card.flag}\n`;
        if (card.lastFourDigits) data += `   💳 Final: ${card.lastFourDigits}\n`;
        if (card.availableLimit !== undefined) {
            data += `   💰 Limite disponível: ${formatCurrency(card.availableLimit)}\n`;
        } else {
            data += `   💰 Limite Total: ${formatCurrency(card.limit)}\n`;
        }
        if (card.isDefault) data += `   ⭐ Cartão Padrão\n`;
        data += `   🚦 Status: ${translateStatus(card.isActive ? 'Active' : 'Inactive')}\n`;
    });
    return data.trim();
}

function formatCreditCardInvoiceDataStructure(invoiceDetails, listTransactions = true) {
    if (!invoiceDetails) return "🎯 Resumo da Fatura:\n\nDados da fatura não disponíveis.";
    let data = `🎯 Resumo da Fatura - Cartão *${invoiceDetails.cardName || 'N/A'}*\n\n`;
    data += `📅 Mês de Referência: ${invoiceDetails.invoiceReferenceMonthYear || 'N/A'}\n`;
    data += `💰 Total da fatura: ${formatCurrency(invoiceDetails.totalAmount)}\n`;
    if(invoiceDetails.availableLimitAfterInvoice !== undefined) {
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
                parcelInfo = ` (Pcl ${tx.parcelNumber}/${tx.totalParcels})`;
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
    let data = `💳 Limite Disponível - Cartão *${limitInfo.cardName || 'N/A'}*:\n\n`;
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
    data += `📝 Descrição: *${parcelParams.description || firstParcel.description.replace(/ - Parcela \d+\/\d+$/, '')}*\n`;
    data += `💰 Valor Total: ${formatCurrency(parcelParams.totalValue)}\n`;
    data += `📦 Parcelas: ${parcelParams.numberOfParcels}x de ${formatCurrency(firstParcel.value)} (aprox.)\n`;
    if (parcelParams.creditCardName) {
        data += `💳 Cartão: ${parcelParams.creditCardName}\n`;
    } else if (firstParcel.creditCard && firstParcel.creditCard.name) {
        data += `💳 Cartão: ${firstParcel.creditCard.name}\n`;
    }
    if (parcelParams.financialCategoryName) {
        data += `🏷️ Categoria: ${parcelParams.financialCategoryName}\n`;
    } else if (firstParcel.category && firstParcel.category.name) {
        data += `🏷️ Categoria: ${firstParcel.category.name}\n`;
    }
    data += `📅 Data da Compra: ${formatDate(parcelParams.transactionDate || firstParcel.transactionDate)}\n`;
    data += `🗓️ Venc. 1ª Parcela: ${formatDate(parcelParams.initialDueDate || firstParcel.dueDate || firstParcel.transactionDate)}\n`;
    return data.trim();
}

function formatListClientAccountsDataStructure(accounts, currentAccountId = null, ownerNameIfShared = null) {
    if (!accounts || accounts.length === 0) return `🏷️ Perfis ${ownerNameIfShared ? `de ${ownerNameIfShared} ` : ''}cadastrados:\n\nNenhum perfil/conta financeira encontrado(a).`;
    let data = `🏷️ Perfis ${ownerNameIfShared ? `de *${ownerNameIfShared}* ` : ''}disponíveis para você:\n`;
    accounts.forEach((acc, index) => {
        data += `\n${index + 1}️⃣ *${acc.name || acc.accountName}* (${acc.type || acc.accountType})${currentAccountId === acc.id ? ' (Selecionada ✨)' : ''}`;
    });
    return data.trim();
}

function formatProductDataStructure(product) {
    if (!product) return "📦 Resumo do Produto:\n\nDados do produto não disponíveis.";
    let data = `📦 Resumo do Produto:\n\n`;
    data += `🏷️ Nome: *${product.name}*\n`;
    if(product.code) data += `🔢 Código: ${product.code}\n`;
    data += `💰 Preço de Venda: ${formatCurrency(product.salePrice)}\n`;
    if(product.costPrice !== null && product.costPrice !== undefined) data += `💲 Preço de Custo: ${formatCurrency(product.costPrice)}\n`;
    data += `🛍️ Estoque Atual: ${product.quantity !== undefined ? product.quantity : (product.initialQuantity || 0)} ${product.unit || 'UN'}\n`;
    if(product.minimumStock !== null && product.minimumStock !== undefined) data += `📉 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    if(product.description && product.description.trim() !== "") data += `📄 Descrição Detalhada: ${product.description}\n`;
    data += `🚦 Status: ${translateStatus(product.isActive === false ? 'Inactive' : 'Active')}\n`;
    return data.trim();
}

function formatStockInfoDataStructure(stockInfo) {
    if (!stockInfo) return "📦 Informações de Estoque:\n\nDados não disponíveis.";
    let data = `📦 Estoque de *${stockInfo.name}*:\n\n`;
    if (stockInfo.code) data += `🔢 Código: ${stockInfo.code}\n`;
    data += `🛍️ Quantidade Atual: ${stockInfo.quantity} ${stockInfo.unit || 'UN'}\n`;
    if (stockInfo.minimumStock !== undefined && stockInfo.minimumStock !== null) {
        data += `📉 Estoque Mínimo Definido: ${stockInfo.minimumStock} ${stockInfo.unit || 'UN'}\n`;
        if (stockInfo.quantity <= stockInfo.minimumStock) {
            data += `⚠️ *Atenção: Estoque baixo ou zerado!*\n`;
        }
    }
    return data.trim();
}


function formatBusinessClientDataStructure(client) {
    if (!client) return "👥 Resumo do Cliente do Negócio:\n\nDados não disponíveis.";
    let data = `👥 Resumo do Cliente:\n\n`;
    data += `👤 Nome: *${client.name}*\n`;
    if (client.phone) data += `📞 Telefone: ${client.phone}\n`;
    if (client.email) data += `📧 E-mail: ${client.email}\n`;
    if (client.notes) data += `🗒️ Observações: ${client.notes}\n`;
    data += `🚦 Status: ${translateStatus(client.isActive === false ? 'Inactive' : 'Active')}\n`;
    return data.trim();
}

function formatListBusinessClientsDataStructure(clients) {
    if (!clients || clients.length === 0) return "👥 Lista de Clientes:\n\nNenhum cliente do negócio encontrado.";
    let data = "👥 Seus Clientes do Negócio:\n";
    clients.forEach((client, index) => {
        data += `\n${index + 1}️⃣ *${client.name}*`;
        if (client.phone) data += ` - ${client.phone}`;
        if (client.email) data += ` - ${client.email}`;
        data += ` (${translateStatus(client.isActive === false ? 'Inactive' : 'Active')})\n`;
    });
    return data.trim();
}

function formatSharedAccessDataStructure(sharedAccess, perspective = 'owner') {
    if (!sharedAccess) return "🤝 Resumo do Acesso Compartilhado:\n\nDados não disponíveis.";
    let data = `🤝 Resumo do Acesso Compartilhado:\n\n`;

    if (perspective === 'owner') {
        data += `👤 Convidado: *${sharedAccess.sharedWithClient?.name || sharedAccess.sharedWithClient?.email || sharedAccess.sharedWithUserIdentifier}*\n`;
        if (sharedAccess.sharedAccessPhone) data += `📞 WhatsApp do Convidado: ${sharedAccess.sharedAccessPhone}\n`;
        if (sharedAccess.sharedAccessEmail) data += `📧 Email de Acesso do Convidado: ${sharedAccess.sharedAccessEmail}\n`;
    } else {
        data += `👑 Proprietário: *${sharedAccess.ownerClient?.name || sharedAccess.ownerClient?.email || 'Desconhecido'}*\n`;
    }

    let profiles = [];
    if (sharedAccess.canAccessPersonalProfile && sharedAccess.ownerClient?.financialAccounts?.find(fa => fa.accountType === 'PF')) {
        profiles.push(`Perfil Pessoal de ${sharedAccess.ownerClient?.name || 'Proprietário'}`);
    }
    if (sharedAccess.canAccessBusinessProfileId && sharedAccess.ownerClient?.financialAccounts?.find(fa => fa.id === sharedAccess.canAccessBusinessProfileId)) {
        const bizAcc = sharedAccess.ownerClient.financialAccounts.find(fa => fa.id === sharedAccess.canAccessBusinessProfileId);
        profiles.push(`Perfil Empresarial "${bizAcc.accountName}" (${bizAcc.accountType}) de ${sharedAccess.ownerClient?.name || 'Proprietário'}`);
    }
    if (profiles.length > 0) {
        data += `🔑 Acesso Concedido a: ${profiles.join('; ')}\n`;
    } else {
        data += `🔑 Nenhum perfil específico acessível no momento (verifique as permissões).\n`;
    }
    data += `🚦 Status do Convite/Acesso: *${translateStatus(sharedAccess.status, sharedAccess.status)}*\n`; 
    if (sharedAccess.expiresAt) data += `⏳ Expira em: ${formatDate(sharedAccess.expiresAt)}\n`;

    return data.trim();
}

function formatListSharedAccessDataStructure(accessList, perspective = 'owner') {
    if (!accessList || accessList.length === 0) {
        return perspective === 'owner' ? "🤝 Nenhum acesso concedido por você." : "🤝 Nenhum convite ou acesso recebido.";
    }
    let data = perspective === 'owner' ? "🤝 Acessos que Você Concedeu:\n" : "🤝 Convites/Acessos Recebidos:\n";
    accessList.forEach((sa, index) => {
        data += `\n${index + 1}️⃣ `;
        if (perspective === 'owner') {
            data += `Para: *${sa.sharedWithClient?.name || sa.sharedWithClient?.email || sa.sharedWithUserIdentifier}*`;
        } else {
            data += `De: *${sa.ownerClient?.name || sa.ownerClient?.email}*`;
        }
        let profiles = [];
        if (sa.canAccessPersonalProfile && sa.ownerClient?.financialAccounts?.find(fa => fa.accountType === 'PF')) profiles.push("Perfil Pessoal");
        if (sa.canAccessBusinessProfileId && sa.ownerClient?.financialAccounts?.find(fa => fa.id === sa.canAccessBusinessProfileId)) {
             const bizAccName = sa.ownerClient.financialAccounts.find(fa => fa.id === sa.canAccessBusinessProfileId)?.accountName;
             profiles.push(`Empresarial "${bizAccName}"`);
        }
        if (profiles.length > 0) data += ` (Acesso a: ${profiles.join(', ')})`;
        data += ` - Status: *${translateStatus(sa.status, sa.status)}*\n`;
    });
    return data.trim();
}


function formatMotivationalMessagePreferenceDataStructure(prefs) {
    let data = `💬 Preferências de Mensagem Motivacional:\n\n`;
    data += `🚦 Status: ${prefs.enableMotivationMessage ? 'Ativada ✅' : 'Desativada ❌'}\n`;
    if (prefs.enableMotivationMessage && prefs.motivationMessageTime) {
        data += `🕒 Horário Programado: ${prefs.motivationMessageTime.substring(0,5)}\n`;
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
        data += `🌅 Início: ${prefs.waterReminderStartTime ? prefs.waterReminderStartTime.substring(0,5) : 'N/A'}\n`;
        data += `🌃 Fim: ${prefs.waterReminderEndTime ? prefs.waterReminderEndTime.substring(0,5) : 'N/A'}\n`;
        if (prefs.dailyGoalMl) {
            data += `🎯 Meta Diária: ${prefs.dailyGoalMl}ml\n`;
        }
    }
    return data.trim();
}

function formatFinancialAccountDataStructure(account) {
    if (!account) return "🏦 Resumo da Conta Financeira:\n\nDados não disponíveis.";
    let data = "🏦 Resumo da Conta Financeira:\n\n";
    data += `🏷️ Nome: *${account.accountName || account.name}*\n`;
    data += `🗂️ Tipo: ${account.accountType || account.type}\n`;
    if (account.documentNumber) data += `📄 Documento: ${account.documentNumber}\n`;
    data += `⭐ Padrão: ${account.isDefault ? 'Sim ✅' : 'Não ❌'}\n`;
    data += `🚦 Status: ${translateStatus(account.isActive === false ? 'Inactive' : 'Active')}\n`;
    return data.trim();
}


// --- Funções de Onboarding (Mantidas) ---
function getOnboardingWelcomeNoPlanMessage(clientName) {
    const siteUrl = process.env.PLAN_SITE_URL || "https://map-nocontrole.com.br/#planos";
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
                          `💼 Tipo: ${planDetailsText.split(' (')[0].trim()}\n` +
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
                          `📈 Como você tem o ${planDetailsText.split(' (')[0].trim()}, que tal configurarmos também uma conta para sua empresa (PJ) ou MEI?`;
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

function formatAccountSelectionMessage(clientName, planDetailsText, accounts, ownerNameIfShared = null) {
    let aiIntro = `👋 Que bom te ver por aqui, ${clientName}! ${ownerNameIfShared ? `Você está gerenciando as contas de *${ownerNameIfShared}* e ` : ''}${planDetailsText !== "Nenhum plano ativo" ? `Seu plano ${planDetailsText} está a todo vapor!` : 'Vamos colocar suas finanças em dia?' } 🚀`;
    let dataStructure = `🏦 Contas ${ownerNameIfShared ? `de *${ownerNameIfShared}* ` : ''}configuradas e acessíveis para você:\n`;
    accounts.forEach((acc, index) => {
        dataStructure += `\n${index + 1}️⃣ *${acc.name || acc.accountName}* (${acc.type || acc.accountType})`;
    });
    let linkText = `🤔 Qual delas vamos usar hoje? Me diga o nome começarmos! 😉`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}


// --- Initialize or Update State ---
async function initializeOrUpdateState(client, sharedAccessRecord = null, existingState = null, clientAccountsFromDb = [], ownerAccountsIfShared = []) {
    const clientName = client.name && client.name.trim() !== "" && client.name.trim().toLowerCase() !== "unknown" && client.name.trim().toLowerCase() !== "null"
        ? client.name.split(" ")[0]
        : (pushNameFromPayload || "pessoa incrível");

    let ownerClientIdForContext = client.id;
    let isSharedAccessContext = false;
    let sharedAccessPermissions = null;
    let ownerClientForContext = client;
    let ownerClientNameForContext = clientName; 

    if (sharedAccessRecord) {
        isSharedAccessContext = true;
        ownerClientIdForContext = sharedAccessRecord.ownerClientId;
        sharedAccessPermissions = {
            canAccessPersonalProfile: sharedAccessRecord.canAccessPersonalProfile,
            canAccessBusinessProfileId: sharedAccessRecord.canAccessBusinessProfileId,
        };
        if (sharedAccessRecord.ownerClient) { 
            ownerClientForContext = sharedAccessRecord.ownerClient; 
            ownerClientNameForContext = ownerClientForContext.name ? ownerClientForContext.name.split(" ")[0] : "Dono(a) da Conta";
        } else { 
            const ownerClientTemp = await clientService.getClientContactById(ownerClientIdForContext);
             if(ownerClientTemp) { 
                ownerClientForContext = ownerClientTemp; 
                ownerClientNameForContext = ownerClientTemp.name ? ownerClientTemp.name.split(" ")[0] : "Dono(a) da Conta";
            } else {
                 logger.error(`[InitializeState] CRITICAL: Dono da conta ${ownerClientIdForContext} não encontrado para acesso compartilhado.`);
                ownerClientNameForContext = "Dono(a) da Conta"; 
                ownerClientForContext = { accessLevel: 'gratuito', accessExpiresAt: null, id: ownerClientIdForContext, name: "Dono Desconhecido" }; 
            }
        }
        logger.info(`[WHATSAPP SERVICE - Initialize/UpdateState] Contexto de Acesso Compartilhado ATIVO. Ator: ${client.id} (${clientName}), Dono: ${ownerClientIdForContext} (${ownerClientNameForContext})`);
    }


    let hasPaidAccess = false;
    let clientAccessLevel = ownerClientForContext.accessLevel || 'gratuito';
    let clientAccessExpiresAt = ownerClientForContext.accessExpiresAt;
    let accessLevelTextForUser = "Nenhum plano ativo";
    let onboardingStage = existingState?.data?.onboardingStage || 'awaiting_plan_confirmation';

    if (ownerClientForContext.accessLevel && ownerClientForContext.accessLevel !== 'gratuito') {
        // >>> INÍCIO DA MODIFICAÇÃO 2 (USO DA FUNÇÃO) <<<
        if (ownerClientForContext.accessLevel.startsWith('vitalicio_')) {
            hasPaidAccess = true;
            accessLevelTextForUser = formatPlanName(ownerClientForContext.accessLevel);
        } else if (ownerClientForContext.accessExpiresAt) {
            const expiryDate = new Date(ownerClientForContext.accessExpiresAt + 'T00:00:00Z');
            const today = new Date(); today.setUTCHours(0, 0, 0, 0);
            if (expiryDate >= today) {
                hasPaidAccess = true;
                const planNamePart = formatPlanName(ownerClientForContext.accessLevel);
                accessLevelTextForUser = `${planNamePart} (válido até ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
            } else {
                const planNamePart = formatPlanName(ownerClientForContext.accessLevel);
                accessLevelTextForUser = `Plano ${planNamePart} expirado`;
                clientAccessLevel = 'gratuito';
            }
        // >>> FIM DA MODIFICAÇÃO 2 (USO DA FUNÇÃO) <<<
        } else {
            logger.warn(`[WHATSAPP SERVICE - Initialize/UpdateState] Cliente DONO ${ownerClientForContext.id} com accessLevel ${ownerClientForContext.accessLevel} mas sem accessExpiresAt. Considerando como sem plano pago.`);
            clientAccessLevel = 'gratuito';
        }
    }
   
    const accountsForOperation = isSharedAccessContext ? ownerAccountsIfShared : clientAccountsFromDb;
   
    if (hasPaidAccess) {
        if (onboardingStage === 'awaiting_plan_confirmation' || (existingState && !existingState.hasPaidAccess_whenStageLastSet) ) {
            if (!client.email || !client.passwordHash) {
                onboardingStage = 'setting_up_credentials_email';
            } else { 
                if (!isSharedAccessContext) {
                    const hasPfActor = accountsForOperation.some(acc => acc.accountType === 'PF');
                    if (!hasPfActor) {
                         onboardingStage = 'setting_up_pf_account_name';
                    } else {
                         const hasPjMeiActor = accountsForOperation.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                         const planTier = clientAccessLevel.startsWith('avancado') || clientAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                         if (planTier === 'avancado' && !hasPjMeiActor &&
                             existingState?.data?.onboardingStage !== 'confirming_pj_mei_setup' &&
                             existingState?.data?.onboardingStage !== 'awaiting_pj_mei_type' &&
                             existingState?.data?.onboardingStage !== 'creating_pj_mei_account_name') {
                            onboardingStage = 'confirming_pj_mei_setup';
                         } else {
                            onboardingStage = 'onboarding_complete';
                         }
                    }
                } else { 
                    onboardingStage = 'onboarding_complete';
                }
            }
        }
    } else { 
        onboardingStage = 'awaiting_plan_confirmation';
    }

    let defaultAccount = null;
    if (onboardingStage === 'onboarding_complete' && hasPaidAccess && accountsForOperation.length > 0) {
        defaultAccount = accountsForOperation.find(a=>a.isDefault);
        if (!defaultAccount && accountsForOperation.length === 1) {
            defaultAccount = accountsForOperation[0];
        } else if (!defaultAccount) {
            defaultAccount = accountsForOperation.find(a => a.accountType === 'PF') ||
                             accountsForOperation.find(a => a.accountType === 'PJ') ||
                             accountsForOperation.find(a => a.accountType === 'MEI') ||
                             accountsForOperation[0];
        }
    }


    if (existingState) {
        existingState.clientName = clientName;
        existingState.ownerClientIdForContext = ownerClientIdForContext;
        existingState.ownerClientNameForContext = ownerClientNameForContext;
        existingState.isSharedAccessContext = isSharedAccessContext;
        existingState.sharedAccessPermissions = sharedAccessPermissions;

        existingState.currentAccessLevel = clientAccessLevel;
        existingState.accessExpiresAt = clientAccessExpiresAt;
        existingState.hasPaidAccess = hasPaidAccess;
        existingState.accessLevelTextForUser = accessLevelTextForUser;
       
        if (existingState.data.onboardingStage !== onboardingStage && onboardingStage !== 'onboarding_complete') {
            existingState.currentAction = null;
        }
        existingState.data.onboardingStage = onboardingStage;
        existingState.hasPaidAccess_whenStageLastSet = hasPaidAccess;

        if (onboardingStage === 'onboarding_complete' && hasPaidAccess) {
            const currentActiveStillValid = existingState.activeFinancialAccountId && accountsForOperation.some(acc => acc.id === existingState.activeFinancialAccountId);
            if (!currentActiveStillValid && defaultAccount) {
                existingState.activeFinancialAccountId = defaultAccount.id;
                existingState.activeFinancialAccountName = defaultAccount.accountName || defaultAccount.name;
                existingState.activeFinancialAccountType = defaultAccount.accountType || defaultAccount.type;
            } else if (!currentActiveStillValid && accountsForOperation.length > 0) { // Se não há default mas há contas, força seleção
                existingState.activeFinancialAccountId = null;
                existingState.activeFinancialAccountName = null;
                existingState.activeFinancialAccountType = null;
            } else if (!currentActiveStillValid && accountsForOperation.length === 0) { // Nenhuma conta acessível
                existingState.activeFinancialAccountId = null;
                existingState.activeFinancialAccountName = null;
                existingState.activeFinancialAccountType = null;
            }
        } else { // Se não está onboarding_complete ou não tem plano pago, zera conta ativa
            existingState.activeFinancialAccountId = null;
            existingState.activeFinancialAccountName = null;
            existingState.activeFinancialAccountType = null;
        }
       
        logger.debug(`[WHATSAPP SERVICE - UpdateState] Estado atualizado para ator ${client.id}: `, {
            onboardingStage: existingState.data.onboardingStage,
            currentAction: existingState.currentAction,
            hasPaidAccessDono: existingState.hasPaidAccess,
            activeAccountId: existingState.activeFinancialAccountId,
            activeAccountName: existingState.activeFinancialAccountName,
            accessLevelTextDono: existingState.accessLevelTextForUser,
            isShared: existingState.isSharedAccessContext,
            ownerIdCtx: existingState.ownerClientIdForContext,
        });
        return existingState;
    }

    const newState = {
        currentAction: null,
        data: { onboardingStage },
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? (defaultAccount.accountName || defaultAccount.name) : null,
        activeFinancialAccountType: defaultAccount ? (defaultAccount.accountType || defaultAccount.type) : null,
        clientName: clientName,
        ownerClientIdForContext: ownerClientIdForContext,
        ownerClientNameForContext: ownerClientNameForContext,
        isSharedAccessContext: isSharedAccessContext,
        sharedAccessPermissions: sharedAccessPermissions,
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null,
        lastAiResponse: null,
        currentAccessLevel: clientAccessLevel,
        accessExpiresAt: clientAccessExpiresAt,
        hasPaidAccess: hasPaidAccess,
        accessLevelTextForUser: accessLevelTextForUser,
        hasPaidAccess_whenStageLastSet: hasPaidAccess,
    };
   
    logger.debug(`[WHATSAPP SERVICE - InitializeState] Novo estado criado para ator ${client.id}: `, {
        onboardingStage: newState.data.onboardingStage,
        hasPaidAccessDono: newState.hasPaidAccess,
        accessLevelTextDono: newState.accessLevelTextForUser,
        activeAccountId: newState.activeFinancialAccountId,
        isShared: newState.isSharedAccessContext,
        ownerIdCtx: newState.ownerClientIdForContext,
    });
    return newState;
}

/**
 * Processa uma mensagem de áudio recebida.
 * Baixa o áudio, transcreve e, se bem-sucedido, chama processIncomingMessage com o texto.
 */
async function processIncomingAudioMessage(senderPhoneRaw, mediaUrl, mimeType, pushName, rawPayload) {
    // >>> INÍCIO DA MODIFICAÇÃO <<<
    // O nome do parâmetro foi mudado para 'senderPhoneRaw' para clareza.
    // Aplicamos a normalização universal imediatamente.
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);

    if (!canonicalPhone) {
        logger.error(`[WHATSAPP SERVICE] Falha ao normalizar o telefone para MENSAGEM DE ÁUDIO: ${senderPhoneRaw}`);
        return; // Aborta o processamento se o número for inválido.
    }
    // >>> FIM DA MODIFICAÇÃO <<<

    logger.info(`[WHATSAPP SERVICE] Processando mensagem de áudio de ${canonicalPhone}. URL: ${mediaUrl}`);
    pushNameFromPayload = pushName; 
    
    let filenameFromMime = 'audio.ogg'; 
    if (mimeType) { 
        if (mimeType.includes('opus')) filenameFromMime = 'audio.opus';
        else if (mimeType.includes('aac')) filenameFromMime = 'audio.aac';
        else if (mimeType.includes('mpeg')) filenameFromMime = 'audio.mp3';
        else if (mimeType.includes('amr')) filenameFromMime = 'audio.amr';
    }
     try {
        const urlPath = new URL(mediaUrl).pathname;
        const baseName = path.basename(urlPath);
        if (baseName && baseName.includes('.')) { 
             filenameFromMime = baseName; 
        }
    } catch (e) { 
        logger.warn(`[WHATSAPP SERVICE] Não foi possível parsear a URL para extrair nome do arquivo da mídia: ${mediaUrl}. Usando nome inferido: ${filenameFromMime}`);
    }

    try {
        // Enviar mensagem de "processando áudio"
        const processingMessage = `🎧 Opa, ${pushName || 'você'}! Já recebi seu áudio e tô aqui processando tudinho com carinho! 💻✨\nSó um segundinho 😉`;
        await sendWhatsappMessage(canonicalPhone, processingMessage); // Usa o número canônico

        const downloadedMedia = await downloadZapiMedia(mediaUrl); 
        
        if (downloadedMedia && downloadedMedia.stream) {
            const finalFilenameForWhisper = downloadedMedia.filename && downloadedMedia.filename.includes('.')
                ? downloadedMedia.filename
                : filenameFromMime;

            logger.info(`[WHATSAPP SERVICE] Áudio baixado, enviando para transcrição com nome de arquivo: ${finalFilenameForWhisper}`);
            const transcribedText = await aiModelService.transcribeAudioStream(downloadedMedia.stream, finalFilenameForWhisper);

            if (transcribedText && transcribedText.trim() !== "") {
                logger.info(`[WHATSAPP SERVICE] Áudio de ${canonicalPhone} transcrito com sucesso. Chamando processIncomingMessage com o texto.`);
                // Chama a próxima função JÁ com o número canônico
                return await processIncomingMessage(canonicalPhone, transcribedText, pushName, rawPayload);
            } else {
                logger.warn(`[WHATSAPP SERVICE] Transcrição do áudio de ${canonicalPhone} resultou em texto vazio. Notificando usuário.`);
                await sendWhatsappMessage(canonicalPhone, "Não consegui entender o áudio que você enviou. 🤫 Pode tentar gravar novamente ou digitar, por favor?");
            }
        } else {
            logger.error(`[WHATSAPP SERVICE] Falha ao baixar áudio de ${canonicalPhone} da URL: ${mediaUrl}. Notificando usuário.`);
            await sendWhatsappMessage(canonicalPhone, "Tive um problema ao acessar o áudio que você enviou. 🙁 Poderia tentar novamente?");
        }
    } catch (transcriptionError) {
        logger.error(`[WHATSAPP SERVICE] Erro ao transcrever áudio de ${canonicalPhone}: ${transcriptionError.message}`, {stack: transcriptionError.stack});
        await sendWhatsappMessage(canonicalPhone, "Puxa, tive um probleminha para processar seu áudio. 😵‍💫 Pode tentar de novo ou digitar sua mensagem?");
    } finally {
        pushNameFromPayload = null; 
    }
}

async function processIncomingMessage(senderPhoneRaw, messageText, pushName, rawPayload) {
    // >>> INÍCIO DA MODIFICAÇÃO <<<
    // O nome do parâmetro foi mudado para 'senderPhoneRaw' para clareza.
    // Aplicamos a normalização universal imediatamente.
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);

    if (!canonicalPhone) {
        logger.error(`[WHATSAPP HANDLER] Falha ao normalizar o telefone para MENSAGEM DE TEXTO: ${senderPhoneRaw}`);
        return; // Aborta o processamento se o número for inválido.
    }
    // A partir daqui, a variável 'senderPhone' será o nosso número canônico e seguro.
    const senderPhone = canonicalPhone;
    // >>> FIM DA MODIFICAÇÃO <<<

    if (!pushNameFromPayload && pushName) { 
        pushNameFromPayload = pushName;
    }
    
    // const senderPhone = senderPhoneNormalized; // Esta linha não é mais necessária, já definimos acima
    const startTime = Date.now();
    let state;
    let actorClient; 

    try {
        actorClient = await clientService.findClientByPhone(senderPhone); // JÁ USA O NÚMERO CORRETO
        let sharedAccessRecord = null;
        let ownerClientIdForContext; 
        let clientAccountsForOnboarding = [];
        let ownerAccountsIfShared = [];

        if (actorClient) {
            ownerClientIdForContext = actorClient.id; 
            clientAccountsForOnboarding = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
        } else {
            sharedAccessRecord = await sharedAccessService.findActiveSharedAccessByPhone(senderPhone); // JÁ USA O NÚMERO CORRETO
            
            if (sharedAccessRecord && sharedAccessRecord.sharedWithClient) {
                actorClient = sharedAccessRecord.sharedWithClient; 
                ownerClientIdForContext = sharedAccessRecord.ownerClientId; 
                
                if (!actorClient.status || actorClient.status !== 'Ativo') {
                     logger.warn(`[WHATSAPP SERVICE] SharedAccess para ${senderPhone}, mas convidado (ator) ${actorClient.id} está inativo.`);
                     await sendWhatsappMessage(senderPhone, "Olá! Seu acesso a esta conta compartilhada não está ativo. Por favor, contate o proprietário.");
                     return;
                }
                if (!sharedAccessRecord.ownerClient || sharedAccessRecord.ownerClient.status !== 'Ativo') {
                    logger.warn(`[WHATSAPP SERVICE] SharedAccess para ${senderPhone}, mas proprietário ${ownerClientIdForContext} está inativo.`);
                    await sendWhatsappMessage(senderPhone, "Olá! O proprietário da conta que compartilhou este acesso parece não estar ativo. Tente mais tarde ou contate-o.");
                    return;
                }
                
                const allOwnerAccounts = await clientService.getClientFinancialAccounts(ownerClientIdForContext, { isActive: true });
                if (sharedAccessRecord.canAccessPersonalProfile) {
                    const pfAccount = allOwnerAccounts.find(acc => acc.accountType === 'PF');
                    if (pfAccount) ownerAccountsIfShared.push(pfAccount);
                }
                if (sharedAccessRecord.canAccessBusinessProfileId) {
                    const bizAccount = allOwnerAccounts.find(acc => acc.id === sharedAccessRecord.canAccessBusinessProfileId);
                    if (bizAccount) ownerAccountsIfShared.push(bizAccount);
                }

                if (ownerAccountsIfShared.length === 0 ) { 
                    if(sharedAccessRecord.canAccessPersonalProfile || sharedAccessRecord.canAccessBusinessProfileId){
                        logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas nenhuma conta do dono acessível encontrada (mesmo com permissões). Proprietário pode não ter contas do tipo permitido.`);
                        await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado para as contas de ${sharedAccessRecord.ownerClient?.name || 'um usuário'}, mas parece que o proprietário não possui contas ativas do tipo que você pode acessar (Pessoal ou o Empresarial específico). Peça para ele verificar, por favor! 😉`);
                    } else {
                        logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas NENHUMA permissão de acesso a perfil foi dada no sharedAccessRecord.`);
                        await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado para as contas de ${sharedAccessRecord.ownerClient?.name || 'um usuário'}, mas parece que nenhuma permissão para acessar perfis específicos (Pessoal ou Empresarial) foi configurada. Peça para ele verificar as permissões, por favor! 😉`);
                    }
                    return;
                }

            } else { 
                logger.info(`[WHATSAPP SERVICE] Telefone ${senderPhone} não reconhecido. Criando novo cliente...`);
                actorClient = await clientService.createClientContact({ phone: senderPhone, name: pushNameFromPayload || pushName }); // JÁ USA O NÚMERO CORRETO
                ownerClientIdForContext = actorClient.id; 
                
                const welcomeMsg = getOnboardingWelcomeNoPlanMessage(actorClient.name ? actorClient.name.split(" ")[0] : (pushNameFromPayload || pushName || "você"));
                await sendWhatsappMessage(senderPhone, welcomeMsg);
                
                const tempStateForNewUser = await initializeOrUpdateState(actorClient, null, null, [], []);
                tempStateForNewUser.data.onboardingStage = 'awaiting_plan_confirmation';
                tempStateForNewUser.currentAction = 'awaiting_plan_interest_generic';
                conversationState.set(senderPhone, tempStateForNewUser);
                pushNameFromPayload = null; 
                return;
            }
        }
        
        // ... (O RESTO DA FUNÇÃO CONTINUA EXATAMENTE IGUAL, POIS ELA JÁ USA A VARIÁVEL 'senderPhone' CORRETAMENTE) ...
        // ... (Todo o seu código de state, onboarding, switch case, etc., permanece aqui) ...

        const existingState = conversationState.get(senderPhone);
        state = await initializeOrUpdateState(actorClient, sharedAccessRecord, existingState, clientAccountsForOnboarding, ownerAccountsIfShared);
        
        let isNewUserForSessionLogic = !existingState; 

        const clientNameToUse = state.clientName; 

        if (!(rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string')) {
            state.messageHistory.push({ role: 'user', content: messageText || "" }); 
        }
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }
       
        let onboardingReply = "";
        const lowerMessageText = (messageText || "").toLowerCase().trim(); 
       
        logger.debug(`[WHATSAPP ONBOARDING ENTRY] Ator: ${actorClient.id} (${clientNameToUse}), DonoCtx: ${state.ownerClientIdForContext} (${state.ownerClientNameForContext}), Stage (Ator): ${state.data.onboardingStage}, currentAction: ${state.currentAction}, hasPaidAccess (Dono): ${state.hasPaidAccess}, accessLevelText (Dono): ${state.accessLevelTextForUser}, isShared: ${state.isSharedAccessContext}`);

        if (state.data.onboardingStage === 'awaiting_plan_confirmation') {
            if(state.hasPaidAccess_whenStageLastSet || isNewUserForSessionLogic === false) {
                onboardingReply = getOnboardingWelcomeNoPlanMessage(clientNameToUse);
            }
            state.currentAction = 'awaiting_plan_interest_generic';
        } else if (state.data.onboardingStage === 'setting_up_credentials_email') {
             if (state.currentAction !== 'awaiting_input_email_for_credentials' || isNewUserForSessionLogic) {
                 onboardingReply = getOnboardingAskForEmailMessage(clientNameToUse, state.accessLevelTextForUser);
                 state.currentAction = 'awaiting_input_email_for_credentials';
            } else { 
                const emailInput = messageText.trim();
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (emailRegex.test(emailInput)) {
                    state.data.tempEmail = emailInput;
                    onboardingReply = getOnboardingAskForPasswordMessage(clientNameToUse, emailInput);
                    state.data.onboardingStage = 'setting_up_credentials_password';
                    state.currentAction = 'awaiting_input_password_for_credentials';
                } else {
                    onboardingReply = `Opa, ${clientNameToUse}! Esse e-mail não me pareceu muito certo... 🤔 Poderia tentar de novo, por favor? Algo como "seu_nome@exemplo.com".`;
                }
            }
        } else if (state.data.onboardingStage === 'setting_up_credentials_password') {
            const passwordInput = messageText.trim();
            if (passwordInput.length >= 6) {
                state.data.tempPassword = passwordInput;
                onboardingReply = getOnboardingAskForFullNameMessage(clientNameToUse);
                state.data.onboardingStage = 'setting_up_credentials_name';
                state.currentAction = 'awaiting_input_name_for_credentials';
            } else {
                onboardingReply = `Para sua segurança, ${clientNameToUse}, a senha precisa ter pelo menos 6 caracteres. 😉 Pode me dizer uma senha um pouquinho maior?`;
            }
        } else if (state.data.onboardingStage === 'setting_up_credentials_name') {
            const nameInput = messageText.trim();
            if (nameInput.length >= 3 && nameInput.includes(" ")) {
                try {
                    await clientAuthService.setClientCredentials(actorClient.phone, state.data.tempPassword, nameInput, state.data.tempEmail);
                    const updatedActorClient = await clientService.findClientByPhone(actorClient.phone);
                    if (updatedActorClient) actorClient = updatedActorClient;
                    state.clientName = actorClient.name.split(" ")[0];
                    logger.info(`[WHATSAPP ONBOARDING] Credenciais definidas para ATOR ${actorClient.phone}.`);
                    delete state.data.tempEmail; delete state.data.tempPassword;
                   
                    if (!state.isSharedAccessContext) {
                        const actorAccounts = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
                        const hasPfActor = actorAccounts.some(acc => acc.accountType === 'PF');
                        if (!hasPfActor) {
                            state.data.onboardingStage = 'setting_up_pf_account_name';
                            onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
                            state.currentAction = 'awaiting_input_pf_name';
                        } else {
                            const hasPjMeiActor = actorAccounts.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                            const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                            if (planTier === 'avancado' && !hasPjMeiActor) {
                                state.data.onboardingStage = 'confirming_pj_mei_setup';
                                const pfAccName = actorAccounts.find(a => a.accountType === 'PF')?.accountName || "Pessoal";
                                onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, pfAccName, state.accessLevelTextForUser);
                                state.currentAction = 'awaiting_pj_mei_confirm';
                            } else {
                                state.data.onboardingStage = 'onboarding_complete';
                                const aiIntro = `Uhuul, ${clientNameToUse}! Tudo certo com seu acesso e credenciais! 🎉`;
                                const dataStructure = `💼 O plano ${state.accessLevelTextForUser} ${state.isSharedAccessContext ? `de ${state.ownerClientNameForContext} ` : ''}está pronto para uso!`;
                                const linkText = `Como posso te ajudar agora? 🚀`;
                                onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                                state.currentAction = null;
                            }
                        }
                    } else { 
                        state.data.onboardingStage = 'onboarding_complete';
                        const aiIntro = `Maravilha, ${clientNameToUse}! Suas credenciais estão configuradas! 🎉`;
                        const dataStructure = `Agora você pode acessar as contas de ${state.ownerClientNameForContext} com o plano ${state.accessLevelTextForUser}.`;
                        const linkText = `Vamos ver quais contas estão disponíveis?`;
                        onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                        state.currentAction = 'selecting_account_flow_active'; 
                        state.activeFinancialAccountId = null; 
                    }
                } catch (e) { 
                    logger.error(`[WHATSAPP ONBOARDING] Erro ao definir credenciais para ATOR ${actorClient.phone}: ${e.message}`);
                    if (e.message && e.message.toLowerCase().includes('email já está em uso')) {
                         onboardingReply = `Puxa, ${clientNameToUse}, parece que o e-mail "${state.data.tempEmail}" já está sendo usado por outra pessoa. 😬 Você teria outro e-mail para cadastrarmos?`;
                         state.data.onboardingStage = 'setting_up_credentials_email';
                         state.currentAction = 'awaiting_input_email_for_credentials';
                         delete state.data.tempEmail; delete state.data.tempPassword;
                    } else {
                        onboardingReply = `Xi, ${clientNameToUse}, algo não saiu como o esperado ao salvar seus dados (${e.message.substring(0,60)}). 😥 Vamos tentar seu nome completo de novo?`;
                    }
                }
            } else {
                onboardingReply = `Para um toque mais pessoal, ${clientNameToUse}, poderia me dizer seu nome completo? ✨ Assim fica mais bacana no seu perfil!`;
            }
        } else if (state.data.onboardingStage === 'setting_up_pf_account_name') {
             if (state.isSharedAccessContext) { 
                state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null;
            } else if (state.currentAction !== 'awaiting_input_pf_name' || isNewUserForSessionLogic) {
                onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
                state.currentAction = 'awaiting_input_pf_name';
            } else { 
                const pfAccountName = messageText.trim();
                if (pfAccountName.length >= 3 && pfAccountName.length <= 50) {
                    try {
                        const newPfAccount = await clientService.createFinancialAccount(actorClient.id, {
                            accountName: pfAccountName, accountType: 'PF', isDefault: true
                        });
                        state.activeFinancialAccountId = newPfAccount.id;
                        state.activeFinancialAccountName = newPfAccount.accountName;
                        state.activeFinancialAccountType = newPfAccount.accountType;
                        logger.info(`[WHATSAPP ONBOARDING] Conta PF "${pfAccountName}" criada para ATOR ${actorClient.phone}.`);
                       
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
                        logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta PF "${pfAccountName}" para ATOR ${actorClient.phone}: ${e.message}`);
                        onboardingReply = `Opa! 😬 Tive um probleminha para criar a conta "${pfAccountName}" (${e.message.substring(0,60)}). Que tal a gente tentar um nome diferente?`;
                    }
                } else {
                    onboardingReply = `Esse nome parece um pouquinho curto ou um cadinho longo demais, ${clientNameToUse}. Para sua conta Pessoal, que tal um nome entre 3 e 50 letras? Assim fica perfeito! ✍️`;
                }
            }
        } else if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
            if (state.isSharedAccessContext) {
                state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null;
             } else if (state.currentAction !== 'awaiting_pj_mei_confirm' || isNewUserForSessionLogic) {
                const actorPFAccount = (await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true })).find(a => a.accountType === 'PF');
                onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, actorPFAccount?.accountName || "Pessoal", state.accessLevelTextForUser);
                state.currentAction = 'awaiting_pj_mei_confirm';
            } else { 
                const userResponseLower = lowerMessageText;
                let wantsPjMei = false; let pjMeiType = null;
   
                if (userResponseLower.includes("sim") || userResponseLower === "pj" || userResponseLower === "mei" || userResponseLower.includes("quero") || userResponseLower.includes("bora")) {
                    wantsPjMei = true;
                    if (userResponseLower.includes("pj")) pjMeiType = "PJ";
                    else if (userResponseLower.includes("mei")) pjMeiType = "MEI";
                }
   
                if (wantsPjMei) {
                    if (pjMeiType) {
                        state.data.tempPjMeiType = pjMeiType;
                        onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameToUse, pjMeiType);
                        state.data.onboardingStage = 'creating_pj_mei_account_name';
                        state.currentAction = 'awaiting_input_pj_mei_name';
                    } else {
                        onboardingReply = getOnboardingAskForPJTypeMessage(clientNameToUse);
                        state.data.onboardingStage = 'awaiting_pj_mei_type';
                        state.currentAction = 'awaiting_input_pj_mei_type';
                    }
                } else {
                    const aiIntro = `Tranquilo, ${clientNameToUse}! Sem pressa. Se mais pra frente você quiser adicionar sua conta empresarial, é só me avisar! 😉`;
                    const dataStructure = `Sua conta "${state.activeFinancialAccountName || 'Pessoal'}" está prontinha para uso com seu plano ${state.accessLevelTextForUser}!`;
                    const linkText = `O que você gostaria de fazer primeiro? Estou a postos! 🚀`;
                    onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = null;
                }
            }
        } else if (state.data.onboardingStage === 'awaiting_pj_mei_type') {
            if (state.isSharedAccessContext) { state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null; }
            else {
                const typeInput = messageText.trim().toUpperCase();
                if (typeInput === 'PJ' || typeInput === 'MEI') {
                    state.data.tempPjMeiType = typeInput;
                    onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameToUse, typeInput);
                    state.data.onboardingStage = 'creating_pj_mei_account_name';
                    state.currentAction = 'awaiting_input_pj_mei_name';
                } else {
                    onboardingReply = `Por favor, ${clientNameToUse}, me diga se é "PJ" ou "MEI" para sua conta empresarial. Assim a gente configura tudo certinho! 😊`;
                }
            }
        } else if (state.data.onboardingStage === 'creating_pj_mei_account_name') {
            if (state.isSharedAccessContext) { state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null; }
            else {
                const companyName = messageText.trim();
                const companyType = state.data.tempPjMeiType;
                if (companyName.length >= 3 && companyName.length <= 50) {
                    try {
                        await clientService.createFinancialAccount(actorClient.id, { 
                            accountName: companyName, accountType: companyType, isDefault: false
                        });
                        const personalAccountName = state.activeFinancialAccountName || (await clientService.getClientFinancialAccounts(actorClient.id, {isActive:true})).find(a => a.accountType === 'PF')?.accountName || "Pessoal";
                        onboardingReply = getOnboardingCompanyCreatedMessage(clientNameToUse, companyType, companyName, personalAccountName);
                        logger.info(`[WHATSAPP ONBOARDING] Conta ${companyType} "${companyName}" criada para ATOR ${actorClient.phone}.`);
                        state.data.onboardingStage = 'onboarding_complete';
                        state.currentAction = null; delete state.data.tempPjMeiType;
                    } catch (e) {
                        logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta ${companyType} "${companyName}" para ATOR ${actorClient.phone}: ${e.message}`);
                        onboardingReply = `Eita! 😬 Parece que não consegui criar a conta ${companyType} "${companyName}" (${e.message.substring(0,60)}). Será que podemos tentar um nome um pouquinho diferente?`;
                    }
                } else {
                    onboardingReply = `Para o nome da sua ${companyType}, ${clientNameToUse}, que tal algo entre 3 e 50 letras? Assim fica bem bacana! 🌟`;
                }
            }
        }


        if (onboardingReply) {
            state.messageHistory.push({ role: 'assistant', content: onboardingReply });
            await sendWhatsappMessage(senderPhone, onboardingReply);
            conversationState.set(senderPhone, state);
            if (state.data.onboardingStage !== 'onboarding_complete' && state.currentAction !== null) {
                pushNameFromPayload = null; // Limpa após o uso
                return;
            }
        }
       
        if (state.data.onboardingStage === 'onboarding_complete' || !onboardingReply) {
            if (state.data.onboardingStage === 'onboarding_complete' && state.currentAction &&
                (state.currentAction.startsWith('awaiting_input_') || state.currentAction.startsWith('awaiting_pj_mei_') || state.currentAction.startsWith('awaiting_plan_'))) {
                state.currentAction = null;
            }
           
            if (state.data.onboardingStage === 'onboarding_complete' && !state.activeFinancialAccountId) {
                const accountsForSelection = state.isSharedAccessContext
                    ? ownerAccountsIfShared
                    : await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });

                if (accountsForSelection.length > 0) {
                    if (accountsForSelection.length === 1) {
                        const acc = accountsForSelection[0];
                        state.activeFinancialAccountId = acc.id;
                        state.activeFinancialAccountName = acc.accountName || acc.name;
                        state.activeFinancialAccountType = acc.accountType || acc.type;
                        const ownerNameText = state.isSharedAccessContext ? `de ${state.ownerClientNameForContext} ` : '';
                        const aiIntro = `Tudo pronto, ${clientNameToUse}! 🎉`;
                        const dataStructure = `A conta "${state.activeFinancialAccountName}" (${state.activeFinancialAccountType}) ${ownerNameText}já está selecionada. O plano ${state.accessLevelTextForUser} está ativo.`;
                        const linkText = `Como posso te ajudar a organizar suas finanças hoje? 🚀`;
                        const selectMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                        state.messageHistory.push({ role: 'assistant', content: selectMsg });
                        state.currentAction = null;
                        if(state.data) state.data.accountsToList = null;
                        await sendWhatsappMessage(senderPhone, selectMsg);
                    } else if (state.currentAction !== 'selecting_account_flow_active') {
                        state.currentAction = 'selecting_account_flow_active';
                        state.data.accountsToList = accountsForSelection.map(a => ({id: a.id, name: a.accountName || a.name, type: a.accountType || a.type}));
                        const ownerNameForMsg = state.isSharedAccessContext ? state.ownerClientNameForContext : null;
                        const accountOptionsText = formatAccountSelectionMessage(clientNameToUse, state.accessLevelTextForUser, state.data.accountsToList, ownerNameForMsg);
                        state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                        await sendWhatsappMessage(senderPhone, accountOptionsText);
                    } else {
                        const chosenIdentifier = messageText.trim();
                        let accountToSelect = null;
                        const chosenNumber = parseInt(chosenIdentifier, 10);

                        if (state.data.accountsToList && !isNaN(chosenNumber) && chosenNumber > 0 && chosenNumber <= state.data.accountsToList.length) {
                            accountToSelect = state.data.accountsToList[chosenNumber - 1];
                        } else if (state.data.accountsToList) {
                            accountToSelect = state.data.accountsToList.find(acc =>
                                acc.name.toLowerCase() === chosenIdentifier.toLowerCase() ||
                                acc.name.toLowerCase().includes(chosenIdentifier.toLowerCase())
                            );
                        }

                        if (accountToSelect) {
                            state.activeFinancialAccountId = accountToSelect.id;
                            state.activeFinancialAccountName = accountToSelect.name;
                            state.activeFinancialAccountType = accountToSelect.type;
                            const ownerNameText = state.isSharedAccessContext ? `de ${state.ownerClientNameForContext} ` : '';
                            const aiIntro = `Maravilha, ${clientNameToUse}!`;
                            const dataStructure = `Selecionei a conta "${state.activeFinancialAccountName}" ${ownerNameText}para você.`;
                            const linkText = `Como posso te ajudar a colocar tudo em ordem agora? 🚀`;
                            const confirmSelectionMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                            state.messageHistory.push({ role: 'assistant', content: confirmSelectionMsg });
                            state.currentAction = null;
                            if(state.data) state.data.accountsToList = null;
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
                        }
                    }
                    conversationState.set(senderPhone, state);
                    if (state.currentAction === 'selecting_account_flow_active' || !state.activeFinancialAccountId) {
                         pushNameFromPayload = null; return;
                    }
                } else if (!state.isSharedAccessContext) {
                    const aiIntro = `Olá ${clientNameToUse}! Seu plano ${state.accessLevelTextForUser} está tinindo, mas não encontrei nenhuma conta financeira sua.`;
                    const dataStructure = `Vamos criar sua conta Pessoal agora?`;
                    const linkText = `Diga "criar conta pessoal"! 😉`;
                    const noAccountsMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                    state.messageHistory.push({ role: 'assistant', content: noAccountsMsg });
                    state.data.onboardingStage = 'setting_up_pf_account_name';
                    state.currentAction = 'awaiting_input_pf_name';
                    await sendWhatsappMessage(senderPhone, noAccountsMsg);
                    conversationState.set(senderPhone, state);
                    pushNameFromPayload = null; return;
                } else {
                     logger.error(`[WHATSAPP HANDLER CRITICAL] Ator ${clientNameToUse} em acesso compartilhado, onboarding completo, mas NENHUMA conta do dono (${state.ownerClientIdForContext}) acessível ANTES DE CHAMAR A IA.`);
                     await sendWhatsappMessage(senderPhone, `Olá ${clientNameToUse}! Parece que ${state.ownerClientNameForContext} não tem contas financeiras ativas ou acessíveis para você no momento. Por favor, peça para ele verificar. 🙏`);
                     pushNameFromPayload = null; return;
                }
            }


            if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
                 const buttonId = rawPayload.selectedButtonId;
                logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ID '${buttonId}', Texto (label): '${messageText}'`);
                let buttonClickHandledByServiceLogic = true;
                let aiMessageIntroForButton = "";
                let structuredDataBodyForButton = "";
                let platformLinkFooterForButton = formatPlatformLink();
                let resourceTypeForEditMessage = "item";
                
                const isOwnerContextForEditDelete = !state.isSharedAccessContext; 

                if (buttonId.startsWith('edit_')) {
                    if (!isOwnerContextForEditDelete) {
                        aiMessageIntroForButton = `Ops, ${clientNameToUse}! 😬`;
                        structuredDataBodyForButton = "Em acessos compartilhados, apenas o proprietário pode fazer edições. Você pode visualizar os dados ou pedir para o dono da conta fazer a alteração!";
                        platformLinkFooterForButton = "";
                    } else {
                        if (buttonId.startsWith('edit_transaction_')) {
                            const transactionId = buttonId.replace('edit_transaction_', '');
                            state.editingResource = { type: 'transaction', id: transactionId };
                            resourceTypeForEditMessage = "transação";
                            aiMessageIntroForButton = `Claro, ${clientNameToUse}! 😉`;
                            structuredDataBodyForButton = `Descreva na próxima mensagem o que você precisa que eu altere na ${resourceTypeForEditMessage} (ID: ${transactionId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                            platformLinkFooterForButton = "";
                            state.currentAction = 'awaiting_transaction_edit_details';
                        } else if (buttonId.startsWith('edit_appointment_')) {
                            const appointmentId = buttonId.replace('edit_appointment_', '');
                            state.editingResource = { type: 'appointment', id: appointmentId };
                            resourceTypeForEditMessage = "compromisso";
                            aiMessageIntroForButton = `Beleza, ${clientNameToUse}! ✨`;
                            structuredDataBodyForButton = `Me diga na próxima mensagem o que você quer mudar no ${resourceTypeForEditMessage} (ID: ${appointmentId}).`;
                            platformLinkFooterForButton = "";
                            state.currentAction = 'awaiting_appointment_edit_details';
                        } else if (buttonId.startsWith('edit_credit_card_')) {
                            const cardId = buttonId.replace('edit_credit_card_', '');
                            state.editingResource = { type: 'credit_card', id: cardId };
                            resourceTypeForEditMessage = "cartão de crédito";
                            aiMessageIntroForButton = `Entendido, ${clientNameToUse}! 💳`;
                            structuredDataBodyForButton = `O que você gostaria de alterar no ${resourceTypeForEditMessage} (ID: ${cardId})? Pode me dizer, por exemplo: "mudar o limite para 3000" ou "atualizar o dia de fechamento para 25".`;
                            platformLinkFooterForButton = "";
                            state.currentAction = 'awaiting_credit_card_edit_details';
                        } else if (buttonId.startsWith('edit_recurring_rule_')) {
                            const ruleId = buttonId.replace('edit_recurring_rule_', '');
                            state.editingResource = { type: 'recurring_rule', id: ruleId };
                            resourceTypeForEditMessage = "regra de recorrência";
                            aiMessageIntroForButton = `Certo, ${clientNameToUse}! 🔄`;
                            structuredDataBodyForButton = `O que vamos ajustar na ${resourceTypeForEditMessage} (ID: ${ruleId})? Por exemplo: "mudar o valor para 60" ou "alterar a frequência para mensal".`;
                            platformLinkFooterForButton = "";
                            state.currentAction = 'awaiting_recurring_rule_edit_details';
                        } else if (buttonId.startsWith('edit_product_')) {
                            const productId = buttonId.replace('edit_product_', '');
                            state.editingResource = { type: 'product', id: productId };
                            aiMessageIntroForButton = `Beleza, ${clientNameToUse}! 🛍️`;
                            structuredDataBodyForButton = `O que você gostaria de alterar no produto (ID: ${productId})? Por exemplo: "mudar o preço de venda para 150" ou "atualizar o estoque mínimo para 10".`;
                            platformLinkFooterForButton = "";
                            state.currentAction = 'awaiting_product_edit_details';
                        } else if (buttonId.startsWith('edit_parcelled_account_')) {
                            const originalAccountId = buttonId.replace('edit_parcelled_account_', '');
                            const parcelGroupInfo = await financialService.getTransactionById(state.activeFinancialAccountId, originalAccountId);
                            let originalDescriptionForEdit = "sua compra parcelada";
                            if (parcelGroupInfo) {
                                originalDescriptionForEdit = parcelGroupInfo.isParcel && parcelGroupInfo.originalAccountId === parcelGroupInfo.id 
                                    ? parcelGroupInfo.description.replace(/ - Parcela \d+\/\d+$/, '').trim() 
                                    : parcelGroupInfo.description;
                            }
                            state.editingResource = { type: 'parcelled_account', id: originalAccountId, originalDescription: originalDescriptionForEdit };
                            aiMessageIntroForButton = `Ok, ${clientNameToUse}! Você quer editar a compra parcelada de "${originalDescriptionForEdit}".`;
                            structuredDataBodyForButton = `O que gostaria de alterar? Você pode me dizer os novos detalhes, como por exemplo: "mudar para R$250 em 5x no cartão XP com nova descrição 'Presente Dia das Mães'".\n\nLembre-se que alterar valor, número de parcelas ou o cartão irá refazer essa compra com os novos dados. Se quiser mudar apenas a descrição, diga "mudar descrição para [nova descrição]".`;
                            platformLinkFooterForButton = "";
                            state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                        } else { buttonClickHandledByServiceLogic = false; }
                    }
                } else if (buttonId.startsWith('delete_')) {
                     if (!isOwnerContextForEditDelete) {
                        aiMessageIntroForButton = `Ops, ${clientNameToUse}! 😬`;
                        structuredDataBodyForButton = "Em acessos compartilhados, apenas o proprietário pode excluir itens. Você pode pedir para o dono da conta fazer a remoção!";
                        platformLinkFooterForButton = "";
                    } else {
                         if (buttonId.startsWith('delete_transaction_')) {
                            const transactionId = buttonId.replace('delete_transaction_', '');
                            try {
                                await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId, actorClient.id);
                                aiMessageIntroForButton = `Transação removida com sucesso, ${clientNameToUse}! 👍`;
                                structuredDataBodyForButton = "Se precisar de mais alguma coisa, é só chamar.";
                            } catch (e) { 
                                logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                                aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a transação.`;
                                structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                             }
                        } else if (buttonId.startsWith('delete_appointment_')) {
                            const appointmentId = buttonId.replace('delete_appointment_', '');
                            try {
                                await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, true, actorClient.id);
                                aiMessageIntroForButton = `Compromisso removido da sua agenda, ${clientNameToUse}! ✅`;
                            } catch (e) { 
                                logger.error(`[WHATSAPP SERVICE] Erro ao excluir compromisso ${appointmentId} por botão: ${e.message}`);
                                aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir o compromisso.`;
                                structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                             }
                        } else if (buttonId.startsWith('delete_credit_card_')) {
                            const cardId = buttonId.replace('delete_credit_card_', '');
                            try {
                                await creditCardService.deleteCreditCard(state.activeFinancialAccountId, cardId, actorClient.id);
                                aiMessageIntroForButton = `Cartão de crédito removido, ${clientNameToUse}! 🗑️`;
                            } catch (e) { 
                                logger.error(`[WHATSAPP SERVICE] Erro ao excluir cartão ${cardId} por botão: ${e.message}`);
                                aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir o cartão.`;
                                structuredDataBodyForButton = `Detalhe: ${e.message.includes("transações") ? "Ele ainda tem transações associadas." : `(${e.message.substring(0,70)})` }`;
                            }
                        } else if (buttonId.startsWith('delete_recurring_rule_')) {
                            const ruleId = buttonId.replace('delete_recurring_rule_', '');
                            try {
                                await recurringTransactionService.deleteRecurringRule(state.activeFinancialAccountId, ruleId, actorClient.id);
                                aiMessageIntroForButton = `Regra de recorrência removida, ${clientNameToUse}! 👍`;
                            } catch (e) { 
                                logger.error(`[WHATSAPP SERVICE] Erro ao excluir regra ${ruleId} por botão: ${e.message}`);
                                aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a regra.`;
                                structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                            }
                        } else if (buttonId.startsWith('delete_parcelled_account_')) {
                            const originalAccountId = buttonId.replace('delete_parcelled_account_', '');
                            try {
                                await financialService.deleteParcelledAccountGroup(state.activeFinancialAccountId, originalAccountId, actorClient.id);
                                aiMessageIntroForButton = `Compra parcelada e todas as suas parcelas foram removidas, ${clientNameToUse}! 👍`;
                            } catch (e) { 
                                logger.error(`[WHATSAPP SERVICE] Erro ao excluir grupo de parcelas ${originalAccountId} por botão: ${e.message}`);
                                aiMessageIntroForButton = `Ops! Tive um problema ao tentar remover essa compra parcelada.`;
                                structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                            }
                        } else { buttonClickHandledByServiceLogic = false; }
                        if (buttonClickHandledByServiceLogic) {
                             state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                        }
                    }
                }
                else {
                    buttonClickHandledByServiceLogic = false;
                }
       
                if (buttonClickHandledByServiceLogic) {
                    const finalMsg = `${aiMessageIntroForButton}${structuredDataBodyForButton ? `\n\n${structuredDataBodyForButton}` : ''}${platformLinkFooterForButton ? `\n\n${platformLinkFooterForButton}` : ''}`.trim();
                    state.messageHistory.push({ role: 'assistant', content: finalMsg });
                    await sendWhatsappMessage(senderPhone, finalMsg);
                    conversationState.set(senderPhone, state);
                    pushNameFromPayload = null; // Limpa após o uso
                    return;
                }
            }
       
            if (state.currentAction && state.data.onboardingStage === 'onboarding_complete') {
                 // (lógica de state.currentAction e pré-processamento mantida)
            }
       
            logger.info(`[WHATSAPP HANDLER - PÓS-ONBOARDING] Ator: ${actorClient.id} (${clientNameToUse}), DonoCtx: ${state.ownerClientIdForContext}, PlanoDono: ${state.currentAccessLevel}, Conta Ativa: ${state.activeFinancialAccountName || 'N/A'} (ID: ${state.activeFinancialAccountId || 'N/A'}), Msg: "${messageText}"`);
            if(!state.activeFinancialAccountId && state.hasPaidAccess && state.data.onboardingStage === 'onboarding_complete') {
                 // (lógica de forçar seleção de conta mantida)
            }
       
            // <<<<<< INÍCIO DA MODIFICAÇÃO PARA CATEGORIAS >>>>>>
            let availableFinancialCategoriesForAI = [];
            if (state.activeFinancialAccountId) {
                try {
                    // Usa a nova função de financialCategoryService que retorna nomes completos hierárquicos
                    const categoriesFromDb = await financialCategoryService.getAllCategoriesForAccountAI(state.activeFinancialAccountId); 
                    if (categoriesFromDb) { 
                        availableFinancialCategoriesForAI = categoriesFromDb; // Já está no formato [{id, name}]
                    }
                } catch (catError) {
                    logger.error(`[WHATSAPP HANDLER] Erro ao buscar categorias financeiras para IA: ${catError.message}`);
                }
            }
            // <<<<<< FIM DA MODIFICAÇÃO PARA CATEGORIAS >>>>>>
       
            const aiContext = {
                currentFinancialAccountId: state.activeFinancialAccountId,
                currentFinancialAccountType: state.activeFinancialAccountType,
                currentFinancialAccountName: state.activeFinancialAccountName,
                clientName: clientNameToUse,
                isSharedAccess: state.isSharedAccessContext,
                conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
                currentStateData: state.data,
                editingResource: state.editingResource,
                currentAccessLevel: state.currentAccessLevel,
                hasPaidAccess: state.hasPaidAccess,
                availableFinancialCategories: availableFinancialCategoriesForAI, // <<< CATEGORIAS INCLUÍDAS NO CONTEXTO DA IA
            };
            const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
            logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponsePreview: JSON.stringify(aiResponse).substring(0,500) + "..."});
            state.lastAiResponse = aiResponse;
       
            if(state.currentAction && typeof state.currentAction === 'string' &&
               (state.currentAction.startsWith('awaiting_')) &&
               state.data.onboardingStage === 'onboarding_complete' &&
               (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0) ) {
                    if (!state.currentAction.includes('_edit_') && !state.currentAction.includes('_choice') && state.currentAction !== 'awaiting_confirmation' && !state.currentAction.startsWith('awaiting_explicit_')) {
                        state.currentAction = null;
                    }
            }
           
            let aiMessageIntro = aiResponse.overall_summary_suggestion ||
                                (aiResponse.reply_to_user_suggestion && (!aiResponse.detected_actions || aiResponse.detected_actions.length === 0 || aiResponse.detected_actions.every(a => (a.action || a.action_type)?.startsWith("GENERAL_")))
                                    ? aiResponse.reply_to_user_suggestion
                                    : (clientNameToUse ? `Ok, ${clientNameToUse}!` : "Entendido!"));
            if (typeof aiMessageIntro !== 'string' || aiMessageIntro.trim() === "" || aiMessageIntro.trim().toLowerCase() === "null") {
                aiMessageIntro = clientNameToUse ? `Entendido, ${clientNameToUse}! ` : "Entendido! ";
                if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
                    aiMessageIntro += "Vou processar isso para você. ";
                } else if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
                    aiMessageIntro += "Só preciso de um detalhe... ";
                } else {
                    aiMessageIntro += "Como posso te ajudar? ";
                }
            }


            let structuredDataBody = "";
            let platformLinkFooter = formatPlatformLink();
            let finalMessageToSend = "";
       
            state.pendingConfirmation = null;
            let actionWasAnEdit = false; 
            let resourceForButtonsContext = null;
            let multipleActionBodiesList = [];
            const isOwnerActingOnOwnBehalfGlobal = !state.isSharedAccessContext || state.ownerClientIdForContext === actorClient.id;


            if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
                for (const detectedAction of aiResponse.detected_actions) {
                    const params = detectedAction.parameters || detectedAction; 
                    const actionName = detectedAction.action || detectedAction.action_type; 
                    if (!actionName) {
                        logger.warn('[WHATSAPP HANDLER] Ação detectada pela IA sem nome (action/action_type). Pulando.', { detectedAction });
                        continue;
                    }
                    
                    let currentActionBlocked = false;
                    let currentActionFormattedData = "";
                    let blockReasonMessage = "";

                    const ownerId = state.ownerClientIdForContext;
                    const actorId = actorClient.id;

                    const ownerOnlyActions = [
                        'CREATE_FINANCIAL_ACCOUNT', 'UPDATE_FINANCIAL_ACCOUNT', 'DELETE_FINANCIAL_ACCOUNT',
                        'GRANT_ACCESS', 'LIST_GRANTED_ACCESS', 'UPDATE_GRANTED_ACCESS', 'REVOKE_ACCESS'
                    ];
                    if (ownerOnlyActions.includes(actionName) && !isOwnerActingOnOwnBehalfGlobal) {
                        blockReasonMessage = `Desculpe, ${clientNameToUse}, mas a ação de "${actionName.toLowerCase().replace(/_/g, " ")}" só pode ser realizada pelo proprietário da conta (${state.ownerClientNameForContext}).`;
                        currentActionBlocked = true;
                    }
                    
                    const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SET_MOTIVATIONAL_MESSAGE_PREFERENCE', 'SET_WATER_REMINDER_PREFERENCE', 'LIST_RECEIVED_ACCESS', 'RESPOND_TO_INVITE'];
                    if (!state.hasPaidAccess && !publicActions.includes(actionName) && !ownerOnlyActions.includes(actionName) && !currentActionBlocked) {
                        const noPlanIntro = getOnboardingWelcomeNoPlanMessage(state.ownerClientNameForContext).split('\n\n')[0];
                        const noPlanData = getOnboardingWelcomeNoPlanMessage(state.ownerClientNameForContext).split('\n\n').slice(1).join('\n\n');
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(noPlanIntro)) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = noPlanIntro;
                        blockReasonMessage = `Para realizar esta ação, o plano de ${state.ownerClientNameForContext} precisa estar ativo.\n\n${noPlanData}`;
                        platformLinkFooter = "";
                        currentActionBlocked = true;
                    }
                    const accountRequiredActions = [
                        'CREATE_FINANCIAL_TRANSACTION', 'SCHEDULE_APPOINTMENT', 'CREATE_PARCELLED_ACCOUNT',
                        'UPDATE_FINANCIAL_TRANSACTION', 'UPDATE_APPOINTMENT', 'GET_FINANCIAL_SUMMARY',
                        'LIST_FINANCIAL_TRANSACTIONS', 'MARK_TRANSACTION_AS_PAID_RECEIVED',
                        'CREATE_RECURRING_RULE', 'CREATE_PRODUCT', 'GET_STOCK_INFO',
                        'RECORD_STOCK_MOVEMENT', 'LIST_APPOINTMENTS', 'CREATE_CREDIT_CARD',
                        'LIST_CREDIT_CARDS', 'LIST_RECURRING_RULES', 'UPDATE_CREDIT_CARD', 'UPDATE_RECURRING_RULE', 'UPDATE_PRODUCT',
                        'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION', 'RECREATE_PARCELLED_ACCOUNT',
                        'GET_CREDIT_CARD_INVOICE', 'GET_CREDIT_CARD_AVAILABLE_LIMIT', 'PAY_CREDIT_CARD_INVOICE',
                        'CREATE_BUSINESS_CLIENT', 'LIST_BUSINESS_CLIENTS', 'UPDATE_BUSINESS_CLIENT'
                    ];
                    if (accountRequiredActions.includes(actionName) && !state.activeFinancialAccountId && !currentActionBlocked) {
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Opa, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Opa, ${clientNameToUse}! Para eu poder "${actionName.toLowerCase().replace(/_/g, " ")}", preciso que uma conta financeira esteja selecionada.`;
                        blockReasonMessage = `Se você já configurou alguma (ou tem acesso compartilhado), me diga o nome dela. Se não, ${isOwnerActingOnOwnBehalfGlobal ? 'diga "criar conta pessoal"' : `peça para ${state.ownerClientNameForContext} verificar os acessos.`}! 😊`;
                        platformLinkFooter = ""; state.currentAction = 'selecting_account_flow_active'; currentActionBlocked = true;
                    }
                    const pjMeiActions = ['CREATE_PRODUCT', 'GET_STOCK_INFO', 'RECORD_STOCK_MOVEMENT', 'UPDATE_PRODUCT', 'CREATE_BUSINESS_CLIENT', 'LIST_BUSINESS_CLIENTS', 'UPDATE_BUSINESS_CLIENT'];
                     if (pjMeiActions.includes(actionName) && state.activeFinancialAccountType && !['PJ', 'MEI'].includes(state.activeFinancialAccountType)  && !currentActionBlocked) {
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Desculpe, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Desculpe, ${clientNameToUse}, mas "${actionName.toLowerCase().replace(/_/g, " ")}" é apenas para contas PJ ou MEI.`;
                        blockReasonMessage = `Sua conta "${state.activeFinancialAccountName}" é do tipo ${state.activeFinancialAccountType}. Você pode criar uma conta empresarial ou mudar para ela, se tiver uma! 😉`;
                        platformLinkFooter = ""; currentActionBlocked = true;
                    } else if (pjMeiActions.includes(actionName) && state.activeFinancialAccountType && ['PJ', 'MEI'].includes(state.activeFinancialAccountType) && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado') && !currentActionBlocked) {
                        const siteUrlPjMei = process.env.PLAN_SITE_URL || "https://map-nocontrole.com.br/#planos";
                         if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Ah, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Ah, ${clientNameToUse}! Para usar as funcionalidades de ${state.activeFinancialAccountType === 'PJ' ? 'Empresa (PJ)' : 'MEI'}, como "${actionName.toLowerCase().replace(/_/g, " ")}", o plano de ${state.ownerClientNameForContext} precisa ser um dos nossos Planos Avançados. 🚀`;
                        blockReasonMessage = `Eles são perfeitos para quem quer ir além! Confira em ${siteUrlPjMei} e depois me avise para continuarmos! 😉`;
                        platformLinkFooter = ""; currentActionBlocked = true;
                    }
       
                    if (currentActionBlocked) {
                        if (blockReasonMessage) multipleActionBodiesList.push(blockReasonMessage);
                        continue;
                    }

                    try {
                        // *********************************************************************
                        // SWITCH CASE PARA TODAS AS AÇÕES (INTEIRO, COMO ANTES)
                        // IMPORTANTE: Dentro dos cases que usam categoria (financialCategoryName),
                        // a chamada para obter o ID da categoria deve ser feita usando
                        // financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                        // *********************************************************************
                        switch (actionName) {
                            case 'CREATE_FINANCIAL_TRANSACTION': {
                                // MODIFICADO: Usa financialCategoryService e trata o nome completo da categoria vindo da IA
                                const categoryObject = params.financialCategoryName 
                                    ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId) 
                                    : null;
                                const categoryId = categoryObject ? categoryObject.id : null;

                                const cardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                                
                                const txData = {
                                    description: params.description, 
                                    type: params.type, 
                                    value: parseFloat(params.value), 
                                    transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                    financialCategoryId: categoryId,
                                    creditCardId: cardId,
                                    notes: params.notes,
                                    isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : (cardId ? false : false)),
                                    dueDate: cardId ? null : params.dueDate,
                                    isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (cardId ? true : (!params.dueDate))
                                };

                                if (!txData.description || !txData.type || isNaN(txData.value) || txData.value <= 0) {
                                    throw new Error("Dados obrigatórios (descrição, tipo, valor) ausentes ou inválidos para criar transação.");
                                }
                                const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData, actorId); 
                                const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                               
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,") || aiMessageIntro.startsWith("Entendido"))) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Sua transação foi registrada, ${clientNameToUse}!`;
                                } else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) {
                                     aiMessageIntro = `Registrei o seguinte para você, ${clientNameToUse}:`;
                                }
                                currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedTx);
                                if (aiResponse.detected_actions.length === 1 && isOwnerActingOnOwnBehalfGlobal) resourceForButtonsContext = { type: 'transaction', id: newTx.id, description: newTx.description };
                                break;
                            }
                            case 'UPDATE_FINANCIAL_TRANSACTION': {
                                const transactionIdToUpdate = state.editingResource?.type === 'transaction' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.transactionIdToUpdate ? parseInt(params.transactionIdToUpdate, 10) : null);
                                if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não foi fornecido ou não está em contexto de edição.");
                                if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal ) {
                                     throw new Error("Você não tem permissão para editar transações nesta conta compartilhada.");
                                 }

                                const updateDataTx = {};
                                if (params.hasOwnProperty('description')) updateDataTx.description = params.description;
                                if (params.hasOwnProperty('value') && params.value !== null && !isNaN(parseFloat(params.value)) && parseFloat(params.value) > 0) updateDataTx.value = parseFloat(params.value);
                                if (params.hasOwnProperty('transactionDate')) updateDataTx.transactionDate = params.transactionDate;
                                if (params.hasOwnProperty('notes')) updateDataTx.notes = params.notes;
                                if (params.hasOwnProperty('dueDate')) updateDataTx.dueDate = params.dueDate; else if (params.hasOwnProperty('dueDate') && params.dueDate === null) updateDataTx.dueDate = null;
                                if (params.hasOwnProperty('isPaidOrReceived')) updateDataTx.isPaidOrReceived = params.isPaidOrReceived;
                                
                                // MODIFICADO: Usa financialCategoryService
                                if (params.financialCategoryName) {
                                    const categoryObject = await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId);
                                    updateDataTx.financialCategoryId = categoryObject ? categoryObject.id : null;
                                } else if (params.hasOwnProperty('financialCategoryName') && params.financialCategoryName === null) {
                                    updateDataTx.financialCategoryId = null;
                                }
                                
                                if (params.creditCardName) {
                                    updateDataTx.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                } else if (params.hasOwnProperty('creditCardName') && params.creditCardName === null) {
                                    updateDataTx.creditCardId = null;
                                }

                                if (Object.keys(updateDataTx).length === 0) throw new Error("Nenhum dado fornecido para atualizar a transação.");

                                const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateDataTx, actorId);
                                const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,") || aiMessageIntro.startsWith("Entendido"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Transação atualizada com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da transação, ${clientNameToUse}:`;
                                currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedUpdatedTx);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'SCHEDULE_APPOINTMENT': {
                                 const eventDateTime = params.eventDateTime;
                                if (!params.title || !eventDateTime) throw new Error("Título e data/hora são obrigatórios para agendar.");
                                if (params.associatedValue && (isNaN(parseFloat(params.associatedValue)) || parseFloat(params.associatedValue) <= 0 || !params.associatedTransactionType)) throw new Error("Valor associado deve ser maior que zero e tipo (entrada/saída) é obrigatório se um valor está associado.");

                                let businessClientIds = [];
                                if (params.businessClientNames && Array.isArray(params.businessClientNames) && ['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                    for (const name of params.businessClientNames) {
                                        const bcId = await findBusinessClientIdByName(name, state.activeFinancialAccountId);
                                        if (bcId) businessClientIds.push(bcId);
                                        else logger.warn(`[WHATSAPP SERVICE] Cliente de negócio "${name}" não encontrado para appointment na conta ${state.activeFinancialAccountId}.`);
                                    }
                                }

                                const appointmentData = {
                                    title: params.title,
                                    eventDateTime: eventDateTime,
                                    durationMinutes: params.durationMinutes ? parseInt(params.durationMinutes) : null,
                                    location: params.location,
                                    reminderLeadTimeMinutes: params.reminderLeadTimeMinutes ? parseInt(params.reminderLeadTimeMinutes) : 15,
                                    notes: params.notes,
                                    associatedValue: params.associatedValue ? parseFloat(params.associatedValue) : null,
                                    associatedTransactionType: params.associatedTransactionType,
                                    businessClientIds: businessClientIds.length > 0 ? businessClientIds : undefined
                                };
                                const newAppt = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appointmentData, actorId);
                                const reloadedAppt = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newAppt.id);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,")|| aiMessageIntro.startsWith("Entendido"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Seu compromisso foi agendado, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Agendei o seguinte para você, ${clientNameToUse}:`;
                                currentActionFormattedData = formatAppointmentDataStructure(reloadedAppt);
                                if (aiResponse.detected_actions.length === 1 && isOwnerActingOnOwnBehalfGlobal) resourceForButtonsContext = { type: 'appointment', id: newAppt.id, description: newAppt.title };
                                break;
                            }
                            case 'UPDATE_APPOINTMENT': {
                                const appointmentIdToUpdate = state.editingResource?.type === 'appointment' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.appointmentIdToUpdate ? parseInt(params.appointmentIdToUpdate, 10) : null);
                                if (!appointmentIdToUpdate) throw new Error("ID do compromisso para atualizar não foi fornecido.");
                                if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                                     throw new Error("Você não tem permissão para editar compromissos nesta conta compartilhada.");
                                 }

                                const updateDataAppt = {};
                                if (params.hasOwnProperty('title')) updateDataAppt.title = params.title;
                                if (params.hasOwnProperty('eventDateTime')) updateDataAppt.eventDateTime = params.eventDateTime;
                                if (params.hasOwnProperty('durationMinutes')) updateDataAppt.durationMinutes = parseInt(params.durationMinutes);
                                if (params.hasOwnProperty('location')) updateDataAppt.location = params.location;
                                if (params.hasOwnProperty('reminderLeadTimeMinutes')) updateDataAppt.reminderLeadTimeMinutes = parseInt(params.reminderLeadTimeMinutes);
                                if (params.hasOwnProperty('status')) updateDataAppt.status = params.status;
                                if (params.hasOwnProperty('notes')) updateDataAppt.notes = params.notes;
                                if (params.hasOwnProperty('associatedValue') && params.associatedValue !== null && !isNaN(parseFloat(params.associatedValue))) updateDataAppt.associatedValue = parseFloat(params.associatedValue);
                                if (params.hasOwnProperty('associatedTransactionType')) updateDataAppt.associatedTransactionType = params.associatedTransactionType;
                                
                                let businessClientIdsToUpdate = undefined; 
                                if (params.hasOwnProperty('businessClientNames') && ['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                    businessClientIdsToUpdate = []; 
                                    if (Array.isArray(params.businessClientNames) && params.businessClientNames.length > 0) {
                                        for (const name of params.businessClientNames) {
                                            const bcId = await findBusinessClientIdByName(name, state.activeFinancialAccountId);
                                            if (bcId) businessClientIdsToUpdate.push(bcId);
                                        }
                                    }
                                    updateDataAppt.businessClientIds = businessClientIdsToUpdate;
                                }

                                if (Object.keys(updateDataAppt).length === 0) throw new Error("Nenhum dado fornecido para atualizar o compromisso.");

                                const updatedAppt = await appointmentService.updateAppointment(state.activeFinancialAccountId, appointmentIdToUpdate, updateDataAppt, actorId);
                                const reloadedUpdatedAppt = await appointmentService.getAppointmentById(state.activeFinancialAccountId, updatedAppt.id);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Compromisso atualizado, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do compromisso, ${clientNameToUse}:`;
                                currentActionFormattedData = formatAppointmentDataStructure(reloadedUpdatedAppt);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'CREATE_PARCELLED_ACCOUNT': {
                                // MODIFICADO: Usa financialCategoryService
                                const categoryObject = params.financialCategoryName 
                                    ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                                    : null;
                                const categoryId = categoryObject ? categoryObject.id : null;

                                const cardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;

                                if (params.creditCardName && !cardId) {
                                    throw new Error(`Cartão "${params.creditCardName}" não encontrado. Cadastre-o primeiro ou use outro nome.`);
                                }
                                if (!cardId && params.type === 'Saída') { 
                                    throw new Error(`Para uma compra parcelada, preciso do nome do cartão de crédito. Ex: 'parcelei no Nubank'.`);
                                }

                                const parcelData = {
                                    description: params.description,
                                    type: params.type || "Saída", 
                                    totalValue: parseFloat(params.totalValue || params.value),
                                    numberOfParcels: parseInt(params.numberOfParcels),
                                    initialDueDate: params.initialDueDate, 
                                    financialCategoryId: categoryId,
                                    creditCardId: cardId,
                                    notes: params.notes,
                                    transactionDate: params.transactionDate || params.initialDueDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0]
                                };
                                 if (!parcelData.description || !parcelData.type || isNaN(parcelData.totalValue) || parcelData.totalValue <=0 || isNaN(parcelData.numberOfParcels) || parcelData.numberOfParcels < 1 || !parcelData.initialDueDate) {
                                     throw new Error("Dados insuficientes ou inválidos para compra parcelada (descrição, tipo, valor total, nº parcelas, data 1ª parcela).");
                                 }
                                 if (!params.transactionDate && params.initialDueDate) {
                                     parcelData.transactionDate = params.initialDueDate;
                                 }

                                const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData, actorId);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,") || aiMessageIntro.startsWith("Entendido"))) { aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Sua compra parcelada foi registrada, ${clientNameToUse}!`;}
                                else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sua compra parcelada foi registrada, ${clientNameToUse}:`;

                                currentActionFormattedData = formatParcelledAccountDataStructure(parcelData, parcelResult);

                                if (aiResponse.detected_actions.length === 1 && parcelResult.parcels && parcelResult.parcels.length > 0 && isOwnerActingOnOwnBehalfGlobal) {
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
                                if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                                     throw new Error("Você não tem permissão para editar descrições nesta conta compartilhada.");
                                 }

                                await financialService.updateParcelledAccountDescription(state.activeFinancialAccountId, accountIdToUpdateDesc, params.newDescription, actorId);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Descrição da compra parcelada atualizada para "${params.newDescription}", ${clientNameToUse}!`;
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
                                if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                                     throw new Error("Você não tem permissão para recriar compras parceladas nesta conta compartilhada.");
                                 }
                                
                                // MODIFICADO: Usa financialCategoryService
                                const newCatObject = params.newFinancialCategoryName 
                                    ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.newFinancialCategoryName, state.activeFinancialAccountId)
                                    : null;
                                const newCatIdParcel = newCatObject ? newCatObject.id : null;

                                const newCardIdParcel = params.newCreditCardName ? await findCreditCardIdByName(params.newCreditCardName, state.activeFinancialAccountId) : null;

                                if (params.newCreditCardName && !newCardIdParcel) {
                                    throw new Error(`Cartão "${params.newCreditCardName}" não encontrado para a nova compra parcelada.`);
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

                                const recreatedResult = await financialService.recreateParcelledAccount(state.activeFinancialAccountId, originalAccountIdToUpdate, newParcelData, actorId);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Compra parcelada atualizada com sucesso, ${clientNameToUse}! A antiga foi removida.`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a atualização da compra parcelada, ${clientNameToUse}:`;
                                currentActionFormattedData = formatParcelledAccountDataStructure(newParcelData, recreatedResult);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                                if (!params.transactionDescription) throw new Error("Descrição da transação é obrigatória para marcar como paga/recebida.");
                                if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                                     throw new Error("Você não tem permissão para marcar transações como pagas/recebidas nesta conta compartilhada.");
                                }
                                const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
                                
                                // MODIFICADO: Usa financialCategoryService
                                const categoryObjectForMark = params.financialCategoryName 
                                    ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                                    : null;
                                const categoryIdForMark = categoryObjectForMark ? categoryObjectForMark.id : null;


                                const result = await financialService.markTransactionAsPaidOrReceived(
                                    state.activeFinancialAccountId,
                                    params.transactionDescription,
                                    params.transactionValue ? parseFloat(params.transactionValue) : null,
                                    paymentDate,
                                    categoryIdForMark,
                                    actorId
                                );
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Ótimo, ${clientNameToUse}! Transação marcada como liquidada.`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a liquidação da transação, ${clientNameToUse}:`;
                                currentActionFormattedData = `Transação "${result.description}" (${formatCurrency(result.value)}) foi marcada como ${result.type === 'Entrada' ? 'recebida' : 'paga'} em ${formatDate(result.paymentDate)}.`;
                                break;
                            }
                            case 'CREATE_RECURRING_RULE': {
                                // MODIFICADO: Usa financialCategoryService
                                const categoryObjectRule = params.financialCategoryName 
                                    ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                                    : null;
                                const categoryIdRule = categoryObjectRule ? categoryObjectRule.id : null;

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
                                const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData, actorId);
                                const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Sua regra de recorrência foi criada, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Criei a seguinte regra de recorrência para você, ${clientNameToUse}:`;
                                currentActionFormattedData = formatRecurringRuleDataStructure(reloadedRule);
                                if (aiResponse.detected_actions.length === 1 && isOwnerActingOnOwnBehalfGlobal) resourceForButtonsContext = { type: 'recurring_rule', id: newRule.id, description: newRule.description };
                                break;
                            }
                            case 'UPDATE_RECURRING_RULE': {
                                const ruleIdToUpdate = state.editingResource?.type === 'recurring_rule' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.ruleIdToUpdate ? parseInt(params.ruleIdToUpdate, 10) : null);
                                if (!ruleIdToUpdate) throw new Error("ID da regra recorrente para atualizar não foi fornecido.");
                                 if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                                     throw new Error("Você não tem permissão para editar regras recorrentes nesta conta compartilhada.");
                                 }

                                const updateDataRule = {};
                                if (params.hasOwnProperty('description')) updateDataRule.description = params.description;
                                if (params.hasOwnProperty('type')) updateDataRule.type = params.type;
                                if (params.hasOwnProperty('value') && params.value !== null && !isNaN(parseFloat(params.value)) && parseFloat(params.value) > 0) updateDataRule.value = parseFloat(params.value);
                                if (params.hasOwnProperty('frequency')) updateDataRule.frequency = params.frequency;
                                if (params.hasOwnProperty('startDate')) updateDataRule.startDate = params.startDate;
                                if (params.hasOwnProperty('interval') && params.interval !== null && !isNaN(parseInt(params.interval)) && parseInt(params.interval) >= 1) updateDataRule.interval = parseInt(params.interval);
                                if (params.hasOwnProperty('dayOfMonth')) updateDataRule.dayOfMonth = params.dayOfMonth === null ? null : parseInt(params.dayOfMonth);
                                if (params.hasOwnProperty('dayOfWeek')) updateDataRule.dayOfWeek = params.dayOfWeek === null || params.dayOfWeek === undefined ? null : parseInt(params.dayOfWeek);
                                if (params.hasOwnProperty('endDate')) updateDataRule.endDate = params.endDate; else if (params.hasOwnProperty('endDate') && params.endDate === null) updateDataRule.endDate = null;
                                if (params.hasOwnProperty('autoCreateTransaction')) updateDataRule.autoCreateTransaction = params.autoCreateTransaction;
                                if (params.hasOwnProperty('isActive')) updateDataRule.isActive = params.isActive;
                                if (params.hasOwnProperty('notes')) updateDataRule.notes = params.notes;
                                
                                // MODIFICADO: Usa financialCategoryService
                                if (params.financialCategoryName) {
                                    const categoryObjectForRule = await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId);
                                    updateDataRule.financialCategoryId = categoryObjectForRule ? categoryObjectForRule.id : null;
                                } else if (params.hasOwnProperty('financialCategoryName') && params.financialCategoryName === null) {
                                    updateDataRule.financialCategoryId = null;
                                }

                                if (Object.keys(updateDataRule).length === 0) throw new Error("Nenhum dado fornecido para atualizar a regra.");

                                const updatedRule = await recurringTransactionService.updateRecurringRule(state.activeFinancialAccountId, ruleIdToUpdate, updateDataRule, actorId);
                                const reloadedUpdatedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, updatedRule.id);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Regra de recorrência atualizada, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da regra, ${clientNameToUse}:`;
                                currentActionFormattedData = formatRecurringRuleDataStructure(reloadedUpdatedRule);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            // ... (todos os outros cases como estavam, lembrando de ajustar chamadas a systemService.findFinancialCategoryByNameAndType
                            // para financialCategoryService.findFinancialCategoryByNameForAccount onde aplicável, como em PAY_CREDIT_CARD_INVOICE) ...
                            case 'CREATE_PRODUCT': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Cadastro de produtos é apenas para contas PJ/MEI.");
                                const productData = {
                                    name: params.name, 
                                    salePrice: parseFloat(params.salePrice), 
                                    code: params.code,
                                    costPrice: params.costPrice ? parseFloat(params.costPrice) : null,
                                    initialQuantity: params.initialQuantity ? parseInt(params.initialQuantity) : 0,
                                    minimumStock: params.minimumStock ? parseInt(params.minimumStock) : 0,
                                    unit: params.unit || 'UN',
                                    description: params.description 
                                };
                                if (!productData.name || isNaN(productData.salePrice) || productData.salePrice <= 0) {
                                     throw new Error("Nome e preço de venda são obrigatórios para o produto.");
                                 }
                                const newProduct = await productService.createProduct(state.activeFinancialAccountId, productData, actorId);
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Produto "${newProduct.name}" cadastrado com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Cadastrei o produto, ${clientNameToUse}:`;
                                currentActionFormattedData = formatProductDataStructure(newProduct);
                                if (aiResponse.detected_actions.length === 1 && isOwnerActingOnOwnBehalfGlobal) resourceForButtonsContext = { type: 'product', id: newProduct.id, description: newProduct.name };
                                break;
                            }
                            case 'UPDATE_PRODUCT': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Apenas para contas PJ/MEI.");
                                const productIdToUpdate = state.editingResource?.type === 'product' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.productIdToUpdate ? parseInt(params.productIdToUpdate, 10) : null);
                                if (!productIdToUpdate) throw new Error("ID do produto para atualizar não fornecido.");
                                if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                                     throw new Error("Você não tem permissão para editar produtos nesta conta compartilhada.");
                                 }

                                const updateDataProd = {};
                                if (params.hasOwnProperty('name')) updateDataProd.name = params.name;
                                if (params.hasOwnProperty('salePrice') && params.salePrice !== null && !isNaN(parseFloat(params.salePrice)) && parseFloat(params.salePrice) > 0) updateDataProd.salePrice = parseFloat(params.salePrice);
                                if (params.hasOwnProperty('code')) updateDataProd.code = params.code;
                                if (params.hasOwnProperty('costPrice')) updateDataProd.costPrice = params.costPrice === null ? null : parseFloat(params.costPrice);
                                if (params.hasOwnProperty('minimumStock') && params.minimumStock !== null && !isNaN(parseInt(params.minimumStock))) updateDataProd.minimumStock = parseInt(params.minimumStock);
                                if (params.hasOwnProperty('unit')) updateDataProd.unit = params.unit;
                                if (params.hasOwnProperty('description')) updateDataProd.description = params.description;
                                if (params.hasOwnProperty('isActive')) updateDataProd.isActive = params.isActive;

                                if (Object.keys(updateDataProd).length === 0) throw new Error("Nenhum dado para atualizar o produto.");

                                const updatedProduct = await productService.updateProduct(state.activeFinancialAccountId, productIdToUpdate, updateDataProd, actorId);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Produto atualizado com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do produto, ${clientNameToUse}:`;
                                currentActionFormattedData = formatProductDataStructure(updatedProduct);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'GET_STOCK_INFO': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Consulta de estoque é apenas para contas PJ/MEI.");
                                if(!params.productNameOrCode) throw new Error("Nome ou código do produto é obrigatório para ver o estoque.");
                                const stockInfo = await stockService.getProductStockInfoByNameOrCode(state.activeFinancialAccountId, params.productNameOrCode); 
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Aqui estão as informações de estoque para "${stockInfo.name}", ${clientNameToUse}:`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre o estoque de "${stockInfo.name}", ${clientNameToUse}:`;
                                currentActionFormattedData = formatStockInfoDataStructure(stockInfo); 
                                break;
                            }
                            case 'RECORD_STOCK_MOVEMENT': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Movimentação de estoque é apenas para contas PJ/MEI.");
                                if(!params.productNameOrCode || !params.movementType || params.quantity === undefined || params.quantity === null) throw new Error("Produto, tipo de movimento e quantidade são obrigatórios.");
                                const productId = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                                if(!productId) throw new Error(`Produto "${params.productNameOrCode}" não encontrado.`);

                                await stockService.recordStockMovement(state.activeFinancialAccountId, productId, {
                                    movementType: params.movementType,
                                    quantity: parseInt(params.quantity),
                                    reason: params.reason,
                                }, actorId);
                                const updatedStockInfo = await stockService.getProductStockInfoById(state.activeFinancialAccountId, productId);
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Movimentação de estoque registrada para "${updatedStockInfo.name}", ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a movimentação de estoque, ${clientNameToUse}:`;
                                currentActionFormattedData = `✅ Movimento de ${params.movementType.toLowerCase()} (${params.quantity} ${updatedStockInfo.unit || 'UN'}) para "${updatedStockInfo.name}" registrado.\n` +
                                                            `📦 Estoque Atual: ${updatedStockInfo.quantity} ${updatedStockInfo.unit || 'UN'}.`;
                                break;
                            }
                            case 'CREATE_CREDIT_CARD': {
                                const cardData = {
                                    name: params.name, 
                                    limit: parseFloat(params.limit),
                                    closingDay: parseInt(params.closingDay), 
                                    paymentDay: parseInt(params.paymentDay),
                                    lastFourDigits: params.lastFourDigits, 
                                    flag: params.flag,
                                    isDefault: params.isDefault === undefined ? false : params.isDefault
                                };
                                if (!cardData.name || isNaN(cardData.limit) || cardData.limit <= 0 || isNaN(cardData.closingDay) || isNaN(cardData.paymentDay) ) {
                                    throw new Error("Dados insuficientes ou inválidos para criar cartão (nome, limite, dia fechamento/pagamento).");
                                }
                                const newCard = await creditCardService.createCreditCard(state.activeFinancialAccountId, cardData, actorId);
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) { aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Seu novo cartão foi cadastrado, ${clientNameToUse}!`; }
                                else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Seu novo cartão foi cadastrado, ${clientNameToUse}:`;
                                currentActionFormattedData = formatCreditCardDataStructure(newCard);
                                if (aiResponse.detected_actions.length === 1 && isOwnerActingOnOwnBehalfGlobal) resourceForButtonsContext = { type: 'credit_card', id: newCard.id, description: newCard.name };
                                break;
                            }
                            case 'UPDATE_CREDIT_CARD': {
                                const cardIdToUpdate = state.editingResource?.type === 'credit_card' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.cardIdToUpdate ? parseInt(params.cardIdToUpdate, 10) : null);
                                if (!cardIdToUpdate) throw new Error("ID do cartão para atualizar não foi fornecido.");
                                if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                                     throw new Error("Você não tem permissão para editar cartões nesta conta compartilhada.");
                                 }

                                const updateDataCard = {};
                                if (params.hasOwnProperty('name')) updateDataCard.name = params.name;
                                if (params.hasOwnProperty('limit') && params.limit !== null && !isNaN(parseFloat(params.limit)) && parseFloat(params.limit) > 0) updateDataCard.limit = parseFloat(params.limit);
                                if (params.hasOwnProperty('closingDay') && params.closingDay !== null && !isNaN(parseInt(params.closingDay))) updateDataCard.closingDay = parseInt(params.closingDay);
                                if (params.hasOwnProperty('paymentDay') && params.paymentDay !== null && !isNaN(parseInt(params.paymentDay))) updateDataCard.paymentDay = parseInt(params.paymentDay);
                                if (params.hasOwnProperty('lastFourDigits')) updateDataCard.lastFourDigits = params.lastFourDigits;
                                if (params.hasOwnProperty('flag')) updateDataCard.flag = params.flag;
                                if (params.hasOwnProperty('isDefault')) updateDataCard.isDefault = params.isDefault;
                                if (params.hasOwnProperty('isActive')) updateDataCard.isActive = params.isActive;

                                if (Object.keys(updateDataCard).length === 0) throw new Error("Nenhum dado fornecido para atualizar o cartão.");

                                const updatedCard = await creditCardService.updateCreditCard(state.activeFinancialAccountId, cardIdToUpdate, updateDataCard, actorId);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Cartão atualizado com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição do cartão, ${clientNameToUse}:`;
                                currentActionFormattedData = formatCreditCardDataStructure(updatedCard);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'LIST_APPOINTMENTS': {
                                const filterParamsAppt = {
                                    dateStart: params.dateStart, dateEnd: params.dateEnd, status: params.status,
                                    limit: params.limit || 5, page: params.page || 1,
                                };
                                const { appointments, totalItems: totalAppts } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, filterParamsAppt, params.period);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalAppts === 0 ? `Nenhum compromisso encontrado para os filtros, ${clientNameToUse}. 👍` : `📅 Encontrei ${totalAppts} compromissos. Os ${appointments.length > 1 ? appointments.length + " " : ""}próximos são:`);
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = totalAppts === 0 ? `Nenhum compromisso encontrado, ${clientNameToUse}.` : `Sobre os compromissos:`;
                                }

                                if (totalAppts === 0 && aiResponse.detected_actions.length === 1) {
                                    currentActionFormattedData = "Tente outros filtros ou adicione novos compromissos!";
                                } else if (totalAppts > 0) {
                                    let listTextAppt = (aiResponse.detected_actions.length > 1 && multipleActionBodiesList.length > 0) ? "Compromissos Listados:\n" : "🎯 Detalhamento dos Compromissos:\n";
                                    for (const appt of appointments) {
                                        listTextAppt += `\n🗓️ *${appt.title}* - ${formatDate(appt.eventDateTime)} às ${formatTime(appt.eventDateTime, false)}`;
                                        if (appt.status) listTextAppt += ` (Status: ${translateStatus(appt.status)})`;
                                        listTextAppt += ` (ID: ${appt.id})`;
                                    }
                                    currentActionFormattedData = listTextAppt.trim();
                                    if (totalAppts > appointments.length) platformLinkFooter = formatPlatformLink(`E mais ${totalAppts - appointments.length} compromissos. Peça para ver mais ou veja tudo na plataforma!`);
                                } else {
                                    currentActionFormattedData = ""; 
                                }
                                break;
                            }
                            case 'LIST_CREDIT_CARDS': {
                                const { cards, totalItems: totalCards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: params.isActive, includeSummary: params.includeSummary !== false });

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalCards === 0 ? `Você ainda não tem cartões cadastrados, ${clientNameToUse}. Que tal adicionar um?` : `💳 Você tem ${totalCards} cartão(ões) cadastrado(s):`);
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = totalCards === 0 ? `Nenhum cartão cadastrado, ${clientNameToUse}.` : `Sobre seus cartões:`;
                                }

                                if (totalCards > 0) {
                                    currentActionFormattedData = formatCreditCardListDataStructure(cards);
                                } else if (aiResponse.detected_actions.length === 1) { 
                                    currentActionFormattedData = "Diga, por exemplo: \"cadastrar cartão Nubank com limite de 2000, fechamento dia 20 e pagamento dia 28\".";
                                } else {
                                    currentActionFormattedData = "";
                                }
                                break;
                            }
                            case 'LIST_FINANCIAL_TRANSACTIONS': {
                                // MODIFICADO: Usa financialCategoryService para buscar ID da categoria pelo nome
                                const categoryObjectList = params.financialCategoryName 
                                    ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId) 
                                    : null;
                                const categoryIdList = categoryObjectList ? categoryObjectList.id : null;

                                const filterParamsList = {
                                    dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                    financialCategoryId: categoryIdList,
                                    creditCardId: params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null,
                                    isPayableOrReceivable: params.isPayableOrReceivable, isPaidOrReceived: params.isPaidOrReceived,
                                    search: params.searchTerm || params.description, 
                                    limit: params.limit || 7, page: params.page || 1,
                                    sortBy: params.sortBy || 'transactionDate', sortOrder: params.sortOrder || 'DESC'
                                };
                                const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList, params.period);
                               
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
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
                                        if (t.isParcel && t.originalAccount) emoji = '📦'; 
                                        const date = formatDate(t.transactionDate);
                                        let descriptionText = t.description;
                                        if (t.isParcel && t.parcelNumber && t.totalParcels && t.originalAccount) {
                                            const originalDesc = t.originalAccount.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                                             if (!descriptionText.toLowerCase().includes(`parcela ${t.parcelNumber}/${t.totalParcels}`)) { 
                                                descriptionText = `${originalDesc} - Pcl ${t.parcelNumber}/${t.totalParcels}`;
                                             }
                                        }
                                        listText += `\n${emoji} *${descriptionText}* - ${formatCurrency(t.value)}\n    (Categoria: ${catName}, Data: ${date}, ID: ${t.id})`;
                                        if (t.isPayableOrReceivable && !t.creditCardId) { 
                                            listText += t.isPaidOrReceived ? ` (${translateStatus('Paid')} ✅)` : ` (Vence ${formatDate(t.dueDate)} 🗓️)`;
                                        }
                                    }
                                    currentActionFormattedData = listText.trim();
                                    if (totalItems > transactions.length) platformLinkFooter = formatPlatformLink(`E mais ${totalItems - transactions.length} transações. Peça para ver mais ou veja tudo na plataforma!`);
                                } else {
                                    currentActionFormattedData = ""; 
                                }
                                break;
                            }
                            case 'LIST_RECURRING_RULES': {
                                const filterParamsRules = {
                                    isActive: params.isActive !== undefined ? params.isActive : null,
                                    type: params.type,
                                    limit: params.limit || 5, page: params.page || 1
                                };
                                const { rules, totalItems: totalRules } = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, filterParamsRules);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalRules === 0 ? `Nenhuma regra de recorrência encontrada, ${clientNameToUse}.` : `📋 Você tem ${totalRules} regra(s) de recorrência:`);
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = totalRules === 0 ? `Nenhuma regra de recorrência encontrada, ${clientNameToUse}.` : `Sobre as regras de recorrência:`;
                                }

                                if (totalRules === 0 && aiResponse.detected_actions.length === 1) {
                                    currentActionFormattedData = "Que tal criar uma? Diga, por exemplo: \"criar recorrência de aluguel, saída de 1500, mensal, todo dia 5\".";
                                } else if (totalRules > 0) {
                                    let listTextRules = (aiResponse.detected_actions.length > 1 && multipleActionBodiesList.length > 0) ? "Regras Listadas:\n" : "🎯 Detalhamento das Regras:\n";
                                    for (const rule of rules) {
                                        listTextRules += `\n🔄 *${rule.description}* - ${formatCurrency(rule.value)} (${rule.type})\n    (Próx: ${formatDate(rule.nextDueDate)}, Freq: ${rule.frequency}, ID: ${rule.id})`;
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
                                if (!targetAccountIdentifier) {
                                    currentActionFormattedData = "Para qual conta você gostaria de mudar? Me diga o nome ou o tipo (PF, PJ, MEI).";
                                    if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,") || aiMessageIntro.startsWith("Entendido"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Hmm, ${clientNameToUse}, preciso de mais detalhes.`;
                                    else if (multipleActionBodiesList.length === 0) aiMessageIntro = `Sobre a troca de contas, ${clientNameToUse}:`;
                                    platformLinkFooter = "";
                                    break;
                                }

                                const accountsForSwitch = state.isSharedAccessContext
                                    ? ownerAccountsIfShared 
                                    : await clientService.getClientFinancialAccounts(actorId, { isActive: true });

                                if (accountsForSwitch.length === 0) {
                                    aiMessageIntro = `Você não tem nenhuma conta ${state.isSharedAccessContext ? `de ${state.ownerClientNameForContext} ` : ''}acessível no momento, ${clientNameToUse}. 😕`;
                                    currentActionFormattedData = isOwnerActingOnOwnBehalfGlobal ? "Que tal criar uma conta pessoal?" : `Peça para ${state.ownerClientNameForContext} verificar os acessos.`;
                                    platformLinkFooter = "";
                                    if (isOwnerActingOnOwnBehalfGlobal) { state.currentAction = 'awaiting_explicit_account_type_from_ai'; state.data.pendingAccountCreation = true; } 
                                    break;
                                }
                                 if (accountsForSwitch.length === 1 && accountsForSwitch[0].id === state.activeFinancialAccountId) {
                                    aiMessageIntro = `Você já está usando a conta "${accountsForSwitch[0].name || accountsForSwitch[0].accountName}", ${clientNameToUse}. 😉`;
                                    currentActionFormattedData = "Não precisamos trocar nada!"; platformLinkFooter = "";
                                    break;
                                }

                                let foundAccount = accountsForSwitch.find(acc =>
                                    (acc.accountName || acc.name).toLowerCase() === targetAccountIdentifier.toLowerCase() ||
                                    (acc.accountType || acc.type).toLowerCase() === targetAccountIdentifier.toLowerCase() ||
                                    (acc.id && acc.id.toString() === targetAccountIdentifier)
                                );
                                if (!foundAccount) {
                                    foundAccount = accountsForSwitch.find(acc => (acc.accountName || acc.name).toLowerCase().includes(targetAccountIdentifier.toLowerCase()));
                                }

                                if (foundAccount && foundAccount.id !== state.activeFinancialAccountId) {
                                    state.activeFinancialAccountId = foundAccount.id;
                                    state.activeFinancialAccountName = foundAccount.accountName || foundAccount.name;
                                    state.activeFinancialAccountType = foundAccount.accountType || foundAccount.type;
                                    
                                    if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,") || aiMessageIntro.startsWith("Entendido"))) {
                                         aiMessageIntro = aiResponse.overall_summary_suggestion || `Prontinho, ${clientNameToUse}! Mudei para a conta "${state.activeFinancialAccountName}" (${state.activeFinancialAccountType}).`;
                                    } else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) {
                                        aiMessageIntro = `Ok, ${clientNameToUse}! Selecionei a conta:`;
                                    }
                                    currentActionFormattedData = `Conta Ativa: *${state.activeFinancialAccountName}* (${state.activeFinancialAccountType})\n\nO que vamos fazer por aqui agora?`;
                                    platformLinkFooter = "";
                                } else if (foundAccount && foundAccount.id === state.activeFinancialAccountId) {
                                    aiMessageIntro = `Você já está na conta "${state.activeFinancialAccountName}", ${clientNameToUse}! 😉`;
                                    currentActionFormattedData = ""; platformLinkFooter = "";
                                } else {
                                    aiMessageIntro = `Não encontrei uma conta ${state.isSharedAccessContext ? `de ${state.ownerClientNameForContext} ` : ''}chamada ou do tipo "${targetAccountIdentifier}" que você possa acessar, ${clientNameToUse}. 😕`;
                                    let accountListForMsg = "Suas opções são:\n";
                                    accountsForSwitch.forEach(a => accountListForMsg += `\n- *${a.name || a.accountName}* (${a.type || a.accountType})`);
                                    currentActionFormattedData = accountListForMsg;
                                    platformLinkFooter = "";
                                    state.currentAction = 'selecting_account_flow_active';
                                    state.data.accountsToList = accountsForSwitch.map(a => ({id: a.id, name: a.accountName || a.name, type: a.accountType || a.type}));
                                }
                                if (foundAccount) state.currentAction = null; 
                                break;
                            }
                            case 'CREATE_FINANCIAL_ACCOUNT': {
                                if (!isOwnerActingOnOwnBehalfGlobal) throw new Error("Você não pode criar contas financeiras em um acesso compartilhado.");
                                const accountTypeToCreate = params.accountTypeToCreate;
                                const newAccountName = params.newAccountName;

                                if (!accountTypeToCreate) {
                                    state.currentAction = 'awaiting_explicit_account_type_from_ai';
                                    aiMessageIntro = `Entendido, ${clientNameToUse}! Você quer criar uma nova conta.`;
                                    currentActionFormattedData = `Ela será para Pessoa Física (PF), Pessoa Jurídica (PJ) ou MEI?`;
                                    platformLinkFooter = "";
                                    break;
                                }
                                if (!newAccountName) {
                                    state.currentAction = 'awaiting_explicit_account_name_from_ai';
                                    state.data.accountTypeToCreate = accountTypeToCreate;
                                    const msgParts = getOnboardingAskForCompanyNameMessage(clientNameToUse, accountTypeToCreate).split('\n\n');
                                    aiMessageIntro = msgParts[0];
                                    currentActionFormattedData = msgParts[1];
                                    platformLinkFooter = msgParts[2] || "";
                                    break;
                                }
                                if (!['PF', 'PJ', 'MEI'].includes(accountTypeToCreate)) throw new Error("Tipo de conta inválido. Use PF, PJ ou MEI.");
                                if (newAccountName.length < 3 || newAccountName.length > 50) throw new Error("Nome da conta deve ter entre 3 e 50 caracteres.");

                                const currentClientAccounts = await clientService.getClientFinancialAccounts(actorId, { isActive: true }); 
                                const existingPjMei = currentClientAccounts.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');

                                if ((accountTypeToCreate === 'PJ' || accountTypeToCreate === 'MEI') && existingPjMei) {
                                    throw new Error(`Você já possui uma conta ${existingPjMei.accountType} ("${existingPjMei.accountName}"). Só é permitida uma conta empresarial (PJ/MEI) por vez.`);
                                }
                                if ((accountTypeToCreate === 'PJ' || accountTypeToCreate === 'MEI') && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado')) {
                                    state.data.onboardingStage = 'awaiting_plan_confirmation';
                                    throw new Error(`Para criar contas PJ ou MEI, você precisa de um Plano Avançado. Confira nossos planos!`);
                                }

                                const newFinancialAccount = await clientService.createFinancialAccount(actorId, { accountName: newAccountName, accountType: accountTypeToCreate, documentNumber: params.documentNumber });
                                state.activeFinancialAccountId = newFinancialAccount.id;
                                state.activeFinancialAccountName = newFinancialAccount.accountName;
                                state.activeFinancialAccountType = newFinancialAccount.accountType;

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,") || aiMessageIntro.startsWith("Entendido"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Conta "${newFinancialAccount.accountName}" (${newFinancialAccount.accountType}) criada e selecionada, ${clientNameToUse}!`;
                                currentActionFormattedData = formatFinancialAccountDataStructure(newFinancialAccount);
                                platformLinkFooter = ""; state.currentAction = null;
                                break;
                            }
                            case 'GET_FINANCIAL_SUMMARY': {
                                // MODIFICADO: Usa financialCategoryService
                                const categoryObjectSummary = params.financialCategoryName 
                                    ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                                    : null;
                                const categoryIdSummary = categoryObjectSummary ? categoryObjectSummary.id : null;

                                const filters = {
                                    period: params.period || 'este_mes',
                                    dateStart: params.dateStart,
                                    dateEnd: params.dateEnd,
                                    financialCategoryId: categoryIdSummary, 
                                    type: params.type,
                                };
                                const summary = await financialService.getFinancialSummary(state.activeFinancialAccountId, filters);
                                
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || `Aqui está o resumo financeiro que você pediu, ${clientNameToUse}! 📊`;
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = `Resumo Financeiro para ${state.activeFinancialAccountName}:`;
                                }
                                
                                currentActionFormattedData = `🧾 Resumo do Período (${summary.periodDescription}):\n\n` +
                                                             `➡️ Total de Entradas: ${formatCurrency(summary.totalIncome)}\n` +
                                                             `⬅️ Total de Saídas: ${formatCurrency(summary.totalExpenses)}\n` +
                                                             `⚖️ Saldo do Período: ${formatCurrency(summary.netBalance)}\n\n` +
                                                             `💰 Saldo Total da Conta (aproximado): ${formatCurrency(summary.accountTotalBalance)}`;
                                if(summary.categoryBreakdown && summary.categoryBreakdown.length > 0){
                                    currentActionFormattedData += "\n\n Detalhamento por Categoria (Top 5 Saídas):\n";
                                    summary.categoryBreakdown.slice(0,5).forEach(cat => {
                                        currentActionFormattedData += `- ${cat.categoryName || 'Outros'}: ${formatCurrency(cat.totalValue)}\n`;
                                    });
                                }
                                break;
                            }
                            case 'GET_CREDIT_CARD_INVOICE': {
                                const cardNameForInvoice = params.creditCardName;
                                if (!cardNameForInvoice) throw new Error("Nome do cartão é obrigatório para ver a fatura.");
                                const cardIdForInvoice = await findCreditCardIdByName(cardNameForInvoice, state.activeFinancialAccountId);
                                if (!cardIdForInvoice) {
                                    throw new Error(`Não encontrei um cartão chamado "${cardNameForInvoice}". Verifique o nome ou cadastre o cartão.`);
                                }
                                const periodOpts = { type: params.invoicePeriodType || 'aberta', month: params.invoiceMonth, year: params.invoiceYear };
                                const cardForDetails = await creditCardService.getCreditCardById(state.activeFinancialAccountId, cardIdForInvoice); 
                                const invoiceDetails = await creditCardService.getCreditCardInvoiceDetails(state.activeFinancialAccountId, cardIdForInvoice, periodOpts);
                                if(cardForDetails) {
                                    invoiceDetails.cardName = cardForDetails.name; 
                                    invoiceDetails.cardTotalLimit = cardForDetails.limit;
                                }


                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) { 
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || `🛍️ ${clientNameToUse}, aqui está a fatura do seu cartão ${cardNameForInvoice}!`; 
                                } else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) {
                                    aiMessageIntro = `Sobre a fatura do cartão ${cardNameForInvoice}:`;
                                }
                                currentActionFormattedData = formatCreditCardInvoiceDataStructure(invoiceDetails, params.listTransactions !== false);
                                break;
                            }
                            case 'GET_CREDIT_CARD_AVAILABLE_LIMIT': {
                                const cardNameForLimit = params.creditCardName;
                                if (!cardNameForLimit) throw new Error("Nome do cartão é obrigatório para ver o limite.");
                                const cardIdForLimit = await findCreditCardIdByName(cardNameForLimit, state.activeFinancialAccountId);
                                if (!cardIdForLimit) {
                                    throw new Error(`Não encontrei o cartão "${cardNameForLimit}". Verifique o nome ou cadastre o cartão.`);
                                }
                                const limitInfo = await creditCardService.getCreditCardAvailableLimit(state.activeFinancialAccountId, cardIdForLimit);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Aqui está o limite do seu cartão ${limitInfo.cardName}, ${clientNameToUse}:`;
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
                                    throw new Error(`Não encontrei o cartão "${cardNameToPay}" para registrar o pagamento da fatura.`);
                                }
                                const paymentDateCard = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
                                
                                // MODIFICADO: Usa financialCategoryService, e verifica se a categoria "Pagamento de Fatura" existe
                                let categoryNameToUseForPayment = params.financialCategoryName || "Pagamento de Fatura";
                                let categoryObjectPay = await financialCategoryService.findFinancialCategoryByNameForAccount(categoryNameToUseForPayment, state.activeFinancialAccountId);
                                
                                // Se a categoria específica (ou "Pagamento de Fatura") não foi encontrada, não atribui categoria.
                                let categoryIdPay = categoryObjectPay ? categoryObjectPay.id : null;
                                if (!categoryIdPay && params.financialCategoryName) { // Se o usuário especificou uma categoria e ela não foi encontrada
                                    logger.warn(`[WHATSAPP SERVICE] Categoria "${params.financialCategoryName}" fornecida para pagamento de fatura não encontrada na conta ${state.activeFinancialAccountId}. Pagamento será sem categoria.`);
                                } else if (!categoryIdPay && !params.financialCategoryName) { // Se era para usar "Pagamento de Fatura" e não achou
                                    logger.warn(`[WHATSAPP SERVICE] Categoria padrão "Pagamento de Fatura" não encontrada na conta ${state.activeFinancialAccountId}. Pagamento de fatura será sem categoria.`);
                                }


                                const paymentTransaction = await creditCardService.payCreditCardInvoice(
                                    state.activeFinancialAccountId, cardIdToPay, paymentAmount, paymentDateCard,
                                    params.originatingAccountDescription, 
                                    categoryIdPay,
                                    actorId
                                );
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Pagamento da fatura do cartão "${cardNameToPay}" registrado, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre o pagamento da fatura, ${clientNameToUse}:`;
                                currentActionFormattedData = `✅ Pagamento de ${formatCurrency(paymentAmount)} para o cartão "${cardNameToPay}" registrado em ${formatDate(paymentDateCard)}.`;
                                if (paymentTransaction.category) currentActionFormattedData += `\nCategoria: ${paymentTransaction.category.name}.`;
                                break;
                            }
                            case 'SET_MOTIVATIONAL_MESSAGE_PREFERENCE': {
                                if (params.enable === undefined || (params.enable && !params.time)) throw new Error("Preciso saber se quer ativar/desativar e, se ativar, o horário (HH:MM).");
                                await systemService.updateSystemPreferences({ // Removido actorId, pois UserPreference é global
                                    enableMotivationMessage: params.enable,
                                    motivationMessageTime: params.enable ? params.time : null
                                });
                                const updatedPrefsMotiv = await systemService.getSystemPreferences(); // Removido actorId
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Preferências de mensagem motivacional atualizadas, ${clientNameToUse}!`;
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
                                await systemService.updateSystemPreferences({ // Removido actorId
                                    enableWaterReminder: params.enable,
                                    waterReminderFrequencyType: params.enable ? params.frequencyType : 'disabled',
                                    waterReminderCustomIntervalMinutes: params.enable && params.frequencyType === 'custom' ? parseInt(params.customIntervalMinutes) : null,
                                    waterReminderStartTime: params.enable ? params.startTime : null,
                                    waterReminderEndTime: params.enable ? params.endTime : null,
                                    dailyGoalMl: params.enable && params.dailyGoalMl ? parseInt(params.dailyGoalMl) : null
                                });
                                const updatedPrefsWater = await systemService.getSystemPreferences(); // Removido actorId
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Preferências de lembrete de água atualizadas, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre os lembretes de água, ${clientNameToUse}:`;
                                currentActionFormattedData = formatWaterReminderPreferenceDataStructure(updatedPrefsWater);
                                break;
                            }
                            case 'CREATE_BUSINESS_CLIENT': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Cadastro de clientes do negócio é apenas para contas PJ/MEI.");
                                if (!params.name) throw new Error("Nome do cliente do negócio é obrigatório.");
                                const bcData = { name: params.name, phone: params.phone, email: params.email, notes: params.notes };
                                const newBc = await businessClientService.createBusinessClient(state.activeFinancialAccountId, bcData, actorId);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Cliente "${newBc.name}" cadastrado com sucesso, ${clientNameToUse}! 🤝`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Cadastrei o cliente, ${clientNameToUse}:`;
                                currentActionFormattedData = formatBusinessClientDataStructure(newBc);
                                if (aiResponse.detected_actions.length === 1 && isOwnerActingOnOwnBehalfGlobal) resourceForButtonsContext = { type: 'business_client', id: newBc.id, description: newBc.name };
                                break;
                            }
                            case 'LIST_BUSINESS_CLIENTS': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Listagem de clientes do negócio é apenas para contas PJ/MEI.");
                                const filterParamsBC = { search: params.searchTerm, isActive: params.isActive !== undefined ? params.isActive : true, limit: params.limit || 5, page: 1 };
                                const { businessClients, totalItems: totalBC } = await businessClientService.getAllBusinessClients(state.activeFinancialAccountId, filterParamsBC);
                                
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalBC === 0 ? `Nenhum cliente do negócio encontrado, ${clientNameToUse}. Que tal cadastrar o primeiro?` : `👥 Encontrei ${totalBC} cliente(s) do negócio. Aqui estão os primeiros:`);
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                     aiMessageIntro = totalBC === 0 ? `Nenhum cliente do negócio encontrado, ${clientNameToUse}.` : `Sobre seus clientes do negócio:`;
                                }
                                if (totalBC > 0) currentActionFormattedData = formatListBusinessClientsDataStructure(businessClients);
                                else if (totalBC === 0 && aiResponse.detected_actions.length === 1) currentActionFormattedData = "Você pode adicionar um dizendo 'cadastrar cliente [nome do cliente]'.";
                                break;
                            }
                            case 'UPDATE_BUSINESS_CLIENT': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Apenas para contas PJ/MEI.");
                                 if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                                     throw new Error("Você não tem permissão para editar clientes nesta conta compartilhada.");
                                 }
                                const clientIdToUpdate = state.editingResource?.type === 'business_client' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.clientIdToUpdate ? parseInt(params.clientIdToUpdate) : null); 
                                
                                let effectiveClientIdToUpdate = clientIdToUpdate;
                                if (!effectiveClientIdToUpdate && params.name) { 
                                     const foundClient = await businessClientService.getAllBusinessClients(state.activeFinancialAccountId, { search: params.name, limit: 1 }).then(r => r.businessClients?.[0]);
                                     if (foundClient) effectiveClientIdToUpdate = foundClient.id;
                                }
                                if (!effectiveClientIdToUpdate) throw new Error("ID ou nome do cliente do negócio para atualizar não fornecido ou não encontrado.");
                                
                                const updateDataBC = {};
                                if (params.hasOwnProperty('name')) updateDataBC.name = params.name; 
                                if (params.hasOwnProperty('phone')) updateDataBC.phone = params.phone;
                                if (params.hasOwnProperty('email')) updateDataBC.email = params.email;
                                if (params.hasOwnProperty('notes')) updateDataBC.notes = params.notes;
                                if (params.hasOwnProperty('isActive')) updateDataBC.isActive = params.isActive;
                                if (Object.keys(updateDataBC).length === 0 && !params.name) throw new Error("Nenhum dado para atualizar o cliente.");

                                const updatedBC = await businessClientService.updateBusinessClient(state.activeFinancialAccountId, effectiveClientIdToUpdate, updateDataBC, actorId);
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Cliente "${updatedBC.name}" atualizado, ${clientNameToUse}!`;
                                currentActionFormattedData = formatBusinessClientDataStructure(updatedBC);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'GRANT_ACCESS': { 
                                if (!isOwnerActingOnOwnBehalfGlobal) throw new Error("Você não pode gerenciar acessos de dentro de um acesso compartilhado.");
                                if (!params.sharedWithUserIdentifier) throw new Error("Preciso do telefone ou e-mail de quem você quer convidar.");
                                if (!params.accessPersonalProfile && !params.businessProfileToShareName) throw new Error("Você precisa escolher pelo menos um perfil (Pessoal ou Empresarial) para compartilhar.");

                                let businessProfileIdToShare = null;
                                if (params.businessProfileToShareName) {
                                    const bizAccount = (await clientService.getClientFinancialAccounts(ownerId, {isActive:true})).find(acc => (acc.accountType === 'PJ' || acc.accountType === 'MEI') && acc.accountName.toLowerCase() === params.businessProfileToShareName.toLowerCase());
                                    if (!bizAccount) throw new Error(`Não encontrei um perfil empresarial chamado "${params.businessProfileToShareName}" na sua conta.`);
                                    businessProfileIdToShare = bizAccount.id;
                                }

                                // grantAccess agora espera um objeto grantData
                                const grantDataForService = {
                                    sharedWithUserIdentifier: params.sharedWithUserIdentifier,
                                    canAccessPersonalProfile: params.accessPersonalProfile || false,
                                    canAccessBusinessProfileId: businessProfileIdToShare,
                                    sharedAccessEmail: params.sharedAccessEmailForGuest, // Nome correto
                                    sharedAccessPassword: params.sharedAccessPasswordForGuest, // Nome correto
                                    sharedAccessPhone: params.sharedAccessPhoneForGuest, // Nome correto
                                    sharedWithClientName: params.sharedWithClientName // Se a IA extrair o nome do convidado
                                };

                                const newSharedAccess = await sharedAccessService.grantAccess(ownerId, grantDataForService); // Passa actorId implicitamente se o service precisar
                                
                                const reloadedSA = await sharedAccessService.getSharedAccessById(newSharedAccess.id); // Use uma função que busca por ID com includes

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Convite enviado com sucesso para ${params.sharedWithUserIdentifier}! 🤝`;
                                currentActionFormattedData = formatSharedAccessDataStructure(reloadedSA, 'owner');
                                break;
                            }
                            case 'LIST_GRANTED_ACCESS': { 
                                if (!isOwnerActingOnOwnBehalfGlobal) throw new Error("Use 'listar meus convites' para ver os que você recebeu.");
                                const result = await sharedAccessService.getSharedAccessesByOwner(ownerId, { status: params.status });
                                const grantedList = result.sharedAccesses;
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
                                     aiMessageIntro = aiResponse.overall_summary_suggestion || (grantedList.length === 0 ? `Você ainda não compartilhou seu acesso com ninguém, ${clientNameToUse}.` : `Aqui estão os acessos que você concedeu, ${clientNameToUse}:`);
                                }
                                if (grantedList.length > 0) currentActionFormattedData = formatListSharedAccessDataStructure(grantedList, 'owner');
                                break;
                            }
                            case 'LIST_RECEIVED_ACCESS': { 
                                const result = await sharedAccessService.getSharedAccessesForUser(actorId, { status: params.status || 'Pendente' }); 
                                const receivedList = result.sharedAccesses;
                                 if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
                                     aiMessageIntro = aiResponse.overall_summary_suggestion || (receivedList.length === 0 ? `Você não tem convites de acesso pendentes ou ativos, ${clientNameToUse}.` : `Aqui estão os convites/acessos que você recebeu, ${clientNameToUse}:`);
                                }
                                if (receivedList.length > 0) currentActionFormattedData = formatListSharedAccessDataStructure(receivedList, 'guest');
                                else if (params.status === 'Pendente' && receivedList.length === 0 && aiResponse.detected_actions.length === 1) currentActionFormattedData = "Nenhum convite pendente no momento. 👍";
                                break;
                            }
                            case 'RESPOND_TO_INVITE': { 
                                if (!params.responseType || !['aceitar', 'recusar'].includes(params.responseType.toLowerCase())) throw new Error("Preciso saber se você quer 'aceitar' ou 'recusar' o convite.");
                                
                                let sharedAccessIdToRespond = params.sharedAccessId;
                                if (!sharedAccessIdToRespond) { 
                                    const {sharedAccesses: pendingInvites} = await sharedAccessService.getSharedAccessesForUser(actorId, { status: 'Pendente' });
                                    if (pendingInvites.length === 0) throw new Error("Você não tem convites pendentes para responder.");
                                    if (pendingInvites.length === 1 && !params.inviterNameOrIdentifier) {
                                        sharedAccessIdToRespond = pendingInvites[0].id;
                                    } else if (params.inviterNameOrIdentifier) {
                                        const foundInvite = pendingInvites.find(invite => invite.ownerClient?.name.toLowerCase().includes(params.inviterNameOrIdentifier.toLowerCase()) || invite.ownerClient?.email.toLowerCase().includes(params.inviterNameOrIdentifier.toLowerCase()));
                                        if (!foundInvite) throw new Error(`Não encontrei um convite pendente de "${params.inviterNameOrIdentifier}".`);
                                        sharedAccessIdToRespond = foundInvite.id;
                                    } else {
                                        throw new Error("Você tem múltiplos convites pendentes. Por favor, especifique de quem é o convite (ex: 'aceitar convite do Fulano').");
                                    }
                                }
                                const response = params.responseType.toLowerCase();
                                const updatedSharedAccess = await sharedAccessService.respondToInvite(actorId, sharedAccessIdToRespond, response); 
                                const reloadedSAForRespond = await sharedAccessService.getSharedAccessById(updatedSharedAccess.id);

                                aiMessageIntro = aiResponse.overall_summary_suggestion || `Convite ${response === 'aceitar' ? 'aceito' : 'recusado'} com sucesso, ${clientNameToUse}! 🎉`;
                                currentActionFormattedData = formatSharedAccessDataStructure(reloadedSAForRespond, 'guest');
                                if (response === 'aceitar' && !state.activeFinancialAccountId) {
                                     state.currentAction = 'selecting_account_flow_active'; 
                                     state.activeFinancialAccountId = null; 
                                }
                                break;
                            }
                            case 'REVOKE_ACCESS': { 
                                if (!isOwnerActingOnOwnBehalfGlobal) throw new Error("Ação não permitida em acesso compartilhado.");
                                if (!params.sharedWithUserIdentifier) throw new Error("Preciso do telefone ou e-mail do usuário para revogar o acesso.");

                                const {sharedAccesses} = await sharedAccessService.getSharedAccessesByOwner(ownerId, { guestIdentifier: params.sharedWithUserIdentifier, status: 'Ativo' }); 
                                if (sharedAccesses.length === 0) throw new Error(`Não encontrei acessos ativos concedidos para "${params.sharedWithUserIdentifier}".`);
                                
                                let sharedAccessIdToRevoke = null;
                                let guestNameForMsg = params.sharedWithUserIdentifier;

                                if (params.profileNameShared) { 
                                    const targetProfileNameLower = params.profileNameShared.toLowerCase();
                                    const saToRevoke = sharedAccesses.find(sa => {
                                        if (sa.canAccessPersonalProfile && (targetProfileNameLower.includes("pessoal") || sa.ownerClient?.financialAccounts.find(fa=>fa.accountType==='PF')?.accountName.toLowerCase().includes(targetProfileNameLower)) ) return true;
                                        if (sa.canAccessBusinessProfileId) {
                                            const bizAcc = sa.ownerClient?.financialAccounts.find(fa=> fa.id === sa.canAccessBusinessProfileId);
                                            if (bizAcc && bizAcc.accountName.toLowerCase().includes(targetProfileNameLower)) return true;
                                        }
                                        return false;
                                    });
                                    if (!saToRevoke) throw new Error (`Não encontrei um acesso para o perfil "${params.profileNameShared}" concedido a ${params.sharedWithUserIdentifier}.`);
                                    sharedAccessIdToRevoke = saToRevoke.id;
                                    guestNameForMsg = saToRevoke.sharedWithClient?.name || params.sharedWithUserIdentifier;
                                } else if (sharedAccesses.length > 1) {
                                    state.pendingConfirmation = {
                                        action: 'REVOKE_ACCESS',
                                        parameters: { sharedAccessIdsToRevoke: sharedAccesses.map(sa=>sa.id), guestName: sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier, revokeAllForUser: true }, 
                                        message: `Encontrei ${sharedAccesses.length} acessos para ${sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier}. Você quer revogar TODOS eles? (Sim/Não)`
                                    };
                                    aiMessageIntro = state.pendingConfirmation.message;
                                    currentActionFormattedData = ""; platformLinkFooter = "";
                                    state.currentAction = 'awaiting_confirmation';
                                    break; 
                                } else { 
                                    sharedAccessIdToRevoke = sharedAccesses[0].id;
                                    guestNameForMsg = sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier;
                                }
                                
                                if (sharedAccessIdToRevoke && !state.pendingConfirmation) {
                                    await sharedAccessService.revokeAccess(ownerId, sharedAccessIdToRevoke); // Ajustado para revokeAccess 
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || `Acesso de ${guestNameForMsg} revogado com sucesso!`;
                                    currentActionFormattedData = "Esta pessoa não poderá mais acessar as informações através deste convite.";
                                }
                                break;
                            }
                            case 'UPDATE_FINANCIAL_ACCOUNT': {
                                if (!isOwnerActingOnOwnBehalfGlobal) throw new Error("Ação não permitida em acesso compartilhado.");
                                if (!params.accountNameToUpdate) throw new Error("Qual conta você quer atualizar?");
                                
                                const accountToUpdate = (await clientService.getClientFinancialAccounts(ownerId, {isActive:null})).find(acc => acc.accountName.toLowerCase() === params.accountNameToUpdate.toLowerCase());
                                if (!accountToUpdate) throw new Error(`Não encontrei uma conta sua chamada "${params.accountNameToUpdate}".`);

                                const updateDataFA = {};
                                if (params.hasOwnProperty('newAccountName')) updateDataFA.accountName = params.newAccountName;
                                if (params.hasOwnProperty('documentNumber')) updateDataFA.documentNumber = params.documentNumber;
                                if (params.hasOwnProperty('isActive')) updateDataFA.isActive = params.isActive;
                                if (params.hasOwnProperty('isDefault')) updateDataFA.isDefault = params.isDefault;
                                if (Object.keys(updateDataFA).length === 0) throw new Error("Nenhum dado fornecido para atualizar a conta.");

                                const updatedFA = await clientService.updateFinancialAccount(accountToUpdate.id, updateDataFA); 
                                if (state.activeFinancialAccountId === updatedFA.id) {
                                    state.activeFinancialAccountName = updatedFA.accountName;
                                    state.activeFinancialAccountType = updatedFA.accountType; 
                                }
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `Conta "${params.accountNameToUpdate}" atualizada com sucesso, ${clientNameToUse}!`;
                                currentActionFormattedData = formatFinancialAccountDataStructure(updatedFA);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'DELETE_FINANCIAL_ACCOUNT': {
                                if (!isOwnerActingOnOwnBehalfGlobal) throw new Error("Ação não permitida em acesso compartilhado.");
                                if (!params.accountNameToDelete) throw new Error("Qual conta você quer excluir?");

                                const accountsOwned = await clientService.getClientFinancialAccounts(ownerId, {isActive:null});
                                const accountToDelete = accountsOwned.find(acc => acc.accountName.toLowerCase() === params.accountNameToDelete.toLowerCase());
                                if (!accountToDelete) throw new Error(`Não encontrei uma conta sua chamada "${params.accountNameToDelete}".`);
                                if (accountsOwned.length <= 1 && accountToDelete) {
                                    throw new Error("Você não pode excluir sua única conta financeira. Crie outra primeiro, se desejar.");
                                }
                                
                                state.pendingConfirmation = {
                                    action: 'DELETE_FINANCIAL_ACCOUNT',
                                    parameters: { accountIdToDelete: accountToDelete.id, accountNameToDelete: accountToDelete.accountName },
                                    message: `⚠️ ATENÇÃO, ${clientNameToUse}! Você tem certeza ABSOLUTA que quer excluir a conta "${accountToDelete.accountName}"? Esta ação NÃO PODE SER DESFEITA e todas as transações, cartões e dados associados a ela serão PERDIDOS.\n\nDigite "sim, excluir ${accountToDelete.accountName}" para confirmar ou "não" para cancelar.`
                                };
                                aiMessageIntro = state.pendingConfirmation.message;
                                currentActionFormattedData = ""; platformLinkFooter = "";
                                state.currentAction = 'awaiting_confirmation';
                                break;
                            }
                            case 'GENERAL_GREETING_OR_SMALLTALK':
                            case 'GENERAL_QUESTION_OR_HELP':
                            case 'ACTION_CONFIRMATION_YES':
                            case 'ACTION_CONFIRMATION_NO':
                                if (aiResponse.overall_summary_suggestion && aiResponse.overall_summary_suggestion !== aiResponse.reply_to_user_suggestion && aiResponse.detected_actions.length === 1 && !aiResponse.overall_summary_suggestion.startsWith("Ok,")) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion;
                                } else if (aiResponse.reply_to_user_suggestion) {
                                    aiMessageIntro = aiResponse.reply_to_user_suggestion;
                                } else {
                                    aiMessageIntro = `Entendido, ${clientNameToUse}! 😊`;
                                }
                                 currentActionFormattedData = "";
                                 platformLinkFooter = (actionName === 'GENERAL_QUESTION_OR_HELP' && !(aiMessageIntro && aiMessageIntro.includes('map-nocontrole.com.br/painel'))) ? formatPlatformLink("Se precisar de mais funcionalidades, explore nossa plataforma!") : "";

                                if (actionName === 'ACTION_CONFIRMATION_YES' || actionName === 'ACTION_CONFIRMATION_NO') {
                                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                                }
                                break;
                            default:
                                let defaultIntro = `Ok, ${clientNameToUse}!`;
                                if (aiResponse.detected_actions.length === 1 && aiResponse.overall_summary_suggestion && !aiResponse.overall_summary_suggestion.startsWith("Ok,")) {
                                    defaultIntro = aiResponse.overall_summary_suggestion;
                                } else if (aiResponse.reply_to_user_suggestion && !aiResponse.reply_to_user_suggestion.startsWith("Ok,")) {
                                    defaultIntro = aiResponse.reply_to_user_suggestion;
                                }
                               
                                if (multipleActionBodiesList.length === 0 &&
                                    (!(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && aiMessageIntro !== aiResponse.overall_summary_suggestion && aiMessageIntro !== aiResponse.reply_to_user_suggestion && !aiMessageIntro.startsWith("Ok,"))) {
                                     aiMessageIntro = defaultIntro;
                                } else if (aiResponse.detected_actions.length > 1 && aiResponse.overall_summary_suggestion && aiMessageIntro !== aiResponse.overall_summary_suggestion  && !aiResponse.overall_summary_suggestion.startsWith("Ok,")) {
                                    // Mantém
                                } else if (aiResponse.overall_summary_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`)|| aiMessageIntro.startsWith(`Entendido, ${clientNameToUse}!`))  && !aiResponse.overall_summary_suggestion.startsWith("Ok,")) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion;
                                }

                                currentActionFormattedData = `Ainda estou aprendendo a processar a ação de "${actionName.toLowerCase().replace(/_/g," ")}" completamente. 😅 Minha equipe está trabalhando nisso!`;
                                logger.warn(`[WHATSAPP SERVICE] Ação da IA não implementada ou sem formatação específica no switch: ${actionName}`);
                                break;
                        }
                    } catch (e) {
                         logger.error(`[WHATSAPP HANDLER] Erro executando "${actionName}" para ${senderPhone} (Ator: ${actorId}, DonoCtx: ${ownerId}): ${e.message}`, { stack: e.stack?.substring(0,300), paramsUsed: params });
                         let errorIntroPart = `Ops! 😬 Tive um problema ao tentar processar "${params.description || actionName.toLowerCase().replace(/_/g," ")}".`;
                         let errorDataPart = `Detalhe do erro: ${e.message.length < 120 ? e.message : 'Erro interno, desculpe!'}\n\nPode tentar de novo ou com outros termos?`;
                        
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

                    if (currentActionFormattedData && !currentActionBlocked) {
                        multipleActionBodiesList.push(currentActionFormattedData);
                    }
                } 

                if (multipleActionBodiesList.length > 0) {
                    structuredDataBody = multipleActionBodiesList.join("\n\n---\n\n");
                    if ((typeof aiMessageIntro === 'string' && (aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`) || aiMessageIntro.startsWith(`Entendido, ${clientNameToUse}!`) || !aiMessageIntro.includes(clientNameToUse))) &&
                        aiResponse.overall_summary_suggestion && !aiResponse.overall_summary_suggestion.startsWith(`Ok, ${clientNameToUse}!`) &&
                        !(aiMessageIntro && (aiMessageIntro.toLowerCase().includes("ops") || aiMessageIntro.toLowerCase().includes("problema")) ) ) {
                        aiMessageIntro = aiResponse.overall_summary_suggestion;
                    }
                } else if (aiResponse.detected_actions.length === 0) {
                    structuredDataBody = "";
                    if (aiResponse.reply_to_user_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`) || aiMessageIntro.startsWith(`Entendido, ${clientNameToUse}!`) || aiMessageIntro === aiResponse.overall_summary_suggestion )) {
                        if (aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`)) {
                            aiMessageIntro = aiResponse.reply_to_user_suggestion;
                        }
                    }
                }
            } 
       
            if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
                if(!(multipleActionBodiesList.length > 0 && aiMessageIntro && !aiMessageIntro.startsWith("Ok,") && !aiMessageIntro.startsWith("Entendido,"))) { 
                    aiMessageIntro = aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe:`;
                }
                const clarificationBody = aiResponse.clarifications_needed[0].clarification_question;
                structuredDataBody = structuredDataBody ? `${structuredDataBody}\n\n---\n\n${clarificationBody}` : clarificationBody;
                platformLinkFooter = "";
                state.currentAction = 'awaiting_clarification_response';
                state.data.clarificationContext = {
                    action: aiResponse.clarifications_needed[0].original_intent_action_suggestion,
                    original_message: messageText,
                    parameters_so_far: aiResponse.clarifications_needed[0].parameters_so_far || {}
                };
            } else if ((!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) && !structuredDataBody) {
                if (aiResponse.reply_to_user_suggestion &&
                    (typeof aiMessageIntro !== 'string' || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`) || aiMessageIntro.startsWith(`Entendido, ${clientNameToUse}!`) || aiMessageIntro === aiResponse.overall_summary_suggestion )) {
                    if (aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`)) {
                        aiMessageIntro = aiResponse.reply_to_user_suggestion;
                    }
                }
                if(multipleActionBodiesList.length === 0) structuredDataBody = "";

                if ((typeof aiMessageIntro === 'string' && (aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`) || aiMessageIntro.startsWith(`Entendido, ${clientNameToUse}!`))) && !structuredDataBody && !aiResponse.overall_summary_suggestion && !aiResponse.reply_to_user_suggestion) {
                    aiMessageIntro = `Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊`;
                }
            }
       
            if (typeof aiMessageIntro !== 'string' || aiMessageIntro.trim() === "" || aiMessageIntro.trim().toLowerCase() === "null") { 
                aiMessageIntro = `Ok, ${clientNameToUse}! `;
            }

            finalMessageToSend = aiMessageIntro.trim();
            if (structuredDataBody && structuredDataBody.trim() !== "") {
                finalMessageToSend += `\n\n${structuredDataBody.trim()}`;
            }
           
            let noLinkCurrentAction = state.currentAction === 'awaiting_clarification_response' || state.currentAction === 'selecting_account_flow_active' || state.currentAction?.startsWith('awaiting_explicit_') || state.currentAction === 'awaiting_confirmation';
            let noLinkDetectedAction = false;
            if(aiResponse.detected_actions && aiResponse.detected_actions.length > 0){
                noLinkDetectedAction = aiResponse.detected_actions.some(da => {
                    const actionNameCheck = da.action || da.action_type;
                    return actionNameCheck?.startsWith("GENERAL_GREETING") || actionNameCheck?.startsWith("ACTION_CONFIRMATION_") || actionNameCheck === "SWITCH_FINANCIAL_ACCOUNT" || actionNameCheck === "CREATE_FINANCIAL_ACCOUNT" || actionNameCheck === "DELETE_FINANCIAL_ACCOUNT";
                });
            }
            const noLinkConditions = noLinkCurrentAction ||
                                     (finalMessageToSend && finalMessageToSend.includes('https://map-nocontrole.com.br/')) ||
                                     (finalMessageToSend && finalMessageToSend.includes('https://map-nocontrole.com.br/')) ||
                                     (state.data.onboardingStage === 'awaiting_plan_confirmation' && !state.hasPaidAccess) ||
                                     noLinkDetectedAction;


               if (platformLinkFooter && platformLinkFooter.trim() !== "" && !noLinkConditions ) {
             finalMessageToSend += `\n\n---\n\n${platformLinkFooter.trim()}`;
        }
            finalMessageToSend = finalMessageToSend.replace(/\n{3,}/g, '\n\n').trim();
       
            if (finalMessageToSend) {
                state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });
            }
       
            if (actionWasAnEdit || (state.editingResource && (!aiResponse.detected_actions || aiResponse.detected_actions.every(a => !(a.action || a.action_type)?.startsWith("UPDATE_") && (a.action || a.action_type) !== 'RECREATE_PARCELLED_ACCOUNT')))) {
                state.editingResource = null;
            }
            if (state.data.clarificationContext && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
                delete state.data.clarificationContext;
            }
       
            if (finalMessageToSend) {
                const performedConcreteAction = (aiResponse.detected_actions && aiResponse.detected_actions.length > 0 &&
                                           aiResponse.detected_actions.some(a => {
                                               const actionNameCheck = a.action || a.action_type;
                                               return !(actionNameCheck?.startsWith("GENERAL_") || actionNameCheck?.startsWith("LIST_") || actionNameCheck?.startsWith("GET_") || actionNameCheck?.startsWith("SWITCH_") || actionNameCheck?.startsWith("ACTION_CONFIRMATION_") || actionNameCheck === 'DELETE_FINANCIAL_ACCOUNT');
                                           })) &&
                                           (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0);

                const singleConcreteNonEditAction = performedConcreteAction && aiResponse.detected_actions.filter(a => {
                    const actionNameCheck = a.action || a.action_type;
                    return !(actionNameCheck?.startsWith("GENERAL_") ||
                             actionNameCheck?.startsWith("LIST_") ||
                             actionNameCheck?.startsWith("GET_") ||
                             actionNameCheck?.startsWith("SWITCH_") ||
                             actionNameCheck?.startsWith("ACTION_CONFIRMATION_") ||
                             actionNameCheck?.startsWith("UPDATE_") ||
                             actionNameCheck === "RECREATE_PARCELLED_ACCOUNT" ||
                             actionNameCheck === "DELETE_FINANCIAL_ACCOUNT" ||
                             actionNameCheck?.startsWith("GRANT_") || actionNameCheck?.startsWith("REVOKE_") || actionNameCheck?.startsWith("RESPOND_TO_")
                             );
                }).length === 1;

                if (resourceForButtonsContext && singleConcreteNonEditAction && isOwnerActingOnOwnBehalfGlobal) { 
                    let buttons = [];
                    let buttonItemDesc = "item";
                    if (resourceForButtonsContext.description && typeof resourceForButtonsContext.description === 'string') {
                        buttonItemDesc = resourceForButtonsContext.description.length > 24 ? resourceForButtonsContext.description.substring(0, 21) + "..." : resourceForButtonsContext.description;
                    }
                    const buttonTitle = `Opções para "${buttonItemDesc}":`;
       
                    switch(resourceForButtonsContext.type) {
                        case 'transaction': buttons = [ { id: `edit_transaction_${resourceForButtonsContext.id}`, label: "Editar Transação ✍️" }, { id: `delete_transaction_${resourceForButtonsContext.id}`, label: "Excluir Transação 🗑️" }, ]; break;
                        case 'appointment': buttons = [ { id: `edit_appointment_${resourceForButtonsContext.id}`, label: "Editar Compromisso ✍️" }, { id: `delete_appointment_${resourceForButtonsContext.id}`, label: "Excluir Compromisso 🗑️" }, ]; break;
                        case 'credit_card': buttons = [ { id: `edit_credit_card_${resourceForButtonsContext.id}`, label: "Editar Cartão ✍️" }, { id: `delete_credit_card_${resourceForButtonsContext.id}`, label: "Excluir Cartão 🗑️" }, ]; break;
                        case 'recurring_rule': buttons = [ { id: `edit_recurring_rule_${resourceForButtonsContext.id}`, label: "Editar Recorrência ✍️" }, { id: `delete_recurring_rule_${resourceForButtonsContext.id}`, label: "Excluir Recorrência 🗑️" }, ]; break;
                        case 'product': buttons = [ { id: `edit_product_${resourceForButtonsContext.id}`, label: "Editar Produto ✍️" }, ]; break;
                        case 'parcelled_account': buttons = [ { id: `edit_parcelled_account_${resourceForButtonsContext.id}`, label: "Alterar Compra Parcelada ✍️" }, { id: `delete_parcelled_account_${resourceForButtonsContext.id}`, label: "Excluir Compra Parcelada 🗑️" }, ]; break;
                    }
       
                       if (buttons.length > 0) {
                        // Adiciona o rodapé da plataforma diretamente na mensagem que será enviada com os botões
                        const finalMessageWithFooter = `${finalMessageToSend}\n\n${platformLinkFooter}`;
                        await sendButtonListMessage(senderPhone, finalMessageWithFooter, buttons, buttonTitle, "Ver Opções 👇");
                    } else {
                        await sendWhatsappMessage(senderPhone, finalMessageToSend);
                    }
                } else {
                    await sendWhatsappMessage(senderPhone, finalMessageToSend);
                    if(state.editingResource && !resourceForButtonsContext && !actionWasAnEdit) state.editingResource = null;
                }
            }
        }

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000), messageText, rawPayload });
        const clientNameToUseInError = state?.clientName || pushNameFromPayload || "você";
        const errorIntro = `Puxa vida, ${clientNameToUseInError}! 😬 Parece que tive um curto-circuito feio aqui...`;
        const errorData = `🎯 Ocorrência Inesperada:\n\nNão consegui processar sua mensagem (${error.message.substring(0,100)}).\nMinha equipe de engenheiros já foi notificada! 👩‍💻👨‍💻`;
        const errorLink = formatPlatformLink("Por favor, tente de novo em um momentinho ou acesse a plataforma.");
        try {
            await sendWhatsappMessage(senderPhone, `${errorIntro}\n\n${errorData}\n\n${errorLink}`);
        } catch (sendError) {
            logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro crítico para ${senderPhone}: ${sendError.message}`);
        }
    } finally {
        const endTime = Date.now();
        logger.info(`[WHATSAPP HANDLER] Processamento para ${senderPhone} (Ator: ${actorClient?.id || 'N/A'}, DonoCtx: ${state?.ownerClientIdForContext || 'N/A'}) finalizado em ${endTime - startTime}ms.`);
        if (state) {
            logger.debug(`[WHATSAPP HANDLER] Estado final da sessão para ${senderPhone}:`, {
                currentAction: state.currentAction,
                onboardingStage: state.data?.onboardingStage,
                hasPaidAccessDono: state.hasPaidAccess,
                activeFinancialAccountId: state.activeFinancialAccountId,
                isShared: state.isSharedAccessContext,
            });
            conversationState.set(senderPhone, state);
        }
        pushNameFromPayload = null; // Limpa a variável global após o uso para esta chamada
    }
}

module.exports = { 
    processIncomingMessage, 
    processIncomingAudioMessage, 
    formatAppointmentDataStructure 
};
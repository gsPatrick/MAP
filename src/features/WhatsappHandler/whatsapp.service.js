// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const businessClientService = require('../BusinessClient/BusinessClient.service'); // NOVO
const sharedAccessService = require('../SharedAccess/sharedAccess.service'); // NOVO
const systemService = require('../System/system.service');


const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8; // Mantém 8 trocas (usuário + assistente) = 16 mensagens
const MAX_STATE_HISTORY = 20; // Máximo de mensagens no histórico do estado
let pushNameFromPayload = null;


// --- Funções Auxiliares de Busca ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    // O systemService.findFinancialCategoryByNameAndType já deve lidar com a busca por nome e tipo na conta correta
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
            return null;
        }
        logger.error(`[WHATSAPP SERVICE HELPER] Erro inesperado ao buscar cartão ${name}: ${error.message}`);
        throw error;
    }
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    // productService.getAllProducts com search deve retornar o produto
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

function formatTime(dateTimeString, includeSeconds = true) {
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

function formatPlatformLink(customText = "") {
    const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
    const defaultText = `📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}. Qualquer coisa, estou por aqui! 😉`;
    return customText || defaultText;
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
    data += `💼 Título: ${appointment.title || 'N/A'}\n`; // Título é o mais importante
    data += `📆 Data: ${formatDate(appointment.eventDateTime)}\n`;
    data += `🕔 Horário de início: ${formatTime(appointment.eventDateTime, false)}\n`; // Sem segundos por padrão

    if (appointment.durationMinutes) {
        const endTime = new Date(new Date(appointment.eventDateTime).getTime() + appointment.durationMinutes * 60000);
        data += `🕔 Horário de término: ${formatTime(endTime, false)}\n`;
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
    if (appointment.businessClients && appointment.businessClients.length > 0) { // Para PJ/MEI
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
    data += `➡️ Próximo Vencimento: ${rule.nextDueDate ? formatDate(rule.nextDueDate) : 'N/A (Regra Inativa ou Concluída)'}\n`;
    data += `⚙️ Criação Automática: ${rule.autoCreateTransaction ? 'Sim (Gera transação)' : 'Não (Apenas Lembrete)'}\n`;
    data += `🚦 Status da Regra: ${rule.isActive ? 'Ativa ✅' : 'Inativa ❌'}\n`;

    return data.trim();
}

function formatCreditCardDataStructure(card) { // Para um único cartão (cadastro/edição)
    if (!card) return "💳 Resumo do Cartão:\n\nDados não disponíveis.";
    let data = `💳 Resumo do Cartão de Crédito:\n\n`;
    data += `🏦 Nome: ${card.name || 'N/A'}\n`;
    data += `💰 Limite Total: ${formatCurrency(card.limit)}\n`;
    // Se o service calcular o limite disponível no momento do cadastro/edição, pode adicionar aqui
    if (card.availableLimit !== undefined) {
        data += `💰 Limite Disponível: ${formatCurrency(card.availableLimit)}\n`;
    }
    data += `🗓️ Dia de Fechamento: ${card.closingDay}\n`;
    data += `💵 Dia de Pagamento: ${card.paymentDay}\n`;
    if(card.lastFourDigits) data += `🔢 Final do Cartão: ${card.lastFourDigits}\n`;
    if(card.flag) data += `🏳️ Bandeira: ${card.flag}\n`;
    data += `⭐ Cartão Padrão: ${card.isDefault ? 'Sim ✅' : 'Não ❌'}\n`;
    data += `🚦 Status: ${card.isActive ? 'Ativo ✅' : 'Inativo ❌'}\n`;
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
        data += `   🚦 Status: ${card.isActive ? 'Ativo ✅' : 'Inativo ❌'}\n`;
    });
    return data.trim();
}

function formatCreditCardInvoiceDataStructure(invoiceDetails, listTransactions = true) {
    if (!invoiceDetails) return "🎯 Resumo da Fatura:\n\nDados da fatura não disponíveis.";
    let data = `🎯 Resumo da Fatura - Cartão ${invoiceDetails.cardName || 'N/A'}\n\n`;
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
    let data = `🏷️ Perfis ${ownerNameIfShared ? `de ${ownerNameIfShared} ` : ''}cadastrados:\n`;
    accounts.forEach((acc, index) => {
        data += `\n${index + 1}️⃣ *${acc.name || acc.accountName}* (${acc.type || acc.accountType})${currentAccountId === acc.id ? ' (Selecionada ✨)' : ''}`;
    });
    return data.trim();
}

function formatProductDataStructure(product) { // Para um único produto (cadastro/edição)
    if (!product) return "📦 Resumo do Produto:\n\nDados do produto não disponíveis.";
    let data = `📦 Resumo do Produto:\n\n`;
    data += `🏷️ Nome: *${product.name}*\n`;
    if(product.code) data += `🔢 Código: ${product.code}\n`;
    data += `💰 Preço de Venda: ${formatCurrency(product.salePrice)}\n`;
    if(product.costPrice) data += `💲 Preço de Custo: ${formatCurrency(product.costPrice)}\n`;
    data += `🛍️ Estoque Atual: ${product.quantity !== undefined ? product.quantity : (product.initialQuantity || 0)} ${product.unit || 'UN'}\n`;
    if(product.minimumStock) data += `📉 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    if(product.description && product.description.trim() !== "") data += `📄 Descrição Detalhada: ${product.description}\n`;
    data += `🚦 Status: ${product.isActive === false ? 'Inativo ❌' : 'Ativo ✅'}\n`;
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


function formatBusinessClientDataStructure(client) { // Para um único cliente do negócio
    if (!client) return "👥 Resumo do Cliente do Negócio:\n\nDados não disponíveis.";
    let data = `👥 Resumo do Cliente:\n\n`;
    data += `👤 Nome: *${client.name}*\n`;
    if (client.phone) data += `📞 Telefone: ${client.phone}\n`;
    if (client.email) data += `📧 E-mail: ${client.email}\n`;
    if (client.notes) data += `🗒️ Observações: ${client.notes}\n`;
    data += `🚦 Status: ${client.isActive === false ? 'Inativo ❌' : 'Ativo ✅'}\n`;
    return data.trim();
}

function formatListBusinessClientsDataStructure(clients) {
    if (!clients || clients.length === 0) return "👥 Lista de Clientes:\n\nNenhum cliente do negócio encontrado.";
    let data = "👥 Seus Clientes do Negócio:\n";
    clients.forEach((client, index) => {
        data += `\n${index + 1}️⃣ *${client.name}*`;
        if (client.phone) data += ` - ${client.phone}`;
        if (client.email) data += ` - ${client.email}`;
        data += ` (${client.isActive === false ? 'Inativo' : 'Ativo'})\n`;
    });
    return data.trim();
}

function formatSharedAccessDataStructure(sharedAccess, perspective = 'owner') { // perspective: 'owner' ou 'guest'
    if (!sharedAccess) return "🤝 Resumo do Acesso Compartilhado:\n\nDados não disponíveis.";
    let data = `🤝 Resumo do Acesso Compartilhado:\n\n`;

    if (perspective === 'owner') {
        data += `👤 Convidado: *${sharedAccess.sharedWithClient?.name || sharedAccess.sharedWithClient?.email || sharedAccess.sharedWithUserIdentifier}*\n`;
        if (sharedAccess.sharedAccessPhone) data += `📞 Telefone WhatsApp do Convidado: ${sharedAccess.sharedAccessPhone}\n`;
        if (sharedAccess.sharedAccessEmail) data += `📧 Email de Acesso do Convidado: ${sharedAccess.sharedAccessEmail}\n`;
    } else { // guest perspective
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
    data += `🚦 Status do Convite/Acesso: *${sharedAccess.status}*\n`;
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
        data += ` - Status: *${sa.status}*\n`;
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
    data += `🚦 Status: ${account.isActive === false ? 'Inativa ❌' : 'Ativa ✅'}\n`;
    return data.trim();
}


// --- Funções de Onboarding (Seguindo os novos padrões) ---
// (Mantidas como estavam, pois o foco é mais na IA e funcionalidades pós-onboarding)
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
    let aiIntro = `👋 Que bom te ver por aqui, ${clientName}! ${ownerNameIfShared ? `Você está gerenciando as contas de *${ownerNameIfShared}* e ` : ''}Seu ${planDetailsText} está a todo vapor! 🚀`;
    let dataStructure = `🏦 Contas ${ownerNameIfShared ? `de ${ownerNameIfShared} ` : ''}configuradas e acessíveis para você:\n`;
    accounts.forEach((acc, index) => {
        dataStructure += `\n${index + 1}️⃣ *${acc.name || acc.accountName}* (${acc.type || acc.accountType})`;
    });
    let linkText = `🤔 Qual delas vamos usar hoje? Me diga o nome ou o número da conta para começarmos! 😉`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}


// --- Initialize or Update State ---
// Adiciona campos para contexto de compartilhamento: ownerClientIdForContext, isSharedAccess, sharedAccessPermissions
async function initializeOrUpdateState(client, sharedAccessRecord = null, existingState = null, clientAccountsFromDb = [], ownerAccountsIfShared = []) {
    const clientName = client.name && client.name.trim() !== "" && client.name.trim().toLowerCase() !== "unknown" && client.name.trim().toLowerCase() !== "null"
        ? client.name.split(" ")[0]
        : (pushNameFromPayload || "pessoa incrível");

    let ownerClientIdForContext = client.id; // Dono é o próprio cliente por padrão
    let isSharedAccessContext = false;
    let sharedAccessPermissions = null;
    let ownerClientForContext = client; // Cliente dono da conta em operação

    if (sharedAccessRecord) { // Se está operando via um acesso compartilhado
        isSharedAccessContext = true;
        ownerClientIdForContext = sharedAccessRecord.ownerClientId;
        sharedAccessPermissions = { // Mapeia as permissões do sharedAccessRecord
            canAccessPersonalProfile: sharedAccessRecord.canAccessPersonalProfile,
            canAccessBusinessProfileId: sharedAccessRecord.canAccessBusinessProfileId,
            // Adicionar outras permissões relevantes do sharedAccessService se houver (ex: readOnly, canEdit, etc.)
            // Exemplo: canEditTransactions: sharedAccessRecord.permissions?.canEditTransactions || false,
        };
        // Tenta carregar o cliente dono para obter nome, etc.
        const ownerClientTemp = await clientService.findClientById(ownerClientIdForContext);
        if(ownerClientTemp) ownerClientForContext = ownerClientTemp;
        logger.info(`[WHATSAPP SERVICE - Initialize/UpdateState] Contexto de Acesso Compartilhado ATIVO. Ator: ${client.id} (${clientName}), Dono: ${ownerClientIdForContext} (${ownerClientForContext.name || 'Dono'})`);
    }


    let hasPaidAccess = false;
    // Acesso pago é verificado no DONO DA CONTA (ownerClientForContext)
    let clientAccessLevel = ownerClientForContext.accessLevel || 'gratuito';
    let clientAccessExpiresAt = ownerClientForContext.accessExpiresAt;
    let accessLevelTextForUser = "Nenhum plano ativo";
    let onboardingStage = existingState?.data?.onboardingStage || 'awaiting_plan_confirmation';

    if (ownerClientForContext.accessLevel && ownerClientForContext.accessLevel !== 'gratuito') {
        if (ownerClientForContext.accessLevel.startsWith('vitalicio_')) {
            hasPaidAccess = true;
            accessLevelTextForUser = ownerClientForContext.accessLevel.replace('vitalicio_', 'Vitalício ').replace(/_/g, ' ').trim();
            accessLevelTextForUser = accessLevelTextForUser.charAt(0).toUpperCase() + accessLevelTextForUser.slice(1);
        } else if (ownerClientForContext.accessExpiresAt) {
            const expiryDate = new Date(ownerClientForContext.accessExpiresAt + 'T00:00:00Z');
            const today = new Date(); today.setUTCHours(0, 0, 0, 0);
            if (expiryDate >= today) {
                hasPaidAccess = true;
                let planNamePart = ownerClientForContext.accessLevel.replace(/_/g, ' ');
                planNamePart = planNamePart.charAt(0).toUpperCase() + planNamePart.slice(1);
                accessLevelTextForUser = `${planNamePart} (válido até ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
            } else {
                let planNamePart = ownerClientForContext.accessLevel.replace(/_/g, ' ');
                planNamePart = planNamePart.charAt(0).toUpperCase() + planNamePart.slice(1);
                accessLevelTextForUser = `Plano ${planNamePart} expirado`;
                clientAccessLevel = 'gratuito';
            }
        } else {
            logger.warn(`[WHATSAPP SERVICE - Initialize/UpdateState] Cliente DONO ${ownerClientForContext.id} com accessLevel ${ownerClientForContext.accessLevel} mas sem accessExpiresAt. Considerando como sem plano pago.`);
            clientAccessLevel = 'gratuito';
        }
    } else {
         accessLevelTextForUser = "Nenhum plano ativo";
    }

    // Contas a serem consideradas para seleção/default:
    // Se for acesso compartilhado, são as contas do DONO que o convidado pode acessar.
    // Senão, são as contas do próprio cliente.
    const accountsForOperation = isSharedAccessContext ? ownerAccountsIfShared : clientAccountsFromDb;
   
    if (hasPaidAccess) {
        if (onboardingStage === 'awaiting_plan_confirmation' || (existingState && !existingState.hasPaidAccess_whenStageLastSet) ) {
            // Onboarding é do CLIENTE ATOR (client), não do dono (ownerClientForContext),
            // pois o convidado pode não ter passado pelo onboarding de credenciais ainda.
            if (!client.email || !client.passwordHash) { // Se o ATOR não tem credenciais
                onboardingStage = 'setting_up_credentials_email';
            } else { // Ator tem credenciais. Verifica contas do DONO (se acesso compartilhado) ou do próprio ATOR.
                const hasPfAccessible = accountsForOperation.some(acc => acc.accountType === 'PF');
                if (!isSharedAccessContext && !hasPfAccessible) { // Se NÃO é compartilhado e o ATOR não tem PF
                     onboardingStage = 'setting_up_pf_account_name';
                } else if (isSharedAccessContext && !hasPfAccessible && sharedAccessPermissions?.canAccessPersonalProfile) {
                    // Se é compartilhado, convidado PODE acessar PF do dono, mas dono não tem PF.
                    // Isso é um caso estranho, mas o fluxo de seleção de conta deve tratar.
                    // Aqui, consideramos que o onboarding do ator está ok e ele vai para seleção de conta (se houver).
                    onboardingStage = 'onboarding_complete';
                } else { // Ator tem credenciais, e ou não é compartilhado e tem PF, ou é compartilhado e tem acesso a alguma conta.
                     const hasPjMeiAccessible = accountsForOperation.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                     const planTier = clientAccessLevel.startsWith('avancado') || clientAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                    
                     if (!isSharedAccessContext && planTier === 'avancado' && !hasPjMeiAccessible &&
                         existingState?.data?.onboardingStage !== 'confirming_pj_mei_setup' &&
                         existingState?.data?.onboardingStage !== 'awaiting_pj_mei_type' &&
                         existingState?.data?.onboardingStage !== 'creating_pj_mei_account_name') {
                        onboardingStage = 'confirming_pj_mei_setup'; // Dono pode criar PJ/MEI para si
                     } else if (existingState?.data?.onboardingStage !== 'onboarding_complete') {
                        onboardingStage = 'onboarding_complete';
                     }
                }
            }
        }
    } else {
        onboardingStage = 'awaiting_plan_confirmation';
    }

    const defaultAccount = (onboardingStage === 'onboarding_complete' && hasPaidAccess && accountsForOperation.length > 0)
        ? (accountsForOperation.find(a=>a.isDefault && (isSharedAccessContext ? (a.accountType === 'PF' && sharedAccessPermissions?.canAccessPersonalProfile) || (a.id === sharedAccessPermissions?.canAccessBusinessProfileId) : true) ) || accountsForOperation[0])
        : null;

    if (existingState) {
        existingState.clientName = clientName; // Nome do ator
        existingState.ownerClientIdForContext = ownerClientIdForContext;
        existingState.ownerClientNameForContext = ownerClientForContext.name || "Dono da Conta";
        existingState.isSharedAccessContext = isSharedAccessContext;
        existingState.sharedAccessPermissions = sharedAccessPermissions;

        existingState.currentAccessLevel = clientAccessLevel; // Do dono
        existingState.accessExpiresAt = clientAccessExpiresAt; // Do dono
        existingState.hasPaidAccess = hasPaidAccess; // Do dono
        existingState.accessLevelTextForUser = accessLevelTextForUser; // Do dono
       
        if (existingState.data.onboardingStage !== onboardingStage && onboardingStage !== 'onboarding_complete') {
            existingState.currentAction = null;
        }
        existingState.data.onboardingStage = onboardingStage; // Do ator
        existingState.hasPaidAccess_whenStageLastSet = hasPaidAccess;

        if (onboardingStage === 'onboarding_complete' && hasPaidAccess) {
            if (!existingState.activeFinancialAccountId && defaultAccount) {
                existingState.activeFinancialAccountId = defaultAccount.id;
                existingState.activeFinancialAccountName = defaultAccount.accountName || defaultAccount.name;
                existingState.activeFinancialAccountType = defaultAccount.accountType || defaultAccount.type;
            }
        } else {
            existingState.activeFinancialAccountId = null;
            existingState.activeFinancialAccountName = null;
            existingState.activeFinancialAccountType = null;
        }
       
        logger.debug(`[WHATSAPP SERVICE - UpdateState] Estado atualizado para ator ${client.id}: `, {
            onboardingStage: existingState.data.onboardingStage,
            currentAction: existingState.currentAction,
            hasPaidAccess: existingState.hasPaidAccess,
            activeAccountId: existingState.activeFinancialAccountId,
            accessLevelTextForUser: existingState.accessLevelTextForUser,
            isShared: existingState.isSharedAccessContext,
            ownerId: existingState.ownerClientIdForContext,
        });
        return existingState;
    }

    const newState = {
        currentAction: null,
        data: { onboardingStage },
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? (defaultAccount.accountName || defaultAccount.name) : null,
        activeFinancialAccountType: defaultAccount ? (defaultAccount.accountType || defaultAccount.type) : null,
        clientName: clientName, // Do ator
        ownerClientIdForContext: ownerClientIdForContext,
        ownerClientNameForContext: ownerClientForContext.name || "Dono da Conta",
        isSharedAccessContext: isSharedAccessContext,
        sharedAccessPermissions: sharedAccessPermissions,
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null,
        lastAiResponse: null,
        currentAccessLevel: clientAccessLevel, // Do dono
        accessExpiresAt: clientAccessExpiresAt, // Do dono
        hasPaidAccess: hasPaidAccess, // Do dono
        accessLevelTextForUser: accessLevelTextForUser, // Do dono
        hasPaidAccess_whenStageLastSet: hasPaidAccess,
    };
   
    logger.debug(`[WHATSAPP SERVICE - InitializeState] Novo estado criado para ator ${client.id}: `, {
        onboardingStage: newState.data.onboardingStage,
        hasPaidAccess: newState.hasPaidAccess,
        accessLevelTextForUser: newState.accessLevelTextForUser,
        isShared: newState.isSharedAccessContext,
        ownerId: newState.ownerClientIdForContext,
    });
    return newState;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    pushNameFromPayload = pushName;
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    try {
        // 1. Determinar Ator, Dono, Contexto de Compartilhamento e Contas
        let actorClient = await clientService.findClientByPhone(senderPhone);
        let sharedAccessRecord = null;
        let ownerClientIdForContext;
        let clientAccountsForOnboarding = []; // Contas do ator (se não for compartilhado)
        let ownerAccountsIfShared = [];     // Contas do dono (se for compartilhado e acessíveis)

        if (actorClient) { // É um dono de conta
            ownerClientIdForContext = actorClient.id;
            clientAccountsForOnboarding = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
        } else { // Não é dono, verificar se é um convidado com sharedAccessPhone
            sharedAccessRecord = await sharedAccessService.findActiveSharedAccessByPhone(senderPhone);
            if (sharedAccessRecord) {
                actorClient = await clientService.findClientById(sharedAccessRecord.sharedWithClientId);
                if (!actorClient) {
                    logger.warn(`[WHATSAPP SERVICE] SharedAccess encontrado para ${senderPhone}, mas cliente convidado ${sharedAccessRecord.sharedWithClientId} não existe ou inativo. Ignorando.`);
                    // Tratar como usuário não reconhecido ou enviar mensagem específica
                    await sendWhatsappMessage(senderPhone, "Olá! Parece que há um acesso compartilhado configurado para este número, mas não consigo encontrar os detalhes do seu usuário. Por favor, peça ao proprietário da conta para verificar as configurações.");
                    return;
                }
                ownerClientIdForContext = sharedAccessRecord.ownerClientId;
                // Buscar as contas do DONO que o CONVIDADO pode acessar
                const allOwnerAccounts = await clientService.getClientFinancialAccounts(ownerClientIdForContext, { isActive: true });
                if (sharedAccessRecord.canAccessPersonalProfile) {
                    const pfAccount = allOwnerAccounts.find(acc => acc.accountType === 'PF');
                    if (pfAccount) ownerAccountsIfShared.push(pfAccount);
                }
                if (sharedAccessRecord.canAccessBusinessProfileId) {
                    const bizAccount = allOwnerAccounts.find(acc => acc.id === sharedAccessRecord.canAccessBusinessProfileId);
                    if (bizAccount) ownerAccountsIfShared.push(bizAccount);
                }
                if (ownerAccountsIfShared.length === 0) {
                     logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas nenhuma conta acessível encontrada ou configurada no compartilhamento.`);
                     await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado para as contas de ${sharedAccessRecord.ownerClient?.name || 'um usuário'}, mas parece que nenhuma conta específica foi liberada para você ou o proprietário não tem contas ativas. Peça para ele verificar as permissões, por favor! 😉`);
                     return;
                }

            } else { // Número não reconhecido
                // Criar cliente se for número novo e não compartilhado
                // (ou uma mensagem de "não reconhecido" se a política for não criar automaticamente)
                logger.info(`[WHATSAPP SERVICE] Telefone ${senderPhone} não é de um cliente nem de um acesso compartilhado ativo. Criando novo cliente...`);
                actorClient = await clientService.createClient({ phone: senderPhone, name: pushName });
                ownerClientIdForContext = actorClient.id;
                // clientAccountsForOnboarding será []
                await sendWhatsappMessage(senderPhone, `Olá! 👋 Sou o ${aiModelService.ASSISTANT_NAME}, seu novo assistente financeiro! Como este é nosso primeiro contato por aqui, vamos configurar seu acesso. Para começar, você já tem um plano conosco?`);
                // Força o estado de onboarding para 'awaiting_plan_confirmation'
                 const tempStateForNewUser = await initializeOrUpdateState(actorClient, null, null, [], []);
                 tempStateForNewUser.data.onboardingStage = 'awaiting_plan_confirmation';
                 tempStateForNewUser.currentAction = 'awaiting_plan_interest_generic';
                 conversationState.set(senderPhone, tempStateForNewUser);
                 return;
            }
        }

        const existingState = conversationState.get(senderPhone);
        state = await initializeOrUpdateState(actorClient, sharedAccessRecord, existingState, clientAccountsForOnboarding, ownerAccountsIfShared);
        
        let isNewUserForSessionLogic = !existingState; // Se não tinha estado na memória


        const clientNameToUse = state.clientName;

        if (!(rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string')) {
            state.messageHistory.push({ role: 'user', content: messageText });
        }
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }
       
        let onboardingReply = "";
        const lowerMessageText = messageText.toLowerCase().trim();
       
        logger.debug(`[WHATSAPP ONBOARDING ENTRY] Ator: ${actorClient.id}, DonoCtx: ${state.ownerClientIdForContext}, Stage: ${state.data.onboardingStage}, currentAction: ${state.currentAction}, hasPaidAccess: ${state.hasPaidAccess}, accessLevelText: ${state.accessLevelTextForUser}, isShared: ${state.isSharedAccessContext}`);

        // ---- FLUXO DE ONBOARDING (DO ATOR) ----
        // (A lógica de onboarding permanece focada no atorClient, verificando suas credenciais)
        // (O acesso pago é do ownerClientForContext)

        if (state.data.onboardingStage === 'awaiting_plan_confirmation') {
            onboardingReply = getOnboardingWelcomeNoPlanMessage(clientNameToUse);
            state.currentAction = 'awaiting_plan_interest_generic';
        } else if (state.data.onboardingStage === 'setting_up_credentials_email') {
            if (state.currentAction !== 'awaiting_input_email_for_credentials' || isNewUserForSessionLogic) {
                 onboardingReply = getOnboardingAskForEmailMessage(clientNameToUse, state.accessLevelTextForUser); // accessLevelText é do dono
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
                    // As credenciais são sempre do actorClient
                    await clientAuthService.setClientCredentials(actorClient.phone, state.data.tempPassword, nameInput, state.data.tempEmail);
                    actorClient = await clientService.findClientByPhone(actorClient.phone); // Recarrega ator com nome atualizado
                    state.clientName = actorClient.name.split(" ")[0];
                    logger.info(`[WHATSAPP ONBOARDING] Credenciais definidas para ATOR ${actorClient.phone}.`);
                    delete state.data.tempEmail; delete state.data.tempPassword;
                   
                    // Após credenciais, verifica se o ATOR (se não for compartilhado) precisa criar conta PF.
                    // Se for compartilhado, o onboarding de credenciais do ator está feito, vai para seleção de conta do dono.
                    if (!state.isSharedAccessContext) {
                        const actorAccounts = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
                        const hasPfActor = actorAccounts.some(acc => acc.accountType === 'PF');
                        if (!hasPfActor) {
                            state.data.onboardingStage = 'setting_up_pf_account_name';
                            onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse); // Para o ator criar SUA conta PF
                            state.currentAction = 'awaiting_input_pf_name';
                        } else {
                            // Se ator já tem PF, verifica se precisa de PJ/MEI (plano avançado do DONO)
                            const hasPjMeiActor = actorAccounts.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                            const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                            if (planTier === 'avancado' && !hasPjMeiActor) {
                                state.data.onboardingStage = 'confirming_pj_mei_setup'; // Para o ator criar SUA conta PJ/MEI
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
                    } else { // Se é compartilhado, onboarding de credenciais do ator terminou.
                        state.data.onboardingStage = 'onboarding_complete'; // Vai para seleção de conta do dono.
                        const aiIntro = `Maravilha, ${clientNameToUse}! Suas credenciais estão configuradas! 🎉`;
                        const dataStructure = `Agora você pode acessar as contas de ${state.ownerClientNameForContext} com o plano ${state.accessLevelTextForUser}.`;
                        const linkText = `Vamos ver quais contas estão disponíveis?`;
                        onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                        state.currentAction = null; // Força seleção de conta no próximo passo
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
        } else if (state.data.onboardingStage === 'setting_up_pf_account_name') { // Criando conta PF PARA O ATOR
            if (state.isSharedAccessContext) { // Convidado não cria conta para si mesmo neste fluxo principal.
                logger.warn(`[WHATSAPP ONBOARDING] Tentativa de ator convidado ${clientNameToUse} criar conta PF para si mesmo. Redirecionando para onboarding_complete.`);
                state.data.onboardingStage = 'onboarding_complete'; // Pula esta etapa para convidados
                state.currentAction = null;
                // A mensagem de onboardingReply será tratada pelo bloco if (onboardingReply) abaixo se este if não gerar nada
            } else if (state.currentAction !== 'awaiting_input_pf_name' || isNewUserForSessionLogic) {
                onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
                state.currentAction = 'awaiting_input_pf_name';
            } else {
                const pfAccountName = messageText.trim();
                if (pfAccountName.length >= 3 && pfAccountName.length <= 50) {
                    try {
                        const newPfAccount = await clientService.createFinancialAccount(actorClient.id, { // Do ator
                            accountName: pfAccountName, accountType: 'PF', isDefault: true
                        });
                        state.activeFinancialAccountId = newPfAccount.id;
                        state.activeFinancialAccountName = newPfAccount.accountName;
                        state.activeFinancialAccountType = newPfAccount.accountType;
                        logger.info(`[WHATSAPP ONBOARDING] Conta PF "${pfAccountName}" criada para ATOR ${actorClient.phone}.`);
                       
                        const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                        if (planTier === 'avancado') { // Se plano do DONO (que é o ator aqui) é avançado
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
        } else if (state.data.onboardingStage === 'confirming_pj_mei_setup') { // Criando conta PJ/MEI PARA O ATOR
             if (state.isSharedAccessContext) {
                logger.warn(`[WHATSAPP ONBOARDING] Tentativa de ator convidado ${clientNameToUse} criar conta PJ/MEI para si mesmo. Redirecionando para onboarding_complete.`);
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
        } else if (state.data.onboardingStage === 'awaiting_pj_mei_type') { // Para ATOR
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
        } else if (state.data.onboardingStage === 'creating_pj_mei_account_name') { // Para ATOR
            if (state.isSharedAccessContext) { state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null; }
            else {
                const companyName = messageText.trim();
                const companyType = state.data.tempPjMeiType;
                if (companyName.length >= 3 && companyName.length <= 50) {
                    try {
                        await clientService.createFinancialAccount(actorClient.id, { // Do ator
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
                return;
            }
        }
       
        // ---- FIM DO FLUXO DE ONBOARDING / INÍCIO DO FLUXO NORMAL COM IA ----
        if (state.data.onboardingStage === 'onboarding_complete' || !onboardingReply) {
            if (state.data.onboardingStage === 'onboarding_complete' && state.currentAction &&
                (state.currentAction.startsWith('awaiting_input_') || state.currentAction.startsWith('awaiting_pj_mei_') || state.currentAction.startsWith('awaiting_plan_'))) {
                state.currentAction = null;
            }
           
            if (state.data.onboardingStage === 'onboarding_complete' && !state.activeFinancialAccountId) {
                // Se for compartilhado, ownerAccountsIfShared já tem as contas filtradas pelas permissões.
                // Senão, busca as contas do ator.
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
                        const dataStructure = `Sua conta "${state.activeFinancialAccountName}" (${state.activeFinancialAccountType}) ${ownerNameText}já está selecionada com o plano ${state.accessLevelTextForUser}.`;
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
                    if (state.currentAction === 'selecting_account_flow_active' || !state.activeFinancialAccountId) return;
                } else if (!state.isSharedAccessContext) { // Dono sem contas, direciona para criar PF
                    const aiIntro = `Olá ${clientNameToUse}! Seu plano ${state.accessLevelTextForUser} está tinindo, mas não encontrei nenhuma conta financeira sua.`;
                    const dataStructure = `Vamos criar sua conta Pessoal agora?`;
                    const linkText = `Diga "criar conta pessoal"! 😉`;
                    const noAccountsMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                    state.messageHistory.push({ role: 'assistant', content: noAccountsMsg });
                    state.data.onboardingStage = 'setting_up_pf_account_name';
                    state.currentAction = 'awaiting_input_pf_name';
                    await sendWhatsappMessage(senderPhone, noAccountsMsg);
                    conversationState.set(senderPhone, state);
                    return;
                } else { // Compartilhado, mas dono não tem contas acessíveis (já tratado antes, mas como fallback)
                    logger.error(`[WHATSAPP HANDLER CRITICAL] Ator ${clientNameToUse} em acesso compartilhado, onboarding completo, mas NENHUMA conta do dono (${state.ownerClientIdForContext}) acessível ANTES DE CHAMAR A IA.`);
                     await sendWhatsappMessage(senderPhone, `Olá ${clientNameToUse}! Parece que o proprietário da conta (${state.ownerClientNameForContext}) não tem contas financeiras ativas ou acessíveis para você no momento. Por favor, peça para ele verificar. 🙏`);
                     return;
                }
            }


            // ---- PROCESSAMENTO COM IA (continuação) ----
            if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
                const buttonId = rawPayload.selectedButtonId;
                logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ID '${buttonId}', Texto (label): '${messageText}'`);
                let buttonClickHandledByServiceLogic = true;
                let aiMessageIntroForButton = "";
                let structuredDataBodyForButton = "";
                let platformLinkFooterForButton = formatPlatformLink();
                let resourceTypeForEditMessage = "item";
   
                if (buttonId.startsWith('edit_transaction_')) {
                    const transactionId = buttonId.replace('edit_transaction_', '');
                    state.editingResource = { type: 'transaction', id: transactionId };
                    resourceTypeForEditMessage = "transação";
                    aiMessageIntroForButton = `Claro, ${clientNameToUse}! 😉`;
                    structuredDataBodyForButton = `Descreva na próxima mensagem o que você precisa que eu altere na ${resourceTypeForEditMessage} (ID: ${transactionId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_transaction_edit_details';
                } else if (buttonId.startsWith('delete_transaction_')) {
                    const transactionId = buttonId.replace('delete_transaction_', '');
                    try {
                        // VERIFICAR PERMISSÃO DE EDIÇÃO SE FOR COMPARTILHADO
                        if (state.isSharedAccessContext /* && !state.sharedAccessPermissions.canEditTransactions (exemplo) */) {
                             aiMessageIntroForButton = `Desculpe, ${clientNameToUse}, mas você não tem permissão para excluir transações nesta conta compartilhada. 😬`;
                             structuredDataBodyForButton = "Por favor, peça ao proprietário da conta se precisar remover algo.";
                        } else {
                            await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId);
                            aiMessageIntroForButton = `Transação removida com sucesso, ${clientNameToUse}! 👍`;
                            structuredDataBodyForButton = "Se precisar de mais alguma coisa, é só chamar.";
                        }
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a transação.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                // ... (outros botões de editar/excluir, com verificações de permissão para sharedAccess se aplicável)
                // Exemplo para produto:
                else if (buttonId.startsWith('edit_product_')) {
                    const productId = buttonId.replace('edit_product_', '');
                    state.editingResource = { type: 'product', id: productId };
                    aiMessageIntroForButton = `Beleza, ${clientNameToUse}! 🛍️`;
                    structuredDataBodyForButton = `O que você gostaria de alterar no produto (ID: ${productId})? Por exemplo: "mudar o preço de venda para 150" ou "atualizar o estoque mínimo para 10".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_product_edit_details';
                }
                // Adicionar handlers para botões de delete_product, edit/delete_business_client, edit/delete_shared_access (se houver botões para isso)
                else {
                    buttonClickHandledByServiceLogic = false;
                }
       
                if (buttonClickHandledByServiceLogic) {
                    const finalMsg = `${aiMessageIntroForButton}${structuredDataBodyForButton ? `\n\n${structuredDataBodyForButton}` : ''}${platformLinkFooterForButton ? `\n\n${platformLinkFooterForButton}` : ''}`.trim();
                    state.messageHistory.push({ role: 'assistant', content: finalMsg });
                    await sendWhatsappMessage(senderPhone, finalMsg);
                    conversationState.set(senderPhone, state);
                    return;
                }
            }
       
            if (state.currentAction && state.data.onboardingStage === 'onboarding_complete') {
                let stateHandledInPreProcessing = false;
                let preProcAiIntro = "";
                let preProcDataStructure = "";
                let preProcPlatformLink = formatPlatformLink();
       
                if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                     const lowerMsgForConfirm = messageText.toLowerCase().trim();
                     if (lowerMsgForConfirm === 'sim' || lowerMsgForConfirm === 's' || lowerMsgForConfirm.includes('correto') || lowerMsgForConfirm.includes('ok') || lowerMsgForConfirm.includes('pode') || lowerMsgForConfirm.includes('confirma')) {
                        // Lógica para executar a ação pendente
                        // Exemplo para DELETE_FINANCIAL_ACCOUNT
                        if (state.pendingConfirmation.action === 'DELETE_FINANCIAL_ACCOUNT' && state.pendingConfirmation.parameters && state.pendingConfirmation.parameters.accountIdToDelete) {
                            try {
                                if (state.isSharedAccessContext) throw new Error("Você não pode excluir contas financeiras em um acesso compartilhado.");
                                await clientService.deleteFinancialAccount(actorClient.id, state.pendingConfirmation.parameters.accountIdToDelete); // actorClient.id é o owner aqui
                                preProcAiIntro = state.lastAiResponse?.overall_summary_suggestion || `🗑️ Conta financeira removida com sucesso, ${clientNameToUse}!`;
                                preProcDataStructure = `A conta "${state.pendingConfirmation.parameters.accountNameToDelete}" não existe mais.`;
                                // Se a conta ativa foi deletada, precisa limpar ou pedir para selecionar outra.
                                if (state.activeFinancialAccountId === state.pendingConfirmation.parameters.accountIdToDelete) {
                                    state.activeFinancialAccountId = null; state.activeFinancialAccountName = null; state.activeFinancialAccountType = null;
                                    preProcDataStructure += "\n\nComo sua conta ativa foi removida, precisaremos selecionar outra para continuar, ou você pode criar uma nova.";
                                    state.currentAction = 'selecting_account_flow_active'; // Força seleção
                                } else {
                                    state.currentAction = null;
                                }
                                state.pendingConfirmation = null; state.editingResource = null;
                                stateHandledInPreProcessing = true;
                            } catch(e) {
                                logger.error(`[WHATSAPP SERVICE] Erro ao deletar conta financeira após confirmação: ${e.message}`);
                                preProcAiIntro = `Puxa, ${clientNameToUse}, algo deu errado ao tentar remover a conta. 😥`;
                                preProcDataStructure = `Detalhe: ${e.message.substring(0,70)}.\nA conta não foi alterada.`;
                                preProcPlatformLink = "";
                                state.currentAction = null; // Limpa para evitar loop
                                state.pendingConfirmation = null;
                                stateHandledInPreProcessing = true;
                            }
                        }
                        // Adicionar outros casos de confirmação aqui (ex: REVOKE_ACCESS)
                        else if (state.pendingConfirmation.action === 'REVOKE_ACCESS' && state.pendingConfirmation.parameters) {
                             try {
                                if (state.isSharedAccessContext) throw new Error("Você não pode gerenciar acessos compartilhados de dentro de um.");
                                const { sharedAccessIdToRevoke, guestName } = state.pendingConfirmation.parameters;
                                await sharedAccessService.revokeAccessById(state.ownerClientIdForContext, sharedAccessIdToRevoke);
                                preProcAiIntro = `Prontinho, ${clientNameToUse}! O acesso de ${guestName} foi revogado. 👍`;
                                preProcDataStructure = "Eles não poderão mais acessar suas informações através daquele convite.";
                                state.currentAction = null; state.pendingConfirmation = null; stateHandledInPreProcessing = true;
                             } catch (e) {
                                preProcAiIntro = `Ops, ${clientNameToUse}! Não consegui revogar o acesso. 😬`;
                                preProcDataStructure = `Detalhe: ${e.message.substring(0,70)}`;
                                state.currentAction = null; state.pendingConfirmation = null; stateHandledInPreProcessing = true;
                             }
                        }
                         else {
                            preProcAiIntro = `Entendido, ${clientNameToUse}! Confirmado! 👍`;
                            preProcDataStructure = "Vou prosseguir com base nisso. O que mais posso fazer?";
                            preProcPlatformLink = "";
                            state.currentAction = null; state.pendingConfirmation = null;
                            stateHandledInPreProcessing = true;
                        }
                    } else if (lowerMsgForConfirm === 'não' || lowerMsgForConfirm === 'n' || lowerMsgForConfirm.includes('incorreto') || lowerMsgForConfirm.includes('cancela')) {
                        preProcAiIntro = `Ok, ${clientNameToUse}, cancelado! Sem problemas.`;
                        preProcDataStructure = "O que gostaria de fazer então? 😊";
                        preProcPlatformLink = "";
                        state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                        stateHandledInPreProcessing = true;
                    }
                }
                else if (state.currentAction === 'awaiting_explicit_account_type_from_ai') {
                    const typeInput = messageText.trim().toUpperCase();
                    if (typeInput === 'PF' || typeInput === 'PJ' || typeInput === 'MEI') {
                        state.data.accountTypeToCreate = typeInput;
                        const formattedMsg = getOnboardingAskForCompanyNameMessage(clientNameToUse, typeInput);
                        preProcAiIntro = formattedMsg.split('\n\n')[0];
                        preProcDataStructure = formattedMsg.split('\n\n')[1];
                        preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
                        state.currentAction = 'awaiting_explicit_account_name_from_ai';
                    } else {
                        const formattedMsg = getOnboardingAskForPJTypeMessage(clientNameToUse);
                        preProcAiIntro = formattedMsg.split('\n\n')[0];
                        preProcDataStructure = formattedMsg.split('\n\n')[1];
                        preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
                    }
                    stateHandledInPreProcessing = true;
                } else if (state.currentAction === 'awaiting_explicit_account_name_from_ai') {
                    const newAccName = messageText.trim();
                    const typeToCreate = state.data.accountTypeToCreate;
                    if (newAccName.length >= 3 && newAccName.length <= 50) {
                        try {
                            // Validações de plano e limite de contas PJ/MEI para o DONO
                            if (state.isSharedAccessContext) throw new Error("Você não pode criar contas financeiras em um acesso compartilhado.");
                            const currentClientAccountsForCreate = await clientService.getClientFinancialAccounts(state.ownerClientIdForContext, { isActive: true });
                            const existingPjMei = currentClientAccountsForCreate.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                            if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && existingPjMei) {
                                preProcAiIntro = `Opa, ${clientNameToUse}! Você já tem uma conta empresarial (${existingPjMei.accountType}) chamada "${existingPjMei.accountName}".`;
                                preProcDataStructure = "Só podemos ter uma conta PJ ou MEI por vez. 😉";
                            } else if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado')) {
                                preProcAiIntro = `Ah, ${clientNameToUse}! Para criar uma conta empresarial (${typeToCreate}), você precisa de um dos nossos Planos Avançados. 🚀`;
                                preProcDataStructure = `Confira em ${process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"} e depois me avise! 😉`;
                                state.data.onboardingStage = 'awaiting_plan_confirmation';
                            } else {
                                const newFA = await clientService.createFinancialAccount(state.ownerClientIdForContext, { accountName: newAccName, accountType: typeToCreate });
                                const formattedMsg = getOnboardingCompanyCreatedMessage(clientNameToUse, newFA.accountType, newFA.accountName, state.activeFinancialAccountName || "Pessoal");
                                preProcAiIntro = formattedMsg.split('\n\n')[0];
                                preProcDataStructure = formattedMsg.split('\n\n')[1];
                                preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
                                state.activeFinancialAccountId = newFA.id;
                                state.activeFinancialAccountName = newFA.accountName;
                                state.activeFinancialAccountType = newFA.accountType;
                            }
                        } catch(e) {
                            preProcAiIntro = `Ops, não consegui criar a conta "${newAccName}" (${typeToCreate}).`;
                            preProcDataStructure = `Detalhe: ${e.message.substring(0,70)}.\nTente um nome diferente.`;
                        }
                    } else {
                         preProcAiIntro = `Esse nome parece um pouco curto ou longo demais, ${clientNameToUse}.`;
                         preProcDataStructure = `Para sua conta ${typeToCreate}, que tal um nome entre 3 e 50 letras? ✍️`;
                    }
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
                    if (state.currentAction === null && !state.pendingConfirmation &&
                        !(state.currentAction?.startsWith('awaiting_explicit_'))) {
                            return;
                    }
                }
            }
       
            logger.info(`[WHATSAPP HANDLER - PÓS-ONBOARDING] Ator: ${actorClient.id} (${clientNameToUse}), DonoCtx: ${state.ownerClientIdForContext}, PlanoDono: ${state.currentAccessLevel}, Conta Ativa: ${state.activeFinancialAccountName || 'N/A'} (ID: ${state.activeFinancialAccountId || 'N/A'}), Msg: "${messageText}"`);
            if(!state.activeFinancialAccountId && state.hasPaidAccess && state.data.onboardingStage === 'onboarding_complete') {
                 logger.error(`[WHATSAPP HANDLER CRITICAL - PÓS-ONBOARDING] Ator ${actorClient.id} (Dono: ${state.ownerClientIdForContext}) tem acesso pago e onboarding completo, mas NENHUMA conta financeira ativa no estado ANTES DE CHAMAR A IA.`);
                 let noActiveAccountForAIMsg = "";
                 const accountsForAICtx = state.isSharedAccessContext
                    ? ownerAccountsIfShared // Já filtradas por permissão
                    : await clientService.getClientFinancialAccounts(state.ownerClientIdForContext, { isActive: true });

                 if (accountsForAICtx.length > 0) {
                     noActiveAccountForAIMsg = formatAccountSelectionMessage(clientNameToUse, state.accessLevelTextForUser, accountsForAICtx.map(a => ({id: a.id, name: a.accountName || a.name, type: a.accountType || a.type})), state.isSharedAccessContext ? state.ownerClientNameForContext : null);
                     state.currentAction = 'selecting_account_flow_active';
                     state.data.accountsToList = accountsForAICtx.map(a => ({id: a.id, name: a.accountName || a.name, type: a.accountType || a.type}));
                 } else if (!state.isSharedAccessContext) {
                     const aiIntro = `Olá ${clientNameToUse}! Seu plano ${state.accessLevelTextForUser} está tinindo, mas não encontrei nenhuma conta financeira sua.`;
                     const dataStructure = `Vamos criar sua conta Pessoal agora?`;
                     const linkText = `Diga "criar conta pessoal"! 😉`;
                     noActiveAccountForAIMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                     state.data.onboardingStage = 'setting_up_pf_account_name';
                     state.currentAction = 'awaiting_input_pf_name';
                 } else {
                     noActiveAccountForAIMsg = `Olá ${clientNameToUse}! Parece que ${state.ownerClientNameForContext} não tem contas financeiras ativas ou acessíveis para você no momento. Por favor, peça para ele verificar. 🙏`;
                 }
                 state.messageHistory.push({ role: 'assistant', content: noActiveAccountForAIMsg });
                 await sendWhatsappMessage(senderPhone, noActiveAccountForAIMsg);
                 conversationState.set(senderPhone, state);
                 return;
            }
       
       
            const aiContext = {
                currentFinancialAccountId: state.activeFinancialAccountId,
                currentFinancialAccountType: state.activeFinancialAccountType,
                currentFinancialAccountName: state.activeFinancialAccountName,
                clientName: clientNameToUse, // Nome do ATOR
                isSharedAccess: state.isSharedAccessContext, // Informa IA sobre contexto compartilhado
                // ownerName: state.isSharedAccessContext ? state.ownerClientNameForContext : null, // Opcional, IA pode usar para personalizar
                conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
                currentStateData: state.data,
                editingResource: state.editingResource,
                currentAccessLevel: state.currentAccessLevel, // Do DONO
                hasPaidAccess: state.hasPaidAccess, // Do DONO
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
            if (typeof aiMessageIntro !== 'string' || aiMessageIntro.trim() === "") {
                aiMessageIntro = clientNameToUse ? `Ok, ${clientNameToUse}!` : "Entendido!";
            }

            let structuredDataBody = "";
            let platformLinkFooter = formatPlatformLink();
            let finalMessageToSend = "";
       
            state.pendingConfirmation = null;
            actionWasAnEdit = false;
            resourceForButtonsContext = null;
            let multipleActionBodiesList = [];

            if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
                for (const detectedAction of aiResponse.detected_actions) {
                    const params = detectedAction.parameters || detectedAction;
                    const actionName = detectedAction.action || detectedAction.action_type;
                    if (!actionName) {
                        logger.warn('[WHATSAPP HANDLER] Ação detectada pela IA sem nome. Pulando.', { detectedAction });
                        continue;
                    }
                    
                    let currentActionBlocked = false;
                    let currentActionFormattedData = "";
                    let blockReasonMessage = ""; // Mensagem específica para o bloqueio

                    // --- INÍCIO DAS VERIFICAÇÕES DE PERMISSÃO E CONTEXTO ---
                    const isOwnerActingOnOwnBehalf = !state.isSharedAccessContext;
                    const ownerId = state.ownerClientIdForContext; // ID do dono da conta financeira
                    const actorId = actorClient.id; // ID de quem está enviando a mensagem

                    // Ações que EXIGEM que o ator seja o dono da conta (isOwnerActingOnOwnBehalf)
                    const ownerOnlyActions = [
                        'CREATE_FINANCIAL_ACCOUNT', 'UPDATE_FINANCIAL_ACCOUNT', 'DELETE_FINANCIAL_ACCOUNT',
                        'GRANT_ACCESS', 'LIST_GRANTED_ACCESS', 'UPDATE_GRANTED_ACCESS', 'REVOKE_ACCESS'
                    ];
                    if (ownerOnlyActions.includes(actionName) && !isOwnerActingOnOwnBehalf) {
                        blockReasonMessage = `Desculpe, ${clientNameToUse}, mas a ação de "${actionName.toLowerCase().replace(/_/g, " ")}" só pode ser realizada pelo proprietário da conta (${state.ownerClientNameForContext}).`;
                        currentActionBlocked = true;
                    }

                    // Ações que NÃO FAZEM SENTIDO ou são perigosas em contexto compartilhado (mesmo que a IA seja instruída)
                    if (state.isSharedAccessContext && (actionName === 'SWITCH_FINANCIAL_ACCOUNT' && params.targetAccountNameOrType?.toLowerCase() === 'pessoal' && !state.sharedAccessPermissions.canAccessPersonalProfile)) {
                         blockReasonMessage = `Você não tem permissão para acessar o perfil pessoal de ${state.ownerClientNameForContext}, ${clientNameToUse}.`;
                         currentActionBlocked = true;
                    }
                    // (Outras verificações de sharedAccessPermissions podem ser adicionadas aqui para cada ação se necessário,
                    //  ex: !state.sharedAccessPermissions.canCreateTransactions para CREATE_FINANCIAL_TRANSACTION)


                    const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SET_MOTIVATIONAL_MESSAGE_PREFERENCE', 'SET_WATER_REMINDER_PREFERENCE', 'LIST_RECEIVED_ACCESS', 'RESPOND_TO_INVITE'];
                    // Para SWITCH_FINANCIAL_ACCOUNT e CREATE_FINANCIAL_ACCOUNT, a verificação de plano/dono é feita dentro do case.
                    // LIST_GRANTED_ACCESS é do dono.

                    if (!state.hasPaidAccess && !publicActions.includes(actionName) && !ownerOnlyActions.includes(actionName) && !currentActionBlocked) {
                        // Se não for ação pública E NÃO for ação de dono (que seria bloqueada acima se !isOwnerActingOnOwnBehalf)
                        // E o plano do DONO não estiver pago
                        const noPlanIntro = getOnboardingWelcomeNoPlanMessage(state.ownerClientNameForContext).split('\n\n')[0];
                        const noPlanData = getOnboardingWelcomeNoPlanMessage(state.ownerClientNameForContext).split('\n\n').slice(1).join('\n\n');
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(noPlanIntro)) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = noPlanIntro;
                        blockReasonMessage = `Para realizar esta ação, o plano de ${state.ownerClientNameForContext} precisa estar ativo.\n\n${noPlanData}`;
                        platformLinkFooter = "";
                        // Não reverte onboardingStage aqui, pois o problema é o plano do dono, não do ator.
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
                        // UPDATE_FINANCIAL_ACCOUNT e DELETE_FINANCIAL_ACCOUNT usam accountNameToUpdate, não a conta ativa.
                    ];
                    if (accountRequiredActions.includes(actionName) && !state.activeFinancialAccountId && !currentActionBlocked) {
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Opa, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Opa, ${clientNameToUse}! Para eu poder "${actionName.toLowerCase().replace(/_/g, " ")}", preciso que uma conta financeira esteja selecionada.`;
                        blockReasonMessage = `Se você já configurou alguma (ou tem acesso compartilhado), me diga o nome dela. Se não, ${isOwnerActingOnOwnBehalf ? 'diga "criar conta pessoal"' : `peça para ${state.ownerClientNameForContext} verificar os acessos.`}! 😊`;
                        platformLinkFooter = ""; state.currentAction = 'selecting_account_flow_active'; currentActionBlocked = true;
                    }
                    
                    const pjMeiActions = ['CREATE_PRODUCT', 'GET_STOCK_INFO', 'RECORD_STOCK_MOVEMENT', 'UPDATE_PRODUCT', 'CREATE_BUSINESS_CLIENT', 'LIST_BUSINESS_CLIENTS', 'UPDATE_BUSINESS_CLIENT'];
                     if (pjMeiActions.includes(actionName) && state.activeFinancialAccountType && !['PJ', 'MEI'].includes(state.activeFinancialAccountType)  && !currentActionBlocked) {
                        if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Desculpe, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Desculpe, ${clientNameToUse}, mas "${actionName.toLowerCase().replace(/_/g, " ")}" é apenas para contas PJ ou MEI.`;
                        blockReasonMessage = `Sua conta "${state.activeFinancialAccountName}" é do tipo ${state.activeFinancialAccountType}. Você pode criar uma conta empresarial ou mudar para ela, se tiver uma! 😉`;
                        platformLinkFooter = ""; currentActionBlocked = true;
                    } else if (pjMeiActions.includes(actionName) && state.activeFinancialAccountType && ['PJ', 'MEI'].includes(state.activeFinancialAccountType) && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado') && !currentActionBlocked) {
                        const siteUrlPjMei = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                         if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.startsWith("Ah, ")) && aiMessageIntro !== aiResponse.overall_summary_suggestion) aiMessageIntro = `Ah, ${clientNameToUse}! Para usar as funcionalidades de ${state.activeFinancialAccountType === 'PJ' ? 'Empresa (PJ)' : 'MEI'}, como "${actionName.toLowerCase().replace(/_/g, " ")}", o plano de ${state.ownerClientNameForContext} precisa ser um dos nossos Planos Avançados. 🚀`;
                        blockReasonMessage = `Eles são perfeitos para quem quer ir além! Confira em ${siteUrlPjMei} e depois me avise para continuarmos! 😉`;
                        platformLinkFooter = ""; currentActionBlocked = true;
                    }
                    // --- FIM DAS VERIFICAÇÕES DE PERMISSÃO E CONTEXTO ---
       
                    if (currentActionBlocked) {
                        if (blockReasonMessage) multipleActionBodiesList.push(blockReasonMessage);
                        continue; // Pula para a próxima ação detectada, se houver
                    }

                    // Executa a ação (activeFinancialAccountId é a conta do DONO, mas as ações são pelo ATOR)
                    try {
                        switch (actionName) {
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
                                if (!txData.description || !txData.type || isNaN(txData.value) || txData.value <= 0) {
                                    throw new Error("Dados insuficientes ou inválidos para criar transação (descrição, tipo, valor).");
                                }
                                const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData, actorId); // Passa actorId
                                const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                               
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || detectedAction.action_specific_reply_suggestion || `Sua transação foi registrada, ${clientNameToUse}!`;
                                } else if (multipleActionBodiesList.length === 0 && !(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && !aiResponse.overall_summary_suggestion) {
                                     aiMessageIntro = `Registrei o seguinte para você, ${clientNameToUse}:`;
                                }
                                currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedTx);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'transaction', id: newTx.id, description: newTx.description };
                                break;
                            }
                            case 'UPDATE_FINANCIAL_TRANSACTION': {
                                const transactionIdToUpdate = state.editingResource?.type === 'transaction' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.transactionIdToUpdate ? parseInt(params.transactionIdToUpdate, 10) : null);
                                if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não foi fornecido ou não está em contexto de edição.");
                                // VERIFICAR PERMISSÃO DE EDIÇÃO SE FOR COMPARTILHADO
                                if (state.isSharedAccessContext /* && !state.sharedAccessPermissions.canEditXYZ */) {
                                    // throw new Error("Você não tem permissão para editar transações nesta conta compartilhada.");
                                }

                                const updateDataTx = {};
                                if (params.hasOwnProperty('description')) updateDataTx.description = params.description;
                                if (params.hasOwnProperty('value')) updateDataTx.value = parseFloat(params.value);
                                if (params.hasOwnProperty('transactionDate')) updateDataTx.transactionDate = params.transactionDate;
                                if (params.hasOwnProperty('notes')) updateDataTx.notes = params.notes;
                                if (params.hasOwnProperty('dueDate')) updateDataTx.dueDate = params.dueDate; else if (params.hasOwnProperty('dueDate') && params.dueDate === null) updateDataTx.dueDate = null;
                                if (params.hasOwnProperty('isPaidOrReceived')) updateDataTx.isPaidOrReceived = params.isPaidOrReceived;
                                if (params.financialCategoryName) updateDataTx.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || (await financialService.getTransactionById(state.activeFinancialAccountId, transactionIdToUpdate)).type);
                                else if (params.hasOwnProperty('financialCategoryName') && params.financialCategoryName === null) updateDataTx.financialCategoryId = null;
                                if (params.creditCardName) updateDataTx.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                else if (params.hasOwnProperty('creditCardName') && params.creditCardName === null) updateDataTx.creditCardId = null;

                                if (Object.keys(updateDataTx).length === 0) throw new Error("Nenhum dado fornecido para atualizar a transação.");

                                const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateDataTx, actorId); // Passa actorId
                                const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Transação atualizada com sucesso, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sobre a edição da transação, ${clientNameToUse}:`;
                                currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedUpdatedTx);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'SCHEDULE_APPOINTMENT': {
                                const eventDateTime = params.eventDateTime;
                                if (!params.title || !eventDateTime) throw new Error("Título e data/hora são obrigatórios para agendar.");
                                if (params.associatedValue && !params.associatedTransactionType) throw new Error("Tipo (entrada/saída) é obrigatório se um valor está associado ao compromisso.");

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
                                const reloadedAppt = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newAppt.id); // Recarrega para ter businessClients populados

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Seu compromisso foi agendado, ${clientNameToUse}!`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Agendei o seguinte para você, ${clientNameToUse}:`;
                                currentActionFormattedData = formatAppointmentDataStructure(reloadedAppt);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'appointment', id: newAppt.id, description: newAppt.title };
                                break;
                            }
                            // ... (Restante dos cases, adaptando para passar actorId aos services e incluindo verificações de sharedAccessPermissions quando relevante)

                            // NOVO: Cases para BusinessClient
                            case 'CREATE_BUSINESS_CLIENT': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Cadastro de clientes do negócio é apenas para contas PJ/MEI.");
                                if (!params.name) throw new Error("Nome do cliente do negócio é obrigatório.");
                                const bcData = { name: params.name, phone: params.phone, email: params.email, notes: params.notes };
                                const newBc = await businessClientService.createBusinessClient(state.activeFinancialAccountId, bcData, actorId);

                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Cliente "${newBc.name}" cadastrado com sucesso, ${clientNameToUse}! 🤝`;
                                else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Cadastrei o cliente, ${clientNameToUse}:`;
                                currentActionFormattedData = formatBusinessClientDataStructure(newBc);
                                // resourceForButtonsContext para BusinessClient se necessário
                                break;
                            }
                            case 'LIST_BUSINESS_CLIENTS': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Listagem de clientes do negócio é apenas para contas PJ/MEI.");
                                const filterParamsBC = { search: params.searchTerm, isActive: params.isActive, limit: params.limit || 5, page: 1 };
                                const { businessClients, totalItems: totalBC } = await businessClientService.getAllBusinessClients(state.activeFinancialAccountId, filterParamsBC);
                                
                                if (aiResponse.detected_actions.length === 1) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || (totalBC === 0 ? `Nenhum cliente do negócio encontrado, ${clientNameToUse}. Que tal cadastrar o primeiro?` : `👥 Encontrei ${totalBC} cliente(s) do negócio. Aqui estão os primeiros:`);
                                } else if (multipleActionBodiesList.length === 0 && !aiResponse.overall_summary_suggestion) {
                                     aiMessageIntro = totalBC === 0 ? `Nenhum cliente do negócio encontrado, ${clientNameToUse}.` : `Sobre seus clientes do negócio:`;
                                }
                                if (totalBC > 0) currentActionFormattedData = formatListBusinessClientsDataStructure(businessClients);
                                break;
                            }
                            case 'UPDATE_BUSINESS_CLIENT': {
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) throw new Error("Apenas para contas PJ/MEI.");
                                const clientIdToUpdate = state.editingResource?.type === 'business_client' && state.editingResource?.id
                                    ? parseInt(state.editingResource.id, 10)
                                    : (params.clientIdToUpdate ? parseInt(params.clientIdToUpdate) : null);
                                if (!clientIdToUpdate) throw new Error("ID do cliente do negócio para atualizar não fornecido.");
                                
                                const updateDataBC = {};
                                if (params.hasOwnProperty('name')) updateDataBC.name = params.name;
                                if (params.hasOwnProperty('phone')) updateDataBC.phone = params.phone;
                                if (params.hasOwnProperty('email')) updateDataBC.email = params.email;
                                if (params.hasOwnProperty('notes')) updateDataBC.notes = params.notes;
                                if (params.hasOwnProperty('isActive')) updateDataBC.isActive = params.isActive;
                                if (Object.keys(updateDataBC).length === 0) throw new Error("Nenhum dado para atualizar o cliente.");

                                const updatedBC = await businessClientService.updateBusinessClient(state.activeFinancialAccountId, clientIdToUpdate, updateDataBC, actorId);
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Cliente "${updatedBC.name}" atualizado, ${clientNameToUse}!`;
                                currentActionFormattedData = formatBusinessClientDataStructure(updatedBC);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }

                            // NOVO: Cases para SharedAccess
                            case 'GRANT_ACCESS': { // Ação do DONO (ownerId = actorId)
                                if (state.isSharedAccessContext) throw new Error("Você não pode gerenciar acessos de dentro de um acesso compartilhado.");
                                if (!params.sharedWithUserIdentifier) throw new Error("Preciso do telefone ou e-mail de quem você quer convidar.");
                                if (!params.accessPersonalProfile && !params.businessProfileToShareName) throw new Error("Você precisa escolher pelo menos um perfil (Pessoal ou Empresarial) para compartilhar.");

                                let businessProfileIdToShare = null;
                                if (params.businessProfileToShareName) {
                                    const bizAccount = (await clientService.getClientFinancialAccounts(ownerId, {isActive:true})).find(acc => (acc.accountType === 'PJ' || acc.accountType === 'MEI') && acc.accountName.toLowerCase() === params.businessProfileToShareName.toLowerCase());
                                    if (!bizAccount) throw new Error(`Não encontrei um perfil empresarial chamado "${params.businessProfileToShareName}" na sua conta.`);
                                    businessProfileIdToShare = bizAccount.id;
                                }

                                const accessRules = {
                                    canAccessPersonalProfile: params.accessPersonalProfile || false,
                                    canAccessBusinessProfileId: businessProfileIdToShare,
                                    // Outras permissões default podem ser setadas no service
                                };
                                const sharedAccessCredentials = {
                                    email: params.sharedAccessEmailForGuest,
                                    password: params.sharedAccessPasswordForGuest,
                                    phone: params.sharedAccessPhoneForGuest
                                };
                                const newSharedAccess = await sharedAccessService.grantAccess(ownerId, params.sharedWithUserIdentifier, accessRules, sharedAccessCredentials);
                                if (aiResponse.detected_actions.length === 1 && (!aiMessageIntro || aiMessageIntro.startsWith("Ok,"))) aiMessageIntro = aiResponse.overall_summary_suggestion || `Convite enviado com sucesso para ${params.sharedWithUserIdentifier}! 🤝`;
                                currentActionFormattedData = formatSharedAccessDataStructure(newSharedAccess, 'owner');
                                break;
                            }
                            case 'LIST_GRANTED_ACCESS': { // Ação do DONO
                                if (state.isSharedAccessContext) throw new Error("Use 'listar meus convites' para ver os que você recebeu.");
                                const grantedList = await sharedAccessService.listGrantedAccess(ownerId, { status: params.status });
                                if (aiResponse.detected_actions.length === 1) {
                                     aiMessageIntro = aiResponse.overall_summary_suggestion || (grantedList.length === 0 ? `Você ainda não compartilhou seu acesso com ninguém, ${clientNameToUse}.` : `Aqui estão os acessos que você concedeu, ${clientNameToUse}:`);
                                }
                                if (grantedList.length > 0) currentActionFormattedData = formatListSharedAccessDataStructure(grantedList, 'owner');
                                break;
                            }
                            case 'LIST_RECEIVED_ACCESS': { // Ação do ATOR (pode ser dono ou convidado)
                                const receivedList = await sharedAccessService.listReceivedAccess(actorId, { status: params.status || 'Pendente' }); // Default para pendentes
                                 if (aiResponse.detected_actions.length === 1) {
                                     aiMessageIntro = aiResponse.overall_summary_suggestion || (receivedList.length === 0 ? `Você não tem convites de acesso pendentes ou ativos, ${clientNameToUse}.` : `Aqui estão os convites/acessos que você recebeu, ${clientNameToUse}:`);
                                }
                                if (receivedList.length > 0) currentActionFormattedData = formatListSharedAccessDataStructure(receivedList, 'guest');
                                else if (params.status === 'Pendente' && receivedList.length === 0) currentActionFormattedData = "Nenhum convite pendente no momento. 👍";
                                break;
                            }
                            case 'RESPOND_TO_INVITE': { // Ação do ATOR (convidado)
                                if (!params.responseType || !['aceitar', 'recusar'].includes(params.responseType.toLowerCase())) throw new Error("Preciso saber se você quer 'aceitar' ou 'recusar' o convite.");
                                
                                let sharedAccessIdToRespond = params.sharedAccessId;
                                if (!sharedAccessIdToRespond) { // Tenta encontrar pelo nome do convidante se ID não veio
                                    const pendingInvites = await sharedAccessService.listReceivedAccess(actorId, { status: 'Pendente' });
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
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `Convite ${response === 'aceitar' ? 'aceito' : 'recusado'} com sucesso, ${clientNameToUse}! 🎉`;
                                currentActionFormattedData = formatSharedAccessDataStructure(updatedSharedAccess, 'guest');
                                // Se aceitou, e não tem conta ativa, pode ser bom forçar a seleção da conta do dono.
                                if (response === 'aceitar' && !state.activeFinancialAccountId) state.currentAction = 'selecting_account_flow_active';
                                break;
                            }
                            case 'REVOKE_ACCESS': { // Ação do DONO
                                if (state.isSharedAccessContext) throw new Error("Ação não permitida em acesso compartilhado.");
                                if (!params.sharedWithUserIdentifier) throw new Error("Preciso do telefone ou e-mail do usuário para revogar o acesso.");

                                const sharedAccesses = await sharedAccessService.listGrantedAccess(ownerId, { guestIdentifier: params.sharedWithUserIdentifier, status: 'Ativo' });
                                if (sharedAccesses.length === 0) throw new Error(`Não encontrei acessos ativos concedidos para "${params.sharedWithUserIdentifier}".`);
                                
                                let sharedAccessIdToRevoke;
                                let guestNameForMsg = params.sharedWithUserIdentifier;

                                if (params.profileNameShared) { // Revogar acesso a um perfil específico
                                    const targetProfileNameLower = params.profileNameShared.toLowerCase();
                                    const saToRevoke = sharedAccesses.find(sa => {
                                        if (sa.canAccessPersonalProfile && (targetProfileNameLower.includes("pessoal") || targetProfileNameLower.includes(sa.ownerClient?.financialAccounts.find(fa=>fa.accountType==='PF')?.accountName.toLowerCase())) ) return true;
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
                                    // Múltiplos acessos para o mesmo usuário, precisa de confirmação para revogar TODOS ou especificar perfil.
                                    // Por simplicidade, vamos pedir para confirmar a revogação de TODOS.
                                    state.pendingConfirmation = {
                                        action: 'REVOKE_ACCESS',
                                        parameters: { sharedAccessIdToRevoke: sharedAccesses.map(sa=>sa.id), guestName: sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier, revokeAllForUser: true }, // Placeholder
                                        message: `Encontrei ${sharedAccesses.length} acessos para ${sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier}. Você quer revogar TODOS eles? (Sim/Não)`
                                    };
                                    aiMessageIntro = state.pendingConfirmation.message;
                                    currentActionFormattedData = ""; platformLinkFooter = "";
                                    state.currentAction = 'awaiting_confirmation';
                                    break; // Sai do switch, espera confirmação
                                } else { // Apenas um acesso para este usuário, ou não especificou perfil e só tem um.
                                    sharedAccessIdToRevoke = sharedAccesses[0].id;
                                    guestNameForMsg = sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier;
                                }
                                
                                // Se chegou aqui e não pediu confirmação, revoga direto
                                if (sharedAccessIdToRevoke && !state.pendingConfirmation) {
                                    await sharedAccessService.revokeAccessById(ownerId, sharedAccessIdToRevoke);
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || `Acesso de ${guestNameForMsg} revogado com sucesso!`;
                                    currentActionFormattedData = "Esta pessoa não poderá mais acessar as informações através deste convite.";
                                }
                                break;
                            }
                            // Cases para UPDATE_GRANTED_ACCESS, UPDATE_FINANCIAL_ACCOUNT, DELETE_FINANCIAL_ACCOUNT (com devidas proteções e confirmações)
                            case 'UPDATE_FINANCIAL_ACCOUNT': {
                                if (state.isSharedAccessContext) throw new Error("Ação não permitida em acesso compartilhado.");
                                if (!params.accountNameToUpdate) throw new Error("Qual conta você quer atualizar?");
                                
                                const accountToUpdate = (await clientService.getClientFinancialAccounts(ownerId, {isActive:null})).find(acc => acc.accountName.toLowerCase() === params.accountNameToUpdate.toLowerCase());
                                if (!accountToUpdate) throw new Error(`Não encontrei uma conta chamada "${params.accountNameToUpdate}".`);

                                const updateDataFA = {};
                                if (params.hasOwnProperty('newAccountName')) updateDataFA.accountName = params.newAccountName;
                                if (params.hasOwnProperty('documentNumber')) updateDataFA.documentNumber = params.documentNumber;
                                if (params.hasOwnProperty('isActive')) updateDataFA.isActive = params.isActive;
                                if (params.hasOwnProperty('isDefault')) updateDataFA.isDefault = params.isDefault;
                                if (Object.keys(updateDataFA).length === 0) throw new Error("Nenhum dado fornecido para atualizar a conta.");

                                const updatedFA = await clientService.updateFinancialAccount(ownerId, accountToUpdate.id, updateDataFA);
                                // Se a conta ativa foi a atualizada, atualiza no estado
                                if (state.activeFinancialAccountId === updatedFA.id) {
                                    state.activeFinancialAccountName = updatedFA.accountName;
                                    state.activeFinancialAccountType = updatedFA.accountType; // Tipo não muda, mas bom ter
                                }
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `Conta "${params.accountNameToUpdate}" atualizada com sucesso, ${clientNameToUse}!`;
                                currentActionFormattedData = formatFinancialAccountDataStructure(updatedFA);
                                actionWasAnEdit = true; state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'DELETE_FINANCIAL_ACCOUNT': {
                                if (state.isSharedAccessContext) throw new Error("Ação não permitida em acesso compartilhado.");
                                if (!params.accountNameToDelete) throw new Error("Qual conta você quer excluir?");

                                const accountsOwned = await clientService.getClientFinancialAccounts(ownerId, {isActive:null});
                                const accountToDelete = accountsOwned.find(acc => acc.accountName.toLowerCase() === params.accountNameToDelete.toLowerCase());
                                if (!accountToDelete) throw new Error(`Não encontrei uma conta sua chamada "${params.accountNameToDelete}".`);
                                if (accountsOwned.length <= 1 && accountToDelete) {
                                    throw new Error("Você não pode excluir sua única conta financeira. Crie outra primeiro, se desejar.");
                                }
                                
                                // PEDIR CONFIRMAÇÃO EXPLÍCITA
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

                            // Default e outros
                            default:
                                let defaultIntro = `Ok, ${clientNameToUse}!`;
                                if (aiResponse.detected_actions.length === 1 && aiResponse.overall_summary_suggestion) defaultIntro = aiResponse.overall_summary_suggestion;
                                else if (aiResponse.reply_to_user_suggestion) defaultIntro = aiResponse.reply_to_user_suggestion;
                               
                                if (multipleActionBodiesList.length === 0 &&
                                    (!(aiMessageIntro && aiMessageIntro.includes(clientNameToUse)) && aiMessageIntro !== aiResponse.overall_summary_suggestion && aiMessageIntro !== aiResponse.reply_to_user_suggestion)) {
                                     aiMessageIntro = defaultIntro;
                                } else if (aiResponse.detected_actions.length > 1 && aiResponse.overall_summary_suggestion && aiMessageIntro !== aiResponse.overall_summary_suggestion) {
                                    // Mantém
                                } else if (aiResponse.overall_summary_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`))) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion;
                                }

                                currentActionFormattedData = `Ainda estou aprendendo a processar "${actionName.toLowerCase().replace(/_/g," ")}" completamente. 😅 Minha equipe está trabalhando nisso!`;
                                logger.warn(`[WHATSAPP SERVICE] Ação da IA não implementada no switch de formatação: ${actionName}`);
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
                    if ((typeof aiMessageIntro === 'string' && (aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`) || !aiMessageIntro.includes(clientNameToUse))) &&
                        aiResponse.overall_summary_suggestion &&
                        !(aiMessageIntro && (aiMessageIntro.toLowerCase().includes("ops") || aiMessageIntro.toLowerCase().includes("problema")) ) ) {
                        aiMessageIntro = aiResponse.overall_summary_suggestion;
                    }
                } else if (aiResponse.detected_actions.length === 0) {
                    structuredDataBody = "";
                    if (aiResponse.reply_to_user_suggestion && (typeof aiMessageIntro !== 'string' || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`) || aiMessageIntro === aiResponse.overall_summary_suggestion )) {
                        if (aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`)) {
                            aiMessageIntro = aiResponse.reply_to_user_suggestion;
                        }
                    }
                }
            } 
       
            if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
                aiMessageIntro = aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe:`;
                structuredDataBody = aiResponse.clarifications_needed[0].clarification_question;
                platformLinkFooter = "";
                state.currentAction = 'awaiting_clarification_response';
                state.data.clarificationContext = {
                    action: aiResponse.clarifications_needed[0].original_intent_action_suggestion,
                    original_message: messageText,
                    parameters_so_far: aiResponse.clarifications_needed[0].parameters_so_far || {}
                };
            } else if ((!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) && !structuredDataBody) {
                if (aiResponse.reply_to_user_suggestion &&
                    (typeof aiMessageIntro !== 'string' || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`) || aiMessageIntro === aiResponse.overall_summary_suggestion )) {
                    if (aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion || aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`)) {
                        aiMessageIntro = aiResponse.reply_to_user_suggestion;
                    }
                }
                if(multipleActionBodiesList.length === 0) structuredDataBody = "";

                if ((typeof aiMessageIntro === 'string' && aiMessageIntro.startsWith(`Ok, ${clientNameToUse}!`)) && !structuredDataBody && !aiResponse.overall_summary_suggestion && !aiResponse.reply_to_user_suggestion) {
                    aiMessageIntro = `Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊`;
                }
            }
       
            if (typeof aiMessageIntro !== 'string' || aiMessageIntro.trim() === "") {
                aiMessageIntro = `Ok, ${clientNameToUse}!`;
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
                                     (finalMessageToSend && finalMessageToSend.includes('https://app.mapnocontrole.com.br')) ||
                                     (finalMessageToSend && finalMessageToSend.includes('https://mapnocontrole.com.br/planos')) ||
                                     (state.data.onboardingStage === 'awaiting_plan_confirmation' && !state.hasPaidAccess) ||
                                     noLinkDetectedAction;


            if (platformLinkFooter && platformLinkFooter.trim() !== "" && !noLinkConditions ) {
                 finalMessageToSend += `\n\n${platformLinkFooter.trim()}`;
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
                                               return !(actionNameCheck?.startsWith("GENERAL_") || actionNameCheck?.startsWith("LIST_") || actionNameCheck?.startsWith("GET_") || actionNameCheck?.startsWith("SWITCH_") || actionNameCheck?.startsWith("ACTION_CONFIRMATION_") || actionNameCheck === 'DELETE_FINANCIAL_ACCOUNT'); // DELETE_FINANCIAL_ACCOUNT tem seu próprio fluxo de confirmação e não deve ter botões genéricos
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
                             actionNameCheck?.startsWith("GRANT_") || actionNameCheck?.startsWith("REVOKE_") || actionNameCheck?.startsWith("RESPOND_TO_") // Ações de shared access não terão botões de editar/excluir genéricos
                             );
                }).length === 1;

                if (resourceForButtonsContext && singleConcreteNonEditAction) {
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
                        case 'product': buttons = [ { id: `edit_product_${resourceForButtonsContext.id}`, label: "Editar Produto ✍️" }, /* delete_product pode ser via texto */ ]; break;
                        case 'parcelled_account': buttons = [ { id: `edit_parcelled_account_${resourceForButtonsContext.id}`, label: "Alterar Compra Parcelada ✍️" }, { id: `delete_parcelled_account_${resourceForButtonsContext.id}`, label: "Excluir Compra Parcelada 🗑️" }, ]; break;
                        // case 'business_client': buttons = [ { id: `edit_business_client_${resourceForButtonsContext.id}`, label: "Editar Cliente ✍️" }, { id: `delete_business_client_${resourceForButtonsContext.id}`, label: "Excluir Cliente 🗑️" } ]; break;
                        // Não adicionar botões para financial_account ou shared_access aqui
                    }
       
                    if (buttons.length > 0) {
                        await sendButtonListMessage(senderPhone, finalMessageToSend, buttons, buttonTitle, "Ver Opções 👇");
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
        const clientNameToUseInError = state ? state.clientName : (pushNameFromPayload || "você");
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
        logger.info(`[WHATSAPP HANDLER] Processamento para ${senderPhone} (Ator: ${state?.actorClient?.id || 'N/A'}, DonoCtx: ${state?.ownerClientIdForContext || 'N/A'}) finalizado em ${endTime - startTime}ms.`);
        if (state) {
            logger.debug(`[WHATSAPP HANDLER] Estado final da sessão para ${senderPhone}:`, {
                currentAction: state.currentAction,
                onboardingStage: state.data?.onboardingStage,
                hasPaidAccess: state.hasPaidAccess,
                activeFinancialAccountId: state.activeFinancialAccountId,
                isShared: state.isSharedAccessContext,
                // tempEmail: state.data?.tempEmail, // Exemplo se precisar debugar dados temporários
            });
            conversationState.set(senderPhone, state);
        }
        pushNameFromPayload = null;
    }
}

module.exports = { processIncomingMessage };
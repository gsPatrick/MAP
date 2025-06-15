// src/features/WhatsappHandler/response.formatter.js
const logger = require('../../utils/logger');

// Funções de formatação de data e moeda (helpers)
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

function formatPlanName(accessLevelString) {
    if (!accessLevelString || typeof accessLevelString !== 'string') {
        return 'Nenhum plano';
    }
    const planTranslations = {
        'basico': 'Básico', 'avancado': 'Avançado', 'mensal': 'Mensal',
        'anual': 'Anual', 'vitalicio': 'Vitalício'
    };
    return accessLevelString.split('_')
        .map(part => planTranslations[part] || (part.charAt(0).toUpperCase() + part.slice(1)))
        .join(' ');
}

function formatPlatformLink(customText = null) {
    const platformUrl = process.env.PLATFORM_URL || 'map-nocontrole.com.br/painel';
    const defaultText = `📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}. Qualquer coisa, estou por aqui! 😉`;
    return customText || defaultText;
}

const statusTranslations = {
    Scheduled: "Agendado(a) 🗓️", Confirmed: "Confirmado(a) ✅", Cancelled: "Cancelado(a) ❌",
    Completed: "Concluído(a) ✔️", Pending: "Pendente ⏳", Paid: "Pago(a) ✅",
    Received: "Recebido(a) ✅", Active: "Ativo(a) ✅", Inactive: "Inativo(a) ❌",
    Overdue: "Vencido(a) ⏰", Accepted: "Ativo ✅",
};

function translateStatus(statusKey, defaultText = null) {
    return statusTranslations[statusKey] || defaultText || statusKey;
}

// Funções de formatação de "Estrutura de Dados"
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
    if (appointment?.financialAccount?.client?.name && appointment.financialAccount.client.name.toLowerCase() !== 'unknown' && appointment.financialAccount.client.name.toLowerCase() !== 'null') {
        forWhom = `(${appointment.financialAccount.client.name.split(" ")[0]})`;
    } else if (clientNameForReminder && clientNameForReminder !== "Você") {
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

function formatRecurringRuleHistoryDataStructure(history, rule) {
    const ruleName = rule.description || history.ruleDescription;

    // Cenário 1: Nenhuma transação foi gerada ainda.
    if (!history || !history.transactions || history.transactions.length === 0) {
        let data = `📜 Histórico da Regra "${ruleName}":\n\n`;
        data += `Tudo certo! Esta é uma recorrência programada. 👍\n\n`;
        data += `O primeiro lançamento de *${formatCurrency(rule.value)}* será criado automaticamente em *${formatDate(rule.nextDueDate)}*.`;
        return data;
    }

    // Se chegamos aqui, existem transações. Vamos analisá-las.
    const pendingTransactions = history.transactions.filter(tx => !tx.isPaidOrReceived);
    const paidTransactions = history.transactions.filter(tx => tx.isPaidOrReceived);

    let data = `📜 Histórico da Regra "${ruleName}":\n\n`;

    // Cenário 2: Existem transações, mas todas estão pendentes.
    if (pendingTransactions.length > 0 && paidTransactions.length === 0) {
        data += `Atenção! Você tem pagamentos pendentes para esta recorrência:\n`;
        pendingTransactions.forEach((tx, index) => {
            data += `\n${index + 1}️⃣ *${formatCurrency(tx.value)}* com vencimento em *${formatDate(tx.dueDate)}* 🗓️`;
        });
        data += `\n\nPara confirmar o pagamento, diga "paguei a ${ruleName}".`;
    } 
    // Cenário 3: Existem transações pagas (e talvez algumas pendentes também).
    else {
        if (paidTransactions.length > 0) {
            data += `✅ Pagamentos já realizados:\n`;
            paidTransactions.slice(0, 3).forEach((tx) => { // Mostra os 3 últimos pagos
                data += `  - ${formatCurrency(tx.value)} em ${formatDate(tx.paymentDate)}\n`;
            });
        }
        if (pendingTransactions.length > 0) {
            data += `\n🗓️ Próximos pagamentos pendentes:\n`;
            pendingTransactions.slice(0, 2).forEach((tx) => { // Mostra os 2 próximos pendentes
                data += `  - ${formatCurrency(tx.value)} com vencimento em *${formatDate(tx.dueDate)}*\n`;
            });
        }
    }

    // Adiciona informação sobre o próximo lançamento automático, se aplicável
    if (rule.isActive && new Date(rule.nextDueDate) > new Date()) {
        data += `\n\n➡️ O próximo lançamento automático será em *${formatDate(rule.nextDueDate)}*.`;
    } else if (!rule.isActive) {
        data += `\n\n(Esta regra de recorrência está inativa e não irá gerar novos lançamentos).`;
    }

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

function formatMonthlyTrendDataStructure(trendData, accountName) {
    if (!trendData || trendData.length === 0) return "📈 Tendência Financeira:\n\nNão há dados suficientes para gerar a tendência.";

    const summary = {};
    trendData.forEach(item => {
        if (!summary[item.month]) {
            summary[item.month] = { Receitas: 0, Despesas: 0 };
        }
        summary[item.month][item.type] = item.value;
    });

    let data = `📈 Tendência Financeira - Conta "${accountName}"\n`;
    for (const month in summary) {
        const income = summary[month].Receitas || 0;
        const expense = summary[month].Despesas || 0;
        const balance = income - expense;
        const balanceEmoji = balance >= 0 ? '👍' : '👎';
        data += `\n📅 *${month}*:\n`;
        data += `  🟢 Entradas: ${formatCurrency(income)}\n`;
        data += `  🔴 Saídas: ${formatCurrency(expense)}\n`;
        data += `  ${balanceEmoji} Saldo: ${formatCurrency(balance)}\n`;
    }
    return data.trim();
}

function formatCategorySummaryDataStructure(summaryData, type, accountName) {
    if (!summaryData || summaryData.length === 0) return `📊 Resumo de ${type}:\n\nNenhum dado encontrado para gerar o resumo.`;

    let data = `📊 Top 5 Categorias de ${type} - Conta "${accountName}"\n\n`;
    const total = summaryData.reduce((acc, item) => acc + item.value, 0);

    summaryData.slice(0, 5).forEach(item => {
        const percentage = total > 0 ? ((item.value / total) * 100).toFixed(1) : 0;
        data += `*${item.type || 'Sem Categoria'}*: ${formatCurrency(item.value)} (${percentage}%)\n`;
    });

    return data.trim();
}

function formatListFinancialCategoriesDataStructure(categories) {
    if (!categories || categories.length === 0) return "🗂️ Suas Categorias:\n\nNenhuma categoria cadastrada.";

    let data = "🗂️ Suas Categorias Financeiras:\n";

    function buildList(categoryList, level = 0) {
        let listString = "";
        const indent = "  ".repeat(level);
        categoryList.forEach(cat => {
            listString += `\n${indent}📂 *${cat.name}* (ID: ${cat.id})`;
            if (cat.subcategories && cat.subcategories.length > 0) {
                listString += buildList(cat.subcategories, level + 1);
            }
        });
        return listString;
    }

    data += buildList(categories);
    return data.trim();
}

function formatListProductsDataStructure(products) {
    if (!products || products.length === 0) return "📦 Seus Produtos:\n\nNenhum produto cadastrado.";

    let data = "📦 Seus Produtos Cadastrados:\n";
    products.forEach((p, index) => {
        data += `\n${index + 1}️⃣ *${p.name}*\n`;
        data += `   💰 Venda: ${formatCurrency(p.salePrice)}\n`;
        data += `   📦 Estoque: ${p.quantity} ${p.unit || 'UN'}\n`;
    });
    return data.trim();
}

function formatRecurringRuleHistoryDataStructure(history) {
    if (!history || !history.transactions || history.transactions.length === 0) {
        return `📜 Histórico de "${history.ruleDescription}":\n\nNenhuma transação gerada por esta regra ainda.`;
    }
    let data = `📜 Histórico da Regra "${history.ruleDescription}":\n`;
    history.transactions.forEach((tx, index) => {
        const status = tx.isPaidOrReceived ? `(Paga em ${formatDate(tx.paymentDate)})` : `(Pendente, vence ${formatDate(tx.dueDate)})`;
        data += `\n${index + 1}️⃣ ${formatCurrency(tx.value)} em ${formatDate(tx.transactionDate)} ${status}`;
    });
     if (history.totalItems > history.transactions.length) {
        data += `\n\n... e mais ${history.totalItems - history.transactions.length} transação(ões).`;
    }
    return data.trim();
}

function formatHydrationLogDataStructure(logs, prefs, clientName) {
    const totalCompleted = logs.filter(log => log.status === 'completed').reduce((sum, log) => sum + log.amount, 0);
    const goal = prefs.dailyGoalMl || 2000;
    const percentage = goal > 0 ? Math.round((totalCompleted / goal) * 100) : 0;
    
    let data = `💧 *Seu progresso de hidratação hoje, ${clientName}!* 💧\n\n`;
    data += `🎯 Meta: *${goal}ml*\n`;
    data += `✅ Bebido: *${totalCompleted}ml*\n`;
    data += `📊 Progresso: *${percentage}%*\n\n`;

    if (percentage >= 100) {
        data += "Parabéns, meta batida! 🎉 Você é incrível!\n";
    } else {
        const remaining = goal - totalCompleted;
        data += `Faltam *${remaining}ml* para atingir sua meta. Vamos lá! 💪\n`;
    }
    return data;
}

function formatAffiliateDashboardDataStructure(dashboardData, clientName) {
    if (!dashboardData) return "Não foi possível carregar seus dados de afiliado.";
    
    let data = `💰 *Seu Painel de Afiliado, ${clientName}!* 💰\n\n`;
    data += `✨ Seu código de indicação: *${dashboardData.summary.affiliateCode}*\n`;
    data += `👥 Total de indicados: *${dashboardData.totalReferrals}*\n`;
    data += `💵 Saldo disponível para saque: *${formatCurrency(dashboardData.summary.balance)}*\n\n`;
    data += "Compartilhe seu código com amigos e ganhe comissões a cada nova assinatura que eles fizerem! 🚀";
    return data.trim();
}

function formatSubscriptionDataStructure(subscription, clientName) {
    if (!subscription) {
        return `Olá, ${clientName}! Parece que você não tem uma assinatura ativa no momento. Que tal dar uma olhada nos nossos planos? 😉`;
    }
    let data = `📄 *Detalhes da sua Assinatura, ${clientName}!*\n\n`;
    data += `🚀 Plano: *${subscription.plan.name}*\n`;
    data += `⭐ Nível: *${formatPlanName(subscription.plan.tier || 'basico')}*\n`;
    if (subscription.endDate && new Date(subscription.endDate).getFullYear() > 2090) {
         data += `🗓️ Validade: *Acesso Vitalício!* 🎉\n`;
    } else {
         data += `🗓️ Válido até: *${formatDate(subscription.endDate)}*\n`;
    }
    data += `🚦 Status: *${translateStatus(subscription.status)}*\n`;
    return data.trim();
}

function formatFinancialCategoryDataStructure(category) {
    if (!category) return "🗂️ Resumo da Categoria:\n\nDados não disponíveis.";
    let data = `🗂️ Categoria Criada/Atualizada:\n\n`;
    data += `🏷️ Nome: *${category.name}*\n`;
    if (category.parentCategory) { // Se a categoria pai foi incluída no retorno do serviço
        data += `📂 Dentro de: ${category.parentCategory.name}\n`;
    } else if (category.parentId) {
        data += `(É uma subcategoria, mas os detalhes da categoria pai não foram carregados)\n`;
    } else {
        data += `(É uma categoria principal)\n`;
    }
    return data.trim();
}

function formatRichRecurringRuleList(enrichedRules, clientName) {
    if (!enrichedRules || enrichedRules.length === 0) {
        return `Nenhuma regra de recorrência encontrada, ${clientName}.`;
    }

    let data = `📋 Aqui estão suas recorrências, ${clientName}:\n`;

    enrichedRules.forEach(rule => {
        data += `\n🔄 *${rule.description}* - ${formatCurrency(rule.value)} (${rule.type})`;
        
        let statusText = "";
        if (!rule.isActive) {
            statusText = `Status: Inativa ❌`;
        } else if (rule.pendingCount > 0) {
            statusText = `Status: ${rule.pendingCount} pagamento(s) pendente(s) ❗️ (Próximo vence em ${formatDate(rule.nextPendingDueDate)})`;
        } else if (!rule.hasPaidHistory) {
            statusText = `Próximo Lançamento: *${formatDate(rule.nextDueDate)}* 🗓️`;
        } else {
            statusText = `Status: Em dia ✅ (Próximo em ${formatDate(rule.nextDueDate)})`;
        }
        data += `\n   ${statusText}`;
        data += ` (ID: ${rule.id})\n`;
    });

    return data.trim();
}



// Exporta todas as funções em um único objeto
module.exports = {
    formatDate,
    formatTime,
    formatCurrency,
    formatPlanName,
    formatPlatformLink,
    translateStatus,
    formatFinancialTransactionDataStructure,
    formatAppointmentDataStructure,
    formatRecurringRuleDataStructure,
    formatCreditCardDataStructure,
    formatCreditCardListDataStructure,
    formatCreditCardInvoiceDataStructure,
    formatAvailableLimitDataStructure,
    formatParcelledAccountDataStructure,
    formatListClientAccountsDataStructure,
    formatProductDataStructure,
    formatStockInfoDataStructure,
    formatBusinessClientDataStructure,
    formatListBusinessClientsDataStructure,
    formatSharedAccessDataStructure,
    formatListSharedAccessDataStructure,
    formatMotivationalMessagePreferenceDataStructure,
    formatWaterReminderPreferenceDataStructure,
    formatFinancialAccountDataStructure, 
    formatMonthlyTrendDataStructure,
    formatCategorySummaryDataStructure,
    formatListFinancialCategoriesDataStructure,
    formatListProductsDataStructure,
    formatHydrationLogDataStructure,
    formatAffiliateDashboardDataStructure,
    formatSubscriptionDataStructure,
    formatFinancialCategoryDataStructure,
    formatRecurringRuleHistoryDataStructure,
    formatRecurringRuleDataStructure,
    formatRichRecurringRuleList
};
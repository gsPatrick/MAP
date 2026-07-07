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
function formatFinancialTransactionDataStructure(transaction, accountName = null) {
    if (!transaction) return "🎯 Resumo da Transação:\n\nDados não disponíveis.";
    let data = `🎯 Resumo da Transação:\n\n`;
    data += `📝 Descrição: ${transaction.description || 'N/A'}\n`;
    data += `💰 Valor: ${formatCurrency(transaction.value)}\n`;
    data += `💳 Pagamento: ${transaction.paymentMethod || 'Não informado'}\n`;
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
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
    return data.trim();
}

function formatAppointmentDataStructure(appointment, forReminder = false, clientNameForReminder = "Você", isNotification = false, accountName = null) {
    if (!appointment) return "📅 Resumo do Compromisso:\n\nDados não disponíveis.";

    let introEmoji = "📅";
    let introText = "Resumo do Compromisso";

    if (forReminder) {
        introEmoji = "🔔";
        introText = `LEMBRETE DE COMPROMISSO`;
    } else if (isNotification) {
        introEmoji = "✨";
        introText = `DETALHES DO NOVO AGENDAMENTO`;
    }

    let data = `${introEmoji} *${introText}*\n\n`;

    // Cliente(s)
    if (appointment.businessClients && appointment.businessClients.length > 0) {
        const clientNames = appointment.businessClients.map(c => c.name).join(', ');
        data += `👤 *Cliente(s):* ${clientNames}\n`;
    }

    // Serviços e Valor Total
    let totalValue = 0;
    if (appointment.services && appointment.services.length > 0) {
        data += `🛠️ *Serviço(s):*\n`;
        appointment.services.forEach(service => {
            const price = parseFloat(service.priceAtTimeOfBooking || service.price || 0);
            totalValue += price;
            data += `  - ${service.name} (${formatCurrency(price)})\n`;
        });
        if (appointment.services.length > 1) {
            data += `💰 *Valor Total:* ${formatCurrency(totalValue)}\n`;
        }
    } else {
        // Fallback para o título se não houver serviços (agendamentos PF)
        data += `🏷️ *Título:* ${appointment.title || 'N/A'}\n`;
    }

    // Data, Horário e Duração
    data += `🗓️ *Data:* ${formatDate(appointment.eventDateTime)}\n`;
    data += `⏰ *Horário:* ${formatTime(appointment.eventDateTime)}\n`;
    if (appointment.durationMinutes) {
        const endTime = new Date(new Date(appointment.eventDateTime).getTime() + appointment.durationMinutes * 60000);
        data += `⏳ *Duração:* ${appointment.durationMinutes} minutos (até aprox. ${formatTime(endTime)})\n`;
    }

    // Status
    if (appointment.status) {
        data += `🚦 *Status:* ${translateStatus(appointment.status)}\n`;
    }

    // Localização e Notas
    if (appointment.location) {
        data += `📍 *Local:* ${appointment.location}\n`;
    }
    if (appointment.notes) {
        data += `🗒️ *Observações:* ${appointment.notes}\n`;
    }

    if (accountName && !forReminder && !isNotification) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }

    return data.trim();
}

function formatRecurringRuleDataStructure(rule, accountName = null) {
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
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
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

// *** NOVA FUNÇÃO ***
function formatServiceDataStructure(service, accountName = null) {
    if (!service) return "🛠️ Resumo do Serviço:\n\nDados do serviço não disponíveis.";
    let data = `🛠️ Resumo do Serviço:\n\n`;
    data += `🏷️ Nome: *${service.name}*\n`;
    data += `💰 Preço: ${formatCurrency(service.price)}\n`;
    data += `⏰ Duração: ${service.durationMinutes} minutos\n`;
    if (service.description) {
        data += `📄 Descrição: ${service.description}\n`;
    }
    data += `🚦 Status: ${translateStatus(service.isActive ? 'Active' : 'Inactive')}\n`;
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
    return data.trim();
}

// *** NOVA FUNÇÃO ***
function formatListServicesDataStructure(services) {
    if (!services || services.length === 0) return "🛠️ Catálogo de Serviços:\n\nNenhum serviço cadastrado.";
    let data = "🛠️ Seu Catálogo de Serviços:\n";
    services.forEach((service, index) => {
        data += `\n${index + 1}️⃣ *${service.name}*\n`;
        data += `   - Preço: ${formatCurrency(service.price)}\n`;
        data += `   - Duração: ${service.durationMinutes} min\n`;
        data += `   - Status: ${translateStatus(service.isActive ? 'Active' : 'Inactive')}\n`;
    });
    return data.trim();
}


function formatCreditCardDataStructure(card, accountName = null) {
    if (!card) return "💳 Resumo do Cartão:\n\nDados não disponíveis.";
    let data = `💳 Resumo do Cartão de Crédito:\n\n`;
    data += `🏦 Nome: *${card.name || 'N/A'}*\n`;
    data += `💰 Limite Total: ${formatCurrency(card.limit)}\n`;
    if (card.availableLimit !== undefined) {
        data += `💰 Limite Disponível: ${formatCurrency(card.availableLimit)}\n`;
    }
    data += `🗓️ Dia de Fechamento: ${card.closingDay}\n`;
    data += `💵 Dia de Pagamento: ${card.paymentDay}\n`;
    if (card.lastFourDigits) data += `🔢 Final do Cartão: ${card.lastFourDigits}\n`;
    if (card.flag) data += `🏳️ Bandeira: ${card.flag}\n`;
    data += `⭐ Cartão Padrão: ${card.isDefault ? 'Sim ✅' : 'Não ❌'}\n`;
    data += `🚦 Status: ${translateStatus(card.isActive ? 'Active' : 'Inactive')}\n`;
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
    return data.trim();
}

function formatLimitUsageBar(used, total, barLen = 10) {
    const usedNum = parseFloat(used) || 0;
    const totalNum = parseFloat(total) || 0;
    const pctUsed = totalNum > 0 ? Math.min(100, Math.round((usedNum / totalNum) * 100)) : 0;
    const filled = Math.round((pctUsed / 100) * barLen);
    return {
        bar: `${'█'.repeat(filled)}${'░'.repeat(barLen - filled)}`,
        pctUsed,
    };
}

function formatCreditCardListDataStructure(cards, clientName = null) {
    if (!cards || cards.length === 0) {
        return '📋 *Cartões de crédito*\n\nNenhum cartão cadastrado ainda.\n\n💡 Diga: _"cadastrar cartão Renner com limite 5000"_';
    }

    const greeting = clientName ? `💳 *Seus cartões, ${clientName}!*` : '💳 *Seus cartões de crédito*';
    let data = `${greeting}\n`;
    data += `━━━━━━━━━━━━━━━━━━━━\n`;
    data += `📊 *${cards.length}* cartão(ões) encontrado(s)\n`;

    cards.forEach((card, index) => {
        const total = parseFloat(card.limit || 0);
        const used = parseFloat(card.usedLimit ?? (card.availableLimit != null ? total - card.availableLimit : 0));
        const available = card.availableLimit != null ? parseFloat(card.availableLimit) : null;
        const blocked = parseFloat(card.blockedLimit || 0);
        const { bar, pctUsed } = formatLimitUsageBar(used, total);
        const defaultBadge = card.isDefault ? ' ⭐' : '';

        data += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        data += `*${index + 1}.* ${card.name || 'N/A'}${defaultBadge}\n`;

        if (card.flag) data += `🏷️ ${card.flag}`;
        if (card.lastFourDigits) data += `${card.flag ? ' · ' : ''}Final *${card.lastFourDigits}*`;
        if (card.flag || card.lastFourDigits) data += '\n';

        data += `▫️ Limite total: ${formatCurrency(total)}\n`;
        if (available != null) {
            data += `▫️ Utilizado: ${formatCurrency(used)}\n`;
            if (blocked > 0) data += `▫️ Bloqueado: ${formatCurrency(blocked)}\n`;
            data += `▫️ Disponível: *${formatCurrency(available)}* ✅\n`;
            data += `📈 Uso: \`${bar}\` ${pctUsed}%\n`;
        }
        if (card.closingDay && card.paymentDay) {
            data += `🗓️ Fecha dia *${card.closingDay}* · Vence dia *${card.paymentDay}*\n`;
        }
        data += `🚦 ${card.isActive ? 'Ativo ✅' : 'Inativo ❌'}\n`;
    });

    data += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    data += `💡 *Dicas:*\n`;
    data += `• _"como está minha fatura do Renner"_\n`;
    data += `• _"paguei a fatura do cartão Visa"_\n`;
    data += `• _"limite disponível do Renner"_`;

    return data.trim();
}

function formatCreditCardInvoiceDataStructure(invoiceDetails, listTransactions = true, clientName = null, limitInfo = null) {
    if (!invoiceDetails) return '📂 *Fatura do cartão*\n\nDados da fatura não disponíveis.';

    const cardName = invoiceDetails.cardName || 'N/A';
    const totalSpends = parseFloat(invoiceDetails.totalSpendsOriginal || 0);
    const totalPaid = parseFloat(invoiceDetails.totalPaidForThisInvoice || 0);
    const amountDue = parseFloat(invoiceDetails.totalAmount || 0);
    const txCount = invoiceDetails.transactions?.length || 0;
    const isOpen = (invoiceDetails.invoicePeriodDescription || '').toLowerCase().includes('aberta')
        || (invoiceDetails.invoicePeriodDescription || '').toLowerCase().includes('atual');

    const greeting = clientName
        ? `📂 *Fatura do cartão — ${cardName}*\n👋 ${clientName}, aqui está o resumo:`
        : `📂 *Fatura do cartão — ${cardName}*`;

    let data = `${greeting}\n`;
    data += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    const periodLabel = isOpen ? '📂 *FATURA ABERTA*' : '📂 *FATURA*';
    data += `${periodLabel}\n`;
    if (invoiceDetails.invoiceReferenceMonthYear) {
        data += `📅 Referência: *${invoiceDetails.invoiceReferenceMonthYear}*\n`;
    }
    if (invoiceDetails.invoicePeriodDescription && !invoiceDetails.invoiceReferenceMonthYear) {
        data += `📅 ${invoiceDetails.invoicePeriodDescription}\n`;
    }
    if (invoiceDetails.invoiceCycleStartDate && invoiceDetails.invoiceCycleEndDate) {
        data += `🗓️ Ciclo: ${formatDate(invoiceDetails.invoiceCycleStartDate)} → ${formatDate(invoiceDetails.invoiceCycleEndDate)}\n`;
    }
    if (invoiceDetails.paymentDueDate) {
        data += `⏰ Vencimento: *${formatDate(invoiceDetails.paymentDueDate)}*\n`;
    }

    data += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    data += `💰 *VALORES*\n`;
    data += `▫️ Total de gastos: ${formatCurrency(totalSpends)}\n`;
    if (totalPaid > 0) {
        data += `▫️ Já pago/adiantado: ${formatCurrency(totalPaid)} ✅\n`;
    }

    if (amountDue <= 0 && txCount === 0) {
        data += `▫️ A pagar: *${formatCurrency(0)}*\n`;
        data += `\n✨ *Tudo limpo!* Nenhum gasto neste período.\n`;
    } else if (amountDue <= 0) {
        data += `▫️ A pagar: *${formatCurrency(0)}*\n`;
        data += `\n✨ *Em dia!* Pagamentos cobriram os gastos do período.\n`;
    } else {
        data += `▫️ *A pagar: ${formatCurrency(amountDue)}* 🔴\n`;
    }

    const limitTotal = parseFloat(limitInfo?.totalLimit ?? invoiceDetails.cardTotalLimit ?? 0);
    const limitAvailable = parseFloat(
        limitInfo?.availableLimit ?? invoiceDetails.availableLimitAfterInvoice ?? 0
    );
    const limitUsed = parseFloat(limitInfo?.usedLimit ?? limitInfo?.totalDebtOnCard ?? (limitTotal - limitAvailable));

    if (limitTotal > 0) {
        data += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        data += `📊 *LIMITE DO CARTÃO*\n`;
        data += `▫️ Limite total: ${formatCurrency(limitTotal)}\n`;
        data += `▫️ Utilizado: ${formatCurrency(limitUsed)}\n`;
        data += `▫️ Disponível: *${formatCurrency(limitAvailable)}*\n`;
        const { bar, pctUsed } = formatLimitUsageBar(limitUsed, limitTotal);
        data += `📈 Uso: \`${bar}\` ${pctUsed}%\n`;
    }

    if (listTransactions && txCount > 0) {
        data += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        data += `📄 *LANÇAMENTOS (${txCount})*\n`;
        invoiceDetails.transactions.slice(0, 8).forEach((tx, index) => {
            const parcelInfo = tx.isParcel && tx.parcelNumber && tx.totalParcels
                ? ` · ${tx.parcelNumber}/${tx.totalParcels}`
                : '';
            data += `\n${index + 1}. ${tx.description}\n`;
            data += `   ${formatCurrency(tx.value)} · ${formatDate(tx.transactionDate)}${parcelInfo}\n`;
        });
        if (txCount > 8) {
            data += `\n_...e mais ${txCount - 8} lançamento(s)_\n`;
        }
    } else if (listTransactions) {
        data += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        data += `📄 *LANÇAMENTOS*\n✨ Nenhum gasto neste período.\n`;
    }

    data += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    if (amountDue > 0) {
        data += `💡 Para pagar: _"paguei a fatura do ${cardName.split(' ').pop()}"_`;
    } else {
        data += `💡 Ver outro período: _"fatura fechada do ${cardName.split(' ').pop()}"_`;
    }

    return data.trim();
}

function formatAvailableLimitDataStructure(limitInfo) {
    if (!limitInfo) return "💳 Limite Disponível:\n\nDados de limite não disponíveis.";
    let data = `💳 Limite Disponível - Cartão *${limitInfo.cardName || 'N/A'}*:\n\n`;
    data += `💰 Limite Total: ${formatCurrency(limitInfo.totalLimit)}\n`;
    data += `💸 Valor Utilizado: ${formatCurrency(limitInfo.usedLimit != null ? limitInfo.usedLimit : limitInfo.totalDebtOnCard)}\n`;
    if (limitInfo.blockedLimit && parseFloat(limitInfo.blockedLimit) > 0) {
        data += `🔒 Limite Bloqueado (reserva): ${formatCurrency(limitInfo.blockedLimit)}\n`;
    }
    data += `✅ Limite Disponível Agora: ${formatCurrency(limitInfo.availableLimit)}\n`;
    data += `🗓️ Próximo Fechamento: Dia ${limitInfo.closingDay}\n`;
    data += `🗓️ Dia de Pagamento: Dia ${limitInfo.paymentDay}\n`;
    return data.trim();
}

/**
 * Confirmação rica após pagamento/liquidação de fatura de cartão (WhatsApp).
 * Espelha o painel web: pagamento, limites, fatura aberta e próximos vencimentos.
 */
function formatCreditCardInvoicePaymentSuccess({
    clientName,
    cardName,
    payment,
    limitInfo,
    openInvoice,
}) {
    const used = parseFloat(limitInfo?.usedLimit ?? limitInfo?.totalDebtOnCard ?? 0);
    const blocked = parseFloat(limitInfo?.blockedLimit || 0);
    const available = parseFloat(limitInfo?.availableLimit || 0);
    const total = parseFloat(limitInfo?.totalLimit || 0);
    const openDue = parseFloat(openInvoice?.totalAmount || 0);
    const openSpends = parseFloat(openInvoice?.totalSpendsOriginal || 0);
    const openPaid = parseFloat(openInvoice?.totalPaidForThisInvoice || 0);
    const openTxCount = openInvoice?.transactions?.length || 0;

    let msg = `✅ *Fatura paga com sucesso, ${clientName}!*\n\n`;
    msg += `💳 *${cardName}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    msg += `📋 *PAGAMENTO REGISTRADO*\n`;
    msg += `💰 Valor pago: *${formatCurrency(payment.amount)}*\n`;
    msg += `📅 Data: ${formatDate(payment.date)}\n`;
    msg += `💎 Forma: ${payment.method || 'Pix'}\n`;
    if (payment.reference) {
        msg += `🗓️ Referência: *${payment.reference}*\n`;
    }

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `📊 *SITUAÇÃO DO CARTÃO*\n`;
    msg += `▫️ Limite total: ${formatCurrency(total)}\n`;
    msg += `▫️ Utilizado: ${formatCurrency(used)}\n`;
    if (blocked > 0) {
        msg += `▫️ Bloqueado: ${formatCurrency(blocked)}\n`;
    }
    msg += `▫️ Disponível: *${formatCurrency(available)}* ✅\n`;
    if (limitInfo?.closingDay && limitInfo?.paymentDay) {
        msg += `🗓️ Fecha dia *${limitInfo.closingDay}* · Vence dia *${limitInfo.paymentDay}*\n`;
    }

    const usage = formatLimitUsageBar(used, total);
    msg += `📈 Uso: \`${usage.bar}\` ${usage.pctUsed}%\n`;

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `📂 *PRÓXIMA FATURA (aberta)*\n`;

    if (openDue <= 0 && openTxCount === 0) {
        msg += `✨ *Tudo limpo!* Nenhum gasto neste ciclo ainda.\n`;
        msg += `💰 A pagar: *${formatCurrency(0)}*\n`;
    } else if (openDue <= 0) {
        msg += `✨ *Em dia!* Adiantamentos cobriram os gastos do ciclo.\n`;
        msg += `💰 A pagar: *${formatCurrency(0)}*\n`;
        msg += `📦 ${openTxCount} lançamento(s) no ciclo · Total: ${formatCurrency(openSpends)}\n`;
    } else {
        msg += `💰 A pagar: *${formatCurrency(openDue)}*\n`;
        msg += `📦 Gastos no ciclo: ${formatCurrency(openSpends)}\n`;
        if (openPaid > 0) {
            msg += `✅ Já adiantado: ${formatCurrency(openPaid)}\n`;
        }
        if (openTxCount > 0) {
            msg += `\n*Lançamentos recentes:*\n`;
            openInvoice.transactions.slice(0, 4).forEach((tx, index) => {
                const parcel = tx.isParcel && tx.parcelNumber && tx.totalParcels
                    ? ` (${tx.parcelNumber}/${tx.totalParcels})`
                    : '';
                msg += `  ${index + 1}. ${tx.description} — ${formatCurrency(tx.value)}${parcel}\n`;
            });
            if (openTxCount > 4) {
                msg += `  _...e mais ${openTxCount - 4} lançamento(s)_\n`;
            }
        }
    }

    if (openInvoice?.invoiceCycleEndDate) {
        msg += `🗓️ Fechamento previsto: ${formatDate(openInvoice.invoiceCycleEndDate)}\n`;
    }
    if (openInvoice?.paymentDueDate) {
        msg += `⏰ Próximo vencimento: ${formatDate(openInvoice.paymentDueDate)}\n`;
    }

    if (openInvoice?.invoiceReferenceMonthYear) {
        msg += `📅 Ciclo: ${openInvoice.invoiceReferenceMonthYear}\n`;
    }

    msg += `\n_Cartão liberado para novas compras!_ 🚀`;

    return msg.trim();
}

function formatParcelledAccountDataStructure(parcelParams, parcelResult, accountName = null) {
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
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
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

function formatProductDataStructure(product, accountName = null) {
    if (!product) return "📦 Resumo do Produto:\n\nDados do produto não disponíveis.";
    let data = `📦 Resumo do Produto:\n\n`;
    data += `🏷️ Nome: *${product.name}*\n`;
    if (product.code) data += `🔢 Código: ${product.code}\n`;
    data += `💰 Preço de Venda: ${formatCurrency(product.salePrice)}\n`;
    if (product.costPrice !== null && product.costPrice !== undefined) data += `💲 Preço de Custo: ${formatCurrency(product.costPrice)}\n`;
    data += `🛍️ Estoque Atual: ${product.quantity !== undefined ? product.quantity : (product.initialQuantity || 0)} ${product.unit || 'UN'}\n`;
    if (product.minimumStock !== null && product.minimumStock !== undefined) data += `📉 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    if (product.description && product.description.trim() !== "") data += `📄 Descrição Detalhada: ${product.description}\n`;
    data += `🚦 Status: ${translateStatus(product.isActive === false ? 'Inactive' : 'Active')}\n`;
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
    return data.trim();
}

function formatStockInfoDataStructure(stockInfo, accountName = null) {
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
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
    return data.trim();
}

function formatBusinessClientDataStructure(client, accountName = null) {
    if (!client) return "👥 Resumo do Cliente do Negócio:\n\nDados não disponíveis.";
    let data = `👥 Resumo do Cliente:\n\n`;
    data += `👤 Nome: *${client.name}*\n`;
    if (client.phone) data += `📞 Telefone: ${client.phone}\n`;
    if (client.email) data += `📧 E-mail: ${client.email}\n`;
    if (client.notes) data += `🗒️ Observações: ${client.notes}\n`;
    data += `🚦 Status: ${translateStatus(client.isActive === false ? 'Inactive' : 'Active')}\n`;
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
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

/**
 * Retorna a mensagem visual para solicitar a forma de pagamento, com lista de cartões numerada se disponível.
 * @param {string} clientName Nome do cliente para personalizar a saudação.
 * @param {Array} cards Lista de cartões de crédito do cliente (objeto com .name).
 * @returns {string} Mensagem formatada.
 */
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

    // --- INÍCIO DA MODIFICAÇÃO ---
    const affiliateLink = `https://www.map-nocontrole.com.br/assinar/7?ref=${dashboardData.summary.affiliateCode}`;

    let data = `💰 *Seu Painel de Afiliado, ${clientName}!* 💰\n\n`;
    data += `✨ Seu código de indicação: *${dashboardData.summary.affiliateCode}*\n`;
    data += `🔗 Seu link para compartilhar:\n${affiliateLink}\n\n`;
    data += `👥 Total de indicados: *${dashboardData.totalReferrals}*\n`;
    data += `💵 Saldo disponível para saque: *${formatCurrency(dashboardData.summary.balance)}*\n\n`;
    data += "Copie seu link, compartilhe com amigos e ganhe comissões a cada nova assinatura que eles fizerem! 🚀";
    // --- FIM DA MODIFICAÇÃO ---

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

function formatFinancialCategoryDataStructure(category, accountName = null) {
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
    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }
    return data.trim();
}

function formatRichRecurringRuleList(enrichedRules, totalItems, clientName) {
    if (!enrichedRules || enrichedRules.length === 0) {
        return `Nenhuma regra de recorrência encontrada com os filtros aplicados, ${clientName}.`;
    }

    let data = `📋 Aqui estão suas recorrências, ${clientName}:\n`;

    enrichedRules.forEach(rule => {
        let statusEmoji = '❓';
        let statusText = '';
        let details = `Valor: ${formatCurrency(rule.value)} (${rule.type})`;

        if (!rule.isActive) {
            statusEmoji = '❌';
            statusText = `Inativa`;
        } else if (rule.pendingCount > 0) {
            statusEmoji = '❗️';
            statusText = `Pendente`;
            details = `Próximo pagamento de *${formatCurrency(rule.value)}* vence em *${formatDate(rule.nextPendingDueDate)}*`;
        } else if (!rule.hasPaidHistory) {
            statusEmoji = '🗓️';
            statusText = `Agendada`;
            details = `Primeiro lançamento em *${formatDate(rule.nextDueDate)}*`;
        } else {
            statusEmoji = '✅';
            statusText = `Em dia`;
            details = `Próximo lançamento em *${formatDate(rule.nextDueDate)}*`;
        }

        data += `\n-----------------------------------\n`;
        data += `*${rule.description}*\n`;
        data += `${statusEmoji} Status: *${statusText}*\n`;
        data += `💸 ${details}\n`;
    });

    if (totalItems > enrichedRules.length) {
        data += `\n-----------------------------------\n`;
        data += `\n... e mais ${totalItems - enrichedRules.length} regra(s).`;
    }

    return data.trim();
}


function formatFinancialSummaryDataStructure(summary) {
    if (!summary) return "📊 Resumo Financeiro:\n\nDados não disponíveis.";

    const emojiMap = {
        // Categorias Pessoais
        'Alimentação': '🍽️',
        'Supermercado': '🛒',
        'Restaurantes': '🍴',
        'Ifood': '📲',
        'Delivery': '📦',
        'Moradia': '🏠',
        'Aluguel': '💵',
        'Condomínio': '🏢',
        'Contas': '🧾',
        'Conta de Água': '🚰',
        'Conta de Luz': '💡',
        'Conta de Gás': '🔥',
        'Internet': '🌐',
        'Transporte': '🚗',
        'Abastecimento': '⛽',
        'Estacionamento': '🅿️',
        'Uber': '🚕',
        '99': '🚖',
        'Transporte Público': '🚌',
        'Manutenção Veicular': '🔧',
        'Saúde': '💊',
        'Farmácia': '🏥',
        'Plano de Saúde': '🩺',
        'Consultas': '👩‍⚕️',
        'Exames': '🧪',
        'Academia': '🏋️',
        'Lazer': '🎉',
        'Entretenimento': '🎭',
        'Viagens': '✈️',
        'Cinema': '🎬',
        'Shows': '🎤',
        'Assinaturas': '📃',
        'Streamings': '📺',
        'Cuidados Pessoais': '🛀',
        'Beleza': '💄',
        'Compras': '🛍️',
        'Vestuário': '👗',
        'Eletrônicos': '📱',
        'Casa': '🏡',
        'Presentes': '🎁',
        'Educação': '📚',
        'Dívidas': '📉',
        'Empréstimos': '💸',
        'Pagamento de Fatura': '💳',
        'Receitas': '✅',
        'Salário': '💰',
        'Renda Extra': '🤑',
        'Investimentos': '📈',

        // Categorias de Negócio (PJ/MEI)
        'Receitas Operacionais': '📊',
        'Venda de Produtos': '📦',
        'Prestação de Serviços': '🛠️',
        'Outras Receitas': '💵',
        'Custos dos Produtos/Serviços (CPV/CSV)': '💰',
        'Matéria-prima e Insumos': '🧱',
        'Mercadorias para Revenda': '📦',
        'Fretes sobre Vendas': '🚚',
        'Despesas Administrativas': '📋',
        'Salários e Pró-labore': '👔',
        'Aluguel (Escritório/Loja)': '🏢',
        'Contas (Luz, Água, Internet)': '🧾',
        'Telefonia': '📞',
        'Honorários (Contador, Advogado)': '⚖️',
        'Material de Escritório': '📎',
        'Despesas de Marketing': '📢',
        'Marketing e Publicidade': '📣',
        'Comissões de Vendas': '💼',
        'Despesas Financeiras': '💳',
        'Taxas Bancárias': '🏦',
        'Juros de Empréstimos': '📈',
        'Taxas de Cartão': '💳',
        'Impostos e Tributos': '🧾',
        'Simples Nacional / DAS': '📝',
        'Outros Impostos': '📄',
        'Investimentos e Ativos': '📊',
        'Compra de Equipamentos': '🛠️',
        'Manutenção de Ativos': '🔧',
        'Despesas com Pessoal': '👥',
        'Benefícios (VT, VR)': '🎟️',
        'Treinamentos': '🎓',
        'Outras Despesas Operacionais': '📉',
        'Viagens e Representação': '✈️',
        'Manutenção de Software/Licenças': '💻'
    };

    const getCategoryEmoji = (categoryName) => {
        if (!categoryName) return '📂';
        const nameLower = categoryName.toLowerCase();
        for (const key in emojiMap) {
            if (nameLower.includes(key)) return emojiMap[key];
        }
        return '📂';
    };

    let data = `💸 *Entradas:* ${formatCurrency(summary.totalIncome)}\n` +
        `💔 *Saídas:* ${formatCurrency(summary.totalExpenses)}\n` +
        `⚖️ *Balanço Final:* ${formatCurrency(summary.netBalance)}\n\n` +
        `✨ *Por Forma de Pagamento:*\n` +
        `💎 Pix: ${formatCurrency(summary.totalPix || 0)}\n` +
        `💵 Dinheiro: ${formatCurrency(summary.totalCash || 0)}\n` +
        `💳 Cartão: ${formatCurrency(summary.totalCreditCard || 0)}\n`;

    if (summary.expenseBreakdown && summary.expenseBreakdown.length > 0) {
        data += `\n📂 *Despesas por Categoria:*\n`;
        summary.expenseBreakdown.forEach(item => {
            const emoji = getCategoryEmoji(item.categoryName);
            data += `${emoji} ${item.categoryName}: ${formatCurrency(item.totalValue)}\n`;
        });
    }

    if (summary.totalToReceivePending > 0 || summary.totalToPayPending > 0) {
        data += `\n📬 *Valores Pendentes:*\n`;
        data += `📥 A Receber: ${formatCurrency(summary.totalToReceivePending)}\n`;
        data += `📤 A Pagar: ${formatCurrency(summary.totalToPayPending)}\n`;
    }

    if (summary.futureForecast && summary.futureForecast.totalFutureDebt > 0) {
        data += `\n🔮 *Previsão de Parcelas Futuras:*\n`;
        data += `📉 Total Pendente no Cartão: *${formatCurrency(summary.futureForecast.totalFutureDebt)}*\n`;

        summary.futureForecast.forecast.slice(0, 3).forEach(item => {
            const [year, month] = item.month.split('-');
            const dateObj = new Date(Date.UTC(year, month - 1));
            const monthName = dateObj.toLocaleString('pt-BR', { month: 'short', timeZone: 'UTC' });
            data += `🗓️ ${monthName.charAt(0).toUpperCase() + monthName.slice(1)}/${year.slice(2)}: *${formatCurrency(item.total)}*\n`;
        });
    }

    if (summary.recentTransactions && summary.recentTransactions.length > 0) {
        data += `\n─────────────────────\n`;
        data += `🧾 *Movimentações do Período:*\n`;
        summary.recentTransactions.forEach(tx => {
            const emojiType = tx.type === 'Entrada' ? '⬆️' : '⬇️';
            const categoryName = tx.category?.name || 'Geral';
            const categoryEmoji = getCategoryEmoji(categoryName);

            data += `\n📅 ${formatDate(tx.transactionDate)} — ${emojiType} *${tx.type}*\n`;
            data += `📌 ${categoryEmoji} ${categoryName} – ${tx.description}\n`;
            data += `💰 Valor: ${formatCurrency(tx.value)}\n`;
        });
    }

    return data.trim();
}


function formatMorningBriefing(clientName, accountName, pendingTransactions, appointments) {
    const greeting = `Bom dia, ${clientName}! ☀️\nEspero que seu dia seja incrível!`;
    const intro = `Passando para te dar um panorama da sua conta *${accountName}* para hoje:`;

    let financialSection = `\n\n*Pagamentos/Recebimentos Pendentes:*\n`;
    if (pendingTransactions && pendingTransactions.length > 0) {
        pendingTransactions.forEach(tx => {
            const emoji = tx.type === 'Entrada' ? '🟢' : '🔻';
            financialSection += `> ${emoji} ${tx.description} - ${formatCurrency(tx.value)}\n`;
        });
    } else {
        financialSection += `> Nenhuma transação pendente hoje. Ufa! 🙌\n`;
    }

    let appointmentSection = `\n*Compromissos e Afazeres:*\n`;
    if (appointments && appointments.length > 0) {
        appointments.forEach(appt => {
            appointmentSection += `> ${formatTime(appt.eventDateTime, false)} - ${appt.title}\n`;
        });
    } else {
        appointmentSection += `> Nenhum compromisso agendado para hoje. Dia livre! 🤸\n`;
    }

    const footer = `\nSe precisar de qualquer coisa, estou à disposição! ✌️`;

    return `${greeting}\n\n${intro}${financialSection}${appointmentSection}${footer}`.trim();
}

function formatAvailabilityRuleDataStructure(rule, accountName = null) {
    if (!rule) return "📅 Resumo da Regra de Disponibilidade:\n\nDados não disponíveis.";

    const typeMap = {
        work: 'Horário de Trabalho 働く',
        break: 'Pausa / Bloqueio ⏸️',
        day_off: 'Folga / Feriado 🌴'
    };

    let data = `📅 Resumo da Regra de Disponibilidade:\n\n`;
    data += `🏷️ Título: *${rule.title}*\n`;
    data += `⚙️ Tipo: ${typeMap[rule.type] || rule.type}\n`;

    if (rule.rrule) {
        // <<< INÍCIO DA MUDANÇA >>>
        const rruleParts = rule.rrule.split(';');
        const byDayPart = rruleParts.find(p => p.startsWith('BYDAY='))?.split('=')[1];

        let recurrenceText = "Recorrente"; // Fallback
        if (byDayPart) {
            const dayMap = { MO: 'Seg', TU: 'Ter', WE: 'Qua', TH: 'Qui', FR: 'Sex', SA: 'Sáb', SU: 'Dom' };
            const days = byDayPart.split(',').map(day => dayMap[day] || day);

            if (days.length === 7) {
                recurrenceText = "Todos os dias";
            } else if (days.length === 5 && days.includes('Seg') && days.includes('Sex')) {
                recurrenceText = "Segunda a Sexta";
            } else {
                recurrenceText = days.join(', ');
            }
        }
        data += `🔄 Recorrência: ${recurrenceText}\n`;
        // <<< FIM DA MUDANÇA >>>
    }

    if (rule.specificDate) {
        data += `🗓️ Data Específica: ${formatDate(rule.specificDate)}\n`;
    }

    if (rule.startTime && rule.endTime) {
        data += `⏰ Horário: Das ${rule.startTime.substring(0, 5)} às ${rule.endTime.substring(0, 5)}\n`;
    }

    if (rule.type === 'work' && rule.slotIntervalMinutes) {
        data += `⏱️ Intervalo de Agendamento: A cada ${rule.slotIntervalMinutes} minutos\n`;
    }

    if (accountName) {
        data += `\n\n*(Executado na conta: ${accountName})*`;
    }

    return data.trim();
}

function formatListAvailabilityRulesDataStructure(rules) {
    if (!rules || rules.length === 0) return "📅 Suas Regras de Disponibilidade:\n\nNenhuma regra cadastrada. Diga 'criar regra de trabalho' para começar.";

    let data = "📅 Suas Regras de Disponibilidade:\n";

    const workRules = rules.filter(r => r.type === 'work');
    const breakRules = rules.filter(r => r.type === 'break');
    const dayOffRules = rules.filter(r => r.type === 'day_off');

    if (workRules.length > 0) {
        data += "\n--- Horários de Trabalho ---\n";
        workRules.forEach(rule => {
            data += `\n働く *${rule.title}* (ID: ${rule.id})\n`;
            data += `   - Das ${rule.startTime.substring(0, 5)} às ${rule.endTime.substring(0, 5)}\n`;
            if (rule.rrule) data += `   - Recorrência: ${rule.rrule.split(';').find(p => p.startsWith('BYDAY='))?.split('=')[1] || 'Definida'}\n`;
        });
    }
    if (breakRules.length > 0) {
        data += "\n--- Pausas / Bloqueios ---\n";
        breakRules.forEach(rule => {
            data += `\n⏸️ *${rule.title}* (ID: ${rule.id})\n`;
            data += `   - Das ${rule.startTime.substring(0, 5)} às ${rule.endTime.substring(0, 5)}\n`;
            if (rule.rrule) data += `   - Recorrência: ${rule.rrule.split(';').find(p => p.startsWith('BYDAY='))?.split('=')[1] || 'Definida'}\n`;
        });
    }
    if (dayOffRules.length > 0) {
        data += "\n--- Folgas / Feriados ---\n";
        dayOffRules.forEach(rule => {
            data += `\n🌴 *${rule.title}* (ID: ${rule.id})\n`;
            if (rule.specificDate) data += `   - Data: ${formatDate(rule.specificDate)}\n`;
            if (rule.rrule) data += `   - Recorrência: Anual\n`;
        });
    }

    return data.trim();
}

function formatAgendaViewDataStructure(events, startDate, endDate) {
    if (!events || events.length === 0) {
        return `🗓️ Agenda de ${formatDate(startDate)} a ${formatDate(endDate)}:\n\nNenhum evento encontrado. Dia livre! ✨`;
    }

    let data = `🗓️ Sua Agenda de ${formatDate(startDate)} a ${formatDate(endDate)}:\n`;

    // Agrupa eventos por dia
    const eventsByDay = events.reduce((acc, event) => {
        const day = new Date(event.start).toISOString().split('T')[0];
        if (!acc[day]) acc[day] = [];
        acc[day].push(event);
        return acc;
    }, {});

    // Ordena os dias
    const sortedDays = Object.keys(eventsByDay).sort();

    for (const day of sortedDays) {
        data += `\n\n*--- ${formatDate(day)} ---*`;

        // Ordena eventos do dia por horário de início
        const sortedEvents = eventsByDay[day].sort((a, b) => new Date(a.start) - new Date(b.start));

        sortedEvents.forEach(event => {
            const startTime = formatTime(event.start);
            const endTime = formatTime(event.end);
            if (event.type === 'appointment') {
                data += `\n✅ ${startTime} - ${endTime}: *${event.title}* (Status: ${translateStatus(event.status)})`;
            } else if (event.type === 'break') {
                data += `\n⏸️ ${startTime} - ${endTime}: *${event.title}* (Bloqueio)`;
            }
        });
    }

    return data.trim();
}

function formatAvailableTimeSlotsDataStructure(slots, date, duration) {
    if (!slots || slots.length === 0) {
        return `🗓️ Horários para ${formatDate(date)} (duração ${duration} min):\n\nNenhum horário disponível encontrado para esta data. 😕`;
    }

    let data = `✅ Horários disponíveis para *${formatDate(date)}* (duração de ${duration} min):\n\n`;

    // Formata em colunas para melhor visualização
    const columns = [[], [], []];
    slots.forEach((slot, index) => {
        columns[index % 3].push(`- ${slot}`);
    });

    const maxRows = Math.max(columns[0].length, columns[1].length, columns[2].length);
    for (let i = 0; i < maxRows; i++) {
        const col1 = columns[0][i] || '';
        const col2 = columns[1][i] || '';
        const col3 = columns[2][i] || '';
        data += `${col1.padEnd(12)}${col2.padEnd(12)}${col3}\n`;
    }

    data += `\nPara agendar, diga "agendar [serviço] para [cliente] no dia ${formatDate(date)} às [horário]".`;
    return data.trim();
}

function formatBusinessClientDetailsDataStructure(details) {
    if (!details) return "👥 Detalhes do Cliente:\n\nDados não disponíveis.";

    let data = `👥 Detalhes de *${details.name}*:\n\n`;
    if (details.phone) data += `📞 Telefone: ${details.phone}\n`;
    if (details.email) data += `📧 E-mail: ${details.email}\n`;
    data += `💰 Faturamento Total (Concluído): *${formatCurrency(details.totalFaturado)}*\n`;
    data += `🚦 Status: ${translateStatus(details.isActive ? 'Active' : 'Inactive')}\n`;

    if (details.appointmentHistory && details.appointmentHistory.length > 0) {
        data += `\n--- Histórico Recente ---\n`;
        details.appointmentHistory.slice(0, 3).forEach(appt => {
            const serviceNames = appt.services.map(s => s.name).join(' + ');
            data += `\n🗓️ ${formatDate(appt.eventDateTime)}: ${serviceNames || appt.title} - ${translateStatus(appt.status)}`;
        });
    } else {
        data += `\n--- Histórico Recente ---\nNenhum agendamento encontrado para este cliente.`;
    }

    return data.trim();
}

function formatAppointmentHistoryForClientDataStructure(history, clientName) {
    if (!history || history.length === 0) {
        return `📜 Histórico de Agendamentos de *${clientName}*:\n\nNenhum agendamento encontrado.`;
    }

    let data = `📜 Histórico de Agendamentos de *${clientName}*:\n`;
    history.slice(0, 10).forEach(appt => {
        const serviceNames = appt.services.map(s => s.name).join(' + ');
        data += `\n- ${formatDate(appt.eventDateTime)}: ${serviceNames || appt.title} (${translateStatus(appt.status)})`;
    });

    if (history.length > 10) {
        data += `\n\n... e mais ${history.length - 10} agendamento(s).`;
    }

    return data.trim();
}

function formatProviderPublicInfoDataStructure(publicInfo, publicUrl) {
    if (!publicInfo) return "🌐 Página Pública de Agendamento:\n\nInformações não disponíveis.";

    let data = `🌐 Sua Página Pública de Agendamento está no ar!\n\n`;
    data += `✨ Nome do Prestador: *${publicInfo.providerName}*\n`;
    data += `🔗 Seu link para compartilhar: *${publicUrl}*\n\n`;
    data += `Seus clientes podem usar este link para ver seus serviços e agendar um horário diretamente com você. Simples assim! 😉`;

    return data.trim();
}

/** Marcadores de blocos estruturados que o action handler já anexa à resposta. */
const STRUCTURED_RESPONSE_MARKERS = [
    '🎯 Resumo da Transação:',
    '📅 Resumo do Compromisso',
    '🔄 Regra de Recorrência',
    '📦 Compra Parcelada',
    '💳 Resumo do Cartão',
    '🎯 Detalhamento das Transações:',
    '🎯 Detalhamento dos Compromissos:',
];

/**
 * Remove blocos de dados estruturados (e rodapé da plataforma) que a IA
 * às vezes inclui no overall_summary_suggestion, evitando duplicação.
 */
function stripEmbeddedStructuredBlocks(intro, structuredBody) {
    if (!intro || !structuredBody?.trim()) return (intro || '').trim();

    let cleaned = intro;
    for (const marker of STRUCTURED_RESPONSE_MARKERS) {
        if (!structuredBody.includes(marker) || !cleaned.includes(marker)) continue;
        const idx = cleaned.indexOf(marker);
        cleaned = cleaned.substring(0, idx).trim();
    }

    const platformUrl = process.env.PLATFORM_URL || 'map-nocontrole.com.br/painel';
    const escapedUrl = platformUrl.replace(/\./g, '\\.');
    cleaned = cleaned
        .replace(new RegExp(`\\n---\\n+[\\s\\S]*${escapedUrl}[\\s\\S]*$`, 'i'), '')
        .replace(/\n---\n+\s*📊[\s\S]*$/i, '')
        .replace(/\n+\s*📊 Para visualizar[\s\S]*$/i, '')
        .trim();

    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
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
    formatCreditCardInvoicePaymentSuccess,
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
    formatFinancialSummaryDataStructure,
    formatRichRecurringRuleList,
    getPaymentMethodClarificationMessage,
    formatServiceDataStructure, // <-- NOVA FUNÇÃO
    formatListServicesDataStructure, // <-- NOVA FUNÇÃO
    formatMorningBriefing,
    formatAvailabilityRuleDataStructure,
    formatListAvailabilityRulesDataStructure,
    formatAgendaViewDataStructure,
    formatAvailableTimeSlotsDataStructure,
    formatBusinessClientDetailsDataStructure,
    formatAppointmentHistoryForClientDataStructure,
    formatProviderPublicInfoDataStructure,
    stripEmbeddedStructuredBlocks,
};
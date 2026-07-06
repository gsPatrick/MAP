// Helpers para distinguir lançamento novo vs. liquidação e extrair forma de pagamento.

function parseMonetaryValueFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:[.,]\d{2})?)(?:\s*(?:reais|r\$))?/i);
    if (!match) return null;
    const normalized = match[1].replace(/\./g, '').replace(',', '.');
    const val = parseFloat(normalized);
    return Number.isNaN(val) || val <= 0 ? null : val;
}

function extractPaymentMethodFromText(text, creditCards = []) {
    if (!text || typeof text !== 'string') return null;
    const msg = text.toLowerCase().trim();

    if (/^\d+$/.test(msg) && creditCards.length > 0) {
        const idx = parseInt(msg, 10) - 1;
        if (idx >= 0 && idx < creditCards.length) {
            return { paymentMethod: 'Cartão de Crédito', creditCardName: creditCards[idx].name };
        }
    }

    if (/\bpix\b/.test(msg)) return { paymentMethod: 'Pix' };
    if (/\bdinheiro\b|\bem esp[eé]cie\b/.test(msg)) return { paymentMethod: 'Dinheiro' };
    if (/\bcart[aã]o de d[eé]bito\b|\bd[eé]bito\b/.test(msg)) return { paymentMethod: 'Cartão de Débito' };
    if (/\btransfer[eê]ncia\b|\bted\b/.test(msg)) return { paymentMethod: 'Transferência' };
    if (/\bcart[aã]o\b|\bcr[eé]dito\b/.test(msg)) return { paymentMethod: 'Cartão de Crédito' };

    return null;
}

function getRecentUserMessagesFromState(state, limit = 5) {
    const history = state.messageHistory || [];
    const messages = [];
    for (let i = history.length - 1; i >= 0 && messages.length < limit; i -= 1) {
        if (history[i].role === 'user' && history[i].content && history[i].content !== '[ÁUDIO ENVIADO]') {
            messages.push(history[i].content);
        }
    }
    return messages;
}

function getLastUserMessageFromState(state) {
    const msgs = getRecentUserMessagesFromState(state, 1);
    return msgs[0] || '';
}

function looksLikeNewExpenseRegistration(message, params = {}) {
    const msg = (message || '').toLowerCase();
    const hasNewExpenseVerb = /\b(gastei|gasto|comprei|recebi|ganhei)\b/.test(msg);
    const hasMonetaryValue = parseMonetaryValueFromText(msg) != null
        || /\b\d+([.,]\d+)?\b/.test(msg)
        || (params.value != null && parseFloat(params.value) > 0)
        || (params.transactionValue != null && parseFloat(params.transactionValue) > 0);
    const paidWithAmount = /\b(paguei|pago)\b/.test(msg) && hasMonetaryValue;
    return (hasNewExpenseVerb && hasMonetaryValue) || paidWithAmount;
}

function looksLikeNewExpenseInConversation(state, params = {}) {
    if (params.transactionValue != null && parseFloat(params.transactionValue) > 0) return true;
    if (params.value != null && parseFloat(params.value) > 0) return true;

    const pending = state.pendingConfirmation;
    if (pending?.action === 'CREATE_FINANCIAL_TRANSACTION') {
        const p = pending.parameters || {};
        if (p.value && parseFloat(p.value) > 0) return true;
    }

    return getRecentUserMessagesFromState(state, 5).some((m) => looksLikeNewExpenseRegistration(m, params));
}

function resolvePaymentMethodFromConversation(state, creditCards = []) {
    const pendingMethod = state.pendingConfirmation?.parameters?.paymentMethod;
    if (pendingMethod) return { paymentMethod: pendingMethod };

    for (const msg of getRecentUserMessagesFromState(state, 6)) {
        const extracted = extractPaymentMethodFromText(msg, creditCards);
        if (extracted) return extracted;
    }
    return null;
}

module.exports = {
    parseMonetaryValueFromText,
    extractPaymentMethodFromText,
    getRecentUserMessagesFromState,
    getLastUserMessageFromState,
    looksLikeNewExpenseRegistration,
    looksLikeNewExpenseInConversation,
    resolvePaymentMethodFromConversation,
};

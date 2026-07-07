// Detecta intenção de pagamento de fatura de cartão (≠ conta pendente / MARK).

function normalizeSources(...sources) {
    return sources
        .filter(Boolean)
        .map((s) => String(s).toLowerCase())
        .join(' ');
}

function looksLikeCreditCardInvoicePayment(...sources) {
    const text = normalizeSources(...sources);
    if (!/\bfatura\b/.test(text)) return false;

    const hasPaymentVerb = /\b(paguei|pago|quitei|liquidei|antecipei|já paguei|ja paguei|pague)\b/.test(text);
    const hasCardRef = /\bcart[aã]o\b/.test(text)
        || /\brenner\b|\bvisa\b|\bmaster\b|\bnubank\b|\binter\b|\bsantos\b|\briachuelo\b|\bassa[ií]\b/.test(text);

    return hasPaymentVerb && (hasCardRef || /\bfatura\s+do\b/.test(text));
}

function extractCreditCardSearchTerms(...sources) {
    const terms = new Set();

    for (const raw of sources.filter(Boolean)) {
        const patterns = [
            /cart[aã]o\s+(?:de\s+)?([a-záàâãéêíóôõúç0-9][\wáàâãéêíóôõúç\s]{0,40})/i,
            /fatura\s+(?:do\s+)?(?:cart[aã]o\s+)?([a-záàâãéêíóôõúç0-9][\wáàâãéêíóôõúç\s]{0,40})/i,
        ];

        for (const re of patterns) {
            const match = String(raw).match(re);
            if (match) {
                const cleaned = match[1].trim().replace(/[.,!?]+$/, '');
                if (cleaned.length >= 2) terms.add(cleaned);
            }
        }
    }

    return [...terms];
}

function matchCardFromAvailableList(text, availableCards = []) {
    const normalized = normalizeSources(text);
    const sorted = [...availableCards].sort((a, b) => b.name.length - a.name.length);

    for (const card of sorted) {
        if (normalized.includes(card.name.toLowerCase())) return card.name;
        const tokens = card.name.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
        if (tokens.some((token) => normalized.includes(token))) return card.name;
    }

    return null;
}

module.exports = {
    looksLikeCreditCardInvoicePayment,
    extractCreditCardSearchTerms,
    matchCardFromAvailableList,
};

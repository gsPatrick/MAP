// src/utils/formatters.js
// Idealmente, o logger também seria injetado ou importado de um local central, se necessário aqui.
// Por simplicidade, omitirei o logger dentro destas funções de formatação puras.

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    // Garante que a string de data seja interpretada corretamente como UTC se for apenas YYYY-MM-DD
    const safeDateString = dateString.length === 10 ? `${dateString}T00:00:00Z` : dateString;
    try {
        // Formata para pt-BR, mas considera a data como UTC para evitar problemas de fuso ao formatar apenas a data.
        return new Date(safeDateString).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    } catch (e) {
        // console.warn(`[FORMAT DATE UTIL] Data inválida recebida: ${dateString}`);
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
        // console.warn(`[FORMAT TIME UTIL] Data/Hora inválida recebida: ${dateTimeString}`);
        return 'Hora Inválida';
    }
}

function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(parseFloat(value))) return 'R$ --,--';
    return `R$${parseFloat(value).toFixed(2).replace('.', ',')}`;
}

module.exports = {
    formatDate,
    formatTime,
    formatCurrency,
};
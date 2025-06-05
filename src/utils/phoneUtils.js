// src/utils/phoneUtils.js
const logger = require('./logger');

/**
 * Normaliza qualquer número de telefone brasileiro para o formato canônico
 * do sistema: 55 + DDD + 8 dígitos (sempre remove o 9º dígito de celulares).
 * @param {string} phoneNumber - O número de telefone em qualquer formato.
 * @returns {string|null} - O número normalizado ou null se a entrada for inválida.
 */
function normalizePhoneNumberToCanonical(phoneNumber) {
    if (!phoneNumber || typeof phoneNumber !== 'string') {
        return null;
    }

    // 1. Limpa tudo que não for número.
    let cleanNumber = phoneNumber.replace(/\D/g, '');

    // 2. Padroniza para o formato DDI+DDD+Numero se vier sem DDI.
    // Ex: '71982862912' (11 dígitos) -> '5571982862912'
    if (cleanNumber.length === 10 || cleanNumber.length === 11) {
        cleanNumber = '55' + cleanNumber;
    }
    
    // 3. Verifica se é um celular brasileiro com nono dígito (13 dígitos: 55+XX+9XXXXXXXX).
    if (cleanNumber.length === 13 && cleanNumber.startsWith('55') && cleanNumber.charAt(4) === '9') {
        const canonicalNumber = cleanNumber.substring(0, 4) + cleanNumber.substring(5);
        logger.info(`[PHONE UTILS] Número de celular '${phoneNumber}' normalizado para o padrão canônico '${canonicalNumber}'.`);
        return canonicalNumber;
    }
    
    // 4. Se não for um celular com 9º dígito (pode ser fixo ou já estar no formato correto), retorna como está.
    // Ex: '557182862912' (12 dígitos) já está no formato canônico.
    if (cleanNumber.length === 12 && cleanNumber.startsWith('55')) {
        logger.info(`[PHONE UTILS] Número '${phoneNumber}' já está no formato canônico '${cleanNumber}'.`);
        return cleanNumber;
    }

    logger.warn(`[PHONE UTILS] Número '${phoneNumber}' (limpo: '${cleanNumber}') tem um formato não padrão. Retornando como está.`);
    return cleanNumber;
}

module.exports = {
    normalizePhoneNumberToCanonical,
};
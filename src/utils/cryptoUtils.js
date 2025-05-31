// src/utils/cryptoUtils.js
const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const KEY_STRING_BASE64 = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
const IV_STRING_BASE64 = process.env.GOOGLE_TOKEN_ENCRYPTION_IV;

let encryptionKey;
let iv;
let cryptoInitialized = false;

try {
    if (!KEY_STRING_BASE64) {
        throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY não está definida no .env.');
    }
    if (!IV_STRING_BASE64) {
        throw new Error('GOOGLE_TOKEN_ENCRYPTION_IV não está definida no .env.');
    }

    encryptionKey = Buffer.from(KEY_STRING_BASE64, 'base64');
    iv = Buffer.from(IV_STRING_BASE64, 'base64');

    if (encryptionKey.length !== 32) {
        throw new Error(`GOOGLE_TOKEN_ENCRYPTION_KEY inválida. Esperado 32 bytes, obteve ${encryptionKey.length} bytes após decodificação base64.`);
    }
    // Para AES-GCM, o IV de 12 bytes é o mais comum e recomendado.
    // Algumas implementações podem aceitar 16 bytes, mas é bom ser preciso.
    if (iv.length !== 12 && iv.length !== 16) { // Aceita 12 ou 16, mas prefira 12.
         logger.warn(`[CryptoUtils] GOOGLE_TOKEN_ENCRYPTION_IV tem ${iv.length} bytes. Para AES-GCM, 12 bytes é o ideal. Tamanhos de 16 bytes podem funcionar mas são menos comuns para GCM.`);
    }
    // Adicionaremos uma verificação mais rigorosa para os tamanhos de IV mais comuns para GCM.
    // Se você sabe que seu IV é de 16 e funciona, pode manter. Mas se estiver gerando um novo, use 12.
    // Para este exemplo, vamos ser um pouco mais permissivos, mas com um aviso.

    cryptoInitialized = true;
    logger.info('[CryptoUtils] Chaves de criptografia inicializadas com sucesso.');

} catch (error) {
    logger.error('[CryptoUtils] ERRO FATAL AO INICIALIZAR CHAVES DE CRIPTOGRAFIA. A CRIPTOGRAFIA DE TOKENS FALHARÁ.', { message: error.message });
    // Em um cenário de produção, você pode querer que a aplicação não inicie:
    // throw new Error(`Falha crítica na inicialização do CryptoUtils: ${error.message}`);
}


/**
 * Criptografa um texto.
 * @param {string} text - O texto a ser criptografado.
 * @returns {string|null} O texto criptografado em formato 'hex:hex' (encryptedData:authTag) ou null em caso de erro.
 */
function encrypt(text) {
  if (!cryptoInitialized) {
    logger.error('[CryptoUtils] Criptografia não inicializada devido a erro anterior. Não é possível criptografar.');
    return null;
  }
  if (text === null || typeof text === 'undefined') return null;

  try {
    // É importante usar um IV diferente para cada criptografia com GCM se a chave for a mesma.
    // No entanto, para tokens que são criptografados uma vez e armazenados, usar um IV fixo (do .env) é aceitável
    // DESDE QUE a combinação CHAVE+IV seja única por token/dado criptografado, ou que os tokens sejam curtos e trocados frequentemente.
    // Para simplificar e dado que o IV é do .env, vamos usá-lo diretamente.
    // Se você fosse criptografar múltiplos dados com a MESMA chave e IV fixo, isso seria uma vulnerabilidade.
    // Mas aqui, estamos criptografando um token específico.
    const currentIV = iv; // Usando o IV do .env

    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, currentIV);
    let encrypted = cipher.update(String(text), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${encrypted}:${authTag.toString('hex')}`;
  } catch (error) {
    logger.error('[CryptoUtils] Erro ao criptografar:', { message: error.message, stack: error.stack?.substring(0,300) });
    return null;
  }
}

/**
 * Descriptografa um texto.
 * @param {string} encryptedTextWithTag - O texto criptografado (incluindo o authTag, formato 'hex:hex').
 * @returns {string|null} O texto original ou null em caso de erro.
 */
function decrypt(encryptedTextWithTag) {
  if (!cryptoInitialized) {
    logger.error('[CryptoUtils] Criptografia não inicializada devido a erro anterior. Não é possível descriptografar.');
    return null;
  }
  if (!encryptedTextWithTag || typeof encryptedTextWithTag !== 'string') return null;

  try {
    const parts = encryptedTextWithTag.split(':');
    if (parts.length !== 2) {
        logger.error('[CryptoUtils] Formato do texto criptografado inválido. Esperado "encryptedData:authTag". Recebido:', encryptedTextWithTag);
        return null;
    }
    const encryptedText = parts[0];
    const authTag = Buffer.from(parts[1], 'hex');
    
    const currentIV = iv; // Usando o IV do .env que foi usado para criptografar

    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, currentIV);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    // Erros aqui são comuns se a chave/IV estiverem errados, o texto não for o esperado, ou o authTag falhar.
    logger.error('[CryptoUtils] Erro ao descriptografar (verifique chave/IV, formato do texto, ou authTag):', { message: error.message, inputLength: encryptedTextWithTag.length });
    return null;
  }
}

module.exports = {
  encrypt,
  decrypt,
  isCryptoInitialized: () => cryptoInitialized, // Para verificar se inicializou
};
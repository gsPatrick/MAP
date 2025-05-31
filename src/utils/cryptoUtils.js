// src/utils/cryptoUtils.js
const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm'; // Algoritmo de criptografia robusto
const KEY_STRING_BASE64 = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
const IV_STRING_BASE64 = process.env.GOOGLE_TOKEN_ENCRYPTION_IV;

let encryptionKey;
let iv;

try {
    if (!KEY_STRING_BASE64 || KEY_STRING_BASE64.length < 40) { // 32 bytes em base64 são ~44 chars
        throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY não está definida ou é muito curta. Deve ser uma chave de 32 bytes em base64.');
    }
    if (!IV_STRING_BASE64 || IV_STRING_BASE64.length < 20) { // 16 bytes em base64 são ~24 chars
        throw new Error('GOOGLE_TOKEN_ENCRYPTION_IV não está definido ou é muito curto. Deve ser um IV de 16 bytes em base64.');
    }
    encryptionKey = Buffer.from(KEY_STRING_BASE64, 'base64');
    iv = Buffer.from(IV_STRING_BASE64, 'base64');

    if (encryptionKey.length !== 32) {
        throw new Error(`GOOGLE_TOKEN_ENCRYPTION_KEY inválida. Esperado 32 bytes, obteve ${encryptionKey.length} bytes após decodificação base64.`);
    }
    if (iv.length !== 16) { // AES-256-GCM tipicamente usa IV de 12 bytes, mas 16 é comum para outros AES. Ajustaremos para 12 se necessário.
                            // Para GCM, 12 bytes é o recomendado. Se o IV for 16, pode ser usado, mas crypto.randomBytes(12) é melhor para novos IVs.
                            // Vamos manter 16 por ora, mas se gerar um novo IV, use 12 bytes.
        logger.warn(`[CryptoUtils] GOOGLE_TOKEN_ENCRYPTION_IV tem ${iv.length} bytes. Para AES-GCM, 12 bytes é o recomendado. Certifique-se que o IV é apropriado para o algoritmo.`);
    }

} catch (error) {
    logger.error('[CryptoUtils] Erro fatal ao inicializar chaves de criptografia. Verifique .env GOOGLE_TOKEN_ENCRYPTION_KEY e GOOGLE_TOKEN_ENCRYPTION_IV.', { message: error.message });
    // Em um cenário real, você pode querer que a aplicação não inicie se a criptografia falhar.
    // Por simplicidade aqui, apenas logamos o erro.
    // throw error; // Descomente para travar a inicialização em caso de erro de chave.
}


/**
 * Criptografa um texto.
 * @param {string} text - O texto a ser criptografado.
 * @returns {string|null} O texto criptografado em formato 'hex' ou null em caso de erro.
 */
function encrypt(text) {
  if (!encryptionKey || !iv) {
    logger.error('[CryptoUtils] Chave ou IV de criptografia não inicializados. Não é possível criptografar.');
    return null;
  }
  if (text === null || typeof text === 'undefined') return null;

  try {
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
    let encrypted = cipher.update(String(text), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag(); // Necessário para GCM
    return `${encrypted}:${authTag.toString('hex')}`; // Armazena o authTag junto
  } catch (error) {
    logger.error('[CryptoUtils] Erro ao criptografar:', { message: error.message });
    return null;
  }
}

/**
 * Descriptografa um texto.
 * @param {string} encryptedTextWithTag - O texto criptografado (incluindo o authTag, formato 'hex:hex').
 * @returns {string|null} O texto original ou null em caso de erro.
 */
function decrypt(encryptedTextWithTag) {
  if (!encryptionKey || !iv) {
    logger.error('[CryptoUtils] Chave ou IV de criptografia não inicializados. Não é possível descriptografar.');
    return null;
  }
  if (!encryptedTextWithTag || typeof encryptedTextWithTag !== 'string') return null;

  try {
    const parts = encryptedTextWithTag.split(':');
    if (parts.length !== 2) {
        logger.error('[CryptoUtils] Formato do texto criptografado inválido. Esperado "encrypted:authTag".');
        return null;
    }
    const encryptedText = parts[0];
    const authTag = Buffer.from(parts[1], 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv);
    decipher.setAuthTag(authTag); // Essencial para GCM
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    logger.error('[CryptoUtils] Erro ao descriptografar (pode ser chave/IV incorretos ou texto corrompido):', { message: error.message });
    return null;
  }
}

module.exports = {
  encrypt,
  decrypt,
};
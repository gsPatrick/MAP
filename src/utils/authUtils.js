// src/utils/authUtils.js
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'seuSuperSegredoJWTComplexoAqui!';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';

/**
 * Gera um token JWT.
 * @param {object} payloadData - Objeto com dados para o payload (ex: id, email, role).
 * @param {string} type - Tipo de token ('user_admin' ou 'client').
 * @returns {string} O token JWT gerado.
 */
function generateToken(payloadData, type = 'user_admin') { // Adicionado parâmetro type
  const payload = {
    ...payloadData,
    type: type, // Adiciona o tipo ao payload
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

async function comparePasswords(plainPassword, hashedPassword) {
  return bcrypt.compare(plainPassword, hashedPassword);
}

module.exports = {
  generateToken,
  comparePasswords,
  JWT_SECRET,
};
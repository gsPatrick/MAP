// src/utils/authUtils.js
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'seuSuperSegredoJWTComplexoAqui!'; // Mova para .env em produção!
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d'; // Token expira em 1 dia

/**
 * Gera um token JWT para um usuário.
 * @param {object} user - Objeto do usuário (geralmente { id, email, role }).
 * @returns {string} O token JWT gerado.
 */
function generateToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role, // Inclui o role no payload para fácil verificação de autorização
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Compara uma senha fornecida com um hash armazenado.
 * @param {string} plainPassword - A senha em texto plano.
 * @param {string} hashedPassword - A senha hasheada do banco de dados.
 * @returns {Promise<boolean>} True se as senhas corresponderem.
 */
async function comparePasswords(plainPassword, hashedPassword) {
  return bcrypt.compare(plainPassword, hashedPassword);
}

module.exports = {
  generateToken,
  comparePasswords, // Embora o modelo User possa ter seu próprio método, pode ser útil aqui
  JWT_SECRET, // Exportado para o middleware de autenticação
};
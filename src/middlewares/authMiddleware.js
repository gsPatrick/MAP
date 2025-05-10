// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const { User } = require('../database');
const { JWT_SECRET } = require('../utils/authUtils');
const logger = require('../utils/logger');

/**
 * Middleware para autenticar o token JWT.
 * Adiciona req.user com os dados do usuário autenticado se o token for válido.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato "Bearer TOKEN"

  if (!token) {
    logger.warn('[AUTH] Token não fornecido.');
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Opcional: Verificar se o usuário ainda existe e está ativo no banco
    const user = await User.findByPk(decoded.id, { attributes: ['id', 'email', 'name', 'role', 'isActive'] });
    if (!user) {
      logger.warn(`[AUTH] Usuário do token (ID: ${decoded.id}) não encontrado.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Usuário inválido.' });
    }
    if (!user.isActive) {
      logger.warn(`[AUTH] Usuário do token (ID: ${decoded.id}) está inativo.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Usuário inativo.' });
    }

    req.user = user.toJSON(); // Adiciona o objeto do usuário (sem a senha) à requisição
    next();
  } catch (error) {
    logger.error('[AUTH] Erro na verificação do token:', { message: error.message });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'fail', message: 'Token expirado.' });
    }
    return res.status(403).json({ status: 'fail', message: 'Token inválido ou acesso proibido.' }); // Forbidden
  }
}

/**
 * Middleware para autorizar com base no role do usuário.
 * @param {Array<string>} allowedRoles - Array de roles permitidos para acessar a rota.
 */
function authorizeRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      logger.warn('[AUTH] Tentativa de autorização sem req.user ou req.user.role.');
      return res.status(403).json({ status: 'fail', message: 'Acesso proibido. Role não definido.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      logger.warn(`[AUTH] Usuário ${req.user.email} (Role: ${req.user.role}) tentou acessar rota restrita para roles: ${allowedRoles.join(', ')}`);
      return res.status(403).json({ status: 'fail', message: 'Acesso proibido. Permissões insuficientes.' });
    }
    next();
  };
}

module.exports = {
  authenticateToken,
  authorizeRole,
};
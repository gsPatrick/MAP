// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const { User, Client } = require('../database'); // <<< Adicionar Client aqui
const { JWT_SECRET } = require('../utils/authUtils');
const logger = require('../utils/logger');
const subscriptionService = require('../features/Subscription/subscription.service'); // <<< NOVO IMPORT

/**
 * Middleware para autenticar o token JWT de User (Admin).
 * Adiciona req.user com os dados do usuário autenticado se o token for válido.
 */
async function authenticateToken(req, res, next) { // Renomeado para authenticateAdminToken para clareza, ou manter e verificar 'type' no token
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    logger.warn('[AUTH ADMIN] Token não fornecido.');
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Assegurar que é um token de User admin
    if (decoded.type && decoded.type !== 'user_admin') { // Adicionar 'type' ao gerar token de admin
        logger.warn(`[AUTH ADMIN] Tentativa de usar token de tipo '${decoded.type}' em rota de admin.`);
        return res.status(403).json({ status: 'fail', message: 'Token inválido para esta operação.' });
    }


    const user = await User.findByPk(decoded.id, { attributes: ['id', 'email', 'name', 'role', 'isActive'] });
    if (!user) {
      logger.warn(`[AUTH ADMIN] Usuário admin do token (ID: ${decoded.id}) não encontrado.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Usuário inválido.' });
    }
    if (!user.isActive) {
      logger.warn(`[AUTH ADMIN] Usuário admin do token (ID: ${decoded.id}) está inativo.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Usuário inativo.' });
    }

    req.user = user.toJSON();
    next();
  } catch (error) {
    logger.error('[AUTH ADMIN] Erro na verificação do token de admin:', { message: error.message });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'fail', message: 'Token expirado.' });
    }
    return res.status(403).json({ status: 'fail', message: 'Token inválido ou acesso proibido.' });
  }
}

/**
 * Middleware para autenticar o token JWT de Client (Usuário Final).
 * Adiciona req.client com os dados do cliente autenticado se o token for válido.
 * Também verifica se o cliente tem uma assinatura ativa.
 */
async function authenticateClientToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato "Bearer TOKEN"

  if (!token) {
    logger.warn('[AUTH CLIENT] Token não fornecido para rota de cliente.');
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Assegurar que é um token de Client
    if (!decoded.type || decoded.type !== 'client') {
        logger.warn(`[AUTH CLIENT] Tentativa de usar token de tipo '${decoded.type || 'desconhecido'}' em rota de cliente.`);
        return res.status(403).json({ status: 'fail', message: 'Token inválido para acesso de cliente.' });
    }

    const client = await Client.findByPk(decoded.id, { attributes: ['id', 'phone', 'email', 'name', 'status'] });
    if (!client) {
      logger.warn(`[AUTH CLIENT] Cliente do token (ID: ${decoded.id}) não encontrado.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Cliente inválido.' });
    }
    if (client.status === 'Bloqueado' || client.status === 'Inativo') {
      logger.warn(`[AUTH CLIENT] Cliente do token (ID: ${decoded.id}) está ${client.status}.`);
      return res.status(403).json({ status: 'fail', message: `Acesso proibido. Status do cliente: ${client.status}.` });
    }

    // VERIFICAR ASSINATURA ATIVA
    const activeSubscription = await subscriptionService.getActiveSubscription(client.id);
    if (!activeSubscription) {
        logger.warn(`[AUTH CLIENT] Cliente ID ${client.id} (${client.phone}) não possui assinatura ativa. Acesso negado à rota protegida.`);
        // Personalizar mensagem e status code se necessário
        return res.status(403).json({
            status: 'fail_subscription',
            message: 'Acesso negado. Nenhuma assinatura ativa encontrada. Por favor, renove ou adquira um plano.',
            // Poderia adicionar um código específico para o frontend tratar o redirecionamento para planos
            // action_code: 'REDIRECT_TO_PLANS'
        });
    }

    req.client = client.toJSON(); // Adiciona o objeto do cliente à requisição
    req.client.subscription = activeSubscription; // Adiciona detalhes da assinatura ativa
    next();
  } catch (error) {
    logger.error('[AUTH CLIENT] Erro na verificação do token de cliente:', { message: error.message });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'fail', message: 'Token expirado. Faça login novamente.' });
    }
    return res.status(403).json({ status: 'fail', message: 'Token inválido ou acesso proibido.' });
  }
}


/**
 * Middleware para autorizar com base no role do usuário ADMIN.
 * @param {Array<string>} allowedRoles - Array de roles permitidos para acessar a rota.
 */
function authorizeRole(allowedRoles) { // Este é para User (admin)
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      logger.warn('[AUTH ROLE] Tentativa de autorização de role sem req.user ou req.user.role.');
      return res.status(403).json({ status: 'fail', message: 'Acesso proibido. Role não definido.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      logger.warn(`[AUTH ROLE] Usuário admin ${req.user.email} (Role: ${req.user.role}) tentou acessar rota restrita para roles: ${allowedRoles.join(', ')}`);
      return res.status(403).json({ status: 'fail', message: 'Acesso proibido. Permissões insuficientes.' });
    }
    next();
  };
}

// Seria bom modificar o `generateToken` para incluir um campo 'type': 'user_admin' ou 'client'
// Para isso, precisaríamos modificar `src/utils/authUtils.js`
// e passar o tipo ao gerar o token.

module.exports = {
  authenticateToken, // Para Admins (talvez renomear para authenticateAdminToken)
  authenticateClientToken, // <<< NOVO MIDDLEWARE
  authorizeRole, // Para Admins
};
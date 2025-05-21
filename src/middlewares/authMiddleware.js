// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const { User, Client } = require('../database');
const { JWT_SECRET } = require('../utils/authUtils');
const logger = require('../utils/logger');
// const subscriptionService = require('../features/Subscription/subscription.service'); // Podemos remover se a verificação for só no Client

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    logger.warn('[AUTH ADMIN] Token não fornecido.');
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type && decoded.type !== 'user_admin') {
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

async function authenticateClientToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    logger.warn('[AUTH CLIENT] Token não fornecido para rota de cliente.');
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.type || decoded.type !== 'client') {
        logger.warn(`[AUTH CLIENT] Tentativa de usar token de tipo '${decoded.type || 'desconhecido'}' em rota de cliente.`);
        return res.status(403).json({ status: 'fail', message: 'Token inválido para acesso de cliente.' });
    }

    // Buscamos o cliente COM accessLevel e accessExpiresAt
    const client = await Client.findByPk(decoded.id, { 
        attributes: ['id', 'phone', 'email', 'name', 'status', 'accessLevel', 'accessExpiresAt'] 
    });

    if (!client) {
      logger.warn(`[AUTH CLIENT] Cliente do token (ID: ${decoded.id}) não encontrado.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Cliente inválido.' });
    }
    if (client.status === 'Bloqueado' || client.status === 'Inativo') {
      logger.warn(`[AUTH CLIENT] Cliente do token (ID: ${decoded.id}) está ${client.status}.`);
      return res.status(403).json({ status: 'fail', message: `Acesso proibido. Status do cliente: ${client.status}.` });
    }

    // VERIFICAR PLANO ATIVO DIRETAMENTE PELOS CAMPOS DO CLIENTE
    let hasActivePaidAccess = false;
    if (client.accessLevel && client.accessLevel !== 'gratuito') {
        if (client.accessLevel.startsWith('vitalicio_')) {
            hasActivePaidAccess = true;
        } else if (client.accessExpiresAt) { // Para planos não vitalícios, precisa de data de expiração
            const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z'); // Trata como UTC
            const today = new Date();
            today.setUTCHours(0,0,0,0); // Zera hora para comparar só data

            if (expiryDate >= today) {
                hasActivePaidAccess = true;
            }
        }
    }
    
    if (!hasActivePaidAccess && client.status !== 'Aguardando Pagamento') {
        logger.warn(`[AUTH CLIENT] Cliente ID ${client.id} (${client.phone}) não possui plano ativo/válido. AccessLevel: ${client.accessLevel}, ExpiresAt: ${client.accessExpiresAt}. Acesso negado à rota protegida.`);
        return res.status(403).json({
            status: 'fail_subscription',
            message: 'Acesso negado. Nenhuma assinatura ativa encontrada ou sua assinatura expirou. Por favor, renove ou adquira um plano.',
        });
    }

    req.client = client.toJSON();
    // req.client.subscription = activeSubscription; // Não precisamos mais popular isso aqui se verificamos pelo client
    next();
  } catch (error) {
    logger.error('[AUTH CLIENT] Erro na verificação do token de cliente:', { message: error.message });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'fail', message: 'Token expirado. Faça login novamente.' });
    }
    return res.status(403).json({ status: 'fail', message: 'Token inválido ou acesso proibido.' });
  }
}

function authorizeRole(allowedRoles) {
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

module.exports = {
  authenticateToken,
  authenticateClientToken,
  authorizeRole,
};
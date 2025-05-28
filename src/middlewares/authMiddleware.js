// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const { User, Client, FinancialAccount, SharedAccess } = require('../database');
const { JWT_SECRET } = require('../utils/authUtils');
const logger = require('../utils/logger');

// ... (authenticateToken e authorizeRole como antes) ...
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

  logger.debug('[AUTH CLIENT MIDDLEWARE] Iniciando autenticação de token de cliente.'); // Log inicial

  if (!token) {
    logger.warn('[AUTH CLIENT MIDDLEWARE] Token não fornecido.');
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    logger.debug('[AUTH CLIENT MIDDLEWARE] Token decodificado:', decoded); // Log do token decodificado

    if (decoded.type === 'client') {
        logger.debug(`[AUTH CLIENT MIDDLEWARE] Tipo 'client'. Buscando Client ID: ${decoded.id}`);
        const client = await Client.findByPk(decoded.id, {
            attributes: ['id', 'phone', 'email', 'name', 'status', 'accessLevel', 'accessExpiresAt']
        });

        if (!client) {
            logger.warn(`[AUTH CLIENT MIDDLEWARE] Cliente do token (ID: ${decoded.id}) NÃO ENCONTRADO no banco.`);
            return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Cliente inválido.' });
        }
        logger.debug('[AUTH CLIENT MIDDLEWARE] Cliente encontrado:', client.toJSON());

        if (client.status === 'Bloqueado' || client.status === 'Inativo') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE] Cliente (ID: ${decoded.id}) está ${client.status}.`);
            return res.status(403).json({ status: 'fail', message: `Acesso proibido. Status do cliente: ${client.status}.` });
        }
        
        let hasActivePaidAccess = false;
        if (client.accessLevel && client.accessLevel !== 'gratuito') {
            if (client.accessLevel.startsWith('vitalicio_')) hasActivePaidAccess = true;
            else if (client.accessExpiresAt) {
                const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0,0,0,0);
                if (expiryDate >= today) hasActivePaidAccess = true;
            }
        }
        if (!hasActivePaidAccess && client.status !== 'Aguardando Pagamento') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE] Cliente ID ${client.id} não possui plano ativo. AccessLevel: ${client.accessLevel}, ExpiresAt: ${client.accessExpiresAt}.`);
            return res.status(403).json({ status: 'fail_subscription', message: 'Acesso negado. Nenhuma assinatura ativa encontrada ou sua assinatura expirou.' });
        }
        req.client = client.toJSON();
        req.sharedAccessContext = null;
        logger.debug('[AUTH CLIENT MIDDLEWARE] req.client populado para login direto:', req.client);

    } else if (decoded.type === 'client_shared_access') {
        logger.debug(`[AUTH CLIENT MIDDLEWARE] Tipo 'client_shared_access'. Buscando SharedWithClient ID: ${decoded.id} e OwnerClient ID: ${decoded.ownerClientId}`);
        const sharedWithClient = await Client.findByPk(decoded.id, {
            attributes: ['id', 'phone', 'email', 'name', 'status']
        });

        if (!sharedWithClient) {
             logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Usuário compartilhado (ID: ${decoded.id}) do token NÃO ENCONTRADO.`);
             return res.status(401).json({ status: 'fail', message: 'Acesso compartilhado inválido (usuário).' });
        }
        logger.debug('[AUTH CLIENT MIDDLEWARE - SHARED] Usuário compartilhado encontrado:', sharedWithClient.toJSON());

        if (sharedWithClient.status === 'Bloqueado' || sharedWithClient.status === 'Inativo') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Usuário compartilhado (ID: ${decoded.id}) está ${sharedWithClient.status}.`);
            return res.status(403).json({ status: 'fail', message: 'Acesso compartilhado inválido (status do usuário).' });
        }

        const ownerClient = await Client.findByPk(decoded.ownerClientId, {
            attributes: ['id', 'phone', 'email', 'name', 'status', 'accessLevel', 'accessExpiresAt']
        });
        if (!ownerClient) {
            logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Dono da conta (ID: ${decoded.ownerClientId}) NÃO ENCONTRADO.`);
            return res.status(403).json({ status: 'fail', message: 'Conta do proprietário indisponível para acesso compartilhado.' });
        }
        logger.debug('[AUTH CLIENT MIDDLEWARE - SHARED] Dono da conta encontrado:', ownerClient.toJSON());

        if (ownerClient.status === 'Bloqueado' || ownerClient.status === 'Inativo') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Dono da conta (ID: ${decoded.ownerClientId}) está ${ownerClient.status}.`);
            return res.status(403).json({ status: 'fail', message: 'Conta do proprietário indisponível.' });
        }

        let ownerHasActivePaidAccess = false;
        if (ownerClient.accessLevel && ownerClient.accessLevel !== 'gratuito') {
            if (ownerClient.accessLevel.startsWith('vitalicio_')) ownerHasActivePaidAccess = true;
            else if (ownerClient.accessExpiresAt) {
                const expiryDate = new Date(ownerClient.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0,0,0,0);
                if (expiryDate >= today) ownerHasActivePaidAccess = true;
            }
        }
        if (!ownerHasActivePaidAccess && ownerClient.status !== 'Aguardando Pagamento') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Dono da conta (ID: ${ownerClient.id}) não possui plano ativo. AccessLevel: ${ownerClient.accessLevel}, ExpiresAt: ${ownerClient.accessExpiresAt}.`);
            return res.status(403).json({ status: 'fail_subscription', message: 'Acesso negado. A conta do proprietário não possui uma assinatura ativa.' });
        }

        req.client = sharedWithClient.toJSON();
        req.sharedAccessContext = {
            ownerClientId: ownerClient.id,
            ownerClientName: ownerClient.name,
            ownerClientAccessLevel: ownerClient.accessLevel,
            canAccessPersonalProfile: decoded.canAccessPersonalProfile,
            canAccessBusinessProfileId: decoded.canAccessBusinessProfileId
        };
        logger.debug('[AUTH CLIENT MIDDLEWARE - SHARED] req.client e req.sharedAccessContext populados:', {client: req.client, context: req.sharedAccessContext });
    } else {
        logger.warn(`[AUTH CLIENT MIDDLEWARE] Tipo de token desconhecido ou inválido: '${decoded.type || 'desconhecido'}'`);
        return res.status(403).json({ status: 'fail', message: 'Tipo de token inválido para esta operação.' });
    }

    next();
  } catch (error) {
    logger.error('[AUTH CLIENT MIDDLEWARE] Erro na verificação do token:', { message: error.message, tokenProvided: !!token });
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
// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const { User, Client, FinancialAccount, SharedAccess } = require('../database'); // FinancialAccount e SharedAccess podem não ser usados diretamente aqui, mas bom ter se precisar no futuro
const { JWT_SECRET } = require('../utils/authUtils');
const logger = require('../utils/logger');

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    logger.warn('[AUTH ADMIN MIDDLEWARE] Token não fornecido.');
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type && decoded.type !== 'user_admin') {
        logger.warn(`[AUTH ADMIN MIDDLEWARE] Tentativa de usar token de tipo '${decoded.type}' em rota de admin.`);
        return res.status(403).json({ status: 'fail', message: 'Token inválido para esta operação.' });
    }

    const user = await User.findByPk(decoded.id, { attributes: ['id', 'email', 'name', 'role', 'isActive'] });
    if (!user) {
      logger.warn(`[AUTH ADMIN MIDDLEWARE] Usuário admin do token (ID: ${decoded.id}) não encontrado.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Usuário inválido.' });
    }
    if (!user.isActive) {
      logger.warn(`[AUTH ADMIN MIDDLEWARE] Usuário admin do token (ID: ${decoded.id}) está inativo.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Usuário inativo.' });
    }

    req.user = user.toJSON(); // Usar toJSON() é uma boa prática
    next();
  } catch (error) {
    logger.error('[AUTH ADMIN MIDDLEWARE] Erro na verificação do token de admin:', { message: error.message });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'fail', message: 'Token expirado.' });
    }
    return res.status(403).json({ status: 'fail', message: 'Token inválido ou acesso proibido.' });
  }
}

async function authenticateClientToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  logger.debug(`[AUTH CLIENT MIDDLEWARE] ROTA: ${req.originalUrl} - Iniciando autenticação.`);

  if (!token) {
    logger.warn('[AUTH CLIENT MIDDLEWARE] Token não fornecido.');
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    logger.debug('[AUTH CLIENT MIDDLEWARE] Token decodificado:', decoded);

    let clientInstance; // Variável para a instância do Sequelize

    if (decoded.type === 'client') {
        logger.debug(`[AUTH CLIENT MIDDLEWARE] Tipo 'client'. Buscando Client ID: ${decoded.id}`);
        clientInstance = await Client.findByPk(decoded.id, {
            attributes: ['id', 'phone', 'email', 'name', 'status', 'accessLevel', 'accessExpiresAt']
        });

        if (!clientInstance) {
            logger.warn(`[AUTH CLIENT MIDDLEWARE] Cliente do token (ID: ${decoded.id}) NÃO ENCONTRADO no banco.`);
            return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Cliente inválido.' });
        }
        logger.debug('[AUTH CLIENT MIDDLEWARE] Instância Client encontrada:', clientInstance.get({ plain: true }));

        if (clientInstance.status === 'Bloqueado' || clientInstance.status === 'Inativo') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE] Cliente (ID: ${decoded.id}) está ${clientInstance.status}.`);
            return res.status(403).json({ status: 'fail', message: `Acesso proibido. Status do cliente: ${clientInstance.status}.` });
        }
        
        let hasActivePaidAccess = false;
        if (clientInstance.accessLevel && clientInstance.accessLevel !== 'gratuito') {
            if (clientInstance.accessLevel.startsWith('vitalicio_')) hasActivePaidAccess = true;
            else if (clientInstance.accessExpiresAt) {
                const expiryDate = new Date(clientInstance.accessExpiresAt + 'T00:00:00Z'); // Trata como UTC
                const today = new Date(); today.setUTCHours(0,0,0,0); // Zera para comparar só data
                if (expiryDate >= today) hasActivePaidAccess = true;
            }
        }
        if (!hasActivePaidAccess && clientInstance.status !== 'Aguardando Pagamento') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE] Cliente ID ${clientInstance.id} não possui plano ativo/válido. AccessLevel: ${clientInstance.accessLevel}, ExpiresAt: ${clientInstance.accessExpiresAt}. Acesso negado.`);
            return res.status(403).json({ status: 'fail_subscription', message: 'Acesso negado. Nenhuma assinatura ativa encontrada ou sua assinatura expirou.' });
        }
        req.client = clientInstance.get({ plain: true }); // Converte para plain object
        req.sharedAccessContext = null;
        logger.info(`[AUTH CLIENT MIDDLEWARE] req.client populado para login direto. ID: ${req.client.id}`);
        logger.debug('[AUTH CLIENT MIDDLEWARE] Objeto req.client (direto):', req.client);

    } else if (decoded.type === 'client_shared_access') {
        logger.debug(`[AUTH CLIENT MIDDLEWARE] Tipo 'client_shared_access'. Buscando SharedWithClient ID: ${decoded.id} e OwnerClient ID: ${decoded.ownerClientId}`);
        const sharedWithClientInstance = await Client.findByPk(decoded.id, { // ID do usuário que recebeu o acesso
            attributes: ['id', 'phone', 'email', 'name', 'status']
        });

        if (!sharedWithClientInstance) {
             logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Usuário compartilhado (ID: ${decoded.id}) do token NÃO ENCONTRADO.`);
             return res.status(401).json({ status: 'fail', message: 'Acesso compartilhado inválido (usuário).' });
        }
        logger.debug('[AUTH CLIENT MIDDLEWARE - SHARED] Usuário compartilhado encontrado:', sharedWithClientInstance.get({ plain: true }));

        if (sharedWithClientInstance.status === 'Bloqueado' || sharedWithClientInstance.status === 'Inativo') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Usuário compartilhado (ID: ${decoded.id}) está ${sharedWithClientInstance.status}.`);
            return res.status(403).json({ status: 'fail', message: 'Acesso compartilhado inválido (status do usuário).' });
        }

        const ownerClientInstance = await Client.findByPk(decoded.ownerClientId, {
            attributes: ['id', 'phone', 'email', 'name', 'status', 'accessLevel', 'accessExpiresAt']
        });
        if (!ownerClientInstance) {
            logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Dono da conta (ID: ${decoded.ownerClientId}) NÃO ENCONTRADO.`);
            return res.status(403).json({ status: 'fail', message: 'Conta do proprietário indisponível para acesso compartilhado.' });
        }
        logger.debug('[AUTH CLIENT MIDDLEWARE - SHARED] Dono da conta encontrado:', ownerClientInstance.get({ plain: true }));

        if (ownerClientInstance.status === 'Bloqueado' || ownerClientInstance.status === 'Inativo') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Dono da conta (ID: ${decoded.ownerClientId}) está ${ownerClientInstance.status}.`);
            return res.status(403).json({ status: 'fail', message: 'Conta do proprietário indisponível.' });
        }

        let ownerHasActivePaidAccess = false;
        if (ownerClientInstance.accessLevel && ownerClientInstance.accessLevel !== 'gratuito') {
            if (ownerClientInstance.accessLevel.startsWith('vitalicio_')) ownerHasActivePaidAccess = true;
            else if (ownerClientInstance.accessExpiresAt) {
                const expiryDate = new Date(ownerClientInstance.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0,0,0,0);
                if (expiryDate >= today) ownerHasActivePaidAccess = true;
            }
        }
        if (!ownerHasActivePaidAccess && ownerClientInstance.status !== 'Aguardando Pagamento') {
            logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Dono da conta (ID: ${ownerClientInstance.id}) não possui plano ativo. AccessLevel: ${ownerClientInstance.accessLevel}, ExpiresAt: ${ownerClientInstance.accessExpiresAt}.`);
            return res.status(403).json({ status: 'fail_subscription', message: 'Acesso negado. A conta do proprietário não possui uma assinatura ativa.' });
        }

        req.client = sharedWithClientInstance.get({ plain: true }); // O "usuário logado" é quem recebeu o share
        req.sharedAccessContext = {
            ownerClientId: ownerClientInstance.id,
            ownerClientName: ownerClientInstance.name,
            ownerClientAccessLevel: ownerClientInstance.accessLevel,
            canAccessPersonalProfile: decoded.canAccessPersonalProfile,
            canAccessBusinessProfileId: decoded.canAccessBusinessProfileId
        };
        logger.info(`[AUTH CLIENT MIDDLEWARE - SHARED] req.client (sharedWith) populado. ID: ${req.client.id}`);
        logger.debug('[AUTH CLIENT MIDDLEWARE - SHARED] Objeto req.client (sharedWith):', req.client);
        logger.debug('[AUTH CLIENT MIDDLEWARE - SHARED] Objeto req.sharedAccessContext:', req.sharedAccessContext);
    } else {
        logger.warn(`[AUTH CLIENT MIDDLEWARE] Tipo de token desconhecido ou inválido: '${decoded.type || 'desconhecido'}'`);
        return res.status(403).json({ status: 'fail', message: 'Tipo de token inválido para esta operação.' });
    }

    logger.debug('[AUTH CLIENT MIDDLEWARE] Passando para o próximo handler. req.client.id é:', req.client ? req.client.id : 'UNDEFINED');
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
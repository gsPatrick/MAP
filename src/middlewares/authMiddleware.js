// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const { User, Client, FinancialAccount, SharedAccess } = require('../database'); // Adicionado SharedAccess e FinancialAccount
const { JWT_SECRET } = require('../utils/authUtils');
const logger = require('../utils/logger');

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

    if (decoded.type === 'client') {
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
        // Verificação de plano ativo
        let hasActivePaidAccess = false;
        if (client.accessLevel && client.accessLevel !== 'gratuito') {
            if (client.accessLevel.startsWith('vitalicio_')) {
                hasActivePaidAccess = true;
            } else if (client.accessExpiresAt) {
                const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0,0,0,0);
                if (expiryDate >= today) hasActivePaidAccess = true;
            }
        }
        if (!hasActivePaidAccess && client.status !== 'Aguardando Pagamento') {
            logger.warn(`[AUTH CLIENT] Cliente ID ${client.id} (${client.phone}) não possui plano ativo/válido. AccessLevel: ${client.accessLevel}, ExpiresAt: ${client.accessExpiresAt}. Acesso negado.`);
            return res.status(403).json({ status: 'fail_subscription', message: 'Acesso negado. Nenhuma assinatura ativa encontrada ou sua assinatura expirou.' });
        }
        req.client = client.toJSON(); // Cliente logado diretamente
        req.sharedAccessContext = null; // Não é um acesso compartilhado

    } else if (decoded.type === 'client_shared_access') {
        const sharedWithClient = await Client.findByPk(decoded.id, { // ID do usuário que recebeu o acesso
            attributes: ['id', 'phone', 'email', 'name', 'status']
        });
        if (!sharedWithClient || sharedWithClient.status === 'Bloqueado' || sharedWithClient.status === 'Inativo') {
            logger.warn(`[AUTH CLIENT SHARED] Usuário compartilhado do token (ID: ${decoded.id}) não encontrado ou inativo.`);
            return res.status(401).json({ status: 'fail', message: 'Acesso compartilhado inválido (usuário).' });
        }

        // Buscar dados do DONO da conta para verificar o plano
        const ownerClient = await Client.findByPk(decoded.ownerClientId, {
            attributes: ['id', 'phone', 'email', 'name', 'status', 'accessLevel', 'accessExpiresAt']
        });
        if (!ownerClient || ownerClient.status === 'Bloqueado' || ownerClient.status === 'Inativo') {
            logger.warn(`[AUTH CLIENT SHARED] Dono da conta (ID: ${decoded.ownerClientId}) do acesso compartilhado não encontrado ou inativo.`);
            return res.status(403).json({ status: 'fail', message: 'Conta do proprietário indisponível.' });
        }

        // Verificar plano do DONO
        let ownerHasActivePaidAccess = false;
        if (ownerClient.accessLevel && ownerClient.accessLevel !== 'gratuito') {
            if (ownerClient.accessLevel.startsWith('vitalicio_')) {
                ownerHasActivePaidAccess = true;
            } else if (ownerClient.accessExpiresAt) {
                const expiryDate = new Date(ownerClient.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0,0,0,0);
                if (expiryDate >= today) ownerHasActivePaidAccess = true;
            }
        }
        if (!ownerHasActivePaidAccess && ownerClient.status !== 'Aguardando Pagamento') {
            logger.warn(`[AUTH CLIENT SHARED] Dono da conta (ID: ${ownerClient.id}) não possui plano ativo/válido. Acesso compartilhado negado.`);
            return res.status(403).json({ status: 'fail_subscription', message: 'Acesso negado. A conta do proprietário não possui uma assinatura ativa.' });
        }

        req.client = sharedWithClient.toJSON(); // O "usuário logado" é quem recebeu o share
        req.sharedAccessContext = { // Contexto do compartilhamento
            ownerClientId: ownerClient.id,
            ownerClientName: ownerClient.name,
            ownerClientAccessLevel: ownerClient.accessLevel, // Para UI, se necessário
            canAccessPersonalProfile: decoded.canAccessPersonalProfile,
            canAccessBusinessProfileId: decoded.canAccessBusinessProfileId
        };
    } else {
        logger.warn(`[AUTH CLIENT] Tipo de token desconhecido ou inválido: '${decoded.type || 'desconhecido'}'`);
        return res.status(403).json({ status: 'fail', message: 'Tipo de token inválido para esta operação.' });
    }

    next();
  } catch (error) {
    logger.error('[AUTH CLIENT] Erro na verificação do token de cliente/compartilhado:', { message: error.message });
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
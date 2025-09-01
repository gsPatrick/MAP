// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const { User, Client, FinancialAccount, SharedAccess } = require('../database');
const { JWT_SECRET } = require('../utils/authUtils');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

// =========================================================================
// Middleware para Administradores (Inalterado)
// =========================================================================
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
      logger.warn(`[AUTH ADMIN] Usuário admin (ID: ${decoded.id}) não encontrado.`);
      return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Usuário inválido.' });
    }
    if (!user.isActive) {
      logger.warn(`[AUTH ADMIN] Usuário admin (ID: ${decoded.id}) está inativo.`);
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

// =========================================================================
// NÍVEL 1: Middleware de AUTENTICAÇÃO para Clientes (Refatorado)
// Responsabilidade: Apenas validar o token e identificar quem é o usuário.
// =========================================================================
async function authenticateClientToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.type === 'client') {
        const clientInstance = await Client.findByPk(decoded.id, {
            attributes: ['id', 'phone', 'email', 'name', 'status', 'accessLevel', 'accessExpiresAt']
        });

        if (!clientInstance) {
            return res.status(401).json({ status: 'fail', message: 'Acesso não autorizado. Cliente inválido.' });
        }
        if (clientInstance.status === 'Bloqueado' || clientInstance.status === 'Inativo') {
            return res.status(403).json({ status: 'fail', message: `Acesso proibido. Status do cliente: ${clientInstance.status}.` });
        }
        
        req.client = clientInstance.toJSON();
        req.sharedAccessContext = null;

    } else if (decoded.type === 'client_shared_access') {
        const sharedWithClientInstance = await Client.findByPk(decoded.id);
        if (!sharedWithClientInstance || sharedWithClientInstance.status !== 'Ativo') {
             return res.status(401).json({ status: 'fail', message: 'Acesso compartilhado inválido (usuário inativo ou não encontrado).' });
        }

        req.client = sharedWithClientInstance.toJSON();
        req.sharedAccessContext = {
            ownerClientId: decoded.ownerClientId,
            canAccessPersonalProfile: decoded.canAccessPersonalProfile,
            canAccessBusinessProfileId: decoded.canAccessBusinessProfileId
        };
    } else {
        return res.status(403).json({ status: 'fail', message: 'Tipo de token inválido para esta operação.' });
    }
    
    next(); // Autenticação concluída com sucesso

  } catch (error) {
    logger.error('[AUTH CLIENT] Erro na verificação do token:', { message: error.message });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'fail', message: 'Token expirado. Faça login novamente.' });
    }
    return res.status(403).json({ status: 'fail', message: 'Token inválido ou acesso proibido.' });
  }
}

// =========================================================================
// NÍVEL 2: Middleware de AUTORIZAÇÃO PREMIUM (Novo)
// Responsabilidade: Apenas verificar se o cliente (ou o dono da conta) tem um plano ativo.
// DEVE ser usado DEPOIS de `authenticateClientToken`.
// =========================================================================
async function requireActiveSubscription(req, res, next) {
    if (!req.client) {
        logger.error('[AUTH SUB] Middleware `requireActiveSubscription` chamado sem `req.client`. Verifique a ordem dos middlewares.');
        return res.status(500).json({ status: 'error', message: 'Erro interno de configuração de autenticação.' });
    }

    let clientToCheck;

    // Se for um acesso compartilhado, precisamos verificar a assinatura do DONO da conta.
    if (req.sharedAccessContext) {
        clientToCheck = await Client.findByPk(req.sharedAccessContext.ownerClientId);
        if (!clientToCheck) {
             return res.status(403).json({ status: 'fail', message: 'A conta do proprietário não está mais disponível.' });
        }
    } else {
        // Se for um acesso normal, verificamos a assinatura do próprio cliente logado.
        clientToCheck = req.client;
    }

    let hasActivePaidAccess = false;
    if (clientToCheck.accessLevel && clientToCheck.accessLevel !== 'gratuito') {
        if (clientToCheck.accessLevel.startsWith('vitalicio_')) {
            hasActivePaidAccess = true;
        } else if (clientToCheck.accessExpiresAt) {
            const expiryDate = new Date(clientToCheck.accessExpiresAt + 'T23:59:59Z'); // Considera até o fim do dia
            if (expiryDate >= new Date()) {
                hasActivePaidAccess = true;
            }
        }
    }
    
    if (clientToCheck.status === 'Aguardando Pagamento') {
         hasActivePaidAccess = true; // Permite acesso durante o primeiro fluxo de pagamento
    }

    if (!hasActivePaidAccess) {
        logger.warn(`[AUTH SUB] Cliente ID ${clientToCheck.id} não possui plano ativo para a rota ${req.originalUrl}.`);
        return res.status(403).json({ 
            status: 'fail_subscription', 
            message: 'Acesso negado. Nenhuma assinatura ativa encontrada ou sua assinatura expirou.' 
        });
    }

    next(); // Autorização de assinatura bem-sucedida
}


// =========================================================================
// Middlewares Auxiliares (Inalterados)
// =========================================================================

function authorizeRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ status: 'fail', message: 'Acesso proibido. Role não definido.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ status: 'fail', message: 'Acesso proibido. Permissões insuficientes.' });
    }
    next();
  };
}

async function checkFinancialAccountOwnership(req, res, next) {
    try {
        const financialAccountIdFromParams = parseInt(req.params.financialAccountId, 10);
        if (isNaN(financialAccountIdFromParams)) {
            return res.status(400).json({ status: 'fail', message: 'ID da Conta Financeira inválido na rota.' });
        }

        const ownerId = req.sharedAccessContext ? req.sharedAccessContext.ownerClientId : req.client.id;
        
        const financialAccount = await FinancialAccount.findOne({
            where: { id: financialAccountIdFromParams, clientId: ownerId }
        });

        if (!financialAccount) {
            return res.status(403).json({ status: 'fail', message: 'Acesso negado a esta conta financeira.' });
        }
        
        if (!financialAccount.isActive) {
            return res.status(403).json({ status: 'fail', message: 'Esta conta financeira está inativa.' });
        }

        // Adicional: Validação para acesso compartilhado, garantindo que o perfil específico é permitido
        if (req.sharedAccessContext) {
            const { canAccessPersonalProfile, canAccessBusinessProfileId } = req.sharedAccessContext;
            const isPF = financialAccount.accountType === 'PF';
            const isPJ_MEI = ['PJ', 'MEI'].includes(financialAccount.accountType);

            if ((isPF && !canAccessPersonalProfile) || (isPJ_MEI && canAccessBusinessProfileId !== financialAccount.id)) {
                return res.status(403).json({ status: 'fail', message: 'Acesso compartilhado negado para este perfil financeiro específico.' });
            }
        }
        
        req.financialAccount = financialAccount.toJSON();
        next();
    } catch (error) {
        logger.error('[AUTH OWNERSHIP] Erro ao verificar propriedade da conta:', { message: error.message });
        return res.status(500).json({ status: 'error', message: 'Erro ao verificar permissões da conta.' });
    }
}

module.exports = {
  authenticateToken,
  authenticateClientToken,
  requireActiveSubscription,
  authorizeRole,
  checkFinancialAccountOwnership,
};
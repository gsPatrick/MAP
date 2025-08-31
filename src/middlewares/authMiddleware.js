// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const { User, Client, FinancialAccount, SharedAccess } = require('../database');
const { JWT_SECRET } = require('../utils/authUtils');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

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

    let clientInstance;

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
        
        // <<< CORREÇÃO PRINCIPAL: Anexa o cliente à requisição ANTES de verificar a assinatura >>>
        req.client = clientInstance.get({ plain: true });
        req.sharedAccessContext = null;

        // <<< LISTA DE EXCEÇÕES: Rotas que um cliente PODE acessar mesmo sem assinatura ativa >>>
        const subscriptionCheckWhitelist = [
            '/api/subscriptions/me/active',           // Necessária para a página de planos saber o status atual.
            '/api/auth/client/me',                    // Necessária para o checkout buscar os dados do usuário.
            '/api/mercado-pago/process-brick-payment',// Essencial para processar o pagamento do Brick.
            '/api/mercado-pago/create-pix-payment',   // Essencial para o fluxo de pagamento PIX antigo.
            '/api/mercado-pago/checkout',             // Essencial para o fluxo de Checkout Pro.
        ];
        
        // Se a rota atual ESTÁ na whitelist, pulamos a verificação de assinatura.
        if (subscriptionCheckWhitelist.some(path => req.originalUrl.startsWith(path))) {
            logger.info(`[AUTH CLIENT MIDDLEWARE] Rota ${req.originalUrl} na whitelist. Verificação de assinatura pulada para Cliente ID ${req.client.id}.`);
            return next(); // Pula para o próximo handler.
        }

        // <<< A VERIFICAÇÃO DE ASSINATURA AGORA SÓ ACONTECE PARA AS OUTRAS ROTAS >>>
        let hasActivePaidAccess = false;
        if (clientInstance.accessLevel && clientInstance.accessLevel !== 'gratuito') {
            if (clientInstance.accessLevel.startsWith('vitalicio_')) hasActivePaidAccess = true;
            else if (clientInstance.accessExpiresAt) {
                const expiryDate = new Date(clientInstance.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0,0,0,0);
                if (expiryDate >= today) hasActivePaidAccess = true;
            }
        }
        
        // Permite o acesso se o cliente acabou de se cadastrar e está indo pagar.
        if (clientInstance.status === 'Aguardando Pagamento') {
             hasActivePaidAccess = true;
        }

        if (!hasActivePaidAccess) {
            logger.warn(`[AUTH CLIENT MIDDLEWARE] Cliente ID ${clientInstance.id} não possui plano ativo/válido para a rota ${req.originalUrl}. AccessLevel: ${clientInstance.accessLevel}, ExpiresAt: ${clientInstance.accessExpiresAt}. Acesso negado.`);
            return res.status(403).json({ status: 'fail_subscription', message: 'Acesso negado. Nenhuma assinatura ativa encontrada ou sua assinatura expirou.' });
        }
        
        logger.info(`[AUTH CLIENT MIDDLEWARE] Acesso à rota protegida ${req.originalUrl} concedido para Cliente ID: ${req.client.id}`);

    } else if (decoded.type === 'client_shared_access') {
        // A lógica de acesso compartilhado permanece a mesma
        logger.debug(`[AUTH CLIENT MIDDLEWARE] Tipo 'client_shared_access'. Buscando SharedWithClient ID: ${decoded.id} e OwnerClient ID: ${decoded.ownerClientId}`);
        const sharedWithClientInstance = await Client.findByPk(decoded.id, {
            attributes: ['id', 'phone', 'email', 'name', 'status']
        });

        if (!sharedWithClientInstance) {
             logger.warn(`[AUTH CLIENT MIDDLEWARE - SHARED] Usuário compartilhado (ID: ${decoded.id}) do token NÃO ENCONTRADO.`);
             return res.status(401).json({ status: 'fail', message: 'Acesso compartilhado inválido (usuário).' });
        }

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

        req.client = sharedWithClientInstance.get({ plain: true });
        req.sharedAccessContext = {
            ownerClientId: ownerClientInstance.id,
            ownerClientName: ownerClientInstance.name,
            ownerClientAccessLevel: ownerClientInstance.accessLevel,
            canAccessPersonalProfile: decoded.canAccessPersonalProfile,
            canAccessBusinessProfileId: decoded.canAccessBusinessProfileId
        };
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
async function checkFinancialAccountOwnership(req, res, next) {
    try {
        const financialAccountIdFromParams = parseInt(req.params.financialAccountId, 10);

        if (!req.client || !req.client.id) {
            logger.error('[AuthOwnership] Middleware chamado sem req.client. O authenticateClientToken falhou ou não foi executado.');
            return res.status(500).json({ status: 'error', message: 'Erro interno de autenticação.' });
        }
        if (isNaN(financialAccountIdFromParams)) {
            return res.status(400).json({ status: 'fail', message: 'ID da Conta Financeira inválido na rota.' });
        }

        let financialAccount = null;

        if (!req.sharedAccessContext) {
            logger.debug(`[AuthOwnership] Cliente ID ${req.client.id} logado diretamente. Verificando posse ou acesso compartilhado recebido para FA ID ${financialAccountIdFromParams}.`);
            
            financialAccount = await FinancialAccount.findOne({
                where: {
                    id: financialAccountIdFromParams,
                    clientId: req.client.id
                }
            });

            if (!financialAccount) {
                const sharedAccess = await SharedAccess.findOne({
                    where: {
                        sharedWithClientId: req.client.id,
                        status: 'Ativo',
                        [Op.or]: [
                            { canAccessPersonalProfile: true, '$accessibleBusinessProfile.accountType$': 'PF' },
                            { canAccessBusinessProfileId: financialAccountIdFromParams }
                        ]
                    },
                    include: [{
                        model: FinancialAccount,
                        as: 'accessibleBusinessProfile',
                        required: false
                    }]
                });

                if (sharedAccess) {
                    const faTypeFromDb = (await FinancialAccount.findByPk(financialAccountIdFromParams))?.accountType;

                    if (faTypeFromDb === 'PF' && sharedAccess.canAccessPersonalProfile) {
                        financialAccount = await FinancialAccount.findByPk(financialAccountIdFromParams);
                    } else if (['PJ', 'MEI'].includes(faTypeFromDb) && sharedAccess.canAccessBusinessProfileId === financialAccountIdFromParams) {
                        financialAccount = await FinancialAccount.findByPk(financialAccountIdFromParams);
                    }
                }
                
                if (financialAccount) {
                    logger.debug(`[AuthOwnership] Acesso concedido via SharedAccess recebido para FA ID ${financialAccountIdFromParams} pelo Cliente ID ${req.client.id}.`);
                }
            }

        } else {
            logger.debug(`[AuthOwnership] Cliente ID ${req.client.id} logado via acesso compartilhado do Owner ID ${req.sharedAccessContext.ownerClientId}. Verificando acesso para FA ID ${financialAccountIdFromParams}.`);

            const sharedAccess = await SharedAccess.findOne({
                where: {
                    ownerClientId: req.sharedAccessContext.ownerClientId,
                    sharedWithClientId: req.client.id,
                    status: 'Ativo',
                    [Op.or]: [
                        { canAccessPersonalProfile: true },
                        { canAccessBusinessProfileId: financialAccountIdFromParams }
                    ]
                }
            });

            if (sharedAccess) {
                financialAccount = await FinancialAccount.findByPk(financialAccountIdFromParams);
                if (financialAccount) {
                    if (financialAccount.accountType === 'PF' && !sharedAccess.canAccessPersonalProfile) {
                        financialAccount = null;
                    } else if (['PJ', 'MEI'].includes(financialAccount.accountType) && sharedAccess.canAccessBusinessProfileId !== financialAccount.id) {
                        financialAccount = null;
                    }
                    if (financialAccount) {
                        logger.debug(`[AuthOwnership] Acesso concedido via token SharedAccess para FA ID ${financialAccountIdFromParams}.`);
                    }
                }
            }
        }
        
        if (!financialAccount) {
            logger.warn(`[AuthOwnership] Acesso negado para FinancialAccount ID ${financialAccountIdFromParams} ao Cliente ID ${req.client.id}.`);
            return res.status(403).json({ status: 'fail', message: 'Acesso negado a esta conta financeira.' });
        }
        
        if (!financialAccount.isActive) {
            logger.warn(`[AuthOwnership] Cliente ${req.client.id} tentou acessar FinancialAccount INATIVA ID ${financialAccountIdFromParams}.`);
            return res.status(403).json({ status: 'fail', message: 'Esta conta financeira está inativa.' });
        }
        
        req.financialAccount = financialAccount.toJSON();
        next();
    } catch (error) {
        logger.error('[AuthOwnership] Erro ao verificar propriedade/acesso da conta financeira:', { message: error.message, stack: error.stack });
        return res.status(500).json({ status: 'error', message: 'Erro ao verificar permissões da conta.' });
    }
}

async function identifyClientToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ status: 'fail', message: 'Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'client') {
        logger.warn(`[IdentifyClient] Tentativa de usar token de tipo '${decoded.type}' em rota de cliente.`);
        return res.status(403).json({ status: 'fail', message: 'Token inválido para esta operação.' });
    }

    const clientInstance = await Client.findByPk(decoded.id);
    if (!clientInstance) {
      return res.status(401).json({ status: 'fail', message: 'Cliente inválido.' });
    }
    if (clientInstance.status === 'Bloqueado' || clientInstance.status === 'Inativo') {
      return res.status(403).json({ status: 'fail', message: `Status do cliente: ${clientInstance.status}.` });
    }

    req.client = clientInstance.toJSON(); // Adiciona o cliente à requisição
    next();
  } catch (error) {
    logger.error('[IdentifyClient] Erro na verificação do token:', { message: error.message });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'fail', message: 'Token expirado.' });
    }
    return res.status(403).json({ status: 'fail', message: 'Token inválido.' });
  }
}

module.exports = {
  authenticateToken,
  authenticateClientToken,
  authorizeRole,
  checkFinancialAccountOwnership,
  identifyClientToken
};
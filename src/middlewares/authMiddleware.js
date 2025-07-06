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
async function checkFinancialAccountOwnership(req, res, next) {
    try {
        const financialAccountIdFromParams = parseInt(req.params.financialAccountId, 10);

        // Verifica se req.client está populado (deve estar pelo authenticateClientToken)
        if (!req.client || !req.client.id) {
            logger.error('[AuthOwnership] Middleware chamado sem req.client. O authenticateClientToken falhou ou não foi executado.');
            return res.status(500).json({ status: 'error', message: 'Erro interno de autenticação.' });
        }
        if (isNaN(financialAccountIdFromParams)) {
            return res.status(400).json({ status: 'fail', message: 'ID da Conta Financeira inválido na rota.' });
        }

        let financialAccount = null;

        // Cenário 1: Cliente logado diretamente (token.type === 'client')
        // req.sharedAccessContext será null neste caso.
        if (!req.sharedAccessContext) {
            logger.debug(`[AuthOwnership] Cliente ID ${req.client.id} logado diretamente. Verificando posse ou acesso compartilhado recebido para FA ID ${financialAccountIdFromParams}.`);
            
            // Tenta encontrar por posse DIRETA
            financialAccount = await FinancialAccount.findOne({
                where: {
                    id: financialAccountIdFromParams,
                    clientId: req.client.id // O cliente logado é o proprietário
                }
            });

            // Se não encontrou por posse direta, tenta encontrar por ACESSO COMPARTILHADO RECEBIDO
            if (!financialAccount) {
                const sharedAccess = await SharedAccess.findOne({
                    where: {
                        sharedWithClientId: req.client.id, // O cliente logado recebeu acesso
                        status: 'Ativo', // O acesso compartilhado deve estar ativo
                        [Op.or]: [ // Pode ser acesso ao perfil PF ou a um perfil PJ/MEI específico
                            { canAccessPersonalProfile: true, '$accessibleBusinessProfile.accountType$': 'PF' },
                            { canAccessBusinessProfileId: financialAccountIdFromParams }
                        ]
                    },
                    include: [{
                        model: FinancialAccount,
                        as: 'accessibleBusinessProfile',
                        required: false // Para permitir o OR com canAccessPersonalProfile
                    }]
                });

                if (sharedAccess) {
                    // Confirma que o sharedAccess encontrado é para a FA correta
                    // Se for acesso a PF, precisamos que a FA da rota seja PF.
                    // Se for acesso a PJ/MEI, precisa bater o ID.
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

        } else { // Cenário 2: Cliente logado via token de acesso compartilhado (token.type === 'client_shared_access')
            // req.client é o sharedWithClient, req.sharedAccessContext.ownerClientId é o dono.
            logger.debug(`[AuthOwnership] Cliente ID ${req.client.id} logado via acesso compartilhado do Owner ID ${req.sharedAccessContext.ownerClientId}. Verificando acesso para FA ID ${financialAccountIdFromParams}.`);

            // Aqui, a validação é se o token de acesso compartilhado realmente dá permissão para esta FA.
            const sharedAccess = await SharedAccess.findOne({
                where: {
                    ownerClientId: req.sharedAccessContext.ownerClientId,
                    sharedWithClientId: req.client.id,
                    status: 'Ativo',
                    [Op.or]: [
                        { canAccessPersonalProfile: true }, // Acesso ao perfil pessoal do dono
                        { canAccessBusinessProfileId: financialAccountIdFromParams } // Acesso a um perfil de negócio específico
                    ]
                }
            });

            if (sharedAccess) {
                financialAccount = await FinancialAccount.findByPk(financialAccountIdFromParams);
                if (financialAccount) {
                    // Verificações adicionais baseadas no tipo de conta e nas permissões do sharedAccess
                    if (financialAccount.accountType === 'PF' && !sharedAccess.canAccessPersonalProfile) {
                        financialAccount = null; // Tenta acessar PF sem permissão específica
                    } else if (['PJ', 'MEI'].includes(financialAccount.accountType) && sharedAccess.canAccessBusinessProfileId !== financialAccount.id) {
                        financialAccount = null; // Tenta acessar um PJ/MEI diferente do concedido
                    }
                    if (financialAccount) {
                        logger.debug(`[AuthOwnership] Acesso concedido via token SharedAccess para FA ID ${financialAccountIdFromParams}.`);
                    }
                }
            }
        }
        
        // Se, após todas as verificações, a financialAccount ainda é nula, nega o acesso.
        if (!financialAccount) {
            logger.warn(`[AuthOwnership] Acesso negado para FinancialAccount ID ${financialAccountIdFromParams} ao Cliente ID ${req.client.id}.`);
            return res.status(403).json({ status: 'fail', message: 'Acesso negado a esta conta financeira.' });
        }
        
        // Verifica se a conta financeira está ativa
        if (!financialAccount.isActive) {
            logger.warn(`[AuthOwnership] Cliente ${req.client.id} tentou acessar FinancialAccount INATIVA ID ${financialAccountIdFromParams}.`);
            return res.status(403).json({ status: 'fail', message: 'Esta conta financeira está inativa.' });
        }
        
        // Popula req.financialAccount com o objeto da conta para uso posterior nos controllers
        req.financialAccount = financialAccount.toJSON();
        next();
    } catch (error) {
        logger.error('[AuthOwnership] Erro ao verificar propriedade/acesso da conta financeira:', { message: error.message, stack: error.stack });
        return res.status(500).json({ status: 'error', message: 'Erro ao verificar permissões da conta.' });
    }
}

module.exports = {
  authenticateToken,
  authenticateClientToken,
  authorizeRole,
  checkFinancialAccountOwnership
};
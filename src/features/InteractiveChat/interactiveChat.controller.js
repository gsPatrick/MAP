// src/features/InteractiveChat/interactiveChat.controller.js
const interactiveChatService = require('./InteractiveChat.service');
const logger = require('../../utils/logger');
const { FinancialAccount } = require('../../database'); // Para buscar dados do perfil ativo

async function handleSiteChatMessage(req, res, next) {
  try {
    const { message, activeProfileId, userSessionId, payloadFromFrontend } = req.body;
    const clientFromToken = req.client; // Populado por authenticateClientToken

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ status: 'fail', message: 'A mensagem é obrigatória.' });
    }
    if (!activeProfileId || isNaN(parseInt(activeProfileId))) {
        return res.status(400).json({ status: 'fail', message: 'ID do perfil ativo é obrigatório.' });
    }
    if (!userSessionId) {
        return res.status(400).json({ status: 'fail', message: 'ID da sessão do usuário é obrigatório.' });
    }

    // Buscar os detalhes da FinancialAccount ativa para passar ao serviço de chat
    // Isso garante que estamos usando o perfil correto que o usuário selecionou no frontend.
    const currentProfileAccount = await FinancialAccount.findOne({
        where: {
            id: parseInt(activeProfileId),
            clientId: clientFromToken.id // Garante que a conta pertence ao cliente logado
        },
        include: [{ model: require('../../database').Client, as: 'ownerClient', attributes: ['id', 'name'] }] // Inclui o nome do cliente dono
    });

    if (!currentProfileAccount) {
        logger.warn(`[CHAT CTRL] Cliente ${clientFromToken.id} tentou usar perfil ${activeProfileId} que não lhe pertence ou não existe.`);
        return res.status(403).json({ status: 'fail', message: 'Perfil financeiro inválido ou não pertence a você.' });
    }
    if (!currentProfileAccount.isActive) {
        logger.warn(`[CHAT CTRL] Cliente ${clientFromToken.id} tentou usar perfil ${activeProfileId} que está INATIVO.`);
        return res.status(403).json({ status: 'fail', message: `O perfil "${currentProfileAccount.accountName}" está inativo.` });
    }
    
    // Monta o currentProfileContext para o serviço de chat
    const profileContextForChatService = {
        id: currentProfileAccount.id,
        name: currentProfileAccount.accountName,
        type: currentProfileAccount.accountType,
        ownerClient: currentProfileAccount.ownerClient ? currentProfileAccount.ownerClient.toJSON() : { id: clientFromToken.id, name: clientFromToken.name }, // Passa dados do cliente
        // Adicionar outros dados do perfil/conta que a IA precise, se houver.
    };


    // rawPayload no serviço de chat agora será o payloadFromFrontend
    const responseFromService = await interactiveChatService.processSiteChatMessage(
      userSessionId,
      message,
      profileContextForChatService,
      payloadFromFrontend || {} // Passa o payload adicional do frontend (ex: clique em sugestão)
    );

    res.status(200).json({ status: 'success', data: responseFromService });

  } catch (error) {
    logger.error('[CHAT CTRL] Erro ao processar mensagem do chat do site:', { error: error.message, stack: error.stack });
    // O errorHandler global deve pegar isso, mas podemos enviar uma resposta genérica
    next(error); // Deixa o errorHandler global cuidar
  }
}

module.exports = {
  handleSiteChatMessage,
};
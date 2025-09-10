// src/features/BusinessClient/businessClient.controller.js
const businessClientService = require('./BusinessClient.service');
const logger = require('../../utils/logger'); // Para logs no controller se necessário

// Helper para validar e extrair financialAccountId da rota
function getFinancialAccountIdFromRequest(req, paramName = 'financialAccountId') {
    const id = parseInt(req.params[paramName], 10);
    if (isNaN(id) || id <= 0) { // Adicionada checagem para id > 0
        const error = new Error(`ID da Conta Financeira (${paramName}) inválido ou não fornecido na rota.`);
        error.statusCode = 400; error.status = 'fail';
        throw error;
    }
     // Verifica se a conta associada no req (pelo middleware authorizeFinancialAccountOwnership) é PJ/MEI
     // Este middleware já deve ter populado req.financialAccount
    if (!req.financialAccount || !['PJ', 'MEI'].includes(req.financialAccount.accountType)) {
        const error = new Error(`Funcionalidade de Clientes de Negócio disponível apenas para contas PJ ou MEI.`);
        error.statusCode = 403; // Forbidden
        error.status = 'fail';
        throw error;
    }
    // Retorna o ID da financialAccount que já foi validada, autorizada e teve o tipo verificado.
    return req.financialAccount.id;

}

function getBusinessClientIdFromRequest(req, paramName = 'businessClientId') {
    const id = parseInt(req.params[paramName], 10);
    if (isNaN(id) || id <= 0) { // Adicionada checagem para id > 0
        const error = new Error(`ID do Cliente de Negócio (${paramName}) inválido ou não fornecido na rota.`);
        error.statusCode = 400; error.status = 'fail';
        throw error;
    }
    return id;
}


async function createBusinessClient(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req); // Já valida se é PJ/MEI
    // Adicionar validação de schema para req.body (nome obrigatório, photoUrl string opcional)
    const newClient = await businessClientService.createBusinessClient(financialAccountId, req.body);
    res.status(201).json({ status: 'success', data: newClient });
  } catch (error) {
    next(error);
  }
}

async function getAllBusinessClients(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req); // Já valida se é PJ/MEI
    const result = await businessClientService.getAllBusinessClients(financialAccountId, req.query);
    res.status(200).json({ status: 'success', data: result.businessClients, totalItems: result.totalItems });
  } catch (error) {
    next(error);
  }
}

async function getBusinessClientById(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req); // Já valida se é PJ/MEI
    const businessClientId = getBusinessClientIdFromRequest(req);
    const client = await businessClientService.getBusinessClientById(financialAccountId, businessClientId);
    if (!client) {
         const error = new Error(`Cliente de negócio ID ${businessClientId} não encontrado nesta conta.`);
         error.statusCode = 404; error.status = 'fail'; throw error;
    }
    res.status(200).json({ status: 'success', data: client });
  } catch (error) {
    next(error);
  }
}

async function updateBusinessClient(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req); // Já valida se é PJ/MEI
    const businessClientId = getBusinessClientIdFromRequest(req);
    if (Object.keys(req.body).length === 0) {
        const error = new Error('Nenhum dado fornecido para atualização.');
        error.statusCode = 400; error.status = 'fail'; return next(error);
    }
     // Adicionar validação de schema para req.body (photoUrl string opcional)
    const updatedClient = await businessClientService.updateBusinessClient(financialAccountId, businessClientId, req.body);
    if (!updatedClient) {
         const error = new Error(`Cliente de negócio ID ${businessClientId} não encontrado nesta conta para atualização.`);
         error.statusCode = 404; error.status = 'fail'; throw error;
    }
    res.status(200).json({ status: 'success', data: updatedClient });
  } catch (error) {
    next(error);
  }
}

async function deleteBusinessClient(req, res, next) {
  try {
    const financialAccountId = getFinancialAccountIdFromRequest(req); // Já valida se é PJ/MEI
    const businessClientId = getBusinessClientIdFromRequest(req);
    const success = await businessClientService.deleteBusinessClient(financialAccountId, businessClientId);
    if (!success) {
         const error = new Error(`Cliente de negócio ID ${businessClientId} não encontrado nesta conta para exclusão.`);
         error.statusCode = 404; error.status = 'fail'; throw error;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

async function getAppointmentHistory(req, res, next) {
  try {
    const { financialAccountId, businessClientId } = req.params;
    const history = await businessClientService.getAppointmentHistoryForClient(
      parseInt(financialAccountId, 10),
      parseInt(businessClientId, 10)
    );

    res.status(200).json({
      status: 'success',
      message: 'Histórico de agendamentos obtido com sucesso.',
      data: history,
    });
  } catch (error) {
    logger.error(`[BusinessClientController] Erro ao obter histórico de agendamentos: ${error.message}`);
    next(error);
  }
}

/**
 * Obtém detalhes completos (dashboard) de um cliente de negócio.
 */
async function getDetails(req, res, next) {
  try {
    const { financialAccountId, businessClientId } = req.params;
    const details = await businessClientService.getBusinessClientDetails(
      parseInt(financialAccountId, 10),
      parseInt(businessClientId, 10)
    );

    res.status(200).json({
      status: 'success',
      message: 'Detalhes do cliente obtidos com sucesso.',
      data: details,
    });
  } catch (error) {
    logger.error(`[BusinessClientController] Erro ao obter detalhes do cliente: ${error.message}`);
    next(error);
  }
}

/**
 * <<< NOVO CONTROLLER >>>
 * Verifica publicamente se um Business Client existe com base no e-mail ou telefone.
 */
async function verifyPublicClient(req, res, next) {
  try {
    const { financialAccountId } = req.params;
    const { email, phone } = req.body;

    if (!email && !phone) {
      return res.status(400).json({ status: 'fail', message: 'E-mail ou telefone é necessário para a verificação.' });
    }

    const client = await businessClientService.findExistingBusinessClient(
      parseInt(financialAccountId, 10),
      email,
      phone
    );

    if (client) {
      // Retorna apenas dados públicos e seguros
      res.status(200).json({
        status: 'success',
        data: {
          exists: true,
          name: client.name,
          email: client.email,
          phone: client.phone,
        },
      });
    } else {
      res.status(200).json({
        status: 'success',
        data: { exists: false },
      });
    }
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createBusinessClient,
  getAllBusinessClients,
  getBusinessClientById,
  updateBusinessClient,
  deleteBusinessClient,
  getAppointmentHistory,
  getDetails,
  verifyPublicClient
};
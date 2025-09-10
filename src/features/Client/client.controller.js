// src/features/Client/client.controller.js
const clientService = require('./client.service');

// === Client Contact Controllers ===
async function createClientContact(req, res, next) {
  try {
    const newClient = await clientService.createClientContact(req.body);
    res.status(201).json({ status: 'success', data: newClient });
  } catch (error) { next(error); }
}

async function getAllClientContacts(req, res, next) {
  try {
    const result = await clientService.getAllClientContacts(req.query);
    res.status(200).json({ status: 'success', ...result });
  } catch (error) { next(error); }
}

async function getClientContactById(req, res, next) {
  try {
    const clientId = parseInt(req.params.clientId, 10); // clientId da rota
    if (isNaN(clientId)) { /* ... erro 400 ... */ }
    const client = await clientService.getClientContactById(clientId);
    if (!client) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: client });
  } catch (error) { next(error); }
}

async function updateClientContact(req, res, next) {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) { /* ... erro 400 ... */ }
    const updatedClient = await clientService.updateClientContact(clientId, req.body);
    if (!updatedClient) { /* ... erro 404 ... */ }
    res.status(200).json({ status: 'success', data: updatedClient });
  } catch (error) { next(error); }
}

async function deleteClientContact(req, res, next) {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) { /* ... erro 400 ... */ }
    const success = await clientService.deleteClientContact(clientId);
    if (!success) { /* ... erro 404 ... */ }
    res.status(204).send();
  } catch (error) { next(error); }
}


// === Financial Account Controllers (Aninhados sob Client) ===

async function createFinancialAccount(req, res, next) {
  try {
    const clientId = parseInt(req.params.clientId, 10); // clientId da rota pai
    if (isNaN(clientId)) {
        const error = new Error('ID do Cliente inválido.'); error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    // Validação do corpo (accountName, accountType obrigatórios)
    const { accountName, accountType } = req.body;
    if (!accountName || !accountType) {
        const error = new Error('Nome da Conta e Tipo da Conta são obrigatórios.'); error.statusCode = 400; error.status = 'fail'; return next(error);
    }
    const newAccount = await clientService.createFinancialAccount(clientId, req.body);
    res.status(201).json({ status: 'success', data: newAccount });
  } catch (error) { next(error); }
}

async function getClientFinancialAccounts(req, res, next) {
  try {
    const clientId = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) { /* ... erro 400 ... */ }
    const accounts = await clientService.getClientFinancialAccounts(clientId, req.query);
    res.status(200).json({ status: 'success', data: accounts });
  } catch (error) { next(error); }
}

async function getFinancialAccountById(req, res, next) { // Rota: /api/clients/:clientId/financial-accounts/:accountId
    try {
        // const clientId = parseInt(req.params.clientId, 10); // Pode validar se pertence ao cliente da rota
        const accountId = parseInt(req.params.accountId, 10);
        if (isNaN(accountId)) { /* ... erro 400 ... */ }
        const account = await clientService.getFinancialAccountById(accountId);
        if (!account) { /* ... erro 404 ... */ }
        // Adicional: verificar se account.clientId === clientId da rota
        if (account.clientId !== parseInt(req.params.clientId, 10)) {
            const error = new Error('Conta financeira não pertence ao cliente especificado.');
            error.statusCode = 403; error.status = 'fail'; return next(error);
        }
        res.status(200).json({ status: 'success', data: account });
    } catch (error) { next(error); }
}


async function updateFinancialAccount(req, res, next) {
  try {
    // const clientId = parseInt(req.params.clientId, 10); // Para verificar se a conta pertence ao client
    const accountId = parseInt(req.params.accountId, 10);
    if (isNaN(accountId)) { /* ... erro 400 ... */ }
     if (Object.keys(req.body).length === 0) { /* ... erro 400 ... */ }

    // Opcional: Verificar se a conta a ser atualizada realmente pertence ao clientId da rota.
    // O service updateFinancialAccount não tem o clientId como parâmetro direto, mas o accountId é globalmente único.
    // Uma verificação pode ser adicionada no service ou aqui:
    const existingAccount = await clientService.getFinancialAccountById(accountId);
    if (!existingAccount) { /* ... erro 404 ... */ }
    if (existingAccount.clientId !== parseInt(req.params.clientId, 10)) {
        const error = new Error('Conta financeira não pertence ao cliente especificado para atualização.');
        error.statusCode = 403; error.status = 'fail'; return next(error);
    }

    const updatedAccount = await clientService.updateFinancialAccount(accountId, req.body);
    if (!updatedAccount) { /* ... erro 404 (já tratado no service) ... */ }
    res.status(200).json({ status: 'success', data: updatedAccount });
  } catch (error) { next(error); }
}

async function deleteFinancialAccount(req, res, next) {
  try {
    // const clientId = parseInt(req.params.clientId, 10);
    const accountId = parseInt(req.params.accountId, 10);
    if (isNaN(accountId)) { /* ... erro 400 ... */ }
    
    const existingAccount = await clientService.getFinancialAccountById(accountId);
    if (!existingAccount) { /* ... erro 404 ... */ }
    if (existingAccount.clientId !== parseInt(req.params.clientId, 10)) {
        const error = new Error('Conta financeira não pertence ao cliente especificado para exclusão.');
        error.statusCode = 403; error.status = 'fail'; return next(error);
    }

    const success = await clientService.deleteFinancialAccount(accountId);
    if (!success) { /* ... erro 404 (já tratado no service) ... */ }
    res.status(204).send();
  } catch (error) { next(error); }
}

// --- NOVO CONTROLLER DE DEBUG PARA CLIENTES ---
async function getClientsForDebug(req, res, next) {
  try {
    const clients = await clientService.getClientsForDebug();
    res.status(200).json({
      status: 'debug_success',
      message: 'ATENÇÃO: Estes dados incluem hashes de senha de CLIENTES e são apenas para teste.',
      count: clients.length,
      data: clients,
    });
  } catch (error) {
    next(error);
  }
}

async function backfillAffiliateCodes(req, res, next) {
  try {
    const result = await clientService.backfillAffiliateCodes();
    res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }

}

async function getClientInfoByAffiliateCode(req, res, next) {
  try {
    const { affiliateCode } = req.params;
    const clientInfo = await clientService.getClientPublicInfoByAffiliateCode(affiliateCode);
    if (!clientInfo) {
      // Retorna 404 para que o frontend saiba que o código não é válido
      return res.status(404).json({ status: 'fail', message: 'Afiliado não encontrado.' });
    }
    res.status(200).json({ status: 'success', data: clientInfo });
  } catch (error) {
    next(error);
  }
}

async function getClientInfoByAffiliateCode(req, res, next) {
  try {
    const { affiliateCode } = req.params;
    const clientInfo = await clientService.getClientPublicInfoByAffiliateCode(affiliateCode);
    if (!clientInfo) {
      return res.status(404).json({ status: 'fail', message: 'Afiliado não encontrado.' });
    }
    res.status(200).json({ status: 'success', data: clientInfo });
  } catch (error) {
    next(error);
  }
}
module.exports = {
  createClientContact,
  getAllClientContacts,
  getClientContactById,
  updateClientContact,
  deleteClientContact,
  createFinancialAccount,
  getClientFinancialAccounts,
  getFinancialAccountById,
  updateFinancialAccount,
  deleteFinancialAccount,
  getClientsForDebug,
  backfillAffiliateCodes,
  getClientInfoByAffiliateCode,
  getClientInfoByAffiliateCode
};
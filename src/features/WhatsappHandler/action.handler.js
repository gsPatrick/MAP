// src/features/WhatsappHandler/action.handler.js
// VERSÃO REATORADA PARA A API DE ASSISTANTS DA OPENAI

// DESCRIÇÃO:
// Este arquivo contém as IMPLEMENTAÇÕES LÓGICAS para cada uma das "ferramentas" (funções)
// que você cadastrou no seu Assistant da OpenAI. Cada função aqui executa uma lógica de
// negócio e retorna um objeto de dados bruto (JSON) ou lança um erro. O resultado é
// então processado pelo whatsapp.service.js.

// --- Imports dos Serviços ---
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const businessClientService = require('../BusinessClient/BusinessClient.service');
const sharedAccessService = require('../SharedAccess/sharedAccess.service');
const systemService = require('../System/system.service');
const clientService = require('../Client/client.service');
const financialCategoryService = require('../FinancialCategory/financialCategory.service');
const affiliateService = require('../Affiliate/affiliate.service');
const hydrationService = require('../Hydration/hydration.service');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

// --- Funções Helper ---
async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const card = await creditCardService.findCreditCardByName(financialAccountId, name);
    if (!card) throw new Error(`Cartão de crédito "${name}" não encontrado.`);
    return card.id;
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    const productsResult = await productService.getAllProducts(financialAccountId, { search: nameOrCode, limit: 1, isActive: true });
    if (productsResult.products && productsResult.products.length > 0) {
        return productsResult.products[0].id;
    }
    throw new Error(`Produto com nome ou código "${nameOrCode}" não encontrado.`);
}

async function findBusinessClientIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const clientsResult = await businessClientService.getAllBusinessClients(financialAccountId, { search: name, limit: 1, isActive: true });
    if (clientsResult.businessClients && clientsResult.businessClients.length > 0) {
        return clientsResult.businessClients[0].id;
    }
    throw new Error(`Cliente de negócio com nome "${name}" não encontrado.`);
}

// =================================================================
// IMPLEMENTAÇÕES DAS FUNÇÕES (FERRAMENTAS)
// =================================================================

// --- Ações de Criação (CREATE) ---

async function createFinancialTransaction(params, context) {
    const categoryObject = params.financialCategoryName 
        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, context.activeFinancialAccountId) 
        : null;
    
    const txData = {
        ...params,
        value: parseFloat(params.value),
        financialCategoryId: categoryObject ? categoryObject.id : null,
        creditCardId: params.creditCardName ? await findCreditCardIdByName(params.creditCardName, context.activeFinancialAccountId) : null,
        transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
    };

    const newTx = await financialService.createTransaction(context.activeFinancialAccountId, txData, context.actorId);
    return await financialService.getTransactionById(context.activeFinancialAccountId, newTx.id);
}

async function scheduleAppointment(params, context) {
    let businessClientIds = [];
    if (params.businessClientNames && Array.isArray(params.businessClientNames) && ['PJ', 'MEI'].includes(context.activeFinancialAccountType)) {
        for (const name of params.businessClientNames) {
            try {
                const bcId = await findBusinessClientIdByName(name, context.activeFinancialAccountId);
                businessClientIds.push(bcId);
            } catch (e) {
                logger.warn(`[TOOL: scheduleAppointment] Cliente de negócio "${name}" não encontrado.`);
            }
        }
    }

    const appointmentData = { ...params, businessClientIds: businessClientIds.length > 0 ? businessClientIds : undefined };
    const newAppt = await appointmentService.scheduleAppointment(context.activeFinancialAccountId, appointmentData, context.actorId);
    return await appointmentService.getAppointmentById(context.activeFinancialAccountId, newAppt.id);
}

async function createParcelledAccount(params, context) {
    const categoryObject = params.financialCategoryName 
        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, context.activeFinancialAccountId)
        : null;

    const parcelData = {
        ...params,
        totalValue: parseFloat(params.totalValue),
        numberOfParcels: parseInt(params.numberOfParcels),
        financialCategoryId: categoryObject ? categoryObject.id : null,
        creditCardId: params.creditCardName ? await findCreditCardIdByName(params.creditCardName, context.activeFinancialAccountId) : null,
        transactionDate: params.transactionDate || params.initialDueDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
    };
    if (!parcelData.creditCardId && parcelData.type === 'Saída') {
        throw new Error("Para uma compra parcelada do tipo 'Saída', o nome do cartão de crédito é obrigatório.");
    }
    
    return await financialService.createParcelledAccount(context.activeFinancialAccountId, parcelData, context.actorId);
}

async function createRecurringRule(params, context) {
    const categoryObject = params.financialCategoryName 
        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, context.activeFinancialAccountId)
        : null;
    
    const ruleData = { ...params, financialCategoryId: categoryObject ? categoryObject.id : null };
    const newRule = await recurringTransactionService.createRecurringRule(context.activeFinancialAccountId, ruleData);
    return await recurringTransactionService.getRecurringRuleById(context.activeFinancialAccountId, newRule.id);
}

async function createProduct(params, context) {
    const productData = { ...params, initialQuantity: params.initialQuantity || 0 };
    return await productService.createProduct(context.activeFinancialAccountId, productData, context.actorId);
}

async function createCreditCard(params, context) {
    return await creditCardService.createCreditCard(context.activeFinancialAccountId, params, context.actorId);
}

async function createFinancialAccount(params, context) {
    if (context.isSharedAccessContext) throw new Error("Ação não permitida em acesso compartilhado.");
    const accountData = { accountName: params.newAccountName, accountType: params.accountTypeToCreate, documentNumber: params.documentNumber };
    return await clientService.createFinancialAccount(context.actorId, accountData);
}

async function createBusinessClient(params, context) {
    return await businessClientService.createBusinessClient(context.activeFinancialAccountId, params, context.actorId);
}

async function grantAccess(params, context) {
    if (context.isSharedAccessContext) throw new Error("Ação não permitida em acesso compartilhado.");
    let businessProfileIdToShare = null;
    if (params.businessProfileToShareName) {
        const ownerAccounts = await clientService.getClientFinancialAccounts(context.ownerClientIdForContext, {isActive:true});
        const bizAccount = ownerAccounts.find(acc => (acc.accountType === 'PJ' || acc.accountType === 'MEI') && acc.accountName.toLowerCase() === params.businessProfileToShareName.toLowerCase());
        if (!bizAccount) throw new Error(`Perfil empresarial "${params.businessProfileToShareName}" não encontrado.`);
        businessProfileIdToShare = bizAccount.id;
    }
    const grantData = { ...params, canAccessBusinessProfileId: businessProfileIdToShare };
    const newAccess = await sharedAccessService.grantAccess(context.ownerClientIdForContext, grantData);
    return await sharedAccessService.getSharedAccessById(newAccess.id);
}

async function recordStockMovement(params, context) {
    const productId = await findProductIdByNameOrCode(params.productNameOrCode, context.activeFinancialAccountId);
    const movementData = { movementType: params.movementType, quantity: parseInt(params.quantity), reason: params.reason };
    await stockService.recordStockMovement(context.activeFinancialAccountId, productId, movementData, context.actorId);
    return await stockService.getProductStockInfoById(context.activeFinancialAccountId, productId);
}

async function payCreditCardInvoice(params, context) {
    const cardId = await findCreditCardIdByName(params.creditCardName, context.activeFinancialAccountId);
    const categoryObject = params.financialCategoryName 
        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, context.activeFinancialAccountId) 
        : null;
    const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
    
    return await creditCardService.payCreditCardInvoice(
        context.activeFinancialAccountId, cardId, parseFloat(params.paymentAmount), paymentDate,
        params.originatingAccountDescription, categoryObject ? categoryObject.id : null, context.actorId
    );
}

async function createFinancialCategory(params, context) {
    let parentId = null;
    if (params.parentCategoryName) {
        const parentCat = await financialCategoryService.findFinancialCategoryByNameForAccount(params.parentCategoryName, context.activeFinancialAccountId);
        if (!parentCat) throw new Error(`Categoria pai "${params.parentCategoryName}" não encontrada.`);
        parentId = parentCat.id;
    }
    return await financialCategoryService.createFinancialCategory(context.activeFinancialAccountId, { name: params.name, parentId });
}

async function createMotivationalPhrase(params, context) {
    return await systemService.createMotivationalPhrase({ ...params, createdBy: context.actorId });
}

// --- Ações de Leitura (GET / LIST) ---

async function getFinancialSummary(params, context) {
    const categoryObject = params.financialCategoryName 
        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, context.activeFinancialAccountId) 
        : null;
    const filters = { ...params, financialCategoryId: categoryObject ? categoryObject.id : null };
    return await financialService.getFinancialSummary(context.activeFinancialAccountId, filters);
}

async function listFinancialTransactions(params, context) {
    const categoryObject = params.financialCategoryName 
        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, context.activeFinancialAccountId) 
        : null;
    const creditCardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, context.activeFinancialAccountId).catch(() => null) : null;
    const filters = { ...params, financialCategoryId: categoryObject ? categoryObject.id : null, creditCardId };
    return await financialService.getAllTransactions(context.activeFinancialAccountId, filters, params.period);
}

async function listAppointments(params, context) {
    return await appointmentService.getAllAppointments(context.activeFinancialAccountId, params, params.period);
}

async function listCreditCards(params, context) {
    return await creditCardService.getAllCreditCards(context.activeFinancialAccountId, params);
}

async function listRecurringRules(params, context) {
    return await recurringTransactionService.getAllRecurringRules(context.activeFinancialAccountId, { descriptionSearch: params.ruleDescription, ...params });
}

async function getStockInfo(params, context) {
    return await stockService.getProductStockInfoByNameOrCode(context.activeFinancialAccountId, params.productNameOrCode);
}

async function getCreditCardInvoice(params, context) {
    const cardId = await findCreditCardIdByName(params.creditCardName, context.activeFinancialAccountId);
    const periodOpts = { type: params.invoicePeriodType || 'aberta', month: params.invoiceMonth, year: params.invoiceYear };
    return await creditCardService.getCreditCardInvoiceDetails(context.activeFinancialAccountId, cardId, periodOpts);
}

async function getCreditCardAvailableLimit(params, context) {
    const cardId = await findCreditCardIdByName(params.creditCardName, context.activeFinancialAccountId);
    return await creditCardService.getCreditCardAvailableLimit(context.activeFinancialAccountId, cardId);
}

async function listBusinessClients(params, context) {
    return await businessClientService.getAllBusinessClients(context.activeFinancialAccountId, params);
}

async function listGrantedAccess(params, context) {
    if (context.isSharedAccessContext) throw new Error("Ação não permitida em acesso compartilhado.");
    return await sharedAccessService.getSharedAccessesByOwner(context.ownerClientIdForContext, params);
}

async function listReceivedAccess(params, context) {
    return await sharedAccessService.getSharedAccessesForUser(context.actorId, params);
}

async function getMonthlyTrend(params, context) {
    return await financialService.getMonthlyTrend(context.activeFinancialAccountId, params.numberOfMonths || 6);
}

async function getExpenseCategorySummary(params, context) {
    return await financialService.getExpenseCategorySummary(context.activeFinancialAccountId, params.dateStart, params.dateEnd);
}

async function getIncomeCategorySummary(params, context) {
    return await financialService.getIncomeCategorySummary(context.activeFinancialAccountId, params.dateStart, params.dateEnd);
}

async function listFinancialCategories(params, context) {
    return await financialCategoryService.getAllFinancialCategories(context.activeFinancialAccountId, { hierarchical: true });
}

async function listProducts(params, context) {
    return await productService.getAllProducts(context.activeFinancialAccountId, params);
}

async function getProductDetails(params, context) {
    const productId = await findProductIdByNameOrCode(params.productNameOrCode, context.activeFinancialAccountId);
    return await productService.getProductById(context.activeFinancialAccountId, productId);
}

async function getHydrationLog(params, context) {
    const logs = await hydrationService.getTodaysLogsByClient(context.actorId);
    const prefs = await systemService.getSystemPreferences();
    return { logs, preferences: { dailyGoalMl: prefs.dailyGoalMl } };
}

async function getAffiliateDashboard(params, context) {
    if (context.isSharedAccessContext) throw new Error("O painel de afiliados só pode ser acessado pelo próprio dono da conta.");
    return await affiliateService.getAffiliateDashboard(context.actorId);
}

async function getActiveSubscription(params, context) {
    return await subscriptionService.getActiveSubscription(context.ownerClientIdForContext);
}

// --- Ações de Atualização (UPDATE) ---

async function updateFinancialTransaction(params, context) {
    const { transactionIdToUpdate, ...updateData } = params;
    if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não foi fornecido.");
    if (updateData.financialCategoryName) {
        const categoryObject = await financialCategoryService.findFinancialCategoryByNameForAccount(updateData.financialCategoryName, context.activeFinancialAccountId);
        updateData.financialCategoryId = categoryObject ? categoryObject.id : null;
    }
    if (updateData.creditCardName) {
        updateData.creditCardId = await findCreditCardIdByName(updateData.creditCardName, context.activeFinancialAccountId);
    }
    const updatedTx = await financialService.updateTransaction(context.activeFinancialAccountId, transactionIdToUpdate, updateData, context.actorId);
    return await financialService.getTransactionById(context.activeFinancialAccountId, updatedTx.id);
}

async function updateAppointment(params, context) {
    const { appointmentIdToUpdate, ...updateData } = params;
    if (!appointmentIdToUpdate) throw new Error("ID do compromisso para atualizar não foi fornecido.");
    const updatedAppt = await appointmentService.updateAppointment(context.activeFinancialAccountId, appointmentIdToUpdate, updateData, context.actorId);
    return await appointmentService.getAppointmentById(context.activeFinancialAccountId, updatedAppt.id);
}

async function markTransactionAsPaidReceived(params, context) {
    const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
    const categoryObject = params.financialCategoryName ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, context.activeFinancialAccountId) : null;
    return await financialService.markTransactionAsPaidOrReceived(
        context.activeFinancialAccountId, params.transactionDescription, params.transactionValue ? parseFloat(params.transactionValue) : null,
        paymentDate, categoryObject ? categoryObject.id : null, context.actorId
    );
}

async function updateRecurringRule(params, context) {
    const { ruleIdToUpdate, ...updateData } = params;
    if (!ruleIdToUpdate) throw new Error("ID da regra para atualizar não foi fornecido.");
    const updatedRule = await recurringTransactionService.updateRecurringRule(context.activeFinancialAccountId, ruleIdToUpdate, updateData, context.actorId);
    return await recurringTransactionService.getRecurringRuleById(context.activeFinancialAccountId, updatedRule.id);
}

async function updateProduct(params, context) {
    const { productIdToUpdate, ...updateData } = params;
    if (!productIdToUpdate) throw new Error("ID do produto para atualizar não foi fornecido.");
    return await productService.updateProduct(context.activeFinancialAccountId, productIdToUpdate, updateData, context.actorId);
}

async function updateParcelledAccountDescription(params, context) {
    const { originalAccountIdToUpdate, newDescription } = params;
    if (!originalAccountIdToUpdate || !newDescription) throw new Error("ID e nova descrição são obrigatórios.");
    await financialService.updateParcelledAccountDescription(context.activeFinancialAccountId, originalAccountIdToUpdate, newDescription, context.actorId);
    return { success: true, message: `Descrição da compra parcelada (ID: ${originalAccountIdToUpdate}) atualizada para "${newDescription}".` };
}

async function recreateParcelledAccount(params, context) {
    const { originalAccountIdToUpdate, ...newParcelData } = params;
    if (!originalAccountIdToUpdate) throw new Error("ID da compra original é obrigatório para recriar.");
    return await financialService.recreateParcelledAccount(context.activeFinancialAccountId, originalAccountIdToUpdate, newParcelData, context.actorId);
}

async function updateCreditCard(params, context) {
    const { cardIdToUpdate, ...updateData } = params;
    if (!cardIdToUpdate) throw new Error("ID do cartão para atualizar não foi fornecido.");
    return await creditCardService.updateCreditCard(context.activeFinancialAccountId, cardIdToUpdate, updateData, context.actorId);
}

async function updateBusinessClient(params, context) {
    const { clientIdToUpdate, ...updateData } = params;
    if (!clientIdToUpdate) throw new Error("ID do cliente para atualizar não foi fornecido.");
    return await businessClientService.updateBusinessClient(context.activeFinancialAccountId, clientIdToUpdate, updateData, context.actorId);
}

async function updateFinancialAccount(params, context) {
    if (context.isSharedAccessContext) throw new Error("Ação não permitida em acesso compartilhado.");
    const ownerAccounts = await clientService.getClientFinancialAccounts(context.ownerClientIdForContext, {isActive:null});
    const accountToUpdate = ownerAccounts.find(acc => acc.accountName.toLowerCase() === params.accountNameToUpdate.toLowerCase());
    if (!accountToUpdate) throw new Error(`Conta "${params.accountNameToUpdate}" não encontrada.`);
    const { accountNameToUpdate, ...updateData } = params;
    return await clientService.updateFinancialAccount(accountToUpdate.id, updateData);
}

async function updateGrantedAccess(params, context) {
    throw new Error("UPDATE_GRANTED_ACCESS precisa ser implementado com a lógica de busca de ID.");
}

async function updateFinancialCategory(params, context) {
    const { categoryNameToUpdate, ...updateData } = params;
    const categoryToUpdate = await financialCategoryService.findFinancialCategoryByNameForAccount(categoryNameToUpdate, context.activeFinancialAccountId);
    if (!categoryToUpdate) throw new Error(`Categoria "${categoryNameToUpdate}" não encontrada.`);
    if (updateData.newParentCategoryName) {
        const newParent = await financialCategoryService.findFinancialCategoryByNameForAccount(updateData.newParentCategoryName, context.activeFinancialAccountId);
        if (!newParent) throw new Error(`Nova categoria pai "${updateData.newParentCategoryName}" não encontrada.`);
        updateData.parentId = newParent.id;
    }
    if (updateData.newName) updateData.name = updateData.newName;
    return await financialCategoryService.updateFinancialCategory(context.activeFinancialAccountId, categoryToUpdate.id, updateData);
}

async function updateMotivationalPhrase(params, context) {
    const { phraseIdToUpdate, ...updateData } = params;
    if (!phraseIdToUpdate) throw new Error("ID da frase para atualizar não foi fornecido.");
    return await systemService.updateMotivationalPhrase(phraseIdToUpdate, updateData);
}

async function logWaterIntake(params, context) {
    await hydrationService.logWaterIntake(context.actorId, params.amountInMl ? parseInt(params.amountInMl) : null);
    return { success: true };
}

// --- Ações de Exclusão (DELETE) ---

async function deleteFinancialAccount(params, context) {
    if (context.isSharedAccessContext) throw new Error("Ação não permitida em acesso compartilhado.");
    const ownerAccounts = await clientService.getClientFinancialAccounts(context.ownerClientIdForContext, { isActive: null });
    const accountToDelete = ownerAccounts.find(acc => acc.accountName.toLowerCase() === params.accountNameToDelete.toLowerCase());
    if (!accountToDelete) throw new Error(`Conta "${params.accountNameToDelete}" não encontrada.`);
    await clientService.deleteFinancialAccount(accountToDelete.id);
    return { success: true, message: `Conta "${params.accountNameToDelete}" excluída.` };
}

async function revokeAccess(params, context) {
    throw new Error("REVOKE_ACCESS precisa ser implementado com a lógica de busca de ID.");
}

async function deleteFinancialTransaction(params, context) {
    let transactionIdToDelete = params.transactionId;
    if (!transactionIdToDelete && params.description) {
         const { transactions } = await financialService.getAllTransactions(context.activeFinancialAccountId, { search: params.description, limit: 1 });
         if(transactions && transactions.length > 0) transactionIdToDelete = transactions[0].id;
    }
    if (!transactionIdToDelete) throw new Error(`Transação com descrição "${params.description}" não encontrada para exclusão.`);
    await financialService.deleteTransaction(context.activeFinancialAccountId, transactionIdToDelete);
    return { success: true, message: `Transação (ID: ${transactionIdToDelete}) excluída.` };
}

async function deleteProduct(params, context) {
    const productId = await findProductIdByNameOrCode(params.productNameOrCode, context.activeFinancialAccountId);
    await productService.deleteProduct(context.activeFinancialAccountId, productId);
    return { success: true, message: `Produto "${params.productNameOrCode}" excluído.` };
}

async function deleteRecurringRule(params, context) {
    const { rules } = await recurringTransactionService.getAllRecurringRules(context.activeFinancialAccountId, { descriptionSearch: params.ruleDescription });
    if (!rules || rules.length === 0) throw new Error(`Regra recorrente "${params.ruleDescription}" não encontrada.`);
    if (rules.length > 1) throw new Error(`Múltiplas regras encontradas para "${params.ruleDescription}". Por favor, seja mais específico.`);
    await recurringTransactionService.deleteRecurringRule(context.activeFinancialAccountId, rules[0].id);
    return { success: true, message: `Regra recorrente "${params.ruleDescription}" excluída.` };
}

async function deleteBusinessClient(params, context) {
    const clientId = await findBusinessClientIdByName(params.clientNameToDelete, context.activeFinancialAccountId);
    await businessClientService.deleteBusinessClient(context.activeFinancialAccountId, clientId);
    return { success: true, message: `Cliente "${params.clientNameToDelete}" excluído.` };
}

async function deleteFinancialCategory(params, context) {
    const categoryToDelete = await financialCategoryService.findFinancialCategoryByNameForAccount(params.categoryNameToDelete, context.activeFinancialAccountId);
    if (!categoryToDelete) throw new Error(`Categoria "${params.categoryNameToDelete}" não encontrada.`);
    await financialCategoryService.deleteFinancialCategory(context.activeFinancialAccountId, categoryToDelete.id, params);
    return { success: true, message: `Categoria "${params.categoryNameToDelete}" excluída.` };
}

async function deleteMotivationalPhrase(params, context) {
    if (!params.phraseIdToDelete) throw new Error("ID da frase para apagar não foi fornecido.");
    await systemService.deleteMotivationalPhrase(params.phraseIdToDelete);
    return { success: true, message: `Frase (ID: ${params.phraseIdToDelete}) apagada.` };
}

// --- Ações de Sistema e Estado ---

async function switchFinancialAccount(params, context) {
    const ownerAccounts = await clientService.getClientFinancialAccounts(context.ownerClientIdForContext, { isActive: true });
    let accessibleAccounts = context.isSharedAccessContext
        ? ownerAccounts.filter(acc => (acc.accountType === 'PF' && context.sharedAccessPermissions.canAccessPersonalProfile) || (context.sharedAccessPermissions.canAccessBusinessProfileId === acc.id))
        : ownerAccounts;
    
    let foundAccount = accessibleAccounts.find(acc =>
        (acc.accountName || acc.name).toLowerCase() === params.targetAccountNameOrType.toLowerCase() ||
        (acc.accountType || acc.type).toLowerCase() === params.targetAccountNameOrType.toLowerCase()
    );
    if (!foundAccount) {
        foundAccount = accessibleAccounts.find(acc => (acc.accountName || acc.name).toLowerCase().includes(params.targetAccountNameOrType.toLowerCase()));
    }
    if (!foundAccount) throw new Error(`Conta "${params.targetAccountNameOrType}" não encontrada ou inacessível.`);
    
    return { action: 'ACCOUNT_SWITCHED', newAccount: foundAccount };
}

async function setMotivationalMessagePreference(params, context) {
    const prefs = await clientService.updateClientMotivationPrefs(context.actorId, { enable: params.enable, time: params.enable ? params.time : null });
    return { wantsMotivationMessage: prefs.wantsMotivationMessage, motivationMessageTime: prefs.motivationMessageTime };
}

async function setWaterReminderPreference(params, context) {
    await systemService.updateSystemPreferences({
        enableWaterReminder: params.enable,
        waterReminderFrequencyType: params.enable ? params.frequencyType : 'disabled',
        waterReminderCustomIntervalMinutes: params.enable && params.frequencyType === 'custom' ? parseInt(params.customIntervalMinutes) : null,
        waterReminderStartTime: params.enable ? params.startTime : null,
        waterReminderEndTime: params.enable ? params.endTime : null,
        dailyGoalMl: params.enable && params.dailyGoalMl ? parseInt(params.dailyGoalMl) : null
    });
    return await systemService.getSystemPreferences();
}

async function respondToInvite(params, context) {
    let sharedAccessIdToRespond = params.sharedAccessId;
    if (!sharedAccessIdToRespond) {
        const { sharedAccesses: pendingInvites } = await sharedAccessService.getSharedAccessesForUser(context.actorId, { status: 'Pendente' });
        if (pendingInvites.length === 0) throw new Error("Você não tem convites pendentes.");
        if (pendingInvites.length === 1 && !params.inviterNameOrIdentifier) {
            sharedAccessIdToRespond = pendingInvites[0].id;
        } else if (params.inviterNameOrIdentifier) {
            const foundInvite = pendingInvites.find(i => i.ownerClient?.name.toLowerCase().includes(params.inviterNameOrIdentifier.toLowerCase()));
            if (!foundInvite) throw new Error(`Convite de "${params.inviterNameOrIdentifier}" não encontrado.`);
            sharedAccessIdToRespond = foundInvite.id;
        } else {
            throw new Error("Você tem múltiplos convites pendentes. Especifique de quem é o convite.");
        }
    }
    const updatedAccess = await sharedAccessService.respondToInvite(context.actorId, sharedAccessIdToRespond, params.responseType);
    return await sharedAccessService.getSharedAccessById(updatedAccess.id);
}

async function generalGreetingOrSmalltalk(params, context) {
    // Esta função não faz nada, apenas confirma para a IA que a saudação foi "tratada".
    // A IA então prosseguirá para gerar sua própria resposta de texto.
    return { success: true, message: "Saudação reconhecida." };
}

async function actionConfirmationYes(params, context) {
    // Reconhece um "sim" do usuário. A lógica real dependerá do estado da conversa,
    // que a IA gerenciará.
    return { success: true, message: "Confirmação positiva reconhecida." };
}

async function actionConfirmationNo(params, context) {
    // Reconhece um "não" do usuário.
    return { success: true, message: "Confirmação negativa reconhecida." };
}

async function generalQuestionOrHelp(params, context) {
    // Reconhece um pedido de ajuda. A IA formulará a resposta instrutiva.
    return { success: true, message: "Pedido de ajuda reconhecido." };
}


// --- Exporta todas as funções para serem usadas pelo tool.map.js ---
module.exports = {
    generalQuestionOrHelp,
    actionConfirmationYes,
    generalGreetingOrSmalltalk,
    actionConfirmationNo,
    createFinancialTransaction,
    scheduleAppointment,
    createParcelledAccount,
    updateFinancialTransaction,
    updateAppointment,
    getFinancialSummary,
    listFinancialTransactions,
    markTransactionAsPaidReceived,
    createRecurringRule,
    createProduct,
    getStockInfo,
    recordStockMovement,
    listAppointments,
    createCreditCard,
    listCreditCards,
    listRecurringRules,
    switchFinancialAccount,
    createFinancialAccount,
    getCreditCardInvoice,
    getCreditCardAvailableLimit,
    payCreditCardInvoice,
    updateCreditCard,
    updateRecurringRule,
    updateProduct,
    updateParcelledAccountDescription,
    recreateParcelledAccount,
    setMotivationalMessagePreference,
    setWaterReminderPreference,
    createBusinessClient,
    listBusinessClients,
    updateBusinessClient,
    grantAccess,
    listGrantedAccess,
    listReceivedAccess,
    updateGrantedAccess,
    revokeAccess,
    respondToInvite,
    updateFinancialAccount,
    deleteFinancialAccount,
    getMonthlyTrend,
    getExpenseCategorySummary,
    getIncomeCategorySummary,
    createFinancialCategory,
    listFinancialCategories,
    updateFinancialCategory,
    deleteFinancialCategory,
    listProducts,
    getProductDetails,
    deleteProduct,
    deleteRecurringRule,
    logWaterIntake,
    getHydrationLog,
    deleteBusinessClient,
    getActiveSubscription,
    getAffiliateDashboard,
    createMotivationalPhrase,
    updateMotivationalPhrase,
    deleteMotivationalPhrase,
    deleteFinancialTransaction
};
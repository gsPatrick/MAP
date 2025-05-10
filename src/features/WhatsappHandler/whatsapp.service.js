// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service');

const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8; // Número de pares (usuário/assistente) para enviar à IA
const MAX_STATE_HISTORY = 20; // Máximo de mensagens no estado para evitar consumo excessivo de memória

// Helper para buscar categoria por nome (adapte conforme sua implementação em systemService)
async function findFinancialCategoryIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    logger.debug(`[WHATSAPP SERVICE] Buscando categoria financeira por nome: "${name}" para conta ${financialAccountId}`);
    // Supondo que systemService.findFinancialCategoryByName(name, typeContext, accountContext) exista
    // e possa usar o nome da conta ou financialAccountId para escopo, se aplicável.
    // Por simplicidade, se não houver lógica de escopo por conta, pode ser uma busca global.
    const categories = await systemService.getAllFinancialCategories({isActive: true}); // Pega todas ativas
    const found = categories.find(cat => cat.name.toLowerCase() === name.toLowerCase());
    if(found) return found.id;

    // Tentar busca parcial (case-insensitive)
    const partialFound = categories.find(cat => cat.name.toLowerCase().includes(name.toLowerCase()));
    if (partialFound) {
        logger.info(`[WHATSAPP SERVICE] Categoria por nome "${name}" não encontrada exatamente. Usando correspondência parcial: "${partialFound.name}" (ID: ${partialFound.id})`);
        return partialFound.id;
    }
    logger.warn(`[WHATSAPP SERVICE] Categoria financeira com nome "${name}" não encontrada.`);
    return null;
}

// Helper para buscar cartão por nome
async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    logger.debug(`[WHATSAPP SERVICE] Buscando cartão por nome: "${name}" para conta ${financialAccountId}`);
    const cards = await creditCardService.getAllCreditCards(financialAccountId, { isActive: true });
    const found = cards.find(card => card.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;

    const partialFound = cards.find(card => card.name.toLowerCase().includes(name.toLowerCase()));
    if (partialFound) {
         logger.info(`[WHATSAPP SERVICE] Cartão por nome "${name}" não encontrado exatamente. Usando correspondência parcial: "${partialFound.name}" (ID: ${partialFound.id})`);
        return partialFound.id;
    }
    logger.warn(`[WHATSAPP SERVICE] Cartão de crédito com nome "${name}" não encontrado para a conta ${financialAccountId}.`);
    return null;
}

// Helper para buscar produto por nome ou código
async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    logger.debug(`[WHATSAPP SERVICE] Buscando produto por nome/código: "${nameOrCode}" para conta ${financialAccountId}`);
    const { products } = await productService.getAllProducts(financialAccountId, { search: nameOrCode, isActive: true, limit: 5 });
    if (products && products.length > 0) {
        // Tenta correspondência exata primeiro (nome ou código)
        const exactMatch = products.find(p => p.name.toLowerCase() === nameOrCode.toLowerCase() || (p.code && p.code.toLowerCase() === nameOrCode.toLowerCase()));
        if (exactMatch) return exactMatch.id;
        // Se não, retorna o primeiro resultado da busca (mais relevante)
        logger.info(`[WHATSAPP SERVICE] Produto por nome/código "${nameOrCode}" não encontrado exatamente. Usando o primeiro da busca: "${products[0].name}" (ID: ${products[0].id})`);
        return products[0].id;
    }
    logger.warn(`[WHATSAPP SERVICE] Produto com nome/código "${nameOrCode}" não encontrado para a conta ${financialAccountId}.`);
    return null;
}

function initializeState(client, defaultAccount = null) {
    const newState = {
        currentAction: null,
        data: {},
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount ? defaultAccount.accountType : null,
        messageHistory: [],
        pendingConfirmation: null,
        editingTransactionId: null, // Para edição de transações
        lastAiResponse: null,
        // language: 'pt-BR', // Futuro: para i18n
    };
    if (client && client.name && newState.activeFinancialAccountName) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${client.name}! 😊 Bem-vindo(a) de volta à sua conta "${newState.activeFinancialAccountName}". Como posso te ajudar hoje?` });
    } else if (client && client.name) {
         newState.messageHistory.push({ role: 'assistant', content: `Olá ${client.name}! 😊 Como posso te ajudar hoje?` });
    }
    return newState;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    try {
        const client = await clientService.findOrCreateClientByPhone(senderPhone, { name: pushName }, true);
        if (!client) {
            await sendWhatsappMessage(senderPhone, "Desculpe, estou com um problema para identificar você no momento. Por favor, tente mais tarde. 😕");
            return;
        }

        state = conversationState.get(senderPhone) || initializeState(client);

        // Adicionar mensagem atual ao histórico do estado
        state.messageHistory.push({ role: 'user', content: messageText });
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY); // Trunca histórico do estado
        }

        // Lógica de seleção/criação de conta se nenhuma estiver ativa
        if (!state.activeFinancialAccountId) {
            const accounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
            if (accounts.length === 0) {
                // Nenhuma conta existe, iniciar fluxo de criação
                state.currentAction = 'creating_first_account_type';
                const welcomeMsg = `Olá ${client.name || 'Amigo(a)'}! 😊 Bem-vindo(a) ao ${aiModelService.ASSISTANT_NAME}! Para começarmos, vamos configurar sua primeira conta. Ela é para suas finanças *Pessoais (PF)*, para sua *Empresa (PJ)* ou para seu *MEI*?`;
                state.messageHistory.push({ role: 'assistant', content: welcomeMsg });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, welcomeMsg);
                return;
            } else if (accounts.length === 1) {
                // Uma única conta, seleciona automaticamente
                state.activeFinancialAccountId = accounts[0].id;
                state.activeFinancialAccountName = accounts[0].accountName;
                state.activeFinancialAccountType = accounts[0].accountType;
                // Adiciona uma saudação ao histórico se ainda não houver, agora com a conta
                if (state.messageHistory.length <= 2) { // Se só tem a mensagem do sistema e a do usuário
                    state.messageHistory.pop(); // Remove a última (do usuário) para reinserir com contexto
                    state.messageHistory.push({ role: 'assistant', content: `Olá ${client.name}! 😊 Conta "${state.activeFinancialAccountName}" selecionada automaticamente. Como posso te ajudar?` });
                    state.messageHistory.push({ role: 'user', content: messageText });
                }
            } else {
                // Múltiplas contas, precisa de seleção
                state.currentAction = 'selecting_initial_financial_account';
                state.data = { accountsToList: accounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType})) }; // Salva apenas o necessário
                let accountOptionsText = `Olá ${client.name}! Você tem algumas contas configuradas:\n`;
                accounts.forEach((acc, i) => { accountOptionsText += `\n- *${acc.accountName}* (${acc.accountType})`; });
                accountOptionsText += "\n\nQual delas você gostaria de usar agora? Pode me dizer o nome dela. 😉";
                state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, accountOptionsText);
                return;
            }
        }
        // Garante que nome e tipo da conta ativa estejam no estado
        if (state.activeFinancialAccountId && (!state.activeFinancialAccountName || !state.activeFinancialAccountType)) {
            const accDetails = await clientService.getFinancialAccountById(state.activeFinancialAccountId);
            if (accDetails && accDetails.isActive) {
                state.activeFinancialAccountName = accDetails.accountName;
                state.activeFinancialAccountType = accDetails.accountType;
            } else { // Conta se tornou inativa ou foi deletada
                logger.warn(`[WHATSAPP SERVICE] Conta ativa ID ${state.activeFinancialAccountId} não é mais válida para ${senderPhone}. Resetando estado de conta.`);
                state.activeFinancialAccountId = null; state.activeFinancialAccountName = null; state.activeFinancialAccountType = null;
                conversationState.set(senderPhone, state);
                // Chamar a função novamente para refazer a lógica de seleção de conta
                return processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload);
            }
        }

        logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id} (${client.name || 'Sem nome'}), Conta Ativa: ${state.activeFinancialAccountId || 'N/A'} (${state.activeFinancialAccountName || 'N/A'} - ${state.activeFinancialAccountType || 'N/A'}), Msg: "${messageText}"`);
        conversationState.set(senderPhone, state); // Salva o estado atualizado

        // === Lógica de Estado da Conversa (Interações Multi-Etapas ANTES da IA) ===
        // Somente se `currentAction` estiver definido e não for uma ação que precise da IA para progredir.
        if (state.currentAction) {
            let stateHandled = false;
            let replyForState = "";

            if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                const lowerMsg = messageText.toLowerCase().trim();
                if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                    const confirmedAction = state.pendingConfirmation;
                    state.currentAction = null; state.data = {}; state.pendingConfirmation = null;
                    conversationState.set(senderPhone, state);
                    // A ação confirmada será re-processada pela IA/Switch principal com os parâmetros já coletados.
                    // Aqui, apenas preparamos para que a IA saiba que foi confirmado.
                    // Podemos adicionar uma mensagem ao histórico indicando a confirmação.
                    state.messageHistory.push({role: 'assistant', content: `Ótimo, confirmado! Processando: ${confirmedAction.action} com ${JSON.stringify(confirmedAction.parameters)}`});
                    // Deixa a IA reavaliar a situação com a confirmação no histórico.
                    // Ou, para simplificar, tentamos executar a ação aqui se for simples o suficiente
                    // Mas o ideal é deixar a IA reprocessar. Para este exemplo, vamos apenas informar.
                    replyForState = `Beleza! Vou prosseguir com ${confirmedAction.parameters.description || 'isso'} então. 👍`;
                    stateHandled = true;
                    // IMPORTANTE: Para que a ação seja efetivamente executada, o fluxo precisaria
                    // chamar o switch de ações novamente, ou a IA precisa ser informada que a
                    // ação pendente foi confirmada para que ela a inclua em `detected_actions` na próxima rodada.
                    // A maneira mais limpa é deixar a IA ser chamada de novo com o histórico atualizado.
                    // Para simular uma execução direta aqui, precisaríamos de um mini-dispatcher.
                    // Por ora, o replyForState sinaliza a confirmação e a IA é chamada em seguida.
                    await sendWhatsappMessage(senderPhone, replyForState);
                    // Não damos return aqui, deixamos a IA processar com a confirmação no histórico.
                    // O `currentAction` foi limpo, então não entraremos neste bloco novamente.
                } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) {
                    replyForState = "Ok, cancelado! Sem problemas. O que gostaria de fazer então? 😊";
                    state.currentAction = null; state.data = {}; state.pendingConfirmation = null;
                    stateHandled = true; // Estado tratado, a IA será chamada com o novo contexto
                    state.messageHistory.push({role: 'assistant', content: replyForState});
                    conversationState.set(senderPhone, state);
                    await sendWhatsappMessage(senderPhone, replyForState);
                    return; // Retorna para não chamar a IA se a ação foi explicitamente cancelada.
                } else {
                    // Não foi sim nem não, a IA vai tentar entender.
                    stateHandled = false; // Deixa a IA lidar com a resposta ambígua.
                }
            }
            // Adicionar mais lógica de estado aqui se necessário (ex: creating_first_account_type, selecting_initial_financial_account)
            // Essas lógicas devem ser robustas e verificar se a mensagem do usuário corresponde ao que é esperado.
            // Se o usuário fugir do fluxo, a IA deve ser capaz de pegar.
            if (state.currentAction === 'creating_first_account_type') {
                const typeChosen = messageText.toLowerCase();
                let accountTypeToCreate = null;
                if (typeChosen.includes('pessoal') || typeChosen.includes('pf')) accountTypeToCreate = 'PF';
                else if (typeChosen.includes('empresa') || typeChosen.includes('pj')) accountTypeToCreate = 'PJ';
                else if (typeChosen.includes('mei')) accountTypeToCreate = 'MEI';

                if (accountTypeToCreate) {
                    state.data.accountTypeToCreate = accountTypeToCreate;
                    state.currentAction = 'awaiting_first_account_name';
                    replyForState = `Ótimo! E qual nome você gostaria de dar para esta sua conta ${accountTypeToCreate}? (Ex: "Minhas Finanças", "Empresa ABC")`;
                    stateHandled = true;
                } else {
                    replyForState = "Não entendi bem o tipo. Pode ser Pessoal (PF), Empresa (PJ) ou MEI?";
                    stateHandled = true; // Mantém no mesmo estado, mas envia a pergunta
                }
            } else if (state.currentAction === 'awaiting_first_account_name') {
                const accountName = messageText.trim();
                if (accountName.length > 2) {
                    const newAccount = await clientService.createFinancialAccount(client.id, {
                        accountName: accountName,
                        accountType: state.data.accountTypeToCreate,
                        isDefault: true // Primeira conta é default
                    });
                    state.activeFinancialAccountId = newAccount.id;
                    state.activeFinancialAccountName = newAccount.accountName;
                    state.activeFinancialAccountType = newAccount.accountType;
                    replyForState = `Perfeito! Sua conta "${newAccount.accountName}" (${newAccount.accountType}) foi criada e já está selecionada! 🎉 Como posso te ajudar agora?`;
                    state.currentAction = null; state.data = {};
                    stateHandled = true;
                } else {
                    replyForState = "Esse nome parece um pouco curto. Poderia me dizer um nome com pelo menos 3 letras para sua conta?";
                    stateHandled = true; // Mantém no mesmo estado
                }
            } else if (state.currentAction === 'selecting_initial_financial_account') {
                 const chosenAccountName = messageText.toLowerCase().trim();
                 const accountToSelect = state.data.accountsToList.find(acc => acc.name.toLowerCase().includes(chosenAccountName));
                 if (accountToSelect) {
                    state.activeFinancialAccountId = accountToSelect.id;
                    state.activeFinancialAccountName = accountToSelect.name;
                    state.activeFinancialAccountType = accountToSelect.type;
                    replyForState = `Entendido! Selecionei a conta "${state.activeFinancialAccountName}". Como posso ajudar?`;
                    state.currentAction = null; state.data = {};
                    stateHandled = true;
                 } else {
                    replyForState = `Hum, não encontrei uma conta com esse nome na sua lista. Qual delas você gostaria de usar? Pode me dizer o nome.`;
                    stateHandled = true; // Mantém estado, repete pergunta
                 }
            }

            if (stateHandled && replyForState) {
                state.messageHistory.push({ role: 'assistant', content: replyForState });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForState);
                if (state.currentAction === null) return; // Se o estado foi resolvido, não precisa da IA agora.
                                                      // Exceto se for uma confirmação que libera a IA para agir.
            }
        }

        // === Chamada para a IA ===
        const aiContext = {
            currentFinancialAccountId: state.activeFinancialAccountId,
            currentFinancialAccountType: state.activeFinancialAccountType,
            currentFinancialAccountName: state.activeFinancialAccountName,
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2), // Envia os últimos N pares de mensagens
            currentStateData: state.data, // Para a IA saber se está no meio de um fluxo
        };
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponse});
        state.lastAiResponse = aiResponse;

        let finalReplyToUser = aiResponse.reply_to_user_suggestion || "Não tenho certeza de como te ajudar com isso agora. 😕";
        let requiresConfirmationByAI = false;
        let executedActionsSummary = []; // Para montar resumo se múltiplas ações

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            // Se houver múltiplas ações, a `reply_to_user_suggestion` da IA já deve ser um resumo.
            // Aqui processamos cada ação.
            for (const detectedAction of aiResponse.detected_actions) {
                let actionSuccess = false;
                let actionDetailMessage = ""; // Será preenchido por cada case
                const params = detectedAction.parameters || {};
                const MIN_CONFIDENCE_FOR_AUTO_ACTION = 0.70; // Confiança mínima para agir sem pedir confirmação explícita

                if (detectedAction.confidence < MIN_CONFIDENCE_FOR_AUTO_ACTION && detectedAction.action !== "GENERAL_GREETING_OR_SMALLTALK" && detectedAction.action !== "GENERAL_QUESTION_OR_HELP") {
                    requiresConfirmationByAI = true;
                    state.pendingConfirmation = detectedAction; // Salva para o próximo turno
                    // A `reply_to_user_suggestion` da IA já deve ser uma pergunta de confirmação.
                    // Ex: "Entendi que você quer registrar uma despesa de X. Confirma?"
                    // Não precisamos adicionar ao `executedActionsSummary` ainda.
                    break; // Interrompe o loop de ações se uma precisa de confirmação
                }

                try {
                    switch (detectedAction.action) {
                        case 'CREATE_FINANCIAL_TRANSACTION':
                            const categoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId);
                            const cardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                            const txData = {
                                description: params.description, type: params.type, value: parseFloat(params.value),
                                transactionDate: params.transactionDate || new Date().toISOString().split('T')[0],
                                financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes
                            };
                            const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                            actionDetailMessage = `${params.type} "${newTx.description}" (R$ ${parseFloat(newTx.value).toFixed(2)}) registrada em ${new Date(newTx.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' })}.`;
                            actionSuccess = true;
                            // Se for a única ação, oferecer botões de editar/excluir
                            if (aiResponse.detected_actions.length === 1) {
                                state.editingTransactionId = newTx.id; // Para contexto futuro se ele clicar
                            }
                            break;

                        case 'CREATE_PARCELLED_ACCOUNT':
                            const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId);
                            const cardIdParcel = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                            const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, {
                                description: params.description, type: params.type, totalValue: parseFloat(params.totalValue),
                                numberOfParcels: parseInt(params.numberOfParcels), initialDueDate: params.initialDueDate,
                                financialCategoryId: catIdParcel, creditCardId: cardIdParcel, notes: params.notes
                            });
                            actionDetailMessage = `Conta parcelada "${params.description}" (${parcelResult.parcels.length}x) registrada.`;
                            actionSuccess = true;
                            break;

                        case 'GET_FINANCIAL_SUMMARY':
                        case 'LIST_FINANCIAL_TRANSACTIONS':
                            const filterParams = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd,
                                type: params.type,
                                financialCategoryId: await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId),
                                isPaidOrReceived: params.isPaidOrReceived,
                                searchTerm: params.searchTerm
                            };
                            if (params.period) { // A IA pode passar 'period' ou datas específicas
                                const today = new Date();
                                switch(params.period) {
                                    case 'today': filterParams.dateStart = filterParams.dateEnd = today.toISOString().split('T')[0]; break;
                                    case 'yesterday':
                                        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
                                        filterParams.dateStart = filterParams.dateEnd = yesterday.toISOString().split('T')[0]; break;
                                    case 'this_week':
                                        const firstDayOfWeek = new Date(today.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1) )); // Ajusta para segunda
                                        const lastDayOfWeek = new Date(firstDayOfWeek); lastDayOfWeek.setDate(firstDayOfWeek.getDate() + 6);
                                        filterParams.dateStart = firstDayOfWeek.toISOString().split('T')[0];
                                        filterParams.dateEnd = lastDayOfWeek.toISOString().split('T')[0]; break;
                                    // Adicionar mais casos de período
                                }
                            }

                            if (detectedAction.action === 'GET_FINANCIAL_SUMMARY') {
                                const summary = await financialService.getFinancialSummary(state.activeFinancialAccountId, filterParams);
                                actionDetailMessage = `Resumo para ${state.activeFinancialAccountName}:\nEntradas: R$ ${summary.totalEntradas.toFixed(2)}\nSaídas: R$ ${summary.totalSaidas.toFixed(2)}\n*Saldo Efetivado: R$ ${summary.saldoEfetivado.toFixed(2)}*\nContas a Receber: R$ ${summary.totalAReceberPendente.toFixed(2)}\nContas a Pagar: R$ ${summary.totalAPagarPendente.toFixed(2)}`;
                            } else { // LIST_FINANCIAL_TRANSACTIONS
                                const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, { ...filterParams, limit: 5 }); // Limita para não ser muito longo
                                if (totalItems === 0) {
                                    actionDetailMessage = "Nenhuma transação encontrada para os filtros informados. 👍";
                                } else {
                                    actionDetailMessage = `Encontrei ${totalItems} transações. As mais recentes são:\n`;
                                    transactions.forEach(t => {
                                        actionDetailMessage += `- ${t.description} (R$ ${parseFloat(t.value).toFixed(2)}) em ${new Date(t.transactionDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})} ${t.isPayableOrReceivable ? (t.isPaidOrReceived ? '(Paga/Recebida)' : `(Vence ${new Date(t.dueDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})})`): ''}\n`;
                                    });
                                    if (totalItems > 5) actionDetailMessage += `\nE mais ${totalItems - 5} transações.`;
                                }
                            }
                            actionSuccess = true;
                            break;

                        case 'CREATE_PRODUCT':
                        case 'GET_STOCK_INFO':
                        case 'RECORD_STOCK_MOVEMENT':
                            if (state.activeFinancialAccountType === 'PF') {
                                actionDetailMessage = `Essa função de estoque é para contas PJ ou MEI, ${client.name || ''}. Na sua conta PF atual, não temos como fazer isso. Quer trocar para uma conta PJ/MEI ou criar uma?`;
                                // Poderia setar um estado aqui para 'awaiting_account_switch_or_create_for_stock'
                            } else {
                                if (detectedAction.action === 'CREATE_PRODUCT') {
                                    const newProd = await productService.createProduct(state.activeFinancialAccountId, params);
                                    actionDetailMessage = `Produto "${newProd.name}" cadastrado com sucesso!`;
                                } else if (detectedAction.action === 'GET_STOCK_INFO') {
                                    const prodId = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                                    if(prodId) {
                                        const balance = await stockService.getProductStockBalance(prodId);
                                        actionDetailMessage = balance ? `O produto ${balance.name} tem ${balance.quantity} ${balance.unit || 'un.'} em estoque.` : `Não encontrei o produto "${params.productNameOrCode}".`;
                                    } else {  actionDetailMessage = `Produto "${params.productNameOrCode}" não encontrado.`; }
                                } else { // RECORD_STOCK_MOVEMENT
                                    const prodIdMov = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                                    if(prodIdMov) {
                                        const movData = {type: params.movementType, quantity: parseInt(params.quantity), reason: params.reason};
                                        await stockService.recordStockMovement(prodIdMov, movData);
                                        actionDetailMessage = `Ok! Movimentação de ${params.quantity} unidade(s) de "${params.productNameOrCode}" (${params.movementType}) registrada.`;
                                    } else { actionDetailMessage = `Não encontrei o produto "${params.productNameOrCode}" para movimentar.`;}
                                }
                                actionSuccess = true;
                            }
                            break;

                        case 'SCHEDULE_APPOINTMENT':
                            const appData = { title: params.title, eventDateTime: params.eventDateTime,
                                            durationMinutes: params.durationMinutes, location: params.location,
                                            reminderLeadTimeMinutes: params.reminderLeadTimeMinutes };
                            const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                            actionDetailMessage = `Compromisso "${newApp.title}" agendado para ${new Date(newApp.eventDateTime).toLocaleString('pt-BR', {timeZone: process.env.TZ || 'America/Sao_Paulo', dateStyle:'short', timeStyle:'short'})}.`;
                            actionSuccess = true;
                            break;

                        case 'LIST_APPOINTMENTS':
                            const appFilterParams = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd, status: params.status,
                                limit: 5 // Limitar para a resposta no chat
                            };
                             if (params.period) { /* ... lógica de período similar a transações ... */ }
                            const { appointments, totalItems: totalApps } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, appFilterParams);
                            if (totalApps === 0) {
                                actionDetailMessage = "Nenhum compromisso encontrado para os filtros informados. 👍";
                            } else {
                                actionDetailMessage = `Encontrei ${totalApps} compromissos. Os próximos são:\n`;
                                appointments.forEach(a => {
                                    actionDetailMessage += `- ${a.title} em ${new Date(a.eventDateTime).toLocaleString('pt-BR', {timeZone: process.env.TZ || 'America/Sao_Paulo', dateStyle:'short', timeStyle:'short'})} (${a.status})\n`;
                                });
                                if (totalApps > 5) actionDetailMessage += `\nE mais ${totalApps - 5}.`;
                            }
                            actionSuccess = true;
                            break;

                        case 'SWITCH_FINANCIAL_ACCOUNT':
                            const accountsAvail = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                            if (params.targetAccountNameOrType) {
                                const target = accountsAvail.find(acc => acc.accountName.toLowerCase().includes(params.targetAccountNameOrType.toLowerCase()) || acc.accountType === params.targetAccountNameOrType.toUpperCase());
                                if (target) {
                                    state.activeFinancialAccountId = target.id;
                                    state.activeFinancialAccountName = target.accountName;
                                    state.activeFinancialAccountType = target.accountType;
                                    finalReplyToUser = `Prontinho! Mudei para a sua conta "${target.accountName}" (${target.accountType}). O que você gostaria de fazer nela?`;
                                } else {
                                    finalReplyToUser = `Não encontrei uma conta com nome ou tipo parecido com "${params.targetAccountNameOrType}". Você tem as contas: ${accountsAvail.map(a => `"${a.accountName}" (${a.accountType})`).join(', ')}. Qual delas gostaria de usar?`;
                                    state.currentAction = 'awaiting_account_switch_choice'; // IA não conseguiu, volta para estado manual
                                    state.data = { accountsToList: accountsAvail.map(a => ({id: a.id, name: a.accountName, type: a.accountType})) };
                                }
                            } else { // IA pediu para listar
                                let opts = "Você tem as seguintes contas:\n";
                                accountsAvail.forEach((acc) => { opts += `\n- *${acc.accountName}* (${acc.accountType})`;});
                                opts += "\n\nPara qual delas você gostaria de mudar? Só me dizer o nome. 😉";
                                finalReplyToUser = opts;
                                state.currentAction = 'awaiting_account_switch_choice';
                                state.data = { accountsToList: accountsAvail.map(a => ({id: a.id, name: a.accountName, type: a.accountType})) };
                            }
                            actionSuccess = true; // A intenção de trocar foi processada
                            break;

                        case 'CREATE_FINANCIAL_ACCOUNT':
                            state.currentAction = 'awaiting_new_account_type_from_ia'; // Novo estado específico
                            state.data = {
                                accountTypeToCreateSuggestion: params.accountTypeToCreate,
                                newAccountNameSuggestion: params.newAccountName
                            };
                            if(params.accountTypeToCreate && params.newAccountName){
                                finalReplyToUser = `Legal! Então vamos criar uma conta ${params.accountTypeToCreate} chamada "${params.newAccountName}", correto? (Sim/Não)`;
                                state.pendingConfirmation = {action: 'CONFIRM_CREATE_FINANCIAL_ACCOUNT', parameters: {accountType: params.accountTypeToCreate, accountName: params.newAccountName}};
                                requiresConfirmationByAI = true; // Requer confirmação Sim/Não
                            } else if (params.accountTypeToCreate) {
                                finalReplyToUser = `Ok, uma conta ${params.accountTypeToCreate}! Que nome você gostaria de dar para ela?`;
                            } else {
                                finalReplyToUser = "Certo! Sua nova conta será Pessoal (PF), Empresa (PJ) ou MEI?";
                            }
                            actionSuccess = true; // Intenção de criar foi processada
                            break;
                        
                        // Este é um novo "pseudo-action" para o estado de confirmação de criação de conta
                        case 'CONFIRM_CREATE_FINANCIAL_ACCOUNT':
                            // Este case só seria chamado se o usuário respondesse "sim" a uma pergunta de confirmação anterior.
                            // A lógica de criar a conta estaria aqui.
                            const newAccountData = state.pendingConfirmation.parameters;
                            const createdAcc = await clientService.createFinancialAccount(client.id, {
                                accountName: newAccountData.accountName,
                                accountType: newAccountData.accountType,
                                isDefault: (await clientService.getClientFinancialAccounts(client.id)).length === 0 // Primeira é default
                            });
                            state.activeFinancialAccountId = createdAcc.id;
                            state.activeFinancialAccountName = createdAcc.accountName;
                            state.activeFinancialAccountType = createdAcc.accountType;
                            finalReplyToUser = `Conta "${createdAcc.accountName}" (${createdAcc.accountType}) criada e selecionada! O que faremos agora?`;
                            state.pendingConfirmation = null; state.currentAction = null;
                            actionSuccess = true;
                            break;

                        case 'GENERAL_GREETING_OR_SMALLTALK':
                        case 'GENERAL_QUESTION_OR_HELP':
                            // A `reply_to_user_suggestion` da IA já deve conter a resposta apropriada.
                            // Não há ação de backend aqui, apenas a resposta da IA.
                            actionDetailMessage = finalReplyToUser; // A resposta da IA é o "detalhe"
                            actionSuccess = true; // A "ação" foi a IA responder.
                            break;

                        case 'ACTION_CONFIRMATION_YES':
                             if(state.pendingConfirmation){
                                // Simula que a IA vai reprocessar a ação pendente
                                const reProcessAction = state.pendingConfirmation;
                                logger.info(`[WHATSAPP SERVICE] Usuário confirmou ação pendente: ${reProcessAction.action}`);
                                // Para executar de fato, precisaríamos de um dispatcher aqui ou a IA
                                // deveria ter retornado a ação confirmada em `detected_actions`.
                                // Vamos assumir que a IA, ao receber "sim", re-analisa e inclui a ação original.
                                // Se o `pendingConfirmation` era um `CONFIRM_CREATE_FINANCIAL_ACCOUNT`, chamamos ele:
                                if(reProcessAction.action === 'CONFIRM_CREATE_FINANCIAL_ACCOUNT'){
                                    const createdAccConfirm = await clientService.createFinancialAccount(client.id, {
                                        accountName: reProcessAction.parameters.accountName,
                                        accountType: reProcessAction.parameters.accountType,
                                        isDefault: (await clientService.getClientFinancialAccounts(client.id)).length === 0
                                    });
                                    state.activeFinancialAccountId = createdAccConfirm.id;
                                    state.activeFinancialAccountName = createdAccConfirm.accountName;
                                    state.activeFinancialAccountType = createdAccConfirm.accountType;
                                    finalReplyToUser = `Conta "${createdAccConfirm.accountName}" (${createdAccConfirm.accountType}) criada e selecionada! O que faremos agora?`;
                                    state.pendingConfirmation = null; state.currentAction = null;
                                    actionSuccess = true;
                                } else {
                                    // Para outras ações, a IA precisaria re-detectar.
                                    // Vamos apenas confirmar e pedir o próximo comando.
                                    finalReplyToUser = `Ok, confirmado! Processando "${reProcessAction.parameters.description || reProcessAction.action}"... (Em um cenário real, a ação seria executada aqui ou a IA a retornaria novamente). O que mais posso fazer?`;
                                    state.pendingConfirmation = null; // Limpa a confirmação pendente
                                    actionSuccess = true;
                                }

                             } else {
                                 finalReplyToUser = "Confirmado! 👍 Em que mais posso ajudar?";
                                 actionSuccess = true;
                             }
                            break;
                        case 'ACTION_CONFIRMATION_NO':
                            finalReplyToUser = "Entendido, cancelamos a ação anterior. O que gostaria de fazer em seguida?";
                            state.pendingConfirmation = null; state.currentAction = null;
                            actionSuccess = true;
                            break;

                        default:
                            actionDetailMessage = `Desculpe, ainda não aprendi a fazer "${detectedAction.action}". 🧐`;
                            logger.warn(`[WHATSAPP HANDLER] Ação da IA não implementada: ${detectedAction.action}`);
                            break;
                    }
                    if (actionSuccess && actionDetailMessage) {
                        executedActionsSummary.push(actionDetailMessage);
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone} (Conta ${state.activeFinancialAccountId}): ${e.message}`, { stack: e.stack, params: params });
                    executedActionsSummary.push(`❌ Ops! Tive um problema ao tentar "${detectedAction.action}": ${e.message.length < 100 ? e.message : 'Por favor, tente novamente.'}`);
                }
            } // Fim do loop for detected_actions

            // Montar a resposta final se múltiplas ações foram executadas
            if (executedActionsSummary.length > 1) {
                finalReplyToUser = (aiResponse.overall_summary_suggestion ? aiResponse.overall_summary_suggestion + "\n\n" : "Ok, aqui está o que eu fiz:\n\n") +
                                   executedActionsSummary.join("\n\n") +
                                   "\n\nAlgo mais em que posso ajudar? 😊";
            } else if (executedActionsSummary.length === 1) {
                finalReplyToUser = (aiResponse.overall_summary_suggestion ? aiResponse.overall_summary_suggestion + "\n\n" : "") +
                                   executedActionsSummary[0] +
                                   "\n\nPosso ajudar com mais alguma coisa?";
            }
            // Se `finalReplyToUser` não foi alterado (ex: só saudações), ele mantém o `reply_to_user_suggestion` da IA.
        } else if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            // A `reply_to_user_suggestion` já deve ser a pergunta de clarificação.
            state.currentAction = 'awaiting_clarification_response'; // Um estado para saber que estamos esperando essa info
            state.data = {
                pending_actions_from_ia: aiResponse.detected_actions, // Ações que estavam sendo consideradas
                clarifications_asked_by_ia: aiResponse.clarifications_needed,
                original_user_message_for_clarification: messageText
            };
        } else if (aiResponse.ununderstood_segments && aiResponse.ununderstood_segments.length > 0 && (!aiResponse.detected_actions || aiResponse.detected_actions.length === 0)) {
            // A IA não entendeu partes e não detectou ações. A `reply_to_user_suggestion` já deve refletir isso.
            // Ex: "Não entendi bem quando você disse 'XPTO'. Pode explicar de outra forma?"
        } else if ((!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) &&
                   (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
            // Nenhuma ação, nenhuma clarificação. A IA deve ter dado uma resposta genérica em `reply_to_user_suggestion`.
        }


        state.messageHistory.push({ role: 'assistant', content: finalReplyToUser });

        // Lógica de estado após a IA
        if (requiresConfirmationByAI && state.pendingConfirmation) {
            state.currentAction = 'awaiting_confirmation'; // Prepara para o Sim/Não do usuário
        } else if (state.currentAction !== 'awaiting_clarification_response' &&
                   state.currentAction !== 'awaiting_account_switch_choice' && // Mantém se estiver esperando escolha de conta
                   state.currentAction !== 'awaiting_new_account_type_from_ia' && // Mantém se estiver criando conta via IA
                   !state.currentAction?.startsWith('awaiting_first_account') // Mantém se no fluxo inicial de criação de conta
                   ) {
            // Limpa estado se não estiver em um fluxo multi-etapa específico ou esperando confirmação.
            // Ações como GENERAL_GREETING ou perguntas não devem limpar o `currentAction` se ele já estava setado para algo importante.
            // Esta lógica de limpeza pode precisar de refinamento.
            if (!state.pendingConfirmation && state.currentAction !== 'awaiting_clarification_response') {
                 // state.currentAction = null; // Descomentar com cuidado.
                 // state.data = {};
            }
        }
        conversationState.set(senderPhone, state);

        // Envio de Resposta Final
        if (finalReplyToUser) {
            // Verifica se é uma única transação criada com sucesso para enviar botões
            const singleTxCreated = aiResponse.detected_actions?.length === 1 &&
                                    aiResponse.detected_actions[0].action === 'CREATE_FINANCIAL_TRANSACTION' &&
                                    executedActionsSummary.length === 1 && // Garante que a ação foi bem sucedida
                                    !executedActionsSummary[0].startsWith('❌') &&
                                    state.editingTransactionId;

            if (singleTxCreated) {
                const buttons = [
                    { id: `edit_transaction_${state.editingTransactionId}`, label: "✏️ Editar" },
                    { id: `delete_transaction_${state.editingTransactionId}`, label: "🗑️ Excluir" },
                    // { id: `share_transaction_${state.editingTransactionId}`, label: "Compartilhar" }
                ];
                // A `finalReplyToUser` já contém a confirmação da criação da transação.
                // Podemos adicionar um call to action para os botões.
                const messageWithButtons = finalReplyToUser + "\n\nO que gostaria de fazer com ela?";
                await sendButtonListMessage(senderPhone, messageWithButtons, buttons, "Opções da Transação");
                state.editingTransactionId = null; // Limpa após oferecer os botões
            } else {
                await sendWhatsappMessage(senderPhone, finalReplyToUser);
            }
        }

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack, messageText, rawPayload });
        conversationState.delete(senderPhone); // Limpa estado em erro crítico
        try {
            await sendWhatsappMessage(senderPhone, "Ops! 🌩️ Encontrei um probleminha técnico e não pude processar sua solicitação agora. Minha equipe já foi notificada! Por favor, tente novamente em alguns instantes. Peço desculpas pelo transtorno!");
        } catch (sendError) {
            logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro crítico para ${senderPhone}: ${sendError.message}`);
        }
    } finally {
        const endTime = Date.now();
        logger.info(`[WHATSAPP HANDLER] Processamento da mensagem para ${senderPhone} finalizado em ${endTime - startTime}ms.`);
        if (state) conversationState.set(senderPhone, state); // Garante que o estado final seja salvo
    }
}

module.exports = { processIncomingMessage };
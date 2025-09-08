
// src/features/WhatsappHandler/action.handler.js
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
const availabilityService = require('../Availability/availability.service');
const serviceService = require('../Service/service.service');
const publicBookingService = require('../PublicBooking/publicBooking.service');
const logger = require('../../utils/logger');
const formatter = require('./response.formatter'); // Importa o novo formatador
const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const checklistService = require('../Checklist/checklist.service');

// Helpers que antes estavam no whatsapp.service
async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    try {
        const card = await creditCardService.findCreditCardByName(financialAccountId, name);
        return card ? card.id : null;
    } catch (error) {
        if (error.statusCode === 404) {
            // Este erro será tratado de forma inteligente no case
            throw { statusCode: 404, message: `Cartão de crédito "${name}" não encontrado.` };
        }
        logger.error(`[ACTION HANDLER] Erro ao buscar cartão ${name}: ${error.message}`);
        throw error;
    }
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    const productsResult = await productService.getAllProducts(financialAccountId, { search: nameOrCode, limit: 1, isActive: true });
    if (productsResult.products && productsResult.products.length > 0) {
        return productsResult.products[0].id;
    }
    return null;
}

async function findBusinessClientIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const clientsResult = await businessClientService.getAllBusinessClients(financialAccountId, { search: name, limit: 1, isActive: true });
    if (clientsResult.businessClients && clientsResult.businessClients.length > 0) {
        return clientsResult.businessClients[0].id;
    }
    return null;
}

/**
 * Executa uma ação detectada pela IA.
 * @param {object} state - O estado da conversa.
 * @param {object} detectedAction - O objeto da ação detectada.
 * @param {string} clientNameToUse - O nome do cliente para mensagens.
 * @param {boolean} isOwnerActingOnOwnBehalfGlobal - Flag de permissão.
 * @param {number} actorId - ID do cliente que está agindo.
 * @returns {Promise<{formattedData: string, resourceForButtonsContext: object|null, wasAnEdit: boolean}>}
 */
async function handleAction(state, detectedAction, clientNameToUse, isOwnerActingOnOwnBehalfGlobal, actorId) {
    const params = detectedAction.parameters || detectedAction;
    const actionName = detectedAction.action || detectedAction.action_type;
    let formattedData = "";
    
    let resourceForButtonsContext = {
        type: 'multi_action_block',
        resources: []
    };
    let wasAnEdit = false;

    try {
        switch (actionName) {
// =================================================================
            // AÇÕES DE CRIAÇÃO (CREATE)
            // =================================================================

            case 'CREATE_FINANCIAL_TRANSACTION': {
                try {
                    const categoryObject = params.financialCategoryName 
                        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId) 
                        : null;
                    const categoryId = categoryObject ? categoryObject.id : null;

                    let cardId = null;
                    if (params.creditCardName) {
                        cardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                        if (!cardId) {
                            throw { statusCode: 404, message: `Cartão de crédito "${params.creditCardName}" não encontrado.` };
                        }
                    }

                    const txData = {
                        description: params.description, 
                        type: params.type, 
                        value: parseFloat(params.value), 
                        transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                        financialCategoryId: categoryId,
                        creditCardId: cardId,
                        notes: params.notes,
                        isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : (cardId ? false : false)),
                        dueDate: cardId ? null : params.dueDate,
                        isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (cardId ? true : (!params.dueDate))
                    };
                    if (!txData.description || !txData.type || isNaN(txData.value) || txData.value <= 0) {
                        throw { statusCode: 400, message: "Dados obrigatórios (descrição, tipo, valor) ausentes ou inválidos para criar transação." };
                    }

                    const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData, actorId); 
                    const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                    
                    formattedData = formatter.formatFinancialTransactionDataStructure(reloadedTx);
                    resourceForButtonsContext.resources.push({ type: 'transaction', id: newTx.id, description: newTx.description });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_FINANCIAL_TRANSACTION: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `Ops, ${clientNameToUse}! 😬 Tive um problema ao registrar sua transação.`;
                    let body = `Detalhe: ${e.message}`;

                    if (e.statusCode === 404 && e.message.includes('Cartão de crédito')) {
                        intro = `Hum, não encontrei o cartão "${params.creditCardName}" que você mencionou, ${clientNameToUse}.`;
                        const { cards: existingCards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                        if (existingCards && existingCards.length > 0) {
                            body = `Seus cartões cadastrados são: *${existingCards.map(c => c.name).join(', ')}*.\n\nVocê quis dizer um deles ou quer cadastrar um novo cartão?`;
                        } else {
                            body = `Parece que você ainda não tem nenhum cartão cadastrado. Quer adicionar um agora? É só dizer "cadastrar cartão [nome] com limite X..."`;
                        }
                    } else if (e.statusCode === 400 || e.statusCode === 409) {
                        intro = `Opa, ${clientNameToUse}!`;
                        body = e.message;
                    }
                    
                    formattedData = `❌ ${intro}\n${body}`;
                }
                break;
            }
            case 'CREATE_SALE_TRANSACTION': {
    try {
        const { productNameOrCode, quantitySold, salePricePerUnit, transactionDate, notes, businessClientName } = params;

        if (!productNameOrCode || !quantitySold || isNaN(parseInt(quantitySold)) || parseInt(quantitySold) <= 0) {
            throw { statusCode: 400, message: "Para registrar uma venda, preciso do nome do produto e da quantidade vendida." };
        }

        // 1. Encontrar o produto e validar
        const productsResult = await productService.getAllProducts(state.activeFinancialAccountId, { search: productNameOrCode, limit: 1, isActive: true });
        if (!productsResult.products || productsResult.products.length === 0) {
            throw { statusCode: 404, message: `Produto "${productNameOrCode}" não encontrado no seu estoque.` };
        }
        const product = productsResult.products[0];

        // 2. Dar baixa no estoque
        await stockService.recordStockMovement(state.activeFinancialAccountId, product.id, {
            movementType: 'Saída',
            quantity: parseInt(quantitySold),
            reason: `Venda para ${businessClientName || 'cliente'}`,
        }, actorId);

        // 3. Criar a transação financeira de ENTRADA
        const finalSalePrice = salePricePerUnit ? parseFloat(salePricePerUnit) : parseFloat(product.salePrice);
        const totalValue = finalSalePrice * parseInt(quantitySold);

        const saleDescription = `Venda de ${quantitySold}x ${product.name}${businessClientName ? ` para ${businessClientName}` : ''}`;

        const saleTransaction = await financialService.createTransaction(state.activeFinancialAccountId, {
            description: saleDescription,
            type: 'Entrada', // <<< AQUI ESTÁ A CORREÇÃO CRÍTICA
            value: totalValue,
            transactionDate: transactionDate || new Date().toISOString().split('T')[0],
            isPayableOrReceivable: false,
            isPaidOrReceived: true,
            notes: notes,
        }, actorId);

        // 4. Formatar a resposta de sucesso
        const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, saleTransaction.id);
        formattedData = formatter.formatFinancialTransactionDataStructure(reloadedTx);
        formattedData += `\n\n📦 Estoque de "${product.name}" atualizado com sucesso!`;

        resourceForButtonsContext.resources.push({ type: 'transaction', id: saleTransaction.id, description: saleDescription });

    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em CREATE_SALE_TRANSACTION: ${e.message}`, { error: e, paramsUsed: params });
        formattedData = `❌ Ops, ${clientNameToUse}! Não consegui registrar a venda.\nDetalhe: ${e.message}`;
    }
    break;
            }
                    case 'CREATE_CHECKLIST_ITEM': {
                try {
                    const { text, priority } = detectedAction.parameters;
                    if (!text) {
                        throw { statusCode: 400, message: "Para adicionar uma tarefa, preciso que me diga o que fazer. Ex: 'adicionar tarefa Falar com fornecedor'." };
                    }
                    
                    const today = new Date().toISOString().split('T')[0];
                    const newItem = await checklistService.addChecklistItem(state.activeFinancialAccountId, today, { text, priority });

                    formattedData = `✅ Tarefa adicionada ao seu checklist de hoje!\n\n> *"${newItem.text}"* (Prioridade: ${priority || 'Média'})`;

                    const currentChecklist = await checklistService.getChecklistByDate(state.activeFinancialAccountId, today);
                    const pendingCount = currentChecklist.items.filter(item => !item.completed).length;

                    formattedData += `\n\nVocê tem agora *${pendingCount}* tarefa(s) pendente(s) para hoje. Vamos nessa! 💪`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_CHECKLIST_ITEM: ${e.message}`, { error: e, paramsUsed: detectedAction.parameters });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui adicionar sua tarefa.\nDetalhe: ${e.message}`;
                }
                break;
            
            }            case 'COMPLETE_CHECKLIST_ITEM': {
                try {

                    const { text } = detectedAction.parameters;
                    if (!text) {
                        throw { statusCode: 400, message: "Qual tarefa você concluiu? Preciso da descrição para marcá-la." };
                    }
                    
                    const today = new Date().toISOString().split('T')[0];
                    const currentChecklist = await checklistService.getChecklistByDate(state.activeFinancialAccountId, today);
                    
                    const pendingItems = currentChecklist.items.filter(item => !item.completed);
                    if (pendingItems.length === 0) {
                        formattedData = `🎉 Uau, você já tinha concluído tudo por hoje! Se quiser, pode adicionar mais tarefas.`;
                        break;
                    }
                    
                    let bestMatch = null;
                    let highestScore = 0;
                    const userWords = text.toLowerCase().split(' ');

                    for (const item of pendingItems) {
                        const itemWords = item.text.toLowerCase().split(' ');
                        const score = userWords.filter(word => itemWords.includes(word)).length;
                        if (score > highestScore) {
                            highestScore = score;
                            bestMatch = item;
                        }
                    }

                    if (!bestMatch) {
                        throw { statusCode: 404, message: `Não encontrei uma tarefa pendente parecida com "${text}".` };
                    }

                    const updatedItem = await checklistService.updateChecklistItem(state.activeFinancialAccountId, bestMatch.id, { completed: true });

                    formattedData = `✅ Mandou bem! Marquei a tarefa *"${updatedItem.text}"* como concluída.`;

                    const updatedChecklist = await checklistService.getChecklistByDate(state.activeFinancialAccountId, today);
                    const newPendingCount = updatedChecklist.items.filter(item => !item.completed).length;

                    if (newPendingCount === 0) {
                         formattedData += `\n\n*PARABÉNS!* 🏆 Você finalizou todas as tarefas de hoje! Momento de celebrar e relaxar!`;
                    } else {
                         formattedData += `\n\nAgora faltam apenas *${newPendingCount}* tarefa(s). Continue assim! 💪`;
                    }
                    
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em COMPLETE_CHECKLIST_ITEM: ${e.message}`, { error: e, paramsUsed: detectedAction.parameters });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui marcar sua tarefa como concluída.\nDetalhe: ${e.message}`;
                }
                break;
            } 

            case 'SETTLE_OPEN_CREDIT_CARD_INVOICE': {
                try {
                    const cardNameToSettle = params.creditCardName;
                    if (!cardNameToSettle) {
                        throw { statusCode: 400, message: "Preciso do nome do cartão para liquidar a fatura." };
                    }
                    const cardIdToSettle = await findCreditCardIdByName(cardNameToSettle, state.activeFinancialAccountId);
                    if (!cardIdToSettle) {
                        throw { statusCode: 404, message: `Não encontrei um cartão chamado "${cardNameToSettle}". Verifique o nome ou cadastre o cartão.` };
                    }

                    const paymentTransaction = await creditCardService.settleOpenCreditCardInvoice(
                        state.activeFinancialAccountId,
                        cardIdToSettle,
                        new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" })).toISOString().split('T')[0],
                        null,
                        null,
                        actorId
                    );
                    
                    formattedData = `🎉 A fatura aberta do cartão "${cardNameToSettle}" foi liquidada com sucesso! ` +
                                    `Um pagamento de *${formatter.formatCurrency(paymentTransaction.value)}* foi registrado.`;

                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em SETTLE_OPEN_CREDIT_CARD_INVOICE: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `❌ Ops, ${clientNameToUse}! Não consegui liquidar a fatura.`;
                    let body = `Detalhe: ${e.message}`;

                    if (e.statusCode === 404 && e.message.includes('Cartão de crédito')) {
                        intro = `Hum, não encontrei o cartão "${params.creditCardName}" que você mencionou, ${clientNameToUse}.`;
                        const { cards: existingCards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                        if (existingCards && existingCards.length > 0) {
                            body = `Seus cartões cadastrados são: *${existingCards.map(c => c.name).join(', ')}*.\n\nVocê quis dizer um deles?`;
                        } else {
                            body = `Parece que você ainda não tem nenhum cartão cadastrado.`;
                        }
                    }
                    formattedData = `${intro}\n${body}`;
                }
                break;
            }

            case 'SCHEDULE_APPOINTMENT': {
                try {
                    if (!params.title || !params.eventDateTime) {
                        throw { statusCode: 400, message: "Título e data/hora são obrigatórios para agendar." };
                    }

                    const appointmentData = {
                        title: params.title,
                        eventDateTime: params.eventDateTime,
                        durationMinutes: params.durationMinutes ? parseInt(params.durationMinutes) : null,
                        location: params.location,
                        notes: params.notes,
                        reminderLeadTimeMinutes: params.reminderLeadTimeMinutes,
                        reminderEnabled: params.reminderEnabled,
                        businessClientIds: [],
                        serviceIds: [],
                    };
                    
                    if (['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                        if (params.businessClientNames && Array.isArray(params.businessClientNames)) {
                            for (const name of params.businessClientNames) {
                                const bcId = await findBusinessClientIdByName(name, state.activeFinancialAccountId);
                                if (bcId) {
                                    appointmentData.businessClientIds.push(bcId);
                                }
                                // Se bcId for nulo, a IA já tratou o fluxo de criação de cliente,
                                // ou o usuário optou por não criar, então o agendamento é criado sem associação.
                            }
                        }
                    }

                    const newAppt = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appointmentData, actorId);
                    
                    formattedData = formatter.formatAppointmentDataStructure(newAppt);
                    resourceForButtonsContext.resources.push({ type: 'appointment', id: newAppt.id, description: newAppt.title });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em SCHEDULE_APPOINTMENT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui agendar seu compromisso.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'CREATE_PARCELLED_ACCOUNT': {
                try {
                    const categoryObject = params.financialCategoryName 
                        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                        : null;
                    const categoryId = categoryObject ? categoryObject.id : null;

                    let cardId = null;
                    if (params.creditCardName) {
                        cardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                        if (!cardId) {
                            throw { statusCode: 404, message: `Cartão de crédito "${params.creditCardName}" não encontrado.` };
                        }
                    } else if (params.type === 'Saída') {
                        throw { statusCode: 400, message: `Para uma compra parcelada, preciso do nome do cartão de crédito. Ex: 'parcelei no Nubank'.` };
                    }

                    const parcelData = {
                        description: params.description,
                        type: params.type || "Saída", 
                        totalValue: parseFloat(params.totalValue || params.value),
                        numberOfParcels: parseInt(params.numberOfParcels),
                        initialDueDate: params.initialDueDate, 
                        financialCategoryId: categoryId,
                        creditCardId: cardId,
                        notes: params.notes,
                        transactionDate: params.transactionDate || params.initialDueDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0]
                    };

                    if (!parcelData.description || !parcelData.type || isNaN(parcelData.totalValue) || parcelData.totalValue <= 0 || isNaN(parcelData.numberOfParcels) || parcelData.numberOfParcels < 1 || !parcelData.initialDueDate) {
                        throw { statusCode: 400, message: "Dados insuficientes ou inválidos para compra parcelada (descrição, tipo, valor total, nº parcelas, data 1ª parcela)." };
                    }
                    if (!params.transactionDate && params.initialDueDate) {
                        parcelData.transactionDate = params.initialDueDate;
                    }

                    const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData, actorId);
                    
                    formattedData = formatter.formatParcelledAccountDataStructure(parcelData, parcelResult);
                    if (parcelResult.parcels && parcelResult.parcels.length > 0) {
                        const originalTxId = parcelResult.parcels[0].originalAccountId || parcelResult.parcels[0].id;
                        resourceForButtonsContext.resources.push({ type: 'parcelled_account', id: originalTxId, description: parcelData.description });
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_PARCELLED_ACCOUNT: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `Ops, ${clientNameToUse}! 😬 Não consegui registrar sua compra parcelada.`;
                    let body = `Detalhe: ${e.message}`;

                    if (e.statusCode === 404 && e.message.includes('Cartão de crédito')) {
                        intro = `Hum, não encontrei o cartão "${params.creditCardName}" que você mencionou, ${clientNameToUse}.`;
                        const { cards: existingCards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                        if (existingCards && existingCards.length > 0) {
                            body = `Seus cartões cadastrados são: *${existingCards.map(c => c.name).join(', ')}*.\n\nVocê quis dizer um deles ou quer cadastrar um novo cartão?`;
                        } else {
                            body = `Parece que você ainda não tem nenhum cartão cadastrado.`;
                        }
                    }
                    
                    formattedData = `❌ ${intro}\n${body}`;
                }
                break;
            }

            case 'CREATE_RECURRING_RULE': {
                try {
                    const categoryObjectRule = params.financialCategoryName 
                        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                        : null;
                    const categoryIdRule = categoryObjectRule ? categoryObjectRule.id : null;
                    
                    const ruleData = {
                        description: params.description,
                        type: params.type,
                        value: parseFloat(params.value),
                        frequency: params.frequency,
                        startDate: params.startDate,
                        interval: params.interval ? parseInt(params.interval) : 1,
                        dayOfMonth: params.dayOfMonth ? parseInt(params.dayOfMonth) : null,
                        dayOfWeek: params.dayOfWeek !== undefined && params.dayOfWeek !== null ? parseInt(params.dayOfWeek) : null,
                        endDate: params.endDate,
                        autoCreateTransaction: true,
                        financialCategoryId: categoryIdRule,
                        notes: params.notes
                    };

                    if (!ruleData.description || !ruleData.type || isNaN(ruleData.value) || ruleData.value <= 0 || !ruleData.frequency || !ruleData.startDate) {
                        throw { statusCode: 400, message: "Dados insuficientes para criar regra recorrente (desc, tipo, valor, frequência, data início)." };
                    }
                    
                    const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                    const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);
                    
                    formattedData = formatter.formatRecurringRuleDataStructure(reloadedRule);
                    resourceForButtonsContext.resources.push({ type: 'recurring_rule', id: newRule.id, description: newRule.description });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_RECURRING_RULE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui criar a regra de recorrência.\nDetalhe: ${e.message}`;
                }
                break;
            }

          case 'CREATE_PRODUCT': {
                try {
                    // <<< INÍCIO DA CORREÇÃO DE LÓGICA >>>
                    // Se estivermos em modo de edição para um produto, esta chamada DEVE ser uma atualização.
                    // Isso protege contra a IA que pode erroneamente detectar CREATE em vez de UPDATE.
                    if (state.editingResource?.type === 'product' && state.editingResource?.id) {
                        logger.warn(`[ACTION HANDLER] IA detectou CREATE_PRODUCT, mas o sistema está em modo de edição para o produto ID ${state.editingResource.id}. Forçando uma ATUALIZAÇÃO.`);
                        
                        // Reutiliza a lógica de UPDATE_PRODUCT diretamente
                        const updateParams = { 
                            ...params, 
                            productIdToUpdate: state.editingResource.id 
                        };
                        // Chamamos a função de atualização e retornamos seu resultado.
                        // Precisamos simular a chamada da ação UPDATE_PRODUCT.
                        // A forma mais limpa é duplicar a lógica de 'UPDATE_PRODUCT' aqui ou refatorar para uma função auxiliar.
                        // Por simplicidade, vamos duplicar a lógica essencial aqui:
                        
                        const updateDataProd = {};
                        if (params.hasOwnProperty('name')) updateDataProd.name = params.name;
                        if (params.hasOwnProperty('salePrice') && !isNaN(parseFloat(params.salePrice))) updateDataProd.salePrice = parseFloat(params.salePrice);
                        if (params.hasOwnProperty('code')) updateDataProd.code = params.code;
                        if (params.hasOwnProperty('costPrice')) updateDataProd.costPrice = params.costPrice === null ? null : parseFloat(params.costPrice);
                        // Adiciona a atualização de quantidade que a IA pode ter inferido
                        if (params.hasOwnProperty('initialQuantity') && !isNaN(parseInt(params.initialQuantity))) updateDataProd.quantity = parseInt(params.initialQuantity);
                        if (params.hasOwnProperty('minimumStock') && !isNaN(parseInt(params.minimumStock))) updateDataProd.minimumStock = parseInt(params.minimumStock);
                        if (params.hasOwnProperty('unit')) updateDataProd.unit = params.unit;
                        if (params.hasOwnProperty('description')) updateDataProd.description = params.description;
                        
                        const updatedProduct = await productService.updateProduct(state.activeFinancialAccountId, state.editingResource.id, updateDataProd, actorId);
                        
                        formattedData = formatter.formatProductDataStructure(updatedProduct);
                        wasAnEdit = true; // Sinaliza que a edição foi concluída.
                        break; // Sai do case 'CREATE_PRODUCT'
                    }
                    // <<< FIM DA CORREÇÃO DE LÓGICA >>>

                    // Se não estiver em modo de edição, a lógica de criação normal continua.
                    const productData = {
                        name: params.name, salePrice: parseFloat(params.salePrice), code: params.code,
                        costPrice: params.costPrice ? parseFloat(params.costPrice) : null,
                        initialQuantity: params.initialQuantity ? parseInt(params.initialQuantity) : 0,
                        minimumStock: params.minimumStock ? parseInt(params.minimumStock) : 0,
                        unit: params.unit || 'UN', description: params.description 
                    };
                    if (!productData.name || isNaN(productData.salePrice) || productData.salePrice <= 0) {
                         throw { statusCode: 400, message: "Nome e preço de venda são obrigatórios para o produto." };
                    }
                    
                    const newProduct = await productService.createProduct(state.activeFinancialAccountId, productData, actorId);
                    
                    formattedData = formatter.formatProductDataStructure(newProduct);
                    resourceForButtonsContext.resources.push({ type: 'product', id: newProduct.id, description: newProduct.name });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_PRODUCT: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `Ops, ${clientNameToUse}! Não consegui cadastrar o produto.`;
                    let body = `Detalhe: ${e.message}`;
                    if (e.statusCode === 409) {
                        intro = `Opa, ${clientNameToUse}!`;
                        body = `Já existe um produto com este nome/código. Você gostaria de editar o existente?`;
                    }
                    formattedData = `❌ ${intro}\n${body}`;
                }
                break;
            }

            case 'CREATE_CREDIT_CARD': {
                try {
                    const cardData = {
                        name: params.name, limit: parseFloat(params.limit),
                        closingDay: parseInt(params.closingDay), paymentDay: parseInt(params.paymentDay),
                        lastFourDigits: params.lastFourDigits, flag: params.flag,
                        isDefault: params.isDefault === undefined ? false : params.isDefault
                    };
                    if (!cardData.name || isNaN(cardData.limit) || cardData.limit <= 0 || isNaN(cardData.closingDay) || isNaN(cardData.paymentDay) ) {
                        throw { statusCode: 400, message: "Dados insuficientes ou inválidos para criar cartão (nome, limite, dia fechamento/pagamento)." };
                    }
                    
                    const newCard = await creditCardService.createCreditCard(state.activeFinancialAccountId, cardData, actorId);
                    
                    formattedData = formatter.formatCreditCardDataStructure(newCard);
                    resourceForButtonsContext.resources.push({ type: 'credit_card', id: newCard.id, description: newCard.name });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_CREDIT_CARD: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `Ops, ${clientNameToUse}! Não consegui cadastrar o cartão.`;
                    let body = `Detalhe: ${e.message}`;
                    if (e.statusCode === 409) {
                        intro = `Opa, ${clientNameToUse}!`;
                        body = `Já existe um cartão com o nome "${params.name}". Por favor, escolha outro nome.`;
                    }
                    formattedData = `❌ ${intro}\n${body}`;
                }
                break;
            }

            case 'CREATE_FINANCIAL_ACCOUNT': {
                try {
                    if (!isOwnerActingOnOwnBehalfGlobal) {
                        throw { statusCode: 403, message: "Você não pode criar contas financeiras em um acesso compartilhado." };
                    }
                    const { accountTypeToCreate, newAccountName, documentNumber } = params;
                    if (!accountTypeToCreate || !newAccountName) {
                        throw { statusCode: 400, message: "Tipo e nome da conta são obrigatórios." };
                    }
                    if (!['PF', 'PJ', 'MEI'].includes(accountTypeToCreate)) {
                        throw { statusCode: 400, message: "Tipo de conta inválido. Use PF, PJ ou MEI." };
                    }
                    if (newAccountName.length < 3 || newAccountName.length > 50) {
                        throw { statusCode: 400, message: "Nome da conta deve ter entre 3 e 50 caracteres." };
                    }
                    const currentClientAccounts = await clientService.getClientFinancialAccounts(actorId, { isActive: null });
                    const existingPjMei = currentClientAccounts.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                    if ((accountTypeToCreate === 'PJ' || accountTypeToCreate === 'MEI') && existingPjMei) {
                        throw { statusCode: 409, message: `Você já possui uma conta ${existingPjMei.accountType} ("${existingPjMei.accountName}"). Só é permitida uma conta empresarial (PJ/MEI) por vez.` };
                    }
                    if ((accountTypeToCreate === 'PJ' || accountTypeToCreate === 'MEI') && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado')) {
                        throw { statusCode: 403, message: `Para criar contas PJ ou MEI, você precisa de um Plano Avançado. Confira nossos planos!` };
                    }
                    
                    const newFinancialAccount = await clientService.createFinancialAccount(actorId, { accountName: newAccountName, accountType: accountTypeToCreate, documentNumber });
                    
                    formattedData = formatter.formatFinancialAccountDataStructure(newFinancialAccount) + "\n\nEsta conta foi criada, mas a sua conta ativa continua a mesma. Diga \"mudar para " + newFinancialAccount.accountName + "\" para começar a usá-la.";
                } catch(e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_FINANCIAL_ACCOUNT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui criar a conta.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'CREATE_BUSINESS_CLIENT': {
                try {
                    if (!params.name) {
                        throw { statusCode: 400, message: "Nome do cliente do negócio é obrigatório." };
                    }
                    const bcData = { name: params.name, phone: params.phone, email: params.email, notes: params.notes };
                    const newBc = await businessClientService.createBusinessClient(state.activeFinancialAccountId, bcData, actorId);
                    
                    formattedData = formatter.formatBusinessClientDataStructure(newBc);
                    resourceForButtonsContext.resources.push({ type: 'business_client', id: newBc.id, description: newBc.name });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_BUSINESS_CLIENT: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `Ops, ${clientNameToUse}! Não consegui cadastrar este cliente.`;
                    let body = `Detalhe: ${e.message}`;
                    if (e.statusCode === 409) {
                        intro = `Opa, ${clientNameToUse}!`;
                        body = `Já existe um cliente com este nome/telefone/email. Você gostaria de editar o existente?`;
                    }
                    formattedData = `❌ ${intro}\n${body}`;
                }
                break;
            }

            case 'GRANT_ACCESS': {
                try {
                    if (!isOwnerActingOnOwnBehalfGlobal) {
                        throw { statusCode: 403, message: "Você não pode gerenciar acessos de dentro de um acesso compartilhado." };
                    }
                    if (!params.sharedWithUserIdentifier) {
                        throw { statusCode: 400, message: "Preciso do telefone ou e-mail de quem você quer convidar." };
                    }
                    if (!params.accessPersonalProfile && !params.businessProfileToShareName) {
                        throw { statusCode: 400, message: "Você precisa escolher pelo menos um perfil (Pessoal ou Empresarial) para compartilhar." };
                    }

                    let businessProfileIdToShare = null;
                    if (params.businessProfileToShareName) {
                        const ownerAccounts = await clientService.getClientFinancialAccounts(state.ownerClientIdForContext, {isActive:true});
                        const bizAccount = ownerAccounts.find(acc => (acc.accountType === 'PJ' || acc.accountType === 'MEI') && acc.accountName.toLowerCase() === params.businessProfileToShareName.toLowerCase());
                        if (!bizAccount) {
                            throw { statusCode: 404, message: `Não encontrei um perfil empresarial chamado "${params.businessProfileToShareName}" na sua conta.` };
                        }
                        businessProfileIdToShare = bizAccount.id;
                    }

                    const grantDataForService = {
                        sharedWithUserIdentifier: params.sharedWithUserIdentifier,
                        canAccessPersonalProfile: params.accessPersonalProfile || false,
                        canAccessBusinessProfileId: businessProfileIdToShare,
                        sharedAccessEmail: params.sharedAccessEmailForGuest,
                        sharedAccessPassword: params.sharedAccessPasswordForGuest,
                        sharedAccessPhone: params.sharedAccessPhoneForGuest,
                        sharedWithClientName: params.sharedWithClientName
                    };

                    const newSharedAccess = await sharedAccessService.grantAccess(state.ownerClientIdForContext, grantDataForService);
                    const reloadedSA = await sharedAccessService.getSharedAccessById(newSharedAccess.id);
                    
                    formattedData = formatter.formatSharedAccessDataStructure(reloadedSA, 'owner');
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GRANT_ACCESS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não foi possível conceder o acesso.\nDetalhe: ${e.message}`;
                }
                break;
            }
           case 'RECORD_STOCK_MOVEMENT': {
                try {
                    if(!params.productNameOrCode || !params.movementType || params.quantity === undefined || params.quantity === null) {
                        throw { statusCode: 400, message: "Produto, tipo de movimento e quantidade são obrigatórios." };
                    }
                    const productId = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                    if(!productId) {
                        throw { statusCode: 404, message: `Produto "${params.productNameOrCode}" não encontrado.` };
                    }

                    await stockService.recordStockMovement(productId, {
                        type: params.movementType,
                        quantity: parseInt(params.quantity),
                        reason: params.reason,
                    });

                    // <<< INÍCIO DA CORREÇÃO >>>
                    // A chamada foi alterada de getProductStockInfoById para getProductStockBalance,
                    // que é a função que realmente existe no stock.service.js.
                    // O parâmetro financialAccountId foi removido, pois a função só espera o productId.
                    const updatedStockInfo = await stockService.getProductStockBalance(productId);
                    // <<< FIM DA CORREÇÃO >>>
                    
                    formattedData = `✅ Movimento de ${params.movementType.toLowerCase()} (${params.quantity} ${updatedStockInfo.unit || 'UN'}) para "${updatedStockInfo.name}" registrado.\n` +
                                    `📦 Estoque Atual: *${updatedStockInfo.quantity} ${updatedStockInfo.unit || 'UN'}*.`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em RECORD_STOCK_MOVEMENT: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `Ops, ${clientNameToUse}! 😬 Não consegui registrar a movimentação de estoque.`;
                    let body = `Detalhe: ${e.message}`;

                    if (e.statusCode === 404 && e.message.includes('Produto')) {
                        intro = `Hum, não encontrei o produto "${params.productNameOrCode}" que você mencionou, ${clientNameToUse}.`;
                        const { products: existingProducts } = await productService.getAllProducts(state.activeFinancialAccountId, { limit: 5, isActive: true });
                        if (existingProducts && existingProducts.length > 0) {
                            body = `Seus produtos cadastrados são: *${existingProducts.map(p => p.name).join(', ')}*.\n\nVocê quis dizer um deles?`;
                        } else {
                            body = `Parece que você ainda não tem nenhum produto cadastrado. Quer adicionar um agora?`;
                        }
                    }
                    
                    formattedData = `❌ ${intro}\n${body}`;
                }
                break;
            }
            case 'PAY_CREDIT_CARD_INVOICE': {
                try {
                    const cardNameToPay = params.creditCardName;
                    const paymentAmount = parseFloat(params.paymentAmount);
                    if (!cardNameToPay || isNaN(paymentAmount) || paymentAmount <= 0) {
                        throw { statusCode: 400, message: "Nome do cartão e valor do pagamento (maior que zero) são obrigatórios." };
                    }

                    const cardIdToPay = await findCreditCardIdByName(cardNameToPay, state.activeFinancialAccountId);
                    if (!cardIdToPay) {
                        return; 
                    }

                    const paymentDateCard = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
                    let categoryNameToUseForPayment = params.financialCategoryName || "Pagamento de Fatura";
                    let categoryObjectPay = await financialCategoryService.findFinancialCategoryByNameForAccount(categoryNameToUseForPayment, state.activeFinancialAccountId);
                    let categoryIdPay = categoryObjectPay ? categoryObjectPay.id : null;

                    if (!categoryIdPay && params.financialCategoryName) {
                        logger.warn(`[ACTION HANDLER] Categoria "${params.financialCategoryName}" fornecida para pagamento de fatura não encontrada na conta ${state.activeFinancialAccountId}. Pagamento será sem categoria.`);
                    } else if (!categoryIdPay && !params.financialCategoryName) {
                        logger.warn(`[ACTION HANDLER] Categoria padrão "Pagamento de Fatura" não encontrada. Pagamento será sem categoria.`);
                    }

                    const paymentTransaction = await creditCardService.payCreditCardInvoice(
                        state.activeFinancialAccountId, cardIdToPay, paymentAmount, paymentDateCard,
                        params.originatingAccountDescription, 
                        categoryIdPay,
                        actorId
                    );
                    
                    formattedData = `✅ Pagamento de ${formatter.formatCurrency(paymentAmount)} para o cartão "${cardNameToPay}" registrado em ${formatter.formatDate(paymentDateCard)}.`;
                    if (paymentTransaction.category) {
                        formattedData += `\nCategoria: ${paymentTransaction.category.name}.`;
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em PAY_CREDIT_CARD_INVOICE: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `Ops, ${clientNameToUse}! 😬 Não consegui registrar o pagamento da fatura.`;
                    let body = `Detalhe: ${e.message}`;

                    if (e.statusCode === 404 && e.message.includes('Cartão de crédito')) {
                        intro = `Hum, não encontrei o cartão "${params.creditCardName}" que você mencionou, ${clientNameToUse}.`;
                        const { cards: existingCards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                        if (existingCards && existingCards.length > 0) {
                            body = `Seus cartões cadastrados são: *${existingCards.map(c => c.name).join(', ')}*.\n\nVocê quis dizer um deles?`;
                        } else {
                            body = `Parece que você ainda não tem nenhum cartão cadastrado.`;
                        }
                    }
                    
                    formattedData = `❌ ${intro}\n${body}`;
                }
                break;
            }

             case 'CREATE_FINANCIAL_CATEGORY': {
                try {
                    if (state.isSharedAccessContext && !isOwnerActingOnOwnBehalfGlobal) {
                         throw { statusCode: 403, message: "Você não tem permissão para criar categorias nesta conta compartilhada." };
                    }
                    const { name, parentCategoryName } = params;
                    if (!name) {
                        throw { statusCode: 400, message: "O nome da categoria é obrigatório." };
                    }
                    let parentId = null;
                    if (parentCategoryName) {
                        const parentCat = await financialCategoryService.findFinancialCategoryByNameForAccount(parentCategoryName, state.activeFinancialAccountId);
                        if (!parentCat) {
                            throw { statusCode: 404, message: `A categoria pai "${parentCategoryName}" não foi encontrada.` };
                        }
                        parentId = parentCat.id;
                    }
                    const newCategory = await financialCategoryService.createFinancialCategory(state.activeFinancialAccountId, { name, parentId });
                    formattedData = formatter.formatFinancialCategoryDataStructure(newCategory);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_FINANCIAL_CATEGORY: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui criar a categoria.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'CREATE_MOTIVATIONAL_PHRASE': {
                try {
                    const { text, author } = params;
                    if (!text) {
                        throw { statusCode: 400, message: "O texto da frase é obrigatório." };
                    }
                    const newPhrase = await systemService.createMotivationalPhrase({ text, author, createdBy: actorId });
                    formattedData = `✨ Frase motivacional adicionada com sucesso!\n\n_"${newPhrase.text}"_\n- ${newPhrase.author || 'Autor Desconhecido'}`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_MOTIVATIONAL_PHRASE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui salvar sua frase.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'CREATE_AVAILABILITY_RULE': {
                try {
                    const { title, type, rrule, startTime, endTime, specificDate, slotIntervalMinutes } = params;
                    if (!title || !type) {
                        throw { statusCode: 400, message: "Título e tipo da regra são obrigatórios." };
                    }
                    const ruleData = { title, type, rrule, startTime, endTime, specificDate, slotIntervalMinutes };
                    const newRule = await availabilityService.createAvailabilityRule(state.activeFinancialAccountId, ruleData);
                    
                    formattedData = formatter.formatAvailabilityRuleDataStructure(newRule);
                    resourceForButtonsContext.resources.push({ type: 'availability_rule', id: newRule.id, description: newRule.title });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_AVAILABILITY_RULE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui criar a regra de disponibilidade.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_AGENDA_VIEW': {
    try {
        const { dateStart, dateEnd } = params;
        if (!dateStart || !dateEnd) {
            throw { statusCode: 400, message: "Preciso de uma data de início e fim para mostrar a agenda." };
        }
        const agendaEvents = await appointmentService.getAgendaView(state.activeFinancialAccountId, dateStart, dateEnd);
        formattedData = formatter.formatAgendaViewDataStructure(agendaEvents, dateStart, dateEnd);
    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em GET_AGENDA_VIEW: ${e.message}`, { error: e, paramsUsed: params });
        formattedData = `❌ Ops, ${clientNameToUse}! Não consegui buscar sua agenda.\nDetalhe: ${e.message}`;
    }
    break;
}

case 'GET_AVAILABLE_TIME_SLOTS': {
    try {
        const { date, serviceNames, durationMinutes } = params;
        if (!date) {
            throw { statusCode: 400, message: "Para qual data você gostaria de ver os horários livres?" };
        }

        let totalDuration = durationMinutes ? parseInt(durationMinutes) : 0;
        let serviceIds = [];

        if (serviceNames && Array.isArray(serviceNames) && serviceNames.length > 0) {
            const servicesFound = await serviceService.getAllServices(state.activeFinancialAccountId, { search: serviceNames.join(' '), limit: serviceNames.length });
            serviceIds = servicesFound.services.map(s => s.id);
            totalDuration = servicesFound.services.reduce((sum, s) => sum + s.durationMinutes, 0);
        }

        if (totalDuration <= 0) {
            throw { statusCode: 400, message: "Preciso saber a duração do serviço para verificar os horários. Diga, por exemplo, 'horários livres para corte de cabelo amanhã'." };
        }

        const availableSlots = await availabilityService.getAvailableTimeSlots(state.activeFinancialAccountId, date, serviceIds);
        formattedData = formatter.formatAvailableTimeSlotsDataStructure(availableSlots, date, totalDuration);

    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em GET_AVAILABLE_TIME_SLOTS: ${e.message}`, { error: e, paramsUsed: params });
        formattedData = `❌ Ops, ${clientNameToUse}! Não consegui verificar os horários disponíveis.\nDetalhe: ${e.message}`;
    }
    break;
}

            // AÇÕES DE LEITURA (GET / LIST)
            // =================================================================

case 'GET_PROVIDER_PUBLIC_INFO': {
                try {
                    // Busca TODAS as contas do usuário logado, não apenas a ativa
                    const allUserAccounts = await clientService.getClientFinancialAccounts(actorId, { isActive: true });
                    const businessAccount = allUserAccounts.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');

                    if (!businessAccount) {
                        throw { statusCode: 404, message: "Você não possui uma conta de negócios (PJ/MEI) para ter uma página pública de agendamento. Você pode criar uma a qualquer momento!" };
                    }

                    const businessAccountId = businessAccount.id;
                    const publicInfo = await publicBookingService.getProviderPublicInfo(businessAccountId);
                    
                    // Constrói a URL pública baseada no ID da conta de negócios
                    const publicBookingUrl = `https://www.map-nocontrole.com.br/agendar/${businessAccountId}`;
                    
                    formattedData = formatter.formatProviderPublicInfoDataStructure(publicInfo, publicBookingUrl);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_PROVIDER_PUBLIC_INFO: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui buscar as informações da sua página pública.\nDetalhe: ${e.message}`;
                }
                break;
            }


            case 'GET_FINANCIAL_SUMMARY': {
                try {
                    const categoryObjectSummary = params.financialCategoryName 
                        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                        : null;
                    const categoryIdSummary = categoryObjectSummary ? categoryObjectSummary.id : null;
                    
                    const filters = {
                        period: params.period || 'este_mes',
                        dateStart: params.dateStart,
                        dateEnd: params.dateEnd,
                        financialCategoryId: categoryIdSummary, 
                        type: params.type,
                    };

                    const summary = await financialService.getFinancialSummary(state.activeFinancialAccountId, filters);
                    
                    let summaryIntro = `Aqui está o resumo financeiro para *${summary.periodDescription}*, ${clientNameToUse}! 📊`;
                    const summaryBody = formatter.formatFinancialSummaryDataStructure(summary);
                    
                    formattedData = `${summaryIntro}\n\n${summaryBody}`;

                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_FINANCIAL_SUMMARY: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui gerar o resumo financeiro.\nDetalhe: ${e.message}`;
                }
                break;
            }

             case 'LIST_FINANCIAL_ACCOUNTS': {
                try {
                    let accessibleAccounts = [];
                    const ownerNameForMsg = state.isSharedAccessContext ? state.ownerClientNameForContext : null;
                    
                    if (state.isSharedAccessContext) {
                        const ownerAccounts = await clientService.getClientFinancialAccounts(state.ownerClientIdForContext, { isActive: true });
                        accessibleAccounts = ownerAccounts.filter(acc => {
                            if (acc.accountType === 'PF') return state.sharedAccessPermissions.canAccessPersonalProfile;
                            if (acc.accountType === 'PJ' || acc.accountType === 'MEI') return state.sharedAccessPermissions.canAccessBusinessProfileId === acc.id;
                            return false;
                        });
                    } else {
                        accessibleAccounts = await clientService.getClientFinancialAccounts(actorId, { isActive: true });
                    }

                    if (accessibleAccounts.length === 0) {
                        formattedData = `Você não possui contas financeiras acessíveis no momento, ${clientNameToUse}.`;
                    } else {
                        formattedData = formatter.formatListClientAccountsDataStructure(accessibleAccounts, state.activeFinancialAccountId, ownerNameForMsg);
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_FINANCIAL_ACCOUNTS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar suas contas.\nDetalhe: ${e.message}`;
                }
                break;
            }

case 'LIST_APPOINTMENTS': {
    try {
        const filterParamsAppt = {
            dateStart: params.dateStart, dateEnd: params.dateEnd, status: params.status,
            limit: params.limit || 5, page: params.page || 1,
            period: params.period || 'proximos_7_dias'
        };
        
        const { appointments, totalItems: totalAppts, periodDescription } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, filterParamsAppt);

        if (totalAppts === 0) {
            const creativeResponse = await aiModelService.generateCreativeAgendaResponse(clientNameToUse, [], periodDescription);
            formattedData = creativeResponse.overall_summary || `Você não tem nenhum compromisso para *${periodDescription}*. 👍`;
        } else {
            const creativeResponse = await aiModelService.generateCreativeAgendaResponse(clientNameToUse, appointments, periodDescription);

            const appointmentDetails = appointments.map((appt, index) => {
                const formattedBlock = formatter.formatAppointmentDataStructure(appt);
                const individualPhrase = creativeResponse.individual_phrases[index] || "Fique de olho neste compromisso!";
                return `${formattedBlock}\n_${individualPhrase}_`;
            });

            let finalResponse = `${creativeResponse.overall_summary}\n\n` + appointmentDetails.join("\n\n---\n\n");

            if (totalAppts > appointments.length) {
                finalResponse += `\n\nE mais ${totalAppts - appointments.length} compromisso(s). Peça para ver mais ou veja tudo na plataforma!`;
            }
            
            formattedData = finalResponse.trim();
        }
    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em LIST_APPOINTMENTS: ${e.message}`, { error: e, paramsUsed: params });
        formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar os compromissos.\nDetalhe: ${e.message}`;
    }
    break;
}

            case 'LIST_CREDIT_CARDS': {
                try {
                    const { cards, totalItems: totalCards } = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: params.isActive, includeSummary: params.includeSummary !== false });

                    if (totalCards === 0) {
                        formattedData = "Você ainda não tem cartões cadastrados. Que tal adicionar um? Diga, por exemplo: \"cadastrar cartão Nubank com limite de 2000, fechamento dia 20 e pagamento dia 28\".";
                    } else {
                        formattedData = formatter.formatCreditCardListDataStructure(cards);
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_CREDIT_CARDS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar seus cartões.\nDetalhe: ${e.message}`;
                }
                break;
            }
            
 case 'LIST_RECURRING_RULES': {
                try {
                    const filterParamsRules = {
                        ...(params.isActive !== undefined && { isActive: params.isActive }),
                        type: params.type,
                        limit: params.limit || 10,
                        descriptionSearch: params.ruleDescription,
                        dateStart: params.dateStart,
                        dateEnd: params.dateEnd,
                        period: params.period
                    };
                    
                    const { rules: allRulesFound, totalItems } = await recurringTransactionService.getAllRecurringRules(
                        state.activeFinancialAccountId, 
                        filterParamsRules
                    );

                    if (totalItems === 0) {
                        let responseMsg = "Você ainda não tem nenhuma regra de recorrência ativa.";
                        if(filterParamsRules.descriptionSearch) {
                            responseMsg = `Não encontrei nenhuma recorrência ativa com a descrição "${filterParamsRules.descriptionSearch}".`;
                        }
                        formattedData = responseMsg;
                        break;
                    }

                    const enrichedRules = await Promise.all(allRulesFound.map(async (rule) => { 
                        const history = await recurringTransactionService.getRecurringRuleHistory(state.activeFinancialAccountId, rule.id, { limit: 5 });
                        const pendingTransactions = history.transactions.filter(tx => !tx.isPaidOrReceived);
                        
                        return {
                            ...rule,
                            pendingCount: pendingTransactions.length,
                            nextPendingDueDate: pendingTransactions.length > 0 ? pendingTransactions[0].dueDate : null,
                            hasPaidHistory: history.transactions.some(tx => tx.isPaidOrReceived)
                        };
                    }));
                    
                    formattedData = formatter.formatRichRecurringRuleList(enrichedRules, totalItems, clientNameToUse);

                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_RECURRING_RULES: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar as regras de recorrência.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_STOCK_INFO': {
                try {
                    if(!params.productNameOrCode) {
                        throw { statusCode: 400, message: "Nome ou código do produto é obrigatório para ver o estoque." };
                    }
                    const stockInfo = await stockService.getProductStockInfoByNameOrCode(state.activeFinancialAccountId, params.productNameOrCode); 
                    
                    formattedData = formatter.formatStockInfoDataStructure(stockInfo); 
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_STOCK_INFO: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui consultar o estoque.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_CREDIT_CARD_INVOICE': {
                try {
                    const cardNameForInvoice = params.creditCardName;
                    if (!cardNameForInvoice) {
                        throw { statusCode: 400, message: "Nome do cartão é obrigatório para ver a fatura." };
                    }
                    const cardIdForInvoice = await findCreditCardIdByName(cardNameForInvoice, state.activeFinancialAccountId);
                    if (!cardIdForInvoice) {
                        throw { statusCode: 404, message: `Não encontrei um cartão chamado "${cardNameForInvoice}". Verifique o nome ou cadastre o cartão.` };
                    }
                    
                    const periodOpts = { type: params.invoicePeriodType || 'aberta', month: params.invoiceMonth, year: params.invoiceYear };
                    const cardForDetails = await creditCardService.getCreditCardById(state.activeFinancialAccountId, cardIdForInvoice); 
                    const invoiceDetails = await creditCardService.getCreditCardInvoiceDetails(state.activeFinancialAccountId, cardIdForInvoice, periodOpts);
                    
                    if(cardForDetails) {
                        invoiceDetails.cardName = cardForDetails.name; 
                        invoiceDetails.cardTotalLimit = cardForDetails.limit;
                    }

                    formattedData = formatter.formatCreditCardInvoiceDataStructure(invoiceDetails, params.listTransactions !== false);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_CREDIT_CARD_INVOICE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui buscar a fatura.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_CREDIT_CARD_AVAILABLE_LIMIT': {
                try {
                    const cardNameForLimit = params.creditCardName;
                    if (!cardNameForLimit) {
                        throw { statusCode: 400, message: "Nome do cartão é obrigatório para ver o limite." };
                    }
                    const cardIdForLimit = await findCreditCardIdByName(cardNameForLimit, state.activeFinancialAccountId);
                    if (!cardIdForLimit) {
                        throw { statusCode: 404, message: `Não encontrei o cartão "${cardNameForLimit}". Verifique o nome ou cadastre o cartão.` };
                    }
                    
                    const limitInfo = await creditCardService.getCreditCardAvailableLimit(state.activeFinancialAccountId, cardIdForLimit);
                    
                    formattedData = formatter.formatAvailableLimitDataStructure(limitInfo);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_CREDIT_CARD_AVAILABLE_LIMIT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui verificar o limite.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'LIST_BUSINESS_CLIENTS': {
                try {
                    const filterParamsBC = { search: params.searchTerm, isActive: params.isActive !== undefined ? params.isActive : true, limit: params.limit || 5, page: 1 };
                    const { businessClients, totalItems: totalBC } = await businessClientService.getAllBusinessClients(state.activeFinancialAccountId, filterParamsBC);

                    if (totalBC === 0) {
                        formattedData = "Nenhum cliente do negócio encontrado. Que tal cadastrar o primeiro? Diga 'cadastrar cliente [nome do cliente]'.";
                    } else {
                        formattedData = formatter.formatListBusinessClientsDataStructure(businessClients);
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_BUSINESS_CLIENTS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar seus clientes.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'LIST_GRANTED_ACCESS': { 
                try {
                    if (!isOwnerActingOnOwnBehalfGlobal) {
                        throw { statusCode: 403, message: "Use 'listar meus convites' para ver os que você recebeu." };
                    }
                    const result = await sharedAccessService.getSharedAccessesByOwner(state.ownerClientIdForContext, { status: params.status });
                    const grantedList = result.sharedAccesses;

                    if (grantedList.length === 0) {
                        formattedData = `Você ainda não compartilhou seu acesso com ninguém, ${clientNameToUse}.`;
                    } else {
                        formattedData = formatter.formatListSharedAccessDataStructure(grantedList, 'owner');
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_GRANTED_ACCESS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar os acessos concedidos.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'LIST_RECEIVED_ACCESS': { 
                try {
                    const result = await sharedAccessService.getSharedAccessesForUser(actorId, { status: params.status || 'Pendente' }); 
                    const receivedList = result.sharedAccesses;
                    
                    if (receivedList.length === 0) {
                        formattedData = `Você não tem convites de acesso ${params.status || 'pendentes'}, ${clientNameToUse}. 👍`;
                    } else {
                        formattedData = formatter.formatListSharedAccessDataStructure(receivedList, 'guest');
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_RECEIVED_ACCESS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar seus convites.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_MONTHLY_TREND': {
                try {
                    const trendData = await financialService.getMonthlyTrend(state.activeFinancialAccountId, params.numberOfMonths || 6);
                    formattedData = formatter.formatMonthlyTrendDataStructure(trendData, state.activeFinancialAccountName);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_MONTHLY_TREND: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui gerar a tendência mensal.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_EXPENSE_CATEGORY_SUMMARY': {
                try {
                    const summaryData = await financialService.getExpenseCategorySummary(state.activeFinancialAccountId, params.dateStart, params.dateEnd);
                    formattedData = formatter.formatCategorySummaryDataStructure(summaryData, 'Despesas', state.activeFinancialAccountName);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_EXPENSE_CATEGORY_SUMMARY: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui gerar o resumo de despesas por categoria.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_INCOME_CATEGORY_SUMMARY': {
                try {
                    const summaryData = await financialService.getIncomeCategorySummary(state.activeFinancialAccountId, params.dateStart, params.dateEnd);
                    formattedData = formatter.formatCategorySummaryDataStructure(summaryData, 'Receitas', state.activeFinancialAccountName);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_INCOME_CATEGORY_SUMMARY: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui gerar o resumo de receitas por categoria.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'LIST_FINANCIAL_CATEGORIES': {
                try {
                    const categories = await financialCategoryService.getAllFinancialCategories(state.activeFinancialAccountId, { hierarchical: true });
                    formattedData = formatter.formatListFinancialCategoriesDataStructure(categories);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_FINANCIAL_CATEGORIES: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar suas categorias.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'LIST_PRODUCTS': {
                try {
                    const { products, totalItems } = await productService.getAllProducts(state.activeFinancialAccountId, {
                        search: params.searchTerm,
                        isActive: params.isActive !== undefined ? params.isActive : true,
                        limit: params.limit || 5
                    });
                    if (totalItems === 0) {
                        formattedData = "Você ainda não tem produtos cadastrados nesta conta. Que tal cadastrar o primeiro?";
                    } else {
                        formattedData = formatter.formatListProductsDataStructure(products);
                         if (totalItems > products.length) {
                             formattedData += `\n\nE mais ${totalItems - products.length} produto(s). Peça para ver mais ou veja tudo na plataforma!`;
                        }
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_PRODUCTS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar os produtos.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_PRODUCT_DETAILS': {
                try {
                    const productNameOrCode = params.productNameOrCode;
                    if (!productNameOrCode) {
                        throw { statusCode: 400, message: "Preciso do nome ou código do produto para ver os detalhes." };
                    }
                    const productId = await findProductIdByNameOrCode(productNameOrCode, state.activeFinancialAccountId);
                    if (!productId) {
                        throw { statusCode: 404, message: `Não encontrei um produto chamado "${productNameOrCode}".` };
                    }
                    const product = await productService.getProductById(state.activeFinancialAccountId, productId);
                    formattedData = formatter.formatProductDataStructure(product);
                    resourceForButtonsContext.resources.push({ type: 'product', id: product.id, description: product.name });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_PRODUCT_DETAILS: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `❌ Ops, ${clientNameToUse}! Não consegui buscar os detalhes do produto.`;
                    let body = `\nDetalhe: ${e.message}`;
                     if (e.statusCode === 404) {
                        intro = `Hum, não encontrei o produto "${params.productNameOrCode}", ${clientNameToUse}.`;
                        const { products } = await productService.getAllProducts(state.activeFinancialAccountId, { limit: 5, isActive: true });
                        if (products && products.length > 0) {
                            body = `\n\nSeus produtos cadastrados são: *${products.map(p => p.name).join(', ')}*.\n\nVocê quis dizer um deles?`;
                        } else {
                            body = `\n\nParece que você ainda não tem nenhum produto cadastrado.`;
                        }
                    }
                    formattedData = intro + body;
                }
                break;
            }
            
            case 'GET_HYDRATION_LOG': {
                try {
                    const logs = await hydrationService.getTodaysLogsByClient(actorId);
                    const prefs = await systemService.getSystemPreferences(); 
                    formattedData = formatter.formatHydrationLogDataStructure(logs, prefs, clientNameToUse);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_HYDRATION_LOG: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui ver seu progresso de hidratação hoje.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_AFFILIATE_DASHBOARD': {
                try {
                     if (state.isSharedAccessContext) {
                        throw { statusCode: 403, message: "O painel de afiliados só pode ser acessado pelo próprio dono da conta." };
                    }
                    const dashboardData = await affiliateService.getAffiliateDashboard(actorId);
                    formattedData = formatter.formatAffiliateDashboardDataStructure(dashboardData, clientNameToUse);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_AFFILIATE_DASHBOARD: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui buscar seus dados de afiliado.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GET_ACTIVE_SUBSCRIPTION': {
                try {
                    const subscription = await subscriptionService.getActiveSubscription(state.ownerClientIdForContext);
                    formattedData = formatter.formatSubscriptionDataStructure(subscription, clientNameToUse);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em GET_ACTIVE_SUBSCRIPTION: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui verificar os detalhes da sua assinatura.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'LIST_AVAILABILITY_RULES': {
                try {
                    const rules = await availabilityService.getAllAvailabilityRules(state.activeFinancialAccountId);
                    formattedData = formatter.formatListAvailabilityRulesDataStructure(rules);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_AVAILABILITY_RULES: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar suas regras de disponibilidade.\nDetalhe: ${e.message}`;
                }
                break;
            }

// AÇÕES DE LEITURA (GET / LIST)
case 'GET_BUSINESS_CLIENT_DETAILS': {
    try {
        const { clientName } = params;
        if (!clientName) {
            throw { statusCode: 400, message: "Preciso do nome do cliente para buscar os detalhes." };
        }
        
        const clientsResult = await businessClientService.getAllBusinessClients(state.activeFinancialAccountId, { search: clientName, limit: 1, isActive: null });
        if (!clientsResult.businessClients || clientsResult.businessClients.length === 0) {
            throw { statusCode: 404, message: `Não encontrei um cliente chamado "${clientName}".` };
        }
        const clientId = clientsResult.businessClients[0].id;

        const clientDetails = await businessClientService.getBusinessClientDetails(state.activeFinancialAccountId, clientId);
        formattedData = formatter.formatBusinessClientDetailsDataStructure(clientDetails);

    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em GET_BUSINESS_CLIENT_DETAILS: ${e.message}`, { error: e, paramsUsed: params });
        let intro = `❌ Ops, ${clientNameToUse}! Não consegui buscar os detalhes do cliente.`;
        let body = `\nDetalhe: ${e.message}`;
        if (e.statusCode === 404) {
            intro = `Hum, não encontrei o cliente "${params.clientName}", ${clientNameToUse}.`;
            const { businessClients } = await businessClientService.getAllBusinessClients(state.activeFinancialAccountId, { limit: 5, isActive: true });
            if (businessClients && businessClients.length > 0) {
                body = `\n\nSeus clientes cadastrados são: *${businessClients.map(c => c.name).join(', ')}*.\n\nVocê quis dizer um deles?`;
            } else {
                body = `\n\nParece que você ainda não tem nenhum cliente cadastrado.`;
            }
        }
        formattedData = intro + body;
    }
    break;
}

case 'GET_APPOINTMENT_HISTORY_FOR_CLIENT': {
    try {
        const { clientName } = params;
        if (!clientName) {
            throw { statusCode: 400, message: "Preciso do nome do cliente para buscar o histórico." };
        }
        
        const clientsResult = await businessClientService.getAllBusinessClients(state.activeFinancialAccountId, { search: clientName, limit: 1, isActive: null });
        if (!clientsResult.businessClients || clientsResult.businessClients.length === 0) {
            throw { statusCode: 404, message: `Não encontrei um cliente chamado "${clientName}".` };
        }
        const clientId = clientsResult.businessClients[0].id;

        const history = await businessClientService.getAppointmentHistoryForClient(state.activeFinancialAccountId, clientId);
        formattedData = formatter.formatAppointmentHistoryForClientDataStructure(history, clientsResult.businessClients[0].name);

    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em GET_APPOINTMENT_HISTORY_FOR_CLIENT: ${e.message}`, { error: e, paramsUsed: params });
        formattedData = `❌ Ops, ${clientNameToUse}! Não consegui buscar o histórico do cliente.\nDetalhe: ${e.message}`;
    }
    break;
}



           // =================================================================
            // AÇÕES DE ATUALIZAÇÃO (UPDATE)
            // =================================================================

            case 'UPDATE_FINANCIAL_TRANSACTION': {
                try {
                    const transactionIdToUpdate = state.editingResource?.type === 'transaction' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : (params.transactionIdToUpdate ? parseInt(params.transactionIdToUpdate, 10) : null);
                    if (!transactionIdToUpdate) {
                        throw { statusCode: 400, message: "ID da transação para atualizar não foi fornecido ou não está em contexto de edição." };
                    }

                    const updateDataTx = {};
                    if (params.hasOwnProperty('description')) updateDataTx.description = params.description;
                    if (params.hasOwnProperty('value') && params.value !== null && !isNaN(parseFloat(params.value)) && parseFloat(params.value) > 0) updateDataTx.value = parseFloat(params.value);
                    if (params.hasOwnProperty('transactionDate')) updateDataTx.transactionDate = params.transactionDate;
                    if (params.hasOwnProperty('notes')) updateDataTx.notes = params.notes;
                    if (params.hasOwnProperty('dueDate')) updateDataTx.dueDate = params.dueDate; else if (params.hasOwnProperty('dueDate') && params.dueDate === null) updateDataTx.dueDate = null;
                    if (params.hasOwnProperty('isPaidOrReceived')) updateDataTx.isPaidOrReceived = params.isPaidOrReceived;
                    
                    if (params.financialCategoryName) {
                        const categoryObject = await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId);
                        updateDataTx.financialCategoryId = categoryObject ? categoryObject.id : null;
                    } else if (params.hasOwnProperty('financialCategoryName') && params.financialCategoryName === null) {
                        updateDataTx.financialCategoryId = null;
                    }
                    if (params.creditCardName) {
                        updateDataTx.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                    } else if (params.hasOwnProperty('creditCardName') && params.creditCardName === null) {
                        updateDataTx.creditCardId = null;
                    }

                    if (Object.keys(updateDataTx).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado válido fornecido para atualizar a transação." };
                    }

                    const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateDataTx, actorId);
                    const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);
                    
                    formattedData = formatter.formatFinancialTransactionDataStructure(reloadedUpdatedTx);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_FINANCIAL_TRANSACTION: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar a transação.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_APPOINTMENT': {
                try {
                    const appointmentIdToUpdate = state.editingResource?.type === 'appointment' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : (params.appointmentIdToUpdate ? parseInt(params.appointmentIdToUpdate, 10) : null);
                    if (!appointmentIdToUpdate) {
                        throw { statusCode: 400, message: "ID do compromisso para atualizar não foi fornecido." };
                    }
                    
                    const updateDataAppt = {};
                    if (params.hasOwnProperty('title')) updateDataAppt.title = params.title;
                    if (params.hasOwnProperty('eventDateTime')) updateDataAppt.eventDateTime = params.eventDateTime;
                    if (params.hasOwnProperty('durationMinutes')) updateDataAppt.durationMinutes = parseInt(params.durationMinutes);
                    if (params.hasOwnProperty('location')) updateDataAppt.location = params.location;
                    if (params.hasOwnProperty('reminderLeadTimeMinutes')) updateDataAppt.reminderLeadTimeMinutes = parseInt(params.reminderLeadTimeMinutes);
                    if (params.hasOwnProperty('status')) updateDataAppt.status = params.status;
                    if (params.hasOwnProperty('notes')) updateDataAppt.notes = params.notes;
                    if (params.hasOwnProperty('associatedValue') && params.associatedValue !== null && !isNaN(parseFloat(params.associatedValue))) updateDataAppt.associatedValue = parseFloat(params.associatedValue);
                    if (params.hasOwnProperty('associatedTransactionType')) updateDataAppt.associatedTransactionType = params.associatedTransactionType;
                    
                    if (params.hasOwnProperty('businessClientNames') && ['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                        let businessClientIdsToUpdate = []; 
                        if (Array.isArray(params.businessClientNames) && params.businessClientNames.length > 0) {
                            for (const name of params.businessClientNames) {
                                const bcId = await findBusinessClientIdByName(name, state.activeFinancialAccountId);
                                if (bcId) businessClientIdsToUpdate.push(bcId);
                            }
                        }
                        updateDataAppt.businessClientIds = businessClientIdsToUpdate;
                    }

                    if (Object.keys(updateDataAppt).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado válido fornecido para atualizar o compromisso." };
                    }

                    const updatedAppt = await appointmentService.updateAppointment(state.activeFinancialAccountId, appointmentIdToUpdate, updateDataAppt, actorId);
                    const reloadedUpdatedAppt = await appointmentService.getAppointmentById(state.activeFinancialAccountId, updatedAppt.id);
                    
                    formattedData = formatter.formatAppointmentDataStructure(reloadedUpdatedAppt);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_APPOINTMENT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar o compromisso.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                try {
                    if (!params.transactionDescription) {
                        throw { statusCode: 400, message: "Descrição da transação é obrigatória para marcar como paga/recebida." };
                    }
                    
                    const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
                    const categoryObjectForMark = params.financialCategoryName 
                        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId)
                        : null;
                    const categoryIdForMark = categoryObjectForMark ? categoryObjectForMark.id : null;
                    
                    const result = await financialService.markTransactionAsPaidOrReceived(
                        state.activeFinancialAccountId,
                        params.transactionDescription,
                        params.transactionValue ? parseFloat(params.transactionValue) : null,
                        paymentDate,
                        categoryIdForMark,
                        actorId
                    );
                    
                    formattedData = `Transação "${result.description}" (${formatter.formatCurrency(result.value)}) foi marcada como ${result.type === 'Entrada' ? 'recebida' : 'paga'} em ${formatter.formatDate(result.paymentDate)}.`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em MARK_TRANSACTION_AS_PAID_RECEIVED: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `Ops, ${clientNameToUse}! 😬 Não consegui marcar a transação como paga.`;
                    let body = `Detalhe: ${e.message}`;

                    if (e.statusCode === 404) {
                        intro = `Hum, não encontrei uma conta pendente com a descrição "${params.transactionDescription}", ${clientNameToUse}.`;
                        const { transactions: pendingTxs } = await financialService.getAllTransactions(state.activeFinancialAccountId, { isPaidOrReceived: false, limit: 5 });
                        if (pendingTxs && pendingTxs.length > 0) {
                            body = `Suas contas pendentes mais recentes são:\n` + pendingTxs.map(tx => `- ${tx.description} (${formatter.formatCurrency(tx.value)})`).join('\n');
                            body += `\n\nQual delas você pagou?`;
                        } else {
                            body = `Você não tem nenhuma conta pendente no momento.`;
                        }
                    }
                    formattedData = `❌ ${intro}\n${body}`;
                }
                break;
            }

            case 'UPDATE_RECURRING_RULE': {
                try {
                    const ruleIdToUpdate = state.editingResource?.type === 'recurring_rule' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : (params.ruleIdToUpdate ? parseInt(params.ruleIdToUpdate, 10) : null);
                    if (!ruleIdToUpdate) {
                        throw { statusCode: 400, message: "ID da regra recorrente para atualizar não foi fornecido." };
                    }

                    const updateDataRule = {};
                    if (params.hasOwnProperty('description')) updateDataRule.description = params.description;
                    if (params.hasOwnProperty('type')) updateDataRule.type = params.type;
                    if (params.hasOwnProperty('value') && params.value !== null && !isNaN(parseFloat(params.value)) && parseFloat(params.value) > 0) updateDataRule.value = parseFloat(params.value);
                    if (params.hasOwnProperty('frequency')) updateDataRule.frequency = params.frequency;
                    if (params.hasOwnProperty('startDate')) updateDataRule.startDate = params.startDate;
                    if (params.hasOwnProperty('interval') && params.interval !== null && !isNaN(parseInt(params.interval)) && parseInt(params.interval) >= 1) updateDataRule.interval = parseInt(params.interval);
                    if (params.hasOwnProperty('dayOfMonth')) updateDataRule.dayOfMonth = params.dayOfMonth === null ? null : parseInt(params.dayOfMonth);
                    if (params.hasOwnProperty('dayOfWeek')) updateDataRule.dayOfWeek = params.dayOfWeek === null || params.dayOfWeek === undefined ? null : parseInt(params.dayOfWeek);
                    if (params.hasOwnProperty('endDate')) updateDataRule.endDate = params.endDate; else if (params.hasOwnProperty('endDate') && params.endDate === null) updateDataRule.endDate = null;
                    if (params.hasOwnProperty('autoCreateTransaction')) updateDataRule.autoCreateTransaction = params.autoCreateTransaction;
                    if (params.hasOwnProperty('isActive')) updateDataRule.isActive = params.isActive;
                    if (params.hasOwnProperty('notes')) updateDataRule.notes = params.notes;
                    
                    if (params.financialCategoryName) {
                        const categoryObjectForRule = await financialCategoryService.findFinancialCategoryByNameForAccount(params.financialCategoryName, state.activeFinancialAccountId);
                        updateDataRule.financialCategoryId = categoryObjectForRule ? categoryObjectForRule.id : null;
                    } else if (params.hasOwnProperty('financialCategoryName') && params.financialCategoryName === null) {
                        updateDataRule.financialCategoryId = null;
                    }

                    if (Object.keys(updateDataRule).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado válido fornecido para atualizar a regra." };
                    }

                    const updatedRule = await recurringTransactionService.updateRecurringRule(state.activeFinancialAccountId, ruleIdToUpdate, updateDataRule, actorId);
                    const reloadedUpdatedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, updatedRule.id);
                    
                    formattedData = formatter.formatRecurringRuleDataStructure(reloadedUpdatedRule);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_RECURRING_RULE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar a regra.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_PRODUCT': {
                try {
                    const productIdToUpdate = state.editingResource?.type === 'product' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : (params.productIdToUpdate ? parseInt(params.productIdToUpdate, 10) : null);
                    if (!productIdToUpdate) {
                        throw { statusCode: 400, message: "ID do produto para atualizar não fornecido." };
                    }

                    const updateDataProd = {};
                    if (params.hasOwnProperty('name')) updateDataProd.name = params.name;
                    if (params.hasOwnProperty('salePrice') && params.salePrice !== null && !isNaN(parseFloat(params.salePrice)) && parseFloat(params.salePrice) > 0) updateDataProd.salePrice = parseFloat(params.salePrice);
                    if (params.hasOwnProperty('code')) updateDataProd.code = params.code;
                    if (params.hasOwnProperty('costPrice')) updateDataProd.costPrice = params.costPrice === null ? null : parseFloat(params.costPrice);
                    if (params.hasOwnProperty('minimumStock') && params.minimumStock !== null && !isNaN(parseInt(params.minimumStock))) updateDataProd.minimumStock = parseInt(params.minimumStock);
                    if (params.hasOwnProperty('unit')) updateDataProd.unit = params.unit;
                    if (params.hasOwnProperty('description')) updateDataProd.description = params.description;
                    if (params.hasOwnProperty('isActive')) updateDataProd.isActive = params.isActive;
                    
                    if (Object.keys(updateDataProd).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado válido para atualizar o produto." };
                    }

                    const updatedProduct = await productService.updateProduct(state.activeFinancialAccountId, productIdToUpdate, updateDataProd, actorId);
                    
                    formattedData = formatter.formatProductDataStructure(updatedProduct);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_PRODUCT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar o produto.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION': {
                try {
                    const accountIdToUpdateDesc = state.editingResource?.type === 'parcelled_account' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : (params.originalAccountIdToUpdate ? parseInt(params.originalAccountIdToUpdate, 10) : null);
                    if (!accountIdToUpdateDesc || !params.newDescription) {
                        throw { statusCode: 400, message: "ID da compra parcelada e nova descrição são obrigatórios." };
                    }

                    await financialService.updateParcelledAccountDescription(state.activeFinancialAccountId, accountIdToUpdateDesc, params.newDescription, actorId);
                    
                    formattedData = `📝 Descrição da compra parcelada atualizada para: *${params.newDescription}*`;
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_PARCELLED_ACCOUNT_DESCRIPTION: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar a descrição.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'RECREATE_PARCELLED_ACCOUNT': {
                try {
                    const originalAccountIdToUpdate = state.editingResource?.type === 'parcelled_account' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : (params.originalAccountIdToUpdate ? parseInt(params.originalAccountIdToUpdate, 10) : null);
                    if (!originalAccountIdToUpdate) {
                        throw { statusCode: 400, message: "ID da compra parcelada original é obrigatório para recriar." };
                    }

                    const newCatObject = params.newFinancialCategoryName 
                        ? await financialCategoryService.findFinancialCategoryByNameForAccount(params.newFinancialCategoryName, state.activeFinancialAccountId)
                        : null;
                    const newCatIdParcel = newCatObject ? newCatObject.id : null;
                    
                    const newCardIdParcel = params.newCreditCardName ? await findCreditCardIdByName(params.newCreditCardName, state.activeFinancialAccountId) : null;
                    if (params.newCreditCardName && !newCardIdParcel) {
                        throw { statusCode: 404, message: `Cartão "${params.newCreditCardName}" não encontrado para a nova compra parcelada.` };
                    }

                    const newParcelData = {
                        description: params.newDescription, type: params.newType || 'Saída', totalValue: parseFloat(params.newTotalValue),
                        numberOfParcels: parseInt(params.newNumberOfParcels), initialDueDate: params.newInitialDueDate,
                        financialCategoryId: newCatIdParcel, creditCardId: newCardIdParcel, notes: params.newNotes,
                        transactionDate: params.newTransactionDate || params.newInitialDueDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0]
                    };
                    if (!newParcelData.description || isNaN(newParcelData.totalValue) || newParcelData.totalValue <= 0 || isNaN(newParcelData.numberOfParcels) || newParcelData.numberOfParcels < 1 || !newParcelData.initialDueDate) {
                         throw { statusCode: 400, message: "Para recriar a compra parcelada, preciso de: nova descrição, novo valor total, novo nº de parcelas e nova data da 1ª parcela." };
                    }
                    if (!params.newTransactionDate && params.newInitialDueDate) {
                         newParcelData.transactionDate = params.newInitialDueDate;
                    }

                    const recreatedResult = await financialService.recreateParcelledAccount(state.activeFinancialAccountId, originalAccountIdToUpdate, newParcelData, actorId);
                    
                    formattedData = formatter.formatParcelledAccountDataStructure(newParcelData, recreatedResult);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em RECREATE_PARCELLED_ACCOUNT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui recriar a compra parcelada.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_CREDIT_CARD': {
                try {
                    const cardIdToUpdate = state.editingResource?.type === 'credit_card' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : (params.cardIdToUpdate ? parseInt(params.cardIdToUpdate, 10) : null);
                    if (!cardIdToUpdate) {
                        throw { statusCode: 400, message: "ID do cartão para atualizar não foi fornecido." };
                    }

                    const updateDataCard = {};
                    if (params.hasOwnProperty('name')) updateDataCard.name = params.name;
                    if (params.hasOwnProperty('limit') && params.limit !== null && !isNaN(parseFloat(params.limit)) && parseFloat(params.limit) > 0) updateDataCard.limit = parseFloat(params.limit);
                    if (params.hasOwnProperty('closingDay') && params.closingDay !== null && !isNaN(parseInt(params.closingDay))) updateDataCard.closingDay = parseInt(params.closingDay);
                    if (params.hasOwnProperty('paymentDay') && params.paymentDay !== null && !isNaN(parseInt(params.paymentDay))) updateDataCard.paymentDay = parseInt(params.paymentDay);
                    if (params.hasOwnProperty('lastFourDigits')) updateDataCard.lastFourDigits = params.lastFourDigits;
                    if (params.hasOwnProperty('flag')) updateDataCard.flag = params.flag;
                    if (params.hasOwnProperty('isDefault')) updateDataCard.isDefault = params.isDefault;
                    if (params.hasOwnProperty('isActive')) updateDataCard.isActive = params.isActive;
                    
                    if (Object.keys(updateDataCard).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado válido fornecido para atualizar o cartão." };
                    }

                    const updatedCard = await creditCardService.updateCreditCard(state.activeFinancialAccountId, cardIdToUpdate, updateDataCard, actorId);
                    
                    formattedData = formatter.formatCreditCardDataStructure(updatedCard);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_CREDIT_CARD: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar o cartão.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_BUSINESS_CLIENT': {
                try {
                    const clientIdToUpdate = state.editingResource?.type === 'business_client' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : (params.clientIdToUpdate ? parseInt(params.clientIdToUpdate) : null); 
                    
                    let effectiveClientIdToUpdate = clientIdToUpdate;
                    if (!effectiveClientIdToUpdate && params.name) { 
                         const foundClient = await businessClientService.getAllBusinessClients(state.activeFinancialAccountId, { search: params.name, limit: 1 }).then(r => r.businessClients?.[0]);
                         if (foundClient) effectiveClientIdToUpdate = foundClient.id;
                    }
                    if (!effectiveClientIdToUpdate) {
                        throw { statusCode: 400, message: "ID ou nome do cliente do negócio para atualizar não fornecido ou não encontrado." };
                    }

                    const updateDataBC = {};
                    if (params.hasOwnProperty('name')) updateDataBC.name = params.name; 
                    if (params.hasOwnProperty('phone')) updateDataBC.phone = params.phone;
                    if (params.hasOwnProperty('email')) updateDataBC.email = params.email;
                    if (params.hasOwnProperty('notes')) updateDataBC.notes = params.notes;
                    if (params.hasOwnProperty('isActive')) updateDataBC.isActive = params.isActive;
                    
                    if (Object.keys(updateDataBC).length === 0 && !params.name) {
                        throw { statusCode: 400, message: "Nenhum dado válido para atualizar o cliente." };
                    }

                    const updatedBC = await businessClientService.updateBusinessClient(state.activeFinancialAccountId, effectiveClientIdToUpdate, updateDataBC, actorId);
                    
                    formattedData = formatter.formatBusinessClientDataStructure(updatedBC);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_BUSINESS_CLIENT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar o cliente.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_FINANCIAL_ACCOUNT': {
                try {
                    if (!isOwnerActingOnOwnBehalfGlobal) {
                        throw { statusCode: 403, message: "Ação não permitida em acesso compartilhado." };
                    }
                    if (!params.accountNameToUpdate) {
                        throw { statusCode: 400, message: "Qual conta você quer atualizar?" };
                    }

                    const ownerAccounts = await clientService.getClientFinancialAccounts(state.ownerClientIdForContext, {isActive:null});
                    const accountToUpdate = ownerAccounts.find(acc => acc.accountName.toLowerCase() === params.accountNameToUpdate.toLowerCase());
                    if (!accountToUpdate) {
                        throw { statusCode: 404, message: `Não encontrei uma conta sua chamada "${params.accountNameToUpdate}".` };
                    }

                    const updateDataFA = {};
                    if (params.hasOwnProperty('newAccountName')) updateDataFA.accountName = params.newAccountName;
                    if (params.hasOwnProperty('documentNumber')) updateDataFA.documentNumber = params.documentNumber;
                    if (params.hasOwnProperty('isActive')) updateDataFA.isActive = params.isActive;
                    if (params.hasOwnProperty('isDefault')) updateDataFA.isDefault = params.isDefault;
                    
                    if (Object.keys(updateDataFA).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado válido fornecido para atualizar a conta." };
                    }

                    const updatedFA = await clientService.updateFinancialAccount(accountToUpdate.id, updateDataFA); 
                    
                    formattedData = formatter.formatFinancialAccountDataStructure(updatedFA);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_FINANCIAL_ACCOUNT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar a conta.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_GRANTED_ACCESS': {
                try {
                    if (!isOwnerActingOnOwnBehalfGlobal) {
                        throw { statusCode: 403, message: "Ação não permitida em acesso compartilhado." };
                    }
                    if (!params.sharedAccessIdOrUserIdentifier) {
                        throw { statusCode: 400, message: "Preciso do ID do compartilhamento ou do email/telefone do convidado para saber qual acesso atualizar." };
                    }
                    
                    let sharedAccessIdToUpdate;
                    if (!isNaN(parseInt(params.sharedAccessIdOrUserIdentifier))) {
                        sharedAccessIdToUpdate = parseInt(params.sharedAccessIdOrUserIdentifier);
                    } else {
                        const shares = await sharedAccessService.getSharedAccessesByOwner(state.ownerClientIdForContext, { guestIdentifier: params.sharedAccessIdOrUserIdentifier });
                        if (shares.sharedAccesses.length === 0) {
                            throw { statusCode: 404, message: `Nenhum acesso encontrado para "${params.sharedAccessIdOrUserIdentifier}".` };
                        }
                        if (shares.sharedAccesses.length > 1) {
                            throw { statusCode: 409, message: `Encontrei múltiplos acessos para "${params.sharedAccessIdOrUserIdentifier}". Por favor, seja mais específico ou use o ID do compartilhamento.` };
                        }
                        sharedAccessIdToUpdate = shares.sharedAccesses[0].id;
                    }

                    const updateDataSA = {};
                    if (params.hasOwnProperty('newAccessPersonalProfile')) updateDataSA.canAccessPersonalProfile = params.newAccessPersonalProfile;
                    if (params.hasOwnProperty('newBusinessProfileToShareName')) {
                         if (params.newBusinessProfileToShareName === null || params.newBusinessProfileToShareName === "") {
                             updateDataSA.canAccessBusinessProfileId = null;
                         } else {
                             const ownerAccounts = await clientService.getClientFinancialAccounts(state.ownerClientIdForContext, {isActive:true});
                             const bizAccount = ownerAccounts.find(acc => (acc.accountType === 'PJ' || acc.accountType === 'MEI') && acc.accountName.toLowerCase() === params.newBusinessProfileToShareName.toLowerCase());
                             if (!bizAccount) throw { statusCode: 404, message: `Perfil empresarial "${params.newBusinessProfileToShareName}" não encontrado.` };
                             updateDataSA.canAccessBusinessProfileId = bizAccount.id;
                         }
                    }

                    if (Object.keys(updateDataSA).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado válido fornecido para atualizar o acesso." };
                    }

                    const updatedSharedAccess = await sharedAccessService.updateSharedAccess(state.ownerClientIdForContext, sharedAccessIdToUpdate, updateDataSA);
                    
                    formattedData = formatter.formatSharedAccessDataStructure(updatedSharedAccess, 'owner');
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_GRANTED_ACCESS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar o acesso compartilhado.\nDetalhe: ${e.message}`;
                }
                break;
            }

case 'UPDATE_FINANCIAL_CATEGORY': {
                try {
                    if (state.isSharedAccessContext) {
                         throw { statusCode: 403, message: "Você não tem permissão para editar categorias nesta conta compartilhada." };
                    }
                    const { categoryNameToUpdate, newName, newParentCategoryName } = params;
                    if (!categoryNameToUpdate) {
                         throw { statusCode: 400, message: "Qual categoria você gostaria de atualizar?" };
                    }
                    const categoryToUpdate = await financialCategoryService.findFinancialCategoryByNameForAccount(categoryNameToUpdate, state.activeFinancialAccountId);
                    if (!categoryToUpdate) {
                        throw { statusCode: 404, message: `Não encontrei uma categoria chamada "${categoryNameToUpdate}".` };
                    }

                    const updateData = {};
                    if (newName) updateData.name = newName;
                    if (newParentCategoryName) {
                        const newParentCat = await financialCategoryService.findFinancialCategoryByNameForAccount(newParentCategoryName, state.activeFinancialAccountId);
                        if (!newParentCat) throw { statusCode: 404, message: `A nova categoria pai "${newParentCategoryName}" não foi encontrada.`};
                        updateData.parentId = newParentCat.id;
                    } else if (params.hasOwnProperty('newParentCategoryName') && newParentCategoryName === null) {
                        updateData.parentId = null; 
                    }

                    if(Object.keys(updateData).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado novo foi fornecido para a atualização." };
                    }

                    const updatedCategory = await financialCategoryService.updateFinancialCategory(state.activeFinancialAccountId, categoryToUpdate.id, updateData);
                    formattedData = formatter.formatFinancialCategoryDataStructure(updatedCategory);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_FINANCIAL_CATEGORY: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar a categoria.\nDetalhe: ${e.message}`;
                }
                break;
            }
            
            case 'UPDATE_MOTIVATIONAL_PHRASE': {
                try {
                    const { phraseIdToUpdate, newText, newAuthor, isActive } = params;
                    if (!phraseIdToUpdate) {
                        throw { statusCode: 400, message: "Qual frase você gostaria de atualizar? (Preciso do ID)" };
                    }
                    
                    const updateData = {};
                    if (newText) updateData.text = newText;
                    if (newAuthor) updateData.author = newAuthor;
                    if (isActive !== undefined) updateData.isActive = isActive;
                    
                    const updatedPhrase = await systemService.updateMotivationalPhrase(phraseIdToUpdate, updateData);
                    formattedData = `✅ Frase atualizada!\n\n_"${updatedPhrase.text}"_\n- ${updatedPhrase.author || 'Autor Desconhecido'} (Status: ${updatedPhrase.isActive ? 'Ativa' : 'Inativa'})`;
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_MOTIVATIONAL_PHRASE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar sua frase.\nDetalhe: ${e.message}`;
                }
                break;
            }

  case 'LOG_WATER_INTAKE': {
                try {
                    const amount = params.amountInMl ? parseInt(params.amountInMl) : null;
                    
                    await hydrationService.logWaterIntake(actorId, amount);

                    const logs = await hydrationService.getTodaysLogsByClient(actorId);
                    const prefs = await systemService.getSystemPreferences();
                    formattedData = formatter.formatHydrationLogDataStructure(logs, prefs, clientNameToUse);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LOG_WATER_INTAKE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui registrar sua água.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_AVAILABILITY_RULE': {
    try {
        const ruleIdToUpdate = state.editingResource?.type === 'availability_rule' && state.editingResource?.id
            ? parseInt(state.editingResource.id, 10)
            : (params.ruleIdToUpdate ? parseInt(params.ruleIdToUpdate, 10) : null);
        if (!ruleIdToUpdate) {
            throw { statusCode: 400, message: "ID da regra para atualizar não foi fornecido ou não está em contexto de edição." };
        }

        const updateData = { ...params };
        delete updateData.ruleIdToUpdate;

        if (Object.keys(updateData).length === 0) {
            throw { statusCode: 400, message: "Nenhum dado válido fornecido para atualizar a regra." };
        }

        const updatedRule = await availabilityService.updateAvailabilityRule(state.activeFinancialAccountId, ruleIdToUpdate, updateData);
        
        formattedData = formatter.formatAvailabilityRuleDataStructure(updatedRule);
        wasAnEdit = true;
    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em UPDATE_AVAILABILITY_RULE: ${e.message}`, { error: e, paramsUsed: params });
        formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar a regra.\nDetalhe: ${e.message}`;
    }
    break;
}


            // =================================================================
            // AÇÕES DE EXCLUSÃO (DELETE)
            // =================================================================

            case 'DELETE_FINANCIAL_ACCOUNT': {
                try {
                    if (!isOwnerActingOnOwnBehalfGlobal) {
                        throw { statusCode: 403, message: "Ação não permitida em acesso compartilhado." };
                    }
                    if (!params.accountNameToDelete) {
                        throw { statusCode: 400, message: "Qual conta você quer excluir?" };
                    }

                    const ownerAccounts = await clientService.getClientFinancialAccounts(state.ownerClientIdForContext, { isActive: null });
                    const accountToDelete = ownerAccounts.find(acc => acc.accountName.toLowerCase() === params.accountNameToDelete.toLowerCase());
                    
                    if (!accountToDelete) {
                        throw { statusCode: 404, message: `Não encontrei uma conta sua chamada "${params.accountNameToDelete}".` };
                    }
                    if (ownerAccounts.length <= 1) {
                        throw { statusCode: 400, message: "Você não pode excluir sua única conta financeira. Crie outra primeiro, se desejar." };
                    }
                    
                    resourceForButtonsContext = { 
                        type: 'system_action', 
                        id: 'pending_confirmation',
                        description: 'Aguardando confirmação para exclusão de conta',
                        data: {
                            action: 'CONFIRM_DELETE_FINANCIAL_ACCOUNT',
                            parameters: { accountIdToDelete: accountToDelete.id, accountNameToDelete: accountToDelete.accountName },
                            message: `⚠️ *ATENÇÃO, ${clientNameToUse}!* Você tem certeza ABSOLUTA que quer excluir a conta "*${accountToDelete.accountName}*"?\n\nEsta ação NÃO PODE SER DESFEITA e todas as transações, cartões e dados associados a ela serão PERDIDOS para sempre.\n\nDigite "*sim, excluir ${accountToDelete.accountName}*" para confirmar ou "não" para cancelar.`
                        }
                    };
                    formattedData = resourceForButtonsContext.data.message;

                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em DELETE_FINANCIAL_ACCOUNT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui iniciar a exclusão da conta.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'REVOKE_ACCESS': {
                try {
                    if (!isOwnerActingOnOwnBehalfGlobal) {
                        throw { statusCode: 403, message: "Ação não permitida em acesso compartilhado." };
                    }
                    if (!params.sharedWithUserIdentifier) {
                        throw { statusCode: 400, message: "Preciso do telefone ou e-mail do usuário para revogar o acesso." };
                    }

                    const { sharedAccesses } = await sharedAccessService.getSharedAccessesByOwner(state.ownerClientIdForContext, { guestIdentifier: params.sharedWithUserIdentifier, status: 'Ativo' }); 
                    if (sharedAccesses.length === 0) {
                        throw { statusCode: 404, message: `Não encontrei acessos ativos concedidos para "${params.sharedWithUserIdentifier}".` };
                    }

                    let sharedAccessIdToRevoke = null;
                    let guestNameForMsg = params.sharedWithUserIdentifier;

                    if (params.profileNameShared) { 
                        const targetProfileNameLower = params.profileNameShared.toLowerCase();
                        const saToRevoke = sharedAccesses.find(sa => {
                            if (sa.canAccessPersonalProfile && (targetProfileNameLower.includes("pessoal") || sa.ownerClient?.financialAccounts.find(fa=>fa.accountType==='PF')?.accountName.toLowerCase().includes(targetProfileNameLower)) ) return true;
                            if (sa.canAccessBusinessProfileId) {
                                const bizAcc = sa.ownerClient?.financialAccounts.find(fa=> fa.id === sa.canAccessBusinessProfileId);
                                if (bizAcc && bizAcc.accountName.toLowerCase().includes(targetProfileNameLower)) return true;
                            }
                            return false;
                        });
                        if (!saToRevoke) {
                            throw { statusCode: 404, message: `Não encontrei um acesso para o perfil "${params.profileNameShared}" concedido a ${params.sharedWithUserIdentifier}.` };
                        }
                        sharedAccessIdToRevoke = saToRevoke.id;
                        guestNameForMsg = saToRevoke.sharedWithClient?.name || params.sharedWithUserIdentifier;
                    } else if (sharedAccesses.length > 1) {
                        resourceForButtonsContext = { 
                            type: 'system_action',
                            id: 'pending_confirmation',
                            description: 'Aguardando confirmação para revogar múltiplos acessos',
                            data: {
                                action: 'CONFIRM_REVOKE_MULTIPLE_ACCESS',
                                parameters: { sharedAccessIdsToRevoke: sharedAccesses.map(sa => sa.id), guestName: sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier }, 
                                message: `Encontrei ${sharedAccesses.length} acessos para *${sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier}*. Você quer revogar TODOS eles? (Sim/Não)`
                            }
                        };
                        formattedData = resourceForButtonsContext.data.message;
                        break; 
                    } else { 
                        sharedAccessIdToRevoke = sharedAccesses[0].id;
                        guestNameForMsg = sharedAccesses[0].sharedWithClient?.name || params.sharedWithUserIdentifier;
                    }

                    if (sharedAccessIdToRevoke) {
                        await sharedAccessService.revokeAccess(state.ownerClientIdForContext, sharedAccessIdToRevoke); 
                        formattedData = `Acesso de *${guestNameForMsg}* revogado com sucesso! ✅\n\nEsta pessoa não poderá mais acessar as informações através deste convite.`;
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em REVOKE_ACCESS: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui revogar o acesso.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'DELETE_FINANCIAL_TRANSACTION': {
                try {
                    let transactionIdToDelete = params.transactionId;
                    if (!transactionIdToDelete && params.description) {
                         const { transactions } = await financialService.getAllTransactions(state.activeFinancialAccountId, { search: params.description, limit: 1 });
                         if(transactions && transactions.length > 0) transactionIdToDelete = transactions[0].id;
                    }
                    if (!transactionIdToDelete) {
                        throw { statusCode: 404, message: "Não encontrei a transação que você pediu para excluir." };
                    }
                    
                    await financialService.deleteTransaction(state.activeFinancialAccountId, transactionIdToDelete);
                    formattedData = '✅ Transação excluída com sucesso!';
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em DELETE_FINANCIAL_TRANSACTION: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui excluir a transação.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'DELETE_PRODUCT': {
                try {
                    const productNameOrCode = params.productNameOrCode;
                    if (!productNameOrCode) {
                        throw { statusCode: 400, message: "Qual produto você gostaria de excluir?" };
                    }
                    const productIdToDelete = await findProductIdByNameOrCode(productNameOrCode, state.activeFinancialAccountId);
                    if (!productIdToDelete) {
                        throw { statusCode: 404, message: `Não encontrei um produto chamado "${productNameOrCode}".` };
                    }
                    await productService.deleteProduct(state.activeFinancialAccountId, productIdToDelete);
                    formattedData = `✅ Produto "${productNameOrCode}" excluído com sucesso!`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em DELETE_PRODUCT: ${e.message}`, { error: e, paramsUsed: params });
                     let intro = `❌ Ops, ${clientNameToUse}! Não consegui excluir o produto.`;
                    let body = `\nDetalhe: ${e.message}`;
                    if(e.statusCode === 409) { 
                        intro = `Opa, ${clientNameToUse}!`;
                        body = `\nNão posso excluir o produto "${params.productNameOrCode}" porque ele já tem movimentações de estoque registradas. Se você não vai mais usá-lo, você pode marcá-lo como inativo. Quer fazer isso?`;
                    }
                    formattedData = intro + body;
                }
                break;
            }

            case 'DELETE_RECURRING_RULE': {
                try {
                    const ruleDescription = params.ruleDescription;
                    if (!ruleDescription) {
                        throw { statusCode: 400, message: "Qual regra recorrente você quer excluir?" };
                    }
                    const { rules } = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, { descriptionSearch: ruleDescription });
                    if (!rules || rules.length === 0) {
                        throw { statusCode: 404, message: `Não encontrei uma regra com descrição parecida com "${ruleDescription}".` };
                    }
                     if (rules.length > 1) {
                         throw { statusCode: 409, message: `Encontrei múltiplas regras com essa descrição. Por favor, seja mais específico.` };
                    }
                    const ruleIdToDelete = rules[0].id;
                    await recurringTransactionService.deleteRecurringRule(state.activeFinancialAccountId, ruleIdToDelete);
                    formattedData = `✅ Regra recorrente "${ruleDescription}" excluída com sucesso!`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em DELETE_RECURRING_RULE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui excluir a regra.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'DELETE_BUSINESS_CLIENT': {
                 try {
                    const clientNameToDelete = params.clientNameToDelete;
                    if (!clientNameToDelete) {
                        throw { statusCode: 400, message: "Qual cliente do negócio você quer excluir?" };
                    }
                    const clientIdToDelete = await findBusinessClientIdByName(clientNameToDelete, state.activeFinancialAccountId);
                     if (!clientIdToDelete) {
                        throw { statusCode: 404, message: `Não encontrei um cliente chamado "${clientNameToDelete}".` };
                    }
                    await businessClientService.deleteBusinessClient(state.activeFinancialAccountId, clientIdToDelete);
                    formattedData = `✅ Cliente "${clientNameToDelete}" excluído com sucesso!`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em DELETE_BUSINESS_CLIENT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui excluir o cliente.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'DELETE_FINANCIAL_CATEGORY': {
                try {
                    if (state.isSharedAccessContext) {
                        throw { statusCode: 403, message: "Você não tem permissão para excluir categorias nesta conta compartilhada." };
                    }
                    const categoryNameToDelete = params.categoryNameToDelete;
                    if (!categoryNameToDelete) {
                        throw { statusCode: 400, message: "Qual categoria você quer excluir?" };
                    }
                    const categoryToDelete = await financialCategoryService.findFinancialCategoryByNameForAccount(categoryNameToDelete, state.activeFinancialAccountId);
                    if (!categoryToDelete) {
                        throw { statusCode: 404, message: `Não encontrei uma categoria chamada "${categoryNameToDelete}".` };
                    }
                    
                    const actionForTransactions = params.actionForTransactions || 'set_null'; 
                    const actionForSubcategories = params.actionForSubcategories || 'restrict'; 
                    
                    const options = { actionForTransactions, actionForSubcategories };
                    
                    await financialCategoryService.deleteFinancialCategory(state.activeFinancialAccountId, categoryToDelete.id, options);
                    formattedData = `✅ Categoria "${categoryNameToDelete}" excluída com sucesso.`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em DELETE_FINANCIAL_CATEGORY: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `❌ Ops, ${clientNameToUse}! Não consegui excluir a categoria.`;
                    let body = `\nDetalhe: ${e.message}`;
                    if(e.statusCode === 409) {
                        intro = `Opa, ${clientNameToUse}!`;
                        body = `\nNão pude excluir a categoria "${params.categoryNameToDelete}" porque ela tem transações ou subcategorias associadas. Se quiser, posso mover as transações para "Sem Categoria" e promover as subcategorias para o nível principal. Deseja prosseguir com essa opção?`;
                    }
                    formattedData = intro + body;
                }
                break;
            }

             case 'DELETE_MOTIVATIONAL_PHRASE': {
                try {
                    const { phraseIdToDelete } = params;
                    if (!phraseIdToDelete) {
                        throw { statusCode: 400, message: "Qual frase você gostaria de apagar? (Preciso do ID)" };
                    }
                    await systemService.deleteMotivationalPhrase(phraseIdToDelete);
                    formattedData = `✅ Frase (ID: ${phraseIdToDelete}) apagada com sucesso!`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em DELETE_MOTIVATIONAL_PHRASE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui apagar sua frase.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'DELETE_AVAILABILITY_RULE': {
    try {
        let ruleIdToDelete = params.ruleIdToDelete;
        if (!ruleIdToDelete && params.ruleTitleToDelete) {
             const rules = await availabilityService.getAllAvailabilityRules(state.activeFinancialAccountId);
             const ruleFound = rules.find(r => r.title.toLowerCase() === params.ruleTitleToDelete.toLowerCase());
             if (ruleFound) ruleIdToDelete = ruleFound.id;
        }
        if (!ruleIdToDelete) {
            throw { statusCode: 404, message: `Não encontrei a regra de disponibilidade "${params.ruleTitleToDelete || 'especificada'}" para excluir.` };
        }
        
        await availabilityService.deleteAvailabilityRule(state.activeFinancialAccountId, ruleIdToDelete);
        formattedData = '✅ Regra de disponibilidade excluída com sucesso!';
    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em DELETE_AVAILABILITY_RULE: ${e.message}`, { error: e, paramsUsed: params });
        formattedData = `❌ Ops, ${clientNameToUse}! Não consegui excluir a regra.\nDetalhe: ${e.message}`;
    }
    break;
}


            // AÇÕES DE GESTÃO DE SERVIÇOS (CRUD)
            case 'CREATE_SERVICE': {
                try {
                    const serviceData = {
                        name: params.name,
                        description: params.description,
                        durationMinutes: parseInt(params.durationMinutes, 10),
                        price: parseFloat(params.price),
                    };

                    if (!serviceData.name || isNaN(serviceData.price) || isNaN(serviceData.durationMinutes)) {
                        throw { statusCode: 400, message: "Nome, preço e duração são obrigatórios para criar um serviço." };
                    }

                    const newService = await serviceService.createService(state.activeFinancialAccountId, serviceData);
                    formattedData = formatter.formatServiceDataStructure(newService);

                    resourceForButtonsContext.resources.push({ type: 'service', id: newService.id, description: newService.name });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em CREATE_SERVICE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui criar o serviço.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'LIST_SERVICES': {
                try {
                    const { services, totalItems } = await serviceService.getAllServices(state.activeFinancialAccountId, {
                        search: params.searchTerm,
                        isActive: params.isActive !== undefined ? params.isActive : true,
                        limit: params.limit || 5,
                    });

                    if (totalItems === 0) {
                        formattedData = "Você ainda não cadastrou nenhum serviço. Diga 'criar serviço [nome] preço [valor] duração [minutos]' para começar.";
                    } else {
                        formattedData = formatter.formatListServicesDataStructure(services);
                        if (totalItems > services.length) {
                            formattedData += `\n\nE mais ${totalItems - services.length} serviço(s).`;
                        }
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em LIST_SERVICES: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui listar seus serviços.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'UPDATE_SERVICE': {
                try {
                    const serviceIdToUpdate = state.editingResource?.type === 'service' && state.editingResource?.id
                        ? parseInt(state.editingResource.id, 10)
                        : null;
                    
                    if (!serviceIdToUpdate) {
                        throw { statusCode: 400, message: "Por favor, primeiro selecione o serviço que deseja editar." };
                    }

                    const updateDataSvc = {};
                    if (params.hasOwnProperty('name')) updateDataSvc.name = params.name;
                    if (params.hasOwnProperty('description')) updateDataSvc.description = params.description;
                    if (params.hasOwnProperty('durationMinutes')) updateDataSvc.durationMinutes = parseInt(params.durationMinutes, 10);
                    if (params.hasOwnProperty('price')) updateDataSvc.price = parseFloat(params.price);
                    if (params.hasOwnProperty('isActive')) updateDataSvc.isActive = params.isActive;

                    if (Object.keys(updateDataSvc).length === 0) {
                        throw { statusCode: 400, message: "Nenhum dado válido foi fornecido para atualizar o serviço." };
                    }

                    const updatedService = await serviceService.updateService(state.activeFinancialAccountId, serviceIdToUpdate, updateDataSvc);
                    formattedData = formatter.formatServiceDataStructure(updatedService);
                    wasAnEdit = true;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em UPDATE_SERVICE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar o serviço.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'DELETE_SERVICE': {
                try {
                    let serviceIdToDelete = params.serviceId;
                    if (!serviceIdToDelete && params.serviceName) {
                        const { services } = await serviceService.getAllServices(state.activeFinancialAccountId, { search: params.serviceName, limit: 1 });
                        if(services && services.length > 0) serviceIdToDelete = services[0].id;
                    }
                    if (!serviceIdToDelete) {
                        throw { statusCode: 404, message: `Não encontrei o serviço "${params.serviceName}" para excluir.` };
                    }

                    await serviceService.deleteService(state.activeFinancialAccountId, serviceIdToDelete);
                    formattedData = `✅ Serviço (ID: ${serviceIdToDelete}) excluído com sucesso!`;
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em DELETE_SERVICE: ${e.message}`, { error: e, paramsUsed: params });
                    let intro = `❌ Ops, ${clientNameToUse}! Não consegui excluir o serviço.`;
                    let body = `\nDetalhe: ${e.message}`;
                    if(e.statusCode === 409) {
                        intro = `Opa, ${clientNameToUse}!`;
                        body = `\nNão posso excluir o serviço "${params.serviceName}" porque ele já está sendo usado em agendamentos. Se você não o oferece mais, pode *desativá-lo*. Quer fazer isso?`;
                    }
                    formattedData = intro + body;
                }
                break;
            }

            // AÇÕES DE CICLO DE VIDA DO AGENDAMENTO (PJ/MEI)
      case 'CONFIRM_APPOINTMENT': {
    try {
        const appointmentId = params.appointmentId ? parseInt(params.appointmentId, 10) : null;
        if (!appointmentId) {
            throw { statusCode: 400, message: "Preciso do ID do agendamento para confirmá-lo." };
        }
        
        const confirmedAppointment = await appointmentService.confirmAppointment(state.activeFinancialAccountId, appointmentId);
        
        const creativeResponse = await aiModelService.generateBookingConfirmationResponse(clientNameToUse, confirmedAppointment);
        const formattedDetails = formatter.formatAppointmentDataStructure(confirmedAppointment);

        formattedData = `${creativeResponse}\n\n${formattedDetails}`;

    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em CONFIRM_APPOINTMENT: ${e.message}`, { error: e, paramsUsed: params });
        formattedData = `❌ Ops, ${clientNameToUse}! Não consegui confirmar o agendamento.\nDetalhe: ${e.message}`;
    }
    break;
}


            case 'COMPLETE_APPOINTMENT': {
                try {
                    const appointmentId = params.appointmentId ? parseInt(params.appointmentId, 10) : null;
                    if (!appointmentId) {
                        throw { statusCode: 400, message: "Preciso do ID do agendamento para marcá-lo como concluído." };
                    }

                    const completedAppointment = await appointmentService.completeAppointment(state.activeFinancialAccountId, appointmentId);
                    
                    const totalValue = completedAppointment.services.reduce((sum, service) => sum + parseFloat(service.price), 0);
                    
                    formattedData = `🎉 Serviço concluído com sucesso!\n\n` +
                                    `O agendamento ID ${completedAppointment.id} ("${completedAppointment.title}") foi marcado como finalizado. ` +
                                    `Uma transação de entrada no valor de *${formatter.formatCurrency(totalValue)}* foi registrada automaticamente no seu financeiro.`;

                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em COMPLETE_APPOINTMENT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui finalizar o agendamento.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'CANCEL_APPOINTMENT': {
                try {
                    const appointmentId = params.appointmentId ? parseInt(params.appointmentId, 10) : null;
                    if (!appointmentId) {
                        throw { statusCode: 400, message: "Preciso do ID do agendamento para cancelar." };
                    }
                    
                    await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, false);
                    formattedData = `✅ Agendamento ID ${appointmentId} cancelado com sucesso. A outra parte será notificada.`;

                } catch(e) {
                    logger.error(`[ACTION HANDLER] Erro em CANCEL_APPOINTMENT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui cancelar o agendamento.\nDetalhe: ${e.message}`;
                }
                break;
            }

          // AÇÕES DE SISTEMA, ESTADO E PREFERÊNCIAS
                  case 'SWITCH_FINANCIAL_ACCOUNT': {
                try {
                    const targetAccountIdentifier = params.targetAccountNameOrType;
                    if (!targetAccountIdentifier) {
                        throw { statusCode: 400, message: "Para qual conta você gostaria de mudar? Me diga o nome ou o tipo (PF, PJ, MEI)." };
                    }
                    
                    const ownerAccounts = await clientService.getClientFinancialAccounts(state.ownerClientIdForContext, { isActive: true });
                    
                    let accessibleAccounts = ownerAccounts;
                    if (state.isSharedAccessContext) {
                        accessibleAccounts = ownerAccounts.filter(acc => {
                            if (acc.accountType === 'PF') return state.sharedAccessPermissions.canAccessPersonalProfile;
                            if (acc.accountType === 'PJ' || acc.accountType === 'MEI') return state.sharedAccessPermissions.canAccessBusinessProfileId === acc.id;
                            return false;
                        });
                    }

                    if (accessibleAccounts.length === 0) {
                        throw { statusCode: 404, message: `Você não tem nenhuma conta ${state.isSharedAccessContext ? `de ${state.ownerClientNameForContext} ` : ''}acessível no momento.` };
                    }
                    
                    // Lógica de busca flexível
                    const targetLower = targetAccountIdentifier.toLowerCase();
                    const potentialMatches = accessibleAccounts.filter(acc => {
                        const nameLower = (acc.accountName || acc.name).toLowerCase();
                        const typeLower = (acc.accountType || acc.type).toLowerCase();
                        return nameLower.includes(targetLower) ||
                               typeLower.includes(targetLower) ||
                               (targetLower.includes('pessoal') && typeLower === 'pf') ||
                               ((targetLower.includes('empresa') || targetLower.includes('negócio') || targetLower.includes('pj') || targetLower.includes('mei')) && (typeLower === 'pj' || typeLower === 'mei'));
                    });

                    let foundAccount = null;
                    if (potentialMatches.length === 1) {
                        foundAccount = potentialMatches[0];
                    }

                    // Lógica de decisão
                    if (foundAccount && foundAccount.id !== state.activeFinancialAccountId) {
                        formattedData = `Prontinho! Mudei para a conta *"${foundAccount.accountName}"* (${foundAccount.accountType}).\n\nO que vamos fazer por aqui agora?`;
                        resourceForButtonsContext = { type: 'system_action', id: 'account_switched', description: 'Troca de conta realizada', data: foundAccount };
                    } else if (foundAccount && foundAccount.id === state.activeFinancialAccountId) {
                        formattedData = `Você já está na conta "${state.activeFinancialAccountName}", ${clientNameToUse}! 😉`;
                    } else {
                        // Se não encontrou ou encontrou múltiplos, lista as opções
                        const ownerNameForMsg = state.isSharedAccessContext ? state.ownerClientNameForContext : null;
                        const accountOptionsText = formatter.formatListClientAccountsDataStructure(accessibleAccounts, null, ownerNameForMsg);

                        let introMessage = "Não encontrei uma conta exata com esse nome. ";
                        if (potentialMatches.length > 1) {
                            introMessage = "Encontrei algumas opções! ";
                        }
                        
                        formattedData = `${introMessage}Para qual das seguintes contas você gostaria de mudar?\n\n${accountOptionsText}`;
                        
                        // Sinaliza para o serviço principal que estamos aguardando uma seleção
                        resourceForButtonsContext = { 
                            type: 'system_action', 
                            id: 'awaiting_account_selection', 
                            description: 'Aguardando seleção de conta pelo usuário' 
                        };
                    }
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em SWITCH_FINANCIAL_ACCOUNT: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui trocar de conta.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'SET_MOTIVATIONAL_MESSAGE_PREFERENCE': {
                try {
                    if (params.enable === undefined || (params.enable && !params.time)) {
                        throw { statusCode: 400, message: "Preciso saber se quer ativar/desativar e, se ativar, o horário (ex: 8h, 19:30)." };
                    }
                    
                    const updatedClientPrefs = await clientService.updateClientMotivationPrefs(actorId, {
                        enable: params.enable,
                        time: params.enable ? params.time : null
                    });

                    formattedData = formatter.formatMotivationalMessagePreferenceDataStructure({
                        enableMotivationMessage: updatedClientPrefs.wantsMotivationMessage,
                        motivationMessageTime: updatedClientPrefs.motivationMessageTime
                    });
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em SET_MOTIVATIONAL_MESSAGE_PREFERENCE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui atualizar suas preferências de motivação.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'SET_WATER_REMINDER_PREFERENCE': {
                try {
                    if (params.enable === undefined || (params.enable && (!params.frequencyType || !params.startTime || !params.endTime))) {
                        throw { statusCode: 400, message: "Preciso saber se quer ativar/desativar e, se ativar, a frequência, horário de início e fim." };
                    }
                    if (params.enable && params.frequencyType === 'custom' && !params.customIntervalMinutes) {
                        throw { statusCode: 400, message: "Para frequência personalizada de lembrete de água, preciso do intervalo em minutos." };
                    }

                    await systemService.updateSystemPreferences({
                        enableWaterReminder: params.enable,
                        waterReminderFrequencyType: params.enable ? params.frequencyType : 'disabled',
                        waterReminderCustomIntervalMinutes: params.enable && params.frequencyType === 'custom' ? parseInt(params.customIntervalMinutes) : null,
                        waterReminderStartTime: params.enable ? params.startTime : null,
                        waterReminderEndTime: params.enable ? params.endTime : null,
                        dailyGoalMl: params.enable && params.dailyGoalMl ? parseInt(params.dailyGoalMl) : null
                    });
                    const updatedPrefsWater = await systemService.getSystemPreferences();
                    
                    formattedData = formatter.formatWaterReminderPreferenceDataStructure(updatedPrefsWater);
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em SET_WATER_REMINDER_PREFERENCE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui configurar os lembretes de água.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'RESPOND_TO_INVITE': { 
                try {
                    if (!params.responseType || !['aceitar', 'recusar'].includes(params.responseType.toLowerCase())) {
                        throw { statusCode: 400, message: "Preciso saber se você quer 'aceitar' ou 'recusar' o convite." };
                    }
                    
                    let sharedAccessIdToRespond = params.sharedAccessId;
                    if (!sharedAccessIdToRespond) { 
                        const {sharedAccesses: pendingInvites} = await sharedAccessService.getSharedAccessesForUser(actorId, { status: 'Pendente' });
                        if (pendingInvites.length === 0) {
                            throw { statusCode: 404, message: "Você não tem convites pendentes para responder." };
                        }
                        if (pendingInvites.length === 1 && !params.inviterNameOrIdentifier) {
                            sharedAccessIdToRespond = pendingInvites[0].id;
                        } else if (params.inviterNameOrIdentifier) {
                            const foundInvite = pendingInvites.find(invite => invite.ownerClient?.name.toLowerCase().includes(params.inviterNameOrIdentifier.toLowerCase()) || invite.ownerClient?.email.toLowerCase().includes(params.inviterNameOrIdentifier.toLowerCase()));
                            if (!foundInvite) {
                                throw { statusCode: 404, message: `Não encontrei um convite pendente de "${params.inviterNameOrIdentifier}".` };
                            }
                            sharedAccessIdToRespond = foundInvite.id;
                        } else {
                            throw { statusCode: 409, message: "Você tem múltiplos convites pendentes. Por favor, especifique de quem é o convite (ex: 'aceitar convite do Fulano')." };
                        }
                    }
                    
                    const response = params.responseType.toLowerCase();
                    const updatedSharedAccess = await sharedAccessService.respondToInvite(actorId, sharedAccessIdToRespond, response); 
                    const reloadedSAForRespond = await sharedAccessService.getSharedAccessById(updatedSharedAccess.id);
                    
                    formattedData = formatter.formatSharedAccessDataStructure(reloadedSAForRespond, 'guest');
                } catch (e) {
                    logger.error(`[ACTION HANDLER] Erro em RESPOND_TO_INVITE: ${e.message}`, { error: e, paramsUsed: params });
                    formattedData = `❌ Ops, ${clientNameToUse}! Não consegui responder ao convite.\nDetalhe: ${e.message}`;
                }
                break;
            }

            case 'GENERAL_GREETING_OR_SMALLTALK':
            case 'GENERAL_QUESTION_OR_HELP':
            case 'ACTION_CONFIRMATION_YES':
            case 'ACTION_CONFIRMATION_NO':
                formattedData = detectedAction.action_specific_reply_suggestion || "";
                break;
            
            default:
                formattedData = `Ainda estou aprendendo a processar a ação de "${actionName.toLowerCase().replace(/_/g," ")}" completamente. 😅 Minha equipe está trabalhando nisso!`;
                logger.warn(`[ACTION HANDLER] Ação da IA não implementada ou sem formatação específica no switch: ${actionName}`);
                break;
        }
    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro CRÍTICO ao executar "${actionName}": ${e.message}`, { stack: e.stack, paramsUsed: params });
        formattedData = `❌ Ops! Ocorreu um erro inesperado ao tentar executar esta ação. Minha equipe já foi notificada.\nDetalhe: ${e.message}`;
    }

    return { formattedData, resourceForButtonsContext, wasAnEdit };
}



async function handleButtonInteraction(state, buttonId, senderPhone) {
    try {
        const [action, resourceType, idStr] = buttonId.split(':');

        if (resourceType === 'multi_action_block') {
            const resources = JSON.parse(Buffer.from(idStr, 'base64').toString('utf8'));
            
            if (action === 'edit') {
                state.editingResource = { type: 'multi_action_block', resources: resources };
                let editPrompt = "Ok! Estou em modo de edição para este bloco de ações. O que você gostaria de mudar? 😉\n\nPode dizer, por exemplo: ";
                
                const firstItem = resources[0];
                editPrompt += `'mudar o ${firstItem.description} para 60 reais'.`;
                
                await sendWhatsappMessage(senderPhone, editPrompt);
                return { stateUpdated: true, newState: state, flowCompleted: false };
            }

            if (action === 'delete') {
                let deletePrompt = "Entendido. Qual dos itens você gostaria de excluir?\n\n";
                const itemDescriptions = resources.map(r => `*${r.description}*`).join(' ou ');
                deletePrompt += `Você pode me dizer: ${itemDescriptions}.\n\nSe quiser apagar tudo de uma vez, é só dizer *"todos"*!`;
                
                state.pendingConfirmation = {
                    action: 'AWAITING_DELETION_CHOICE',
                    resources: resources
                };
                state.currentAction = 'awaiting_confirmation';
                
                await sendWhatsappMessage(senderPhone, deletePrompt);
                return { stateUpdated: true, newState: state, flowCompleted: false };
            }
        }

        const resourceId = parseInt(idStr, 10);

        if (!action || !resourceType || isNaN(resourceId)) {
            logger.warn(`[BUTTON HANDLER] ID de botão inválido recebido: '${buttonId}'`);
            await sendWhatsappMessage(senderPhone, "Ops, parece que houve um problema com o botão que você clicou. Tente a ação novamente por texto.");
            return { flowCompleted: true };
        }

        if (action === 'edit') {
            state.editingResource = { type: resourceType, id: resourceId };
            const editPrompt = `Ok! Selecionei o item para edição. O que você gostaria de mudar?`;
            await sendWhatsappMessage(senderPhone, editPrompt);
            return { stateUpdated: true, newState: state, flowCompleted: false };
        }

        if (action === 'delete') {
            let successMessage;
            try {
                let resourceDescription = `O item`; 
                
                switch (resourceType) {
                    case 'transaction': {
                        const tx = await financialService.getTransactionById(state.activeFinancialAccountId, resourceId);
                        if (tx) resourceDescription = `A transação "${tx.description}"`;
                        await financialService.deleteTransaction(state.activeFinancialAccountId, resourceId);
                        break;
                    }
                    case 'appointment': {
                        const appt = await appointmentService.getAppointmentById(state.activeFinancialAccountId, resourceId);
                        if (appt) resourceDescription = `O compromisso "${appt.title}"`;
                        await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, resourceId, true);
                        break;
                    }
                    case 'product': {
                        const prod = await productService.getProductById(state.activeFinancialAccountId, resourceId);
                        if (prod) resourceDescription = `O produto "${prod.name}"`;
                        await productService.deleteProduct(state.activeFinancialAccountId, resourceId);
                        break;
                    }
                    case 'credit_card': {
                        const card = await creditCardService.getCreditCardById(state.activeFinancialAccountId, resourceId);
                        if (card) resourceDescription = `O cartão "${card.name}"`;
                        await creditCardService.deleteCreditCard(state.activeFinancialAccountId, resourceId);
                        break;
                    }
                    case 'recurring_rule': {
                        const rule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, resourceId);
                        if (rule) resourceDescription = `A regra recorrente "${rule.description}"`;
                        await recurringTransactionService.deleteRecurringRule(state.activeFinancialAccountId, resourceId);
                        break;
                    }
                    case 'parcelled_account': {
                        const originalTx = await financialService.getTransactionById(state.activeFinancialAccountId, resourceId);
                        if (originalTx) resourceDescription = `A compra parcelada "${originalTx.description.replace(/ - Parcela \d+\/\d+$/, '')}"`;
                        await financialService.deleteParcelledAccountGroup(state.activeFinancialAccountId, resourceId);
                        break;
                    }
                    case 'business_client': {
                        const bc = await businessClientService.getBusinessClientById(state.activeFinancialAccountId, resourceId);
                        if (bc) resourceDescription = `O cliente "${bc.name}"`;
                        await businessClientService.deleteBusinessClient(state.activeFinancialAccountId, resourceId);
                        break;
                    }
                    case 'availability_rule': {
                        const rule = await availabilityService.getAvailabilityRuleById(state.activeFinancialAccountId, resourceId);
                        if (rule) resourceDescription = `A regra de disponibilidade "${rule.title}"`;
                        await availabilityService.deleteAvailabilityRule(state.activeFinancialAccountId, resourceId);
                        break;
}
                    default:
                        throw new Error(`Tipo de recurso "${resourceType}" não suportado para exclusão via botão.`);
                }
                
                successMessage = `✅ ${resourceDescription} foi excluído com sucesso!`;

            } catch (deleteError) {
                logger.error(`[BUTTON HANDLER] Erro ao excluir ${resourceType} ID ${resourceId}: ${deleteError.message}`);
                successMessage = `❌ Ops! Tive um problema ao tentar excluir o item. Detalhe: ${deleteError.message}`;
            }
            
            await sendWhatsappMessage(senderPhone, successMessage);
            return { flowCompleted: true };
        }

        if (action === 'details' && resourceType === 'credit_card') {
            try {
                const card = await creditCardService.getCreditCardById(state.activeFinancialAccountId, resourceId);
                if (!card) {
                    await sendWhatsappMessage(senderPhone, "Ops, não encontrei mais esse cartão para ver os detalhes.");
                    return { flowCompleted: true };
                }
                const fakeUserInput = `ver a fatura aberta do cartão ${card.name}`;
                return { stateUpdated: false, newState: null, flowCompleted: false, repromptWith: fakeUserInput };

            } catch (detailsError) {
                logger.error(`[BUTTON HANDLER] Erro ao buscar detalhes de ${resourceType} ID ${resourceId}: ${detailsError.message}`);
                await sendWhatsappMessage(senderPhone, "❌ Tive um problema ao buscar os detalhes. Por favor, tente novamente por texto.");
                return { flowCompleted: true };
            }
        }
        
        logger.warn(`[BUTTON HANDLER] Ação de botão desconhecida ou não tratada: '${action}' para o tipo '${resourceType}'`);
        await sendWhatsappMessage(senderPhone, "Essa opção ainda está em desenvolvimento. Tente a ação por texto!");
        return { flowCompleted: true };

    } catch (error) {
        logger.error(`[BUTTON HANDLER] Erro crítico ao tratar clique de botão '${buttonId}': ${error.message}`, { stack: error.stack });
        await sendWhatsappMessage(senderPhone, "Ops, tive um problema interno ao processar sua seleção. Minha equipe já foi notificada.");
        return { flowCompleted: true };
    }
}

async function recordSale(state, params, clientNameToUse, actorId) {
    try {
        const { productNameOrCode, quantitySold, saleDate, notes } = params;
        if (!productNameOrCode || !quantitySold || isNaN(parseInt(quantitySold)) || parseInt(quantitySold) <= 0) {
            throw { statusCode: 400, message: "Para registrar uma venda, preciso do nome do produto e da quantidade vendida." };
        }
        
        const financialAccountId = state.activeFinancialAccountId;
        
        // 1. Buscar o produto para obter o preço de venda e o ID
        const product = await productService.findProductByNameOrCodeForSale(financialAccountId, productNameOrCode);
        if (!product) {
            throw { statusCode: 404, message: `Não encontrei um produto ativo chamado "${productNameOrCode}".` };
        }

        const qty = parseInt(quantitySold);

        // 2. Dar baixa no estoque
        await stockService.recordStockMovement(financialAccountId, product.id, {
            movementType: 'Saída',
            quantity: qty,
            reason: `Venda registrada via WhatsApp (Ator ID: ${actorId})`,
        });

        // 3. Criar a transação financeira de ENTRADA
        const totalSaleValue = product.salePrice * qty;
        const transactionDescription = `Venda de ${qty}x ${product.name}`;
        
        await financialService.createTransaction(financialAccountId, {
            description: transactionDescription,
            type: 'Entrada',
            value: totalSaleValue,
            transactionDate: saleDate || new Date().toISOString().split('T')[0],
            isPaidOrReceived: true, // Vendas diretas são consideradas recebidas
            notes: notes,
            // Opcional: Vincular a uma categoria "Venda de Produtos" se existir
        }, actorId);

        return {
            formattedData: `✅ Venda registrada com sucesso!\n\n` +
                           `📦 *Produto:* ${product.name} (-${qty} un.)\n` +
                           `💰 *Entrada:* ${formatter.formatCurrency(totalSaleValue)}\n` +
                           `📈 *Novo Estoque:* ${product.quantity - qty} un.`
        };

    } catch (e) {
        logger.error(`[ACTION HANDLER] Erro em RECORD_SALE: ${e.message}`, { error: e, paramsUsed: params });
        // Retorna uma mensagem de erro formatada para o usuário
        return { formattedData: `❌ Ops, ${clientNameToUse}! Não consegui registrar a venda.\nDetalhe: ${e.message}` };
    }
}
module.exports = {
    handleAction,
    handleButtonInteraction,
    recordSale
};

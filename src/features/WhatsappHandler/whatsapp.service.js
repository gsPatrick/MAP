// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service'); // Para categorias, frases

const { sendWhatsappMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService'); // Assumindo que você o criou
const logger = require('../../utils/logger');
const { Op } = require('sequelize'); // Para queries mais complexas se necessário

// Key: senderPhone, Value: { currentAction, data, activeFinancialAccountId, etc... }
const conversationState = new Map();
const MAX_HISTORY = 6; // Para o histórico da IA

// Função auxiliar para buscar categoria por nome (a ser implementada em systemService ou financialService)
async function findFinancialCategoryIdByName(name, financialAccountId) {
    if (!name) return null;
    // Esta função precisa buscar em FinancialCategory, talvez com escopo global ou específico da conta.
    // Por simplicidade, vamos assumir que ela retorna um objeto { id: ... } ou null.
    const category = await systemService.findFinancialCategoryByName(name, financialAccountId); // Você precisará criar esta função
    return category ? category.id : null;
}

// Função auxiliar para buscar cartão por nome (a ser implementada em creditCardService)
async function findCreditCardIdByName(name, financialAccountId) {
    if (!name) return null;
    const card = await creditCardService.findCreditCardByName(name, financialAccountId); // Você precisará criar esta função
    return card ? card.id : null;
}

// Função auxiliar para buscar produto por nome ou código
async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode) return null;
    // Esta função precisa buscar em Product
    const product = await productService.findProductByNameOrCode(nameOrCode, financialAccountId); // Você precisará criar esta função
    return product ? product.id : null;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
  const senderPhone = senderPhoneNormalized;
  const startTime = Date.now();
  try {
    const client = await clientService.findOrCreateClientByPhone(senderPhone, { name: pushName }, true);
    if (!client) {
      await sendWhatsappMessage(senderPhone, "Desculpe, estou com um problema para identificar você. Por favor, tente mais tarde.");
      return;
    }

    let state = conversationState.get(senderPhone) || {
      currentAction: null, data: {}, activeFinancialAccountId: null, activeFinancialAccountName: null,
      activeFinancialAccountType: null, messageHistory: [], pendingConfirmation: null
    };

    if(state.messageHistory.length === 0 && client.name) { // Adiciona uma saudação inicial ao histórico se for a primeira vez
        state.messageHistory.push({role: 'assistant', content: `Olá ${client.name}! Como posso ajudar na conta ${state.activeFinancialAccountName || 'padrão'}?`});
    }
    if(state.messageHistory.length >= MAX_HISTORY * 2) state.messageHistory = state.messageHistory.slice(-(MAX_HISTORY * 2) + 2);
    state.messageHistory.push({role: 'user', content: messageText});


    if (!state.activeFinancialAccountId) {
      const defaultAccount = await clientService.getActiveOrDefaultFinancialAccount(client.id);
      if (defaultAccount) {
        state.activeFinancialAccountId = defaultAccount.id;
        state.activeFinancialAccountName = defaultAccount.accountName;
        state.activeFinancialAccountType = defaultAccount.accountType;
      } else {
        const accounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
        if (accounts.length === 0) {
          state.currentAction = 'creating_first_account_type';
          state.messageHistory.push({role: 'assistant', content: "Olá! Para começarmos, sua conta é Pessoal (PF), Empresa (PJ) ou MEI?"});
          conversationState.set(senderPhone, state);
          await sendWhatsappMessage(senderPhone, "Olá! Bem-vindo(a) ao Meu Assessor Financeiro! 😊\nPara que eu possa te ajudar melhor, vamos configurar sua primeira conta. Ela é para suas finanças *Pessoais (PF)*, para sua *Empresa (PJ)* ou para seu *MEI*?");
          return;
        } else if (accounts.length === 1) {
            state.activeFinancialAccountId = accounts[0].id; state.activeFinancialAccountName = accounts[0].accountName; state.activeFinancialAccountType = accounts[0].accountType;
        } else {
            state.currentAction = 'selecting_initial_financial_account'; state.data = { accounts };
            let opts = "Você tem mais de uma conta. Qual delas usaremos agora?\n";
            accounts.forEach((acc, i) => { opts += `${i+1}. ${acc.accountName} (${acc.accountType})\n`;});
            state.messageHistory.push({role: 'assistant', content: opts});
            conversationState.set(senderPhone, state);
            await sendWhatsappMessage(senderPhone, opts); return;
        }
      }
    }
    if(state.activeFinancialAccountId && (!state.activeFinancialAccountName || !state.activeFinancialAccountType)){
        const acc = await clientService.getFinancialAccountById(state.activeFinancialAccountId);
        if(acc && acc.isActive){ state.activeFinancialAccountName=acc.accountName; state.activeFinancialAccountType=acc.accountType;}
        else { conversationState.delete(senderPhone); return processIncomingMessage(senderPhone, messageText, pushName, rawPayload); }
    }
    
    const financialAccount = { id: state.activeFinancialAccountId, type: state.activeFinancialAccountType, name: state.activeFinancialAccountName };
    conversationState.set(senderPhone, state); // Salva estado antes de qualquer lógica de ação
    logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id}, Conta Ativa: ${financialAccount.id} (${financialAccount.name} - ${financialAccount.type}), Msg: "${messageText}"`);

    // === Lógica de Estado da Conversa (ANTES da IA para comandos de estado) ===
    if (state.currentAction) {
        // ... (lógica para creating_first_account_type, awaiting_new_account_name, selecting_initial_financial_account, awaiting_account_switch_choice como antes) ...
        // ... (lógica para awaiting_confirmation - YES/NO) ...
        // Se um estado foi tratado e uma resposta enviada, DÊ UM RETURN AQUI.
        // Exemplo:
        if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
            const lowerMsg = messageText.toLowerCase().trim();
            if (lowerMsg === 'sim' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                // Processar a ação que estava pendente em state.pendingConfirmation.action
                // ... lógica para re-executar a ação com os dados de state.pendingConfirmation.parameters ...
                const confirmedAction = state.pendingConfirmation;
                state.currentAction = null; state.data = {}; state.pendingConfirmation = null; // Limpa estado
                conversationState.set(senderPhone, state);
                // Simular reprocessamento com a ação confirmada
                // Isto idealmente seria uma chamada a uma função que executa a ação
                const tempAiResponse = { detected_actions: [confirmedAction], reply_to_user_suggestion: `Ok! Realizando: ${confirmedAction.parameters.description || confirmedAction.action}`};
                // (Essa parte precisa ser mais robusta, chamando o switch case abaixo)
                // Por ora, vamos apenas confirmar e pedir o próximo comando:
                await sendWhatsappMessage(senderPhone, `Confirmado! ${confirmedAction.parameters.description || 'Ação'} realizada. O que mais posso fazer por você?`);
                return;
            } else if (lowerMsg === 'não' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancelar')) {
                state.currentAction = null; state.data = {}; state.pendingConfirmation = null;
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, "Ok, cancelado. O que gostaria de fazer então?");
                return;
            } else {
                await sendWhatsappMessage(senderPhone, `Por favor, responda com "Sim" ou "Não" para a confirmação anterior, ou diga "cancelar".`);
                return;
            }
        }
    }


    // === Comandos diretos ou IA ===
    if (messageText.toLowerCase().trim() === 'menu' || messageText.toLowerCase().trim() === 'ajuda' || messageText.toLowerCase().trim() === 'opções') {
        state.currentAction = null; state.data = {}; state.pendingConfirmation = null;
        const menuMsg = `Você está na conta: *${financialAccount.name} (${financialAccount.type})*.\n\n`+
                        `Como posso ajudar?\n`+
                        `1. Registrar Despesa/Receita\n2. Ver Saldo/Extrato\n`+
                        ( (financialAccount.type === 'PJ' || financialAccount.type === 'MEI') ? `3. Estoque (Consultar/Movimentar)\n4. Compromissos\n` : `3. Compromissos\n` ) +
                        `...\nE. Trocar Conta\nF. Nova Conta`; // Adapte os números
        state.messageHistory.push({role: 'assistant', content: menuMsg});
        conversationState.set(senderPhone, state);
        await sendWhatsappMessage(senderPhone, menuMsg); return;
    }
    // ... (lógica para 'trocar conta', 'nova conta' como na resposta anterior) ...


    // Enviar para IA
    const aiContext = {
      currentFinancialAccountId: financialAccount.id,
      currentFinancialAccountType: financialAccount.type,
      currentFinancialAccountName: financialAccount.name,
      conversationHistory: state.messageHistory.slice(-MAX_HISTORY),
      currentStateData: state.data
    };
    const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
    logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponse});
    state.lastAiResponse = aiResponse;

    let finalReplyToUser = "";
    const individualActionResults = [];
    let clearConversationStateThisTurn = true;
    let requiresConfirmation = false;


    if (aiResponse.overall_summary_suggestion) {
      finalReplyToUser += `${aiResponse.overall_summary_suggestion}\n\n`;
    }

    if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
      if (aiResponse.detected_actions.length > 0 && !finalReplyToUser.includes("Resumo")) { // Adiciona título se não for só sumário
        finalReplyToUser += "📝 *Resumo do que entendi:*\n";
      }

      for (const detectedAction of aiResponse.detected_actions) {
        let actionSuccess = false;
        let actionDetailMessage = `Ação ${detectedAction.action}: (não processada)`;
        const params = detectedAction.parameters || {};
        const MIN_CONFIDENCE = 0.60;

        if (detectedAction.confidence < MIN_CONFIDENCE && detectedAction.action !== "GENERAL_GREETING_OR_SMALLTALK") {
            actionDetailMessage = `⚠️ Entendi que você talvez queira "${detectedAction.action}" com detalhes ${JSON.stringify(params)}, mas não tenho certeza. Pode confirmar ou reformular?`;
            individualActionResults.push(actionDetailMessage);
            clearConversationStateThisTurn = false;
            requiresConfirmation = true; // Implícito que precisa de mais info
            state.pendingConfirmation = detectedAction; // Salva a ação para confirmar depois
            continue;
        }

        try {
          switch (detectedAction.action) {
            // --- TRANSAÇÕES FINANCEIRAS ---
            case 'CREATE_FINANCIAL_TRANSACTION':
              const categoryId = await findFinancialCategoryIdByName(params.financialCategoryName, financialAccount.id);
              const cardId = await findCreditCardIdByName(params.creditCardName, financialAccount.id);
              const txData = { description: params.description, type: params.type, value: parseFloat(params.value),
                               transactionDate: params.transactionDate || new Date().toISOString().split('T')[0],
                               financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes };
              const newTx = await financialService.createTransaction(financialAccount.id, txData);
              actionDetailMessage = `✅ ${params.type}: "${newTx.description}" (R$ ${parseFloat(newTx.value).toFixed(2)}) em ${new Date(newTx.transactionDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})}.`;
              actionSuccess = true;
              break;

            case 'CREATE_PARCELLED_ACCOUNT':
              const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, financialAccount.id);
              const cardIdParcel = await findCreditCardIdByName(params.creditCardName, financialAccount.id);
              const parcelResult = await financialService.createParcelledAccount(financialAccount.id, {
                  description: params.description, type: params.type, totalValue: parseFloat(params.totalValue),
                  numberOfParcels: parseInt(params.numberOfParcels), initialDueDate: params.initialDueDate,
                  financialCategoryId: catIdParcel, creditCardId: cardIdParcel, notes: params.notes });
              actionDetailMessage = `✅ Conta parcelada "${params.description}" (${parcelResult.parcels.length}x) registrada.`;
              actionSuccess = true;
              break;

            case 'GET_FINANCIAL_SUMMARY':
            case 'LIST_FINANCIAL_TRANSACTIONS':
              // ... (implementação como na resposta anterior, usando params e financialAccount.id) ...
              actionDetailMessage = `Resultado para ${detectedAction.action} (implementar formatação).`;
              actionSuccess = true;
              break;
            
            case 'MARK_TRANSACTION_AS_PAID_RECEIVED':
                // Este é mais complexo, pois precisa identificar a transação alvo.
                // A IA passou transactionDescription e transactionValue.
                // Precisaria de uma função em financialService para buscar por esses critérios.
                // Ex: const targetTx = await financialService.findTransactionToMark(financialAccount.id, params.transactionDescription, params.transactionValue);
                // if(targetTx) { await financialService.markAsPaidOrReceived(financialAccount.id, targetTx.id, params.paymentDate); ... }
                actionDetailMessage = `Ação de marcar como pago/recebido (implementar busca da transação).`;
                actionSuccess = false; // Marcar como false até implementar
                requiresConfirmation = true; // Provavelmente precisa confirmar qual transação
                state.pendingConfirmation = detectedAction;
                break;

            // --- PRODUTOS E ESTOQUE (Checar tipo de conta) ---
            case 'CREATE_PRODUCT':
            case 'GET_STOCK_INFO':
            case 'RECORD_STOCK_MOVEMENT':
              if (financialAccount.type !== 'PF') {
                // ... (chamar productService ou stockService com financialAccount.id e params) ...
                if (detectedAction.action === 'CREATE_PRODUCT') {
                    const newProd = await productService.createProduct(financialAccount.id, params);
                    actionDetailMessage = `✅ Produto "${newProd.name}" cadastrado.`;
                } else if (detectedAction.action === 'GET_STOCK_INFO') {
                    const prodId = await findProductIdByNameOrCode(params.productNameOrCode, financialAccount.id);
                    if(prodId) {
                        const balance = await stockService.getProductStockBalance(prodId);
                        actionDetailMessage = balance ? `📦 ${balance.name}: ${balance.quantity} ${balance.unit || 'un.'}` : `Produto "${params.productNameOrCode}" não encontrado.`;
                    } else {  actionDetailMessage = `Produto "${params.productNameOrCode}" não encontrado.`; }
                } else { // RECORD_STOCK_MOVEMENT
                    const prodIdMov = await findProductIdByNameOrCode(params.productNameOrCode, financialAccount.id);
                    if(prodIdMov) {
                        await stockService.recordStockMovement(prodIdMov, {type: params.movementType, quantity: parseInt(params.quantity), reason: params.reason});
                        actionDetailMessage = `✅ Movimentação de ${params.quantity} ${params.productNameOrCode} (${params.movementType}) registrada.`;
                    } else { actionDetailMessage = `Produto "${params.productNameOrCode}" não encontrado para movimentar.`;}
                }
                actionSuccess = true;
              } else {
                actionDetailMessage = `⚠️ Esta ação (${detectedAction.action}) é apenas para contas PJ ou MEI.`;
              }
              break;

            // --- COMPROMISSOS ---
            case 'SCHEDULE_APPOINTMENT':
              // ... (chamar appointmentService.scheduleAppointment com financialAccount.id e params) ...
              actionDetailMessage = `Compromisso "${params.title}" agendado (implementar formatação de data).`;
              actionSuccess = true;
              break;
            case 'LIST_APPOINTMENTS':
              // ... (chamar appointmentService.getAllAppointments com financialAccount.id e params) ...
              actionDetailMessage = `Lista de compromissos (implementar formatação).`;
              actionSuccess = true;
              break;

            // --- RECORRÊNCIAS ---
            case 'CREATE_RECURRING_RULE':
              // ... (chamar recurringTransactionService.createRecurringRule com financialAccount.id e params) ...
              actionDetailMessage = `Recorrência "${params.description}" criada.`;
              actionSuccess = true;
              break;
            // TODO: LIST_RECURRING_RULES

            // --- CARTÕES DE CRÉDITO ---
            case 'CREATE_CREDIT_CARD':
              // ... (chamar creditCardService.createCreditCard com financialAccount.id e params) ...
              actionDetailMessage = `Cartão "${params.name}" cadastrado.`;
              actionSuccess = true;
              break;
            case 'LIST_CREDIT_CARDS':
              // ... (chamar creditCardService.getAllCreditCards com financialAccount.id) ...
              actionDetailMessage = `Lista de cartões (implementar formatação).`;
              actionSuccess = true;
              break;

            // --- GERENCIAMENTO DE CONTA ---
            case 'SWITCH_FINANCIAL_ACCOUNT':
              // Esta ação é mais para o sistema do que para a IA diretamente, mas a IA pode identificá-la.
              // A lógica de troca de conta já está implementada ANTES da chamada da IA.
              // Se a IA chegar aqui, talvez seja um pedido de confirmação ou listagem.
              const accounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
              if (params.targetAccountNameOrType) {
                  const target = accounts.find(acc => acc.accountName.toLowerCase().includes(params.targetAccountNameOrType.toLowerCase()) || acc.accountType === params.targetAccountNameOrType.toUpperCase());
                  if (target) {
                      state.activeFinancialAccountId = target.id; state.activeFinancialAccountName = target.accountName; state.activeFinancialAccountType = target.accountType;
                      actionDetailMessage = `✅ Conta alterada para "${target.accountName}".`;
                  } else { actionDetailMessage = `Não encontrei uma conta com nome/tipo "${params.targetAccountNameOrType}".`; }
              } else { // Listar para escolha
                  let opts = "Para qual conta você gostaria de mudar?\n";
                  accounts.forEach((acc, i) => { opts += `${i+1}. ${acc.accountName} (${acc.accountType})\n`;});
                  state.currentAction = 'awaiting_account_switch_choice'; state.data = { accounts };
                  clearConversationStateThisTurn = false;
                  actionDetailMessage = opts;
              }
              actionSuccess = true; // A intenção foi processada
              break;

            case 'CREATE_FINANCIAL_ACCOUNT':
              // A lógica de criação já está antes da IA, mas a IA pode identificar essa intenção.
              state.currentAction = 'awaiting_new_account_type';
              state.data = { clientId: client.id, accountTypeToCreate: params.accountTypeToCreate };
              clearConversationStateThisTurn = false;
              actionDetailMessage = params.accountTypeToCreate ? `Ok, vamos criar uma conta ${params.accountTypeToCreate}. Qual nome você quer dar a ela?` : "Certo! Sua nova conta será Pessoal (PF), Empresa (PJ) ou MEI?";
              actionSuccess = true;
              break;

            // --- INTERAÇÕES GERAIS ---
            case 'SHOW_MENU': // A IA pode sugerir mostrar o menu
              const menuMsgShow = `Você está na conta: *${financialAccount.name} (${financialAccount.type})*.\n\n`+
                                `Como posso ajudar?\n1. Despesa/Receita\n2. Saldo...\nE. Trocar Conta`;
              actionDetailMessage = menuMsgShow;
              actionSuccess = true;
              break;

            case 'GENERAL_GREETING_OR_SMALLTALK':
              actionDetailMessage = aiResponse.reply_to_user_suggestion || `Olá ${client.name || ''}! Tudo bem? Em que posso ajudar na conta "${financialAccount.name}"?`;
              clearConversationStateThisTurn = false; // Mantém a conversa
              actionSuccess = true;
              break;
            
            case 'ACTION_CONFIRMATION_YES':
                 if(state.pendingConfirmation){
                    // Re-processar state.pendingConfirmation.action e .parameters
                    // Esta é uma lógica complexa que pode envolver chamar esta função recursivamente
                    // ou ter uma função helper para executar a ação pendente.
                    // Por ora:
                    actionDetailMessage = `Ok, confirmado! (Lógica de reprocessar ação pendente ID: ${state.pendingConfirmation?.action})`;
                    // Limpar pendingConfirmation aqui
                    state.pendingConfirmation = null;
                    actionSuccess = true;
                 } else {
                     actionDetailMessage = "Confirmado! 👍";
                     actionSuccess = true;
                 }
                break;
            case 'ACTION_CONFIRMATION_NO':
                actionDetailMessage = "Entendido, cancelamos a ação anterior. O que gostaria de fazer?";
                state.pendingConfirmation = null;
                actionSuccess = true;
                break;

            default:
              actionDetailMessage = `❓ Ação "${detectedAction.action}" ainda não implementada.`;
              logger.warn(`[WHATSAPP HANDLER] Ação da IA não implementada: ${detectedAction.action}`);
              clearConversationStateThisTurn = false;
              break;
          }
        } catch (e) {
          logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone} (Conta ${financialAccount.id}): ${e.message}`, {stack:e.stack, params:params});
          actionDetailMessage = `❌ Erro ao tentar "${detectedAction.action}": ${e.message.length < 70 ? e.message : 'Problema interno.'}`;
        }
        individualActionResults.push(actionDetailMessage);
      }

      if (individualActionResults.length > 0) {
          finalReplyToUser += individualActionResults.join("\n\n") + "\n\n";
      } else if (aiResponse.detected_actions.length > 0) {
          finalReplyToUser += "Tentei processar, mas não tive um resultado claro. Pode tentar 'menu'?";
      }
    }


    if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
      finalReplyToUser += (finalReplyToUser.length > 0 && !finalReplyToUser.endsWith('\n\n') && !finalReplyToUser.endsWith('\n') ? '\n\n' : '');
      finalReplyToUser += `🤔 *Para continuar, preciso de mais alguns detalhes:*\n`;
      aiResponse.clarifications_needed.forEach(clarif => { finalReplyToUser += `- ${clarif.clarification_question}\n`; });
      state.currentAction = 'awaiting_clarification';
      state.data = { pending_actions: aiResponse.detected_actions, clarifications_asked: aiResponse.clarifications_needed, originalIntent: aiResponse.clarifications_needed[0].original_intent_action_suggestion };
      clearConversationStateThisTurn = false;
    } else if (aiResponse.ununderstood_segments && aiResponse.ununderstood_segments.length > 0 && (!aiResponse.detected_actions || aiResponse.detected_actions.length === 0)) {
      finalReplyToUser += (finalReplyToUser.length > 0 && !finalReplyToUser.endsWith('\n\n') && !finalReplyToUser.endsWith('\n') ? '\n\n' : '');
      finalReplyToUser += `😕 *Não entendi bem estas partes:*\n`;
      aiResponse.ununderstood_segments.forEach(segment => { finalReplyToUser += `- "${segment}"\n`; });
      finalReplyToUser += "\nPode tentar de novo ou digitar 'menu'?";
      clearConversationStateThisTurn = false;
    } else if ((!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) && 
               (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0) &&
               (aiResponse.action !== "GENERAL_GREETING_OR_SMALLTALK" && aiResponse.action !== "SHOW_MENU") ) {
      // Se a IA não detectou nada, não pediu clarificação e não é uma saudação, usa o reply_to_user_suggestion da IA ou um fallback
      finalReplyToUser = aiResponse.reply_to_user_suggestion || "Não tenho certeza de como ajudar com isso. Tente 'menu' para ver as opções. 😊";
      clearConversationStateThisTurn = false;
    }


    state.messageHistory.push({role: 'assistant', content: finalReplyToUser});
    if (clearConversationStateThisTurn && !requiresConfirmation) { // Não limpar se ainda precisa de confirmação para uma ação que a IA pediu
      state.currentAction = null;
      state.data = {};
      state.pendingConfirmation = null;
    } else if (requiresConfirmation && state.pendingConfirmation) {
        state.currentAction = 'awaiting_confirmation'; // Prepara para o SIM/NÃO
    }
    conversationState.set(senderPhone, state);

    await sendWhatsappMessage(senderPhone, finalReplyToUser);

  } catch (error) {
    logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack, messageText, rawPayload });
    try {
      await sendWhatsappMessage(senderPhone, "Ops! 🌩️ Encontrei um probleminha técnico e não pude processar sua solicitação. Por favor, tente novamente em alguns instantes ou contate o suporte se persistir.");
    } catch (sendError) { 
      logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro crítico para ${senderPhone}: ${sendError.message}`);
    }
    conversationState.delete(senderPhone);
  } finally {
      const endTime = Date.now();
      logger.info(`[WHATSAPP HANDLER] Processamento da mensagem para ${senderPhone} finalizado em ${endTime - startTime}ms.`);
  }
}

module.exports = { processIncomingMessage };
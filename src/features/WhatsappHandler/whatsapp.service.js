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
const { Op } = require('sequelize'); // Se precisar de operadores do Sequelize aqui

// Key: senderPhone (ex: "5511999999999")
// Value: {
//   currentActionContext: string | null, (ex: 'awaiting_confirmation_for_actions', 'editing_transaction_field')
//   dataForAction: any, // Dados relevantes para a currentActionContext (ex: { detected_actions_from_ia, transaction_to_edit_id })
//   activeFinancialAccountId: number | null,
//   activeFinancialAccountName: string | null,
//   activeFinancialAccountType: string | null,
//   messageHistory: Array<{role: 'user'|'assistant', content: string}>
// }
const conversationState = new Map();
const MAX_HISTORY_FOR_IA = 8; // Número de pares de mensagens (user+assistant) para enviar à IA

async function processIncomingMessage(senderPhoneNormalized, messageText, rawPayload) {
  const senderPhone = senderPhoneNormalized;
  let state = conversationState.get(senderPhone) || {
    currentActionContext: null,
    dataForAction: {},
    activeFinancialAccountId: null,
    activeFinancialAccountName: null,
    activeFinancialAccountType: null,
    messageHistory: [],
  };

  try {
    const clientNameFromPayload = rawPayload?.sender?.name || rawPayload?.notifyName || rawPayload?.pushName || `Usuário ${senderPhone.slice(-4)}`;
    const client = await clientService.findOrCreateClientByPhone(senderPhone, { name: clientNameFromPayload }, true); // true para criar conta PF default

    if (!client) { /* ... erro fatal, log e talvez mensagem de erro ... */ return; }

    // Adiciona mensagem atual ao histórico (antes de qualquer processamento de estado)
    state.messageHistory.push({ role: 'user', content: messageText });
    if (state.messageHistory.length > MAX_HISTORY_FOR_IA * 2) {
      state.messageHistory = state.messageHistory.slice(-(MAX_HISTORY_FOR_IA * 2) + 2);
    }

    // 1. GERENCIAMENTO DE CONTA FINANCEIRA ATIVA E ESTADOS ESPECIAIS (troca de conta, criação)
    if (!state.activeFinancialAccountId) { /* ... lógica para selecionar/criar a primeira conta ... */ } // Como antes
    // ... (código para trocar conta, criar nova conta, como na resposta anterior, usando state.currentActionContext) ...
    // Se alguma dessas ações de estado for tratada, ela deve dar um 'return'

    // Carrega detalhes da conta ativa se necessário (após seleção ou no início)
    if (state.activeFinancialAccountId && (!state.activeFinancialAccountName || !state.activeFinancialAccountType)) {
      const accDetails = await clientService.getFinancialAccountById(state.activeFinancialAccountId);
      if (accDetails && accDetails.isActive) {
        state.activeFinancialAccountName = accDetails.accountName;
        state.activeFinancialAccountType = accDetails.accountType;
      } else { /* ... reseta estado, pede para selecionar conta ... */ return; }
    }
    conversationState.set(senderPhone, state); // Salva estado inicial ou após seleção de conta

    logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id}, Conta: ${state.activeFinancialAccountId} (${state.activeFinancialAccountName}), Msg: "${messageText}"`);

    // === LÓGICA DE PROCESSAMENTO DE BOTÕES ===
    // A Z-API envia o ID do botão clicado, geralmente em um campo como `selectedButtonId` ou `payload.message.buttonPayload`
    // **VERIFIQUE A DOCUMENTAÇÃO DA Z-API PARA A ESTRUTURA EXATA DO WEBHOOK DE RESPOSTA DE BOTÃO**
    const buttonIdClicked = rawPayload?.selectedButtonId || rawPayload?.message?.buttonPayload || rawPayload?.message?.listResponseMessage?.singleSelectReply?.selectedRowId;

    if (buttonIdClicked) {
      logger.info(`[WHATSAPP HANDLER] Botão clicado: ID "${buttonIdClicked}"`);
      state.messageHistory.pop(); // Remove a "mensagem" que é o clique do botão, se ela for o label
      state.messageHistory.push({role: 'user', content: `[Usuário clicou no botão com ID: ${buttonIdClicked}]`}); // Adiciona ao histórico da IA

      if (buttonIdClicked.startsWith('edit_transaction_')) {
        const transactionId = parseInt(buttonIdClicked.replace('edit_transaction_', ''), 10);
        // TODO: Iniciar fluxo de edição para transactionId
        state.currentActionContext = 'editing_transaction_select_field';
        state.dataForAction = { transactionId };
        conversationState.set(senderPhone, state);
        const reply = `Ok, vamos editar a transação ID ${transactionId}. O que você gostaria de alterar?\n1. Descrição\n2. Valor\n3. Data\n4. Categoria`;
        state.messageHistory.push({role: 'assistant', content: reply});
        conversationState.set(senderPhone, state);
        await sendWhatsappMessage(senderPhone, reply);
        return;
      } else if (buttonIdClicked.startsWith('delete_transaction_')) {
        const transactionId = parseInt(buttonIdClicked.replace('delete_transaction_', ''), 10);
        // TODO: Pedir confirmação para deletar transactionId
        state.currentActionContext = 'confirming_delete_transaction';
        state.dataForAction = { transactionId };
        conversationState.set(senderPhone, state);
        const reply = `Você tem certeza que quer excluir a transação ID ${transactionId}? (Sim/Não)`;
        state.messageHistory.push({role: 'assistant', content: reply});
        conversationState.set(senderPhone, state);
        await sendWhatsappMessage(senderPhone, reply);
        return;
      }
      // Adicionar outros prefixos de ID de botão aqui (ex: 'confirm_action_yes_', 'cancel_action_')
    }

    // === LÓGICA DE ESTADOS DE CONVERSA (Ex: confirmações, edição em etapas) ===
    if (state.currentActionContext === 'confirming_delete_transaction' && state.dataForAction?.transactionId) {
        if (messageText.toLowerCase().startsWith('sim')) {
            await financialService.deleteTransaction(state.activeFinancialAccountId, state.dataForAction.transactionId);
            const reply = `✅ Transação ID ${state.dataForAction.transactionId} excluída com sucesso!`;
            state.messageHistory.push({role: 'assistant', content: reply});
            conversationState.delete(senderPhone); // Limpa estado
            await sendWhatsappMessage(senderPhone, reply);
        } else {
            const reply = "Ok, exclusão cancelada.";
            state.messageHistory.push({role: 'assistant', content: reply});
            conversationState.delete(senderPhone);
            await sendWhatsappMessage(senderPhone, reply);
        }
        return;
    }
    // ... (outros manipuladores de estado, como para 'editing_transaction_select_field', etc.)


    // === CHAMADA À IA PARA INTERPRETAÇÃO DA MENSAGEM ===
    const aiContextForPrompt = {
      currentFinancialAccountId: state.activeFinancialAccountId,
      currentFinancialAccountType: state.activeFinancialAccountType,
      currentFinancialAccountName: state.activeFinancialAccountName,
      conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_IA), // Envia as últimas N interações
      // currentStateData: state.dataForAction, // Se a IA precisar do contexto de uma ação pendente
    };
    const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContextForPrompt);
    logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, { aiResponse });
    state.lastAiResponse = aiResponse;

    let finalReplyToUser = "";
    let executedActionDetails = []; // Array para armazenar os resumos de cada ação executada
    let requiresUserConfirmationForMultipleActions = false;
    let actionsToConfirm = [];

    if (aiResponse.overall_summary_suggestion) {
      finalReplyToUser += `${aiResponse.overall_summary_suggestion}\n\n`;
    }

    // Se a IA pedir clarificação, priorizar isso
    if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
      finalReplyToUser += "🤔 Para te ajudar melhor, preciso de alguns esclarecimentos:\n";
      aiResponse.clarifications_needed.forEach(clarif => {
        finalReplyToUser += `- ${clarif.clarification_question}\n`;
      });
      state.currentActionContext = 'awaiting_ai_clarification';
      state.dataForAction = { originalUserMessage: messageText, pendingAiResponse: aiResponse };
      state.messageHistory.push({role: 'assistant', content: finalReplyToUser});
      conversationState.set(senderPhone, state);
      await sendWhatsappMessage(senderPhone, finalReplyToUser);
      return;
    }

    // Processar ações detectadas
    if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
      // Se múltiplas ações ou ação de alto impacto com confiança não tão alta, pedir confirmação geral
      if (aiResponse.detected_actions.length > 1 || 
          (aiResponse.detected_actions.length === 1 && (aiResponse.detected_actions[0].action.includes("DELETE") || aiResponse.detected_actions[0].action.includes("UPDATE")) && aiResponse.detected_actions[0].confidence < 0.85) ) {
          // A IA já deve ter fornecido uma `reply_to_user_suggestion` para confirmação
          systemReply = aiResponse.reply_to_user_suggestion || "Entendi algumas coisas. Posso prosseguir?";
          if(systemReply.toLowerCase().includes("correto?") || systemReply.toLowerCase().includes("posso prosseguir?")){
            requiresUserConfirmationForMultipleActions = true;
            actionsToConfirm = aiResponse.detected_actions;
            finalReplyToUser = systemReply; // Usa a sugestão da IA para confirmação
            state.currentActionContext = 'awaiting_multi_action_confirmation';
            state.dataForAction = { actionsToExecute: actionsToConfirm };
          } else { // Se a IA não sugeriu confirmação mas deveria, forçamos
            requiresUserConfirmationForMultipleActions = true;
            actionsToConfirm = aiResponse.detected_actions;
            finalReplyToUser = "Entendi as seguintes ações:\n";
            actionsToConfirm.forEach((act, i) => {
                finalReplyToUser += `${i+1}. ${act.action.replace(/_/g, " ")}: ${JSON.stringify(act.parameters)}\n`;
            });
            finalReplyToUser += "\nPosso prosseguir? (Sim/Não)";
            state.currentActionContext = 'awaiting_multi_action_confirmation';
            state.dataForAction = { actionsToExecute: actionsToConfirm };
          }
      }

      if (!requiresUserConfirmationForMultipleActions) {
        for (const detectedAction of aiResponse.detected_actions) {
          let actionSuccess = false;
          let detailMsg = "";
          let createdEntityId = null; // Para botões de editar/excluir

          // Simular transação de DB por ação aqui seria mais complexo sem um loop de confirmação
          // Por enquanto, cada service call é individual.

          try {
            // --- SWITCH PARA EXECUTAR AÇÕES ---
            // (Este switch precisa ser MUITO completo, cobrindo todas as actions do prompt da IA)
            switch (detectedAction.action) {
              case 'CREATE_FINANCIAL_TRANSACTION':
                if (detectedAction.confidence > 0.6) { // Limiar de confiança
                  const params = detectedAction.parameters;
                  let categoryId = null; // Mapear params.financialCategoryName para ID
                  if(params.financialCategoryName){
                      const category = await systemService.findFinancialCategoryByName(params.financialCategoryName, state.activeFinancialAccountId);
                      if(category) categoryId = category.id;
                  }
                  let cardId = null; // Mapear params.creditCardName para ID
                   if(params.creditCardName){
                      const card = await creditCardService.findCreditCardByName(params.creditCardName, state.activeFinancialAccountId);
                      if(card) cardId = card.id;
                  }

                  const newTransaction = await financialService.createTransaction(state.activeFinancialAccountId, {
                    description: params.description, type: params.type, value: params.value,
                    transactionDate: params.transactionDate || new Date().toISOString().split('T')[0],
                    financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes,
                    isPayableOrReceivable: params.isPayableOrReceivable || false, // IA deve fornecer
                    dueDate: params.dueDate, // IA deve fornecer se isPayableOrReceivable
                  });
                  createdEntityId = newTransaction.id; // Salva ID para botões
                  detailMsg = `✅ ${params.type === 'Entrada' ? 'Receita' : 'Despesa'} "${params.description}" (R$ ${parseFloat(params.value).toFixed(2)}) registrada.`;
                  actionSuccess = true;
                } else { detailMsg = `⚠️ Não foi possível registrar "${params.description}" (baixa confiança).`; }
                break;
              
              case 'SHOW_MENU': // A IA pode sugerir mostrar o menu em alguns casos
                detailMsg = `Você está operando na conta: *${state.activeFinancialAccountName} (${state.activeFinancialAccountType})*.\n\n` +
                            `MENU PRINCIPAL:\n1. ... 2. ... (menu completo aqui)\n9. Trocar Conta\n10. Criar Nova Conta`;
                actionSuccess = true; // Considera sucesso para fins de log
                break;

              // ... MAIS CASES PARA TODAS AS AÇÕES DO PROMPT ...
              // GET_FINANCIAL_SUMMARY, GET_STOCK_INFO, SCHEDULE_APPOINTMENT, CREATE_RECURRING_RULE, etc.
              // Cada case chama o serviço correspondente com state.activeFinancialAccountId e os parâmetros da IA.
              // Define 'detailMsg' e 'actionSuccess'.
              // Se a ação criar uma entidade (transação, compromisso), defina 'createdEntityId'.

              default:
                detailMsg = `❓ Ação "${detectedAction.action}" ainda não totalmente implementada.`;
                logger.warn(`[WHATSAPP HANDLER] Ação da IA não implementada: ${detectedAction.action}`);
                actionSuccess = false; // Ou true se for uma resposta informativa
                break;
            }

            if (actionSuccess) {
              executedActionDetails.push(detailMsg);
              // Se uma entidade foi criada e queremos adicionar botões de editar/excluir:
              if (createdEntityId && (detectedAction.action === 'CREATE_FINANCIAL_TRANSACTION' /* || outras ações de criação */)) {
                const buttonsForAction = [
                  { id: `edit_${detectedAction.action.toLowerCase()}_${createdEntityId}`, label: `Editar ${detectedAction.action === 'CREATE_FINANCIAL_TRANSACTION' ? 'Transação' : 'Item'}` },
                  { id: `delete_${detectedAction.action.toLowerCase()}_${createdEntityId}`, label: `Excluir ${detectedAction.action === 'CREATE_FINANCIAL_TRANSACTION' ? 'Transação' : 'Item'}` }
                ];
                // Adicionar esses botões à mensagem que será enviada, ou enviar uma mensagem separada com eles.
                // A Z-API pode não permitir texto e botões de lista na mesma mensagem facilmente.
                // Pode ser melhor enviar o 'detailMsg' e depois uma nova mensagem com "Opções para este item:" e os botões.
                // Por simplicidade aqui, apenas logamos a intenção. A implementação do sendButtonListMessage seria chamada aqui.
                logger.info(`[WHATSAPP HANDLER] Intenção de adicionar botões para entidade ID ${createdEntityId} da ação ${detectedAction.action}`);
                // Exemplo: await sendButtonListMessage(senderPhone, "Opções para o item registrado:", buttonsForAction);
                // Isso adicionaria uma mensagem extra. Para o formato dos seus exemplos, os botões vêm APÓS o resumo.
              }
            } else {
              executedActionDetails.push(detailMsg); // Adiciona a mensagem de falha/aviso
            }

          } catch (e) {
            logger.error(`[WHATSAPP HANDLER] Erro executando ação "${detectedAction.action}": ${e.message}`, e);
            executedActionDetails.push(`❌ Erro ao processar "${detectedAction.parameters?.description || detectedAction.action}": ${e.message.substring(0,100)}`);
          }
        } // Fim do loop for detected_actions
      } // Fim do if !requiresUserConfirmationForMultipleActions
    } // Fim do if detected_actions.length > 0


    // Construir a resposta final com base nas ações executadas ou confirmação pendente
    if (!requiresUserConfirmationForMultipleActions) {
        if (executedActionDetails.length > 0) {
            finalReplyToUser += "📝 *Resumo do que fiz:*\n" + executedActionDetails.join("\n\n") + "\n";

            // Adicionar botões contextuais aqui, se a última ação criou algo que pode ser editado/excluído
            // e se apenas UMA ação foi executada com sucesso e criou uma entidade.
            if (aiResponse.detected_actions?.length === 1 && executedActionDetails.length === 1 && executedActionDetails[0].startsWith("✅")) {
                const lastAction = aiResponse.detected_actions[0];
                let entityIdForButtons = null;
                let entityTypeForButtons = null;

                if (lastAction.action === 'CREATE_FINANCIAL_TRANSACTION' && lastAction.parameters.created_id) { // Assumindo que o service retorna o ID
                    entityIdForButtons = lastAction.parameters.created_id; // Você precisaria que o service retornasse o ID criado
                    entityTypeForButtons = 'transaction';
                } // Adicionar para outras entidades (appointment, product, etc.)

                if (entityIdForButtons) {
                    // Construir a mensagem com botões e enviar.
                    // A Z-API pode ter limitações: texto simples + botões de resposta rápida, ou Mensagem de Lista.
                    // Para o formato da sua imagem, parece uma mensagem de texto seguida por botões de resposta rápida ou uma "Lista de Botões".
                    // O sendButtonListMessage é para "Lista de Botões".
                    // Se for texto com quick replies, o payload é diferente.
                    // Vou assumir que podemos enviar o finalReplyToUser e DEPOIS uma mensagem com botões, ou que a IA já compôs.
                    // Por agora, apenas logamos.
                    // await sendButtonListMessage(senderPhone, finalReplyToUser, [
                    //     { id: `edit_${entityTypeForButtons}_${entityIdForButtons}`, label: `Editar ${entityTypeForButtons}` },
                    //     { id: `delete_${entityTypeForButtons}_${entityIdForButtons}`, label: `Excluir ${entityTypeForButtons}` }
                    // ]);
                    // return; // Já enviou com botões
                    finalReplyToUser += "\n\nVocê pode: [Editar Item] ou [Excluir Item]\n(Botões seriam adicionados aqui pela integração final com Z-API)";
                }
            }

        } else if (!finalReplyToUser.includes("Preciso de alguns esclarecimentos")) { // Se não houve ações nem clarificações, mas houve um sumário da IA
            finalReplyToUser += aiResponse.reply_to_user_suggestion || "Não identifiquei nenhuma ação específica. Pode tentar 'menu'?";
        }
    }


    state.messageHistory.push({role: 'assistant', content: finalReplyToUser});
    if (!requiresUserConfirmationForMultipleActions && (!state.currentActionContext || !state.currentActionContext.startsWith('awaiting_'))) {
      state.currentActionContext = null; // Limpa contexto de ação se não estiver esperando algo específico
      state.dataForAction = {};
    }
    conversationState.set(senderPhone, state);

    await sendWhatsappMessage(senderPhone, finalReplyToUser.trim());

  } catch (error) {
    logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack });
    try {
      await sendWhatsappMessage(senderPhone, "Ops! 🌩️ Algo deu errado por aqui. Já estou verificando e logo volto ao normal!");
    } catch (sendError) { 
      logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro CRÍTICO para ${senderPhone}: ${sendError.message}`);
    }
    conversationState.delete(senderPhone);
  }
}

module.exports = { processIncomingMessage };
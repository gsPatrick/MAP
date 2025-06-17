// src/features/WhatsappHandler/whatsapp.service.js
// VERSÃO FINAL REATORADA PARA A API DE ASSISTANTS DA OPENAI (COM PERSISTÊNCIA DE THREAD)

// --- Imports ---
const OpenAI = require('openai');
const clientService = require('../Client/client.service');
const sharedAccessService = require('../SharedAccess/sharedAccess.service');
const onboardingHandler = require('./onboarding.handler');
const formatter = require('./response.formatter');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
const { sendWhatsappMessage } = require('../../services/whatsappService');
const { transcribeAudioStream } = require('../../services/aiModelService'); // Apenas para transcrição
const logger = require('../../utils/logger');
const toolFunctionMap = require('./tool.map.js');

// --- Configuração do Assistant ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

// --- Gerenciamento de Estado (em memória, para dados de sessão rápidos) ---
const conversationState = new Map();
let pushNameFromPayload = null;


// --- Funções de Controle de Fluxo e Estado (Core) ---
async function initializeOrUpdateState(client, sharedAccessRecord = null, existingState = null, clientAccountsFromDb = [], ownerAccountsIfShared = []) {
    const clientName = client.name && client.name.trim() !== "" && client.name.trim().toLowerCase() !== "unknown" && client.name.trim().toLowerCase() !== "null"
        ? client.name.split(" ")[0]
        : (pushNameFromPayload || "pessoa incrível");

    let ownerClientIdForContext = client.id;
    let isSharedAccessContext = false;
    let sharedAccessPermissions = null;
    let ownerClientForContext = client;
    let ownerClientNameForContext = clientName; 

    if (sharedAccessRecord) {
        isSharedAccessContext = true;
        ownerClientIdForContext = sharedAccessRecord.ownerClientId;
        sharedAccessPermissions = {
            canAccessPersonalProfile: sharedAccessRecord.canAccessPersonalProfile,
            canAccessBusinessProfileId: sharedAccessRecord.canAccessBusinessProfileId,
        };
        if (sharedAccessRecord.ownerClient) { 
            ownerClientForContext = sharedAccessRecord.ownerClient; 
            ownerClientNameForContext = ownerClientForContext.name ? ownerClientForContext.name.split(" ")[0] : "Dono(a) da Conta";
        } else { 
            const ownerClientTemp = await clientService.getClientContactById(ownerClientIdForContext);
             if(ownerClientTemp) { 
                ownerClientForContext = ownerClientTemp; 
                ownerClientNameForContext = ownerClientTemp.name ? ownerClientTemp.name.split(" ")[0] : "Dono(a) da Conta";
            } else {
                logger.error(`[InitializeState] CRITICAL: Dono da conta ${ownerClientIdForContext} não encontrado para acesso compartilhado.`);
                ownerClientNameForContext = "Dono(a) da Conta"; 
                ownerClientForContext = { accessLevel: 'gratuito', accessExpiresAt: null, id: ownerClientIdForContext, name: "Dono Desconhecido" }; 
            }
        }
    }

    let hasPaidAccess = false;
    let clientAccessLevel = ownerClientForContext.accessLevel || 'gratuito';
    let clientAccessExpiresAt = ownerClientForContext.accessExpiresAt;
    let accessLevelTextForUser = "Nenhum plano ativo";
    let onboardingStage = existingState?.data?.onboardingStage || 'awaiting_plan_confirmation';

    if (ownerClientForContext.accessLevel && ownerClientForContext.accessLevel !== 'gratuito') {
        if (ownerClientForContext.accessLevel.startsWith('vitalicio_')) {
            hasPaidAccess = true;
            accessLevelTextForUser = formatter.formatPlanName(ownerClientForContext.accessLevel);
        } else if (ownerClientForContext.accessExpiresAt) {
            const expiryDate = new Date(ownerClientForContext.accessExpiresAt + 'T00:00:00Z');
            const today = new Date(); today.setUTCHours(0, 0, 0, 0);
            if (expiryDate >= today) {
                hasPaidAccess = true;
                const planNamePart = formatter.formatPlanName(ownerClientForContext.accessLevel);
                accessLevelTextForUser = `${planNamePart} (válido até ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
            } else {
                const planNamePart = formatter.formatPlanName(ownerClientForContext.accessLevel);
                accessLevelTextForUser = `Plano ${planNamePart} expirado`;
                clientAccessLevel = 'gratuito';
            }
        } else {
            logger.warn(`[WHATSAPP SERVICE - Initialize/UpdateState] Cliente DONO ${ownerClientForContext.id} com accessLevel ${ownerClientForContext.accessLevel} mas sem accessExpiresAt. Considerando como sem plano pago.`);
            clientAccessLevel = 'gratuito';
        }
    }
   
    const accountsForOperation = isSharedAccessContext ? ownerAccountsIfShared : clientAccountsFromDb;
   
    if (hasPaidAccess) {
        if (onboardingStage === 'awaiting_plan_confirmation' || (existingState && !existingState.hasPaidAccess_whenStageLastSet) ) {
            if (!client.email || !client.passwordHash) {
                onboardingStage = 'setting_up_credentials_email';
            } else { 
                if (!isSharedAccessContext) {
                    const hasPfActor = accountsForOperation.some(acc => acc.accountType === 'PF');
                    if (!hasPfActor) {
                         onboardingStage = 'setting_up_pf_account_name';
                    } else {
                         const hasPjMeiActor = accountsForOperation.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                         const planTier = clientAccessLevel.startsWith('avancado') || clientAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                         if (planTier === 'avancado' && !hasPjMeiActor &&
                             existingState?.data?.onboardingStage !== 'confirming_pj_mei_setup' &&
                             existingState?.data?.onboardingStage !== 'awaiting_pj_mei_type' &&
                             existingState?.data?.onboardingStage !== 'creating_pj_mei_account_name') {
                            onboardingStage = 'confirming_pj_mei_setup';
                         } else {
                            onboardingStage = 'onboarding_complete';
                         }
                    }
                } else { 
                    onboardingStage = 'onboarding_complete';
                }
            }
        }
    } else { 
        onboardingStage = 'awaiting_plan_confirmation';
    }

    let defaultAccount = null;
    if (onboardingStage === 'onboarding_complete' && hasPaidAccess && accountsForOperation.length > 0) {
        defaultAccount = accountsForOperation.find(a=>a.isDefault);
        if (!defaultAccount && accountsForOperation.length === 1) {
            defaultAccount = accountsForOperation[0];
        } else if (!defaultAccount) {
            defaultAccount = accountsForOperation.find(a => a.accountType === 'PF') ||
                             accountsForOperation.find(a => a.accountType === 'PJ') ||
                             accountsForOperation.find(a => a.accountType === 'MEI') ||
                             accountsForOperation[0];
        }
    }

    if (existingState) {
        existingState.clientName = clientName;
        existingState.ownerClientIdForContext = ownerClientIdForContext;
        existingState.ownerClientNameForContext = ownerClientNameForContext;
        existingState.isSharedAccessContext = isSharedAccessContext;
        existingState.sharedAccessPermissions = sharedAccessPermissions;
        existingState.currentAccessLevel = clientAccessLevel;
        existingState.accessExpiresAt = clientAccessExpiresAt;
        existingState.hasPaidAccess = hasPaidAccess;
        existingState.accessLevelTextForUser = accessLevelTextForUser;
        if (existingState.data.onboardingStage !== onboardingStage && onboardingStage !== 'onboarding_complete') {
            existingState.currentAction = null;
        }
        existingState.data.onboardingStage = onboardingStage;
        existingState.hasPaidAccess_whenStageLastSet = hasPaidAccess;
        if (onboardingStage === 'onboarding_complete' && hasPaidAccess) {
            const currentActiveStillValid = existingState.activeFinancialAccountId && accountsForOperation.some(acc => acc.id === existingState.activeFinancialAccountId);
            if (!currentActiveStillValid && defaultAccount) {
                existingState.activeFinancialAccountId = defaultAccount.id;
                existingState.activeFinancialAccountName = defaultAccount.accountName || defaultAccount.name;
                existingState.activeFinancialAccountType = defaultAccount.accountType || defaultAccount.type;
            } else if (!currentActiveStillValid && accountsForOperation.length > 0) {
                existingState.activeFinancialAccountId = null;
                existingState.activeFinancialAccountName = null;
                existingState.activeFinancialAccountType = null;
            } else if (!currentActiveStillValid && accountsForOperation.length === 0) {
                existingState.activeFinancialAccountId = null;
                existingState.activeFinancialAccountName = null;
                existingState.activeFinancialAccountType = null;
            }
        } else {
            existingState.activeFinancialAccountId = null;
            existingState.activeFinancialAccountName = null;
            existingState.activeFinancialAccountType = null;
        }
        logger.debug(`[WHATSAPP SERVICE - UpdateState] Estado atualizado para ator ${client.id}: `, {
            onboardingStage: existingState.data.onboardingStage, currentAction: existingState.currentAction,
            hasPaidAccessDono: existingState.hasPaidAccess, activeAccountId: existingState.activeFinancialAccountId,
            isShared: existingState.isSharedAccessContext, ownerIdCtx: existingState.ownerClientIdForContext,
        });
        return existingState;
    }

    const newState = {
        actorId: client.id,
        data: { onboardingStage },
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? (defaultAccount.accountName || defaultAccount.name) : null,
        activeFinancialAccountType: defaultAccount ? (defaultAccount.accountType || defaultAccount.type) : null,
        clientName: clientName, 
        ownerClientIdForContext: ownerClientIdForContext, 
        ownerClientNameForContext: ownerClientNameForContext,
        isSharedAccessContext: isSharedAccessContext, 
        sharedAccessPermissions: sharedAccessPermissions,
        currentAccessLevel: clientAccessLevel, 
        accessExpiresAt: clientAccessExpiresAt,
        hasPaidAccess: hasPaidAccess, 
        accessLevelTextForUser: accessLevelTextForUser,
        hasPaidAccess_whenStageLastSet: hasPaidAccess,
    };
    logger.debug(`[WHATSAPP SERVICE - InitializeState] Novo estado criado para ator ${client.id}: `, {
        onboardingStage: newState.data.onboardingStage, hasPaidAccessDono: newState.hasPaidAccess,
        activeAccountId: newState.activeFinancialAccountId, isShared: newState.isSharedAccessContext,
    });
    return newState;
}

async function processIncomingAudioMessage(senderPhoneRaw, mediaUrl, mimeType, pushName) {
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);
    if (!canonicalPhone) {
        logger.error(`[WHATSAPP SERVICE] Falha ao normalizar o telefone para MENSAGEM DE ÁUDIO: ${senderPhoneRaw}`);
        return;
    }
    logger.info(`[WHATSAPP SERVICE] Processando mensagem de áudio de ${canonicalPhone}.`);
    pushNameFromPayload = pushName;

    try {
        await sendWhatsappMessage(canonicalPhone, `🎧 Opa, ${pushName || 'você'}! Já recebi seu áudio e tô processando... 😉`);
        const transcribedText = await transcribeAudioStream(mediaUrl, mimeType);
        if (transcribedText && transcribedText.trim() !== "") {
            logger.info(`[WHATSAPP SERVICE] Áudio de ${canonicalPhone} transcrito. Chamando processIncomingMessage.`);
            return await processIncomingMessage(canonicalPhone, transcribedText, pushName);
        } else {
            await sendWhatsappMessage(canonicalPhone, "Não consegui entender o áudio que você enviou. Pode tentar de novo ou digitar?");
        }
    } catch (transcriptionError) {
        logger.error(`[WHATSAPP SERVICE] Erro ao transcrever áudio: ${transcriptionError.message}`);
        await sendWhatsappMessage(canonicalPhone, "Puxa, tive um probleminha para processar seu áudio. 😵‍💫 Pode tentar de novo?");
    } finally {
        pushNameFromPayload = null;
    }
}

/**
 * Função principal que orquestra o processamento de mensagens com persistência de Thread.
 */
async function processIncomingMessage(senderPhoneRaw, messageText, pushName) {
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);
    if (!canonicalPhone) return;
    const senderPhone = canonicalPhone;
    if (!pushNameFromPayload && pushName) pushNameFromPayload = pushName;

    try {
        // ETAPA 1: Obter Cliente e Estado da Sessão
        let actorClient = await clientService.findClientByPhone(senderPhone);
        if (!actorClient) {
            actorClient = await clientService.createClientContact({ phone: senderPhone, name: pushNameFromPayload || pushName });
        }
        
        let sharedAccessRecord = await sharedAccessService.findActiveSharedAccessByPhone(senderPhone);
        let clientAccountsForOnboarding = actorClient ? await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true }) : [];
        let ownerAccountsIfShared = sharedAccessRecord ? await clientService.getClientFinancialAccounts(sharedAccessRecord.ownerClientId, { isActive: true }) : [];

        const existingState = conversationState.get(senderPhone);
        let state = await initializeOrUpdateState(actorClient, sharedAccessRecord, existingState, clientAccountsForOnboarding, ownerAccountsIfShared);
        conversationState.set(senderPhone, state);

        // ETAPA 2: Fluxo de Onboarding (Controlado pelo nosso código antes de passar para a IA)
        if (state.data.onboardingStage !== 'onboarding_complete') {
            const onboardingResult = await onboardingHandler.handleOnboardingStep(state, messageText, actorClient);
            conversationState.set(senderPhone, onboardingResult.updatedState);
            if (onboardingResult.onboardingReply) {
                await sendWhatsappMessage(senderPhone, onboardingResult.onboardingReply);
            }
            return;
        }

        // ETAPA 3: Fluxo de Seleção de Conta (Também controlado pelo nosso código)
        if (!state.activeFinancialAccountId) {
            const accountsForSelection = state.isSharedAccessContext
                ? ownerAccountsIfShared
                : await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
            if (accountsForSelection.length > 0) {
                 const ownerNameForMsg = state.isSharedAccessContext ? state.ownerClientNameForContext : null;
                 const accountOptionsText = formatter.formatListClientAccountsDataStructure(accountsForSelection, null, ownerNameForMsg) + "\n\n🤔 Qual delas vamos usar hoje? Me diga o nome ou o número.";
                 await sendWhatsappMessage(senderPhone, accountOptionsText);
            } else {
                 await sendWhatsappMessage(senderPhone, `Olá ${state.clientName}! Parece que não há contas financeiras acessíveis para você no momento.`);
            }
            return; // Precisa esperar a resposta do usuário
        }

        // ETAPA 4: Orquestração com a API de Assistants
        if (!ASSISTANT_ID) {
            logger.error("[ASSISTANT FLOW] OPENAI_ASSISTANT_ID não está configurado no .env!");
            await sendWhatsappMessage(senderPhone, "Desculpe, estou com um problema de configuração interna e não consigo processar seu pedido agora.");
            return;
        }

        // Obtém ou cria um Thread para a conversa de forma persistente
        let threadId = actorClient.openai_thread_id;
        if (!threadId) {
            logger.info(`[ASSISTANT FLOW] Nenhum thread encontrado para ${senderPhone} no DB. Criando um novo...`);
            const thread = await openai.beta.threads.create();
            threadId = thread.id;
            await actorClient.update({ openai_thread_id: threadId });
            logger.info(`[ASSISTANT FLOW] Novo Thread ${threadId} criado e salvo para ${senderPhone}.`);
        } else {
            logger.info(`[ASSISTANT FLOW] Thread ${threadId} recuperado do DB para ${senderPhone}.`);
        }

        // Adiciona a mensagem do usuário ao Thread
        await openai.beta.threads.messages.create(threadId, {
            role: 'user',
            content: messageText,
        });

        // Cria o Run, passando o contexto atual da sua aplicação para a IA
        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: ASSISTANT_ID,
            instructions: `Contexto da aplicação: O nome do usuário é ${state.clientName}. A conta financeira atualmente ativa é "${state.activeFinancialAccountName}" (ID: ${state.activeFinancialAccountId}, Tipo: ${state.activeFinancialAccountType}). O usuário ${state.isSharedAccessContext ? 'ESTÁ' : 'NÃO ESTÁ'} em um contexto de acesso compartilhado.`
        });

        // Inicia o processamento assíncrono do Run
        await handleRunProcessing(run.id, threadId, state, senderPhone);

    } catch (error) {
        logger.error(`[WHATSAPP SERVICE] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack });
        await sendWhatsappMessage(senderPhone, "Puxa vida! 😬 Tive um curto-circuito aqui... Minha equipe já foi notificada. Tente novamente em um instante.");
    } finally {
        pushNameFromPayload = null;
    }
}

/**
 * Orquestra o ciclo de vida de um Run da OpenAI, lidando com a execução de ferramentas.
 */
async function handleRunProcessing(runId, threadId, state, senderPhone) {
    try {
        let run = await openai.beta.threads.runs.retrieve(threadId, runId);

        // Loop para esperar o Run sair do estado de 'in_progress'
        while (['queued', 'in_progress'].includes(run.status)) {
            await new Promise(resolve => setTimeout(resolve, 1500)); // Espera 1.5 segundos
            run = await openai.beta.threads.runs.retrieve(threadId, runId);
            logger.debug(`[ASSISTANT FLOW] Run status para ${senderPhone}: ${run.status}`);
        }

        // Caso 1: A IA precisa que executemos uma ou mais funções (ferramentas)
        if (run.status === 'requires_action') {
            const toolCalls = run.required_action.submit_tool_outputs.tool_calls;
            const toolOutputs = [];

            // Monta o objeto de contexto para passar para as funções
            const context = {
                activeFinancialAccountId: state.activeFinancialAccountId,
                activeFinancialAccountName: state.activeFinancialAccountName,
                activeFinancialAccountType: state.activeFinancialAccountType,
                actorId: state.actorId,
                clientName: state.clientName,
                isSharedAccessContext: state.isSharedAccessContext,
                ownerClientIdForContext: state.ownerClientIdForContext,
                sharedAccessPermissions: state.sharedAccessPermissions,
            };

            for (const toolCall of toolCalls) {
                const functionName = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                
                logger.info(`[ASSISTANT FLOW] Executando ferramenta para ${senderPhone}: ${functionName}`, { args });

                const functionToExecute = toolFunctionMap[functionName];
                if (functionToExecute) {
                    try {
                        const output = await functionToExecute(args, context);
                        
                        // Lógica especial para troca de conta
                        if (output && output.action === 'ACCOUNT_SWITCHED') {
                            state.activeFinancialAccountId = output.newAccount.id;
                            state.activeFinancialAccountName = output.newAccount.accountName || output.newAccount.name;
                            state.activeFinancialAccountType = output.newAccount.accountType || output.newAccount.type;
                            conversationState.set(senderPhone, state); // Atualiza o estado da sessão
                            logger.info(`[ASSISTANT FLOW] Estado atualizado após troca de conta para ${state.activeFinancialAccountName}`);
                        }

                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify(output || { success: true }),
                        });
                    } catch (e) {
                         logger.error(`[ASSISTANT FLOW] Erro ao executar a ferramenta ${functionName}: ${e.message}`);
                         toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ error: e.message }),
                         });
                    }
                }
            }

            // Envia os resultados de volta para o Run continuar
            await openai.beta.threads.runs.submitToolOutputs(threadId, runId, { tool_outputs: toolOutputs });
            return await handleRunProcessing(runId, threadId, state, senderPhone); // Continua o ciclo
        }

        // Caso 2: O Run foi completado com sucesso e a IA gerou uma resposta
        if (run.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(threadId, { limit: 1 });
            const assistantMessage = messages.data[0].content[0].text.value;
            logger.info(`[ASSISTANT FLOW] Run completo. Enviando resposta para ${senderPhone}`);
            await sendWhatsappMessage(senderPhone, assistantMessage);
        } else {
            // Caso 3: O Run falhou
            logger.error(`[ASSISTANT FLOW] Run para ${senderPhone} falhou com status: ${run.status}`, { details: run });
            await sendWhatsappMessage(senderPhone, "Puxa, algo deu errado no meu processamento. Minha equipe já foi notificada. Pode tentar de novo?");
        }

    } catch (error) {
        logger.error(`[ASSISTANT FLOW] Erro ao processar o Run ${runId} para ${senderPhone}: ${error.message}`, { stack: error.stack });
        await sendWhatsappMessage(senderPhone, "Encontrei um erro inesperado. Já estou verificando!");
    }
}

// Exporta as funções principais que serão usadas pelo controller
module.exports = { 
    processIncomingMessage, 
    processIncomingAudioMessage
};
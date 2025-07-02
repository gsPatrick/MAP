// src/features/WhatsappHandler/whatsapp.service.js
// --- Imports dos Serviços de Negócio (Core) ---
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const sharedAccessService = require('../SharedAccess/sharedAccess.service');
const financialCategoryService = require('../FinancialCategory/financialCategory.service');
const financialService = require('../Financial/financial.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');

// --- Imports dos Novos Especialistas e Utilitários ---
const onboardingHandler = require('./onboarding.handler');
const actionHandler = require('./action.handler');
const formatter = require('./response.formatter');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
const { sendWhatsappMessage, sendButtonListMessage, downloadZapiMedia } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');
const path = require('path');

// --- Gerenciamento de Estado da Conversa ---
const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;
let pushNameFromPayload = null;


// --- Funções de Controle de Fluxo e Estado (Core do Maestro) ---

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
        logger.info(`[WHATSAPP SERVICE - Initialize/UpdateState] Contexto de Acesso Compartilhado ATIVO. Ator: ${client.id} (${clientName}), Dono: ${ownerClientIdForContext} (${ownerClientNameForContext})`);
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
        currentAction: null, data: { onboardingStage },
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? (defaultAccount.accountName || defaultAccount.name) : null,
        activeFinancialAccountType: defaultAccount ? (defaultAccount.accountType || defaultAccount.type) : null,
        clientName: clientName, ownerClientIdForContext: ownerClientIdForContext, ownerClientNameForContext: ownerClientNameForContext,
        isSharedAccessContext: isSharedAccessContext, sharedAccessPermissions: sharedAccessPermissions,
        messageHistory: [], pendingConfirmation: null, editingResource: null, lastAiResponse: null,
        currentAccessLevel: clientAccessLevel, accessExpiresAt: clientAccessExpiresAt,
        hasPaidAccess: hasPaidAccess, accessLevelTextForUser: accessLevelTextForUser,
        hasPaidAccess_whenStageLastSet: hasPaidAccess,
    };
    logger.debug(`[WHATSAPP SERVICE - InitializeState] Novo estado criado para ator ${client.id}: `, {
        onboardingStage: newState.data.onboardingStage, hasPaidAccessDono: newState.hasPaidAccess,
        activeAccountId: newState.activeFinancialAccountId, isShared: newState.isSharedAccessContext,
    });
    return newState;
}

async function processIncomingAudioMessage(senderPhoneRaw, mediaUrl, mimeType, pushName, rawPayload) {
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);
    if (!canonicalPhone) {
        logger.error(`[WHATSAPP SERVICE] Falha ao normalizar o telefone para MENSAGEM DE ÁUDIO: ${senderPhoneRaw}`);
        return;
    }
    logger.info(`[WHATSAPP SERVICE] Processando mensagem de áudio de ${canonicalPhone}. URL: ${mediaUrl}`);
    pushNameFromPayload = pushName; 
    let filenameFromMime = 'audio.ogg'; 
    if (mimeType) { 
        if (mimeType.includes('opus')) filenameFromMime = 'audio.opus';
        else if (mimeType.includes('aac')) filenameFromMime = 'audio.aac';
        else if (mimeType.includes('mpeg')) filenameFromMime = 'audio.mp3';
        else if (mimeType.includes('amr')) filenameFromMime = 'audio.amr';
    }
     try {
        const urlPath = new URL(mediaUrl).pathname;
        const baseName = path.basename(urlPath);
        if (baseName && baseName.includes('.')) { 
             filenameFromMime = baseName; 
        }
    } catch (e) { 
        logger.warn(`[WHATSAPP SERVICE] Não foi possível parsear a URL para extrair nome do arquivo da mídia: ${mediaUrl}. Usando nome inferido: ${filenameFromMime}`);
    }

    try {
        const processingMessage = `🎧 Opa, ${pushName || 'você'}! Já recebi seu áudio e tô aqui processando tudinho com carinho! 💻✨\nSó um segundinho 😉`;
        await sendWhatsappMessage(canonicalPhone, processingMessage);
        const downloadedMedia = await downloadZapiMedia(mediaUrl); 
        if (downloadedMedia && downloadedMedia.stream) {
            const finalFilenameForWhisper = downloadedMedia.filename && downloadedMedia.filename.includes('.')
                ? downloadedMedia.filename
                : filenameFromMime;
            logger.info(`[WHATSAPP SERVICE] Áudio baixado, enviando para transcrição com nome de arquivo: ${finalFilenameForWhisper}`);
            const transcribedText = await aiModelService.transcribeAudioStream(downloadedMedia.stream, finalFilenameForWhisper);
            if (transcribedText && transcribedText.trim() !== "") {
                logger.info(`[WHATSAPP SERVICE] Áudio de ${canonicalPhone} transcrito com sucesso. Chamando processIncomingMessage com o texto.`);
                return await processIncomingMessage(canonicalPhone, transcribedText, pushName, rawPayload);
            } else {
                logger.warn(`[WHATSAPP SERVICE] Transcrição do áudio de ${canonicalPhone} resultou em texto vazio. Notificando usuário.`);
                await sendWhatsappMessage(canonicalPhone, "Não consegui entender o áudio que você enviou. 🤫 Pode tentar gravar novamente ou digitar, por favor?");
            }
        } else {
            logger.error(`[WHATSAPP SERVICE] Falha ao baixar áudio de ${canonicalPhone} da URL: ${mediaUrl}. Notificando usuário.`);
            await sendWhatsappMessage(canonicalPhone, "Tive um problema ao acessar o áudio que você enviou. 🙁 Poderia tentar novamente?");
        }
    } catch (transcriptionError) {
        logger.error(`[WHATSAPP SERVICE] Erro ao transcrever áudio de ${canonicalPhone}: ${transcriptionError.message}`, {stack: transcriptionError.stack});
        await sendWhatsappMessage(canonicalPhone, "Puxa, tive um probleminha para processar seu áudio. 😵‍💫 Pode tentar de novo ou digitar sua mensagem?");
    } finally {
        pushNameFromPayload = null; 
    }
}


// =========================================================================================
// <<< INÍCIO DA FUNÇÃO `processIncomingMessage` COM A LÓGICA CORRIGIDA >>>
// =========================================================================================
async function processIncomingMessage(senderPhoneRaw, messageText, pushName, rawPayload) {
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);
    if (!canonicalPhone) {
        logger.error(`[WHATSAPP HANDLER] Falha ao normalizar o telefone: ${senderPhoneRaw}`);
        return;
    }
    const senderPhone = canonicalPhone;
    if (!pushNameFromPayload && pushName) { 
        pushNameFromPayload = pushName;
    }
    const startTime = Date.now();
    let state;
    let actorClient;

    try {
        // ETAPA 1: Obter Cliente e Estado da Sessão - LÓGICA DE IDENTIFICAÇÃO CORRIGIDA
        let sharedAccessRecord = null;
        let clientAccountsForOnboarding = [];
        let ownerAccountsIfShared = [];

        // <<< MUDANÇA CRUCIAL: PRIMEIRO, VERIFICA SE O NÚMERO É DE UM CONVIDADO >>>
        logger.info(`[WHATSAPP SERVICE] Verificando se ${senderPhone} é um convidado (SharedAccess)...`);
        sharedAccessRecord = await sharedAccessService.findActiveSharedAccessByPhone(senderPhone);

        if (sharedAccessRecord && sharedAccessRecord.sharedWithClient) {
            // CASO 1: É um convidado com acesso compartilhado ativo!
            actorClient = sharedAccessRecord.sharedWithClient;
            const ownerClientIdForContext = sharedAccessRecord.ownerClientId;
            logger.info(`[WHATSAPP SERVICE] Identificado ACESSO COMPARTILHADO. Ator: ${actorClient.name} (ID: ${actorClient.id}), Dono: ${ownerClientIdForContext}`);

            if (!actorClient.status || actorClient.status !== 'Ativo') {
                 logger.warn(`[WHATSAPP SERVICE] SharedAccess para ${senderPhone}, mas convidado (ator) ${actorClient.id} está inativo.`);
                 await sendWhatsappMessage(senderPhone, "Olá! Seu acesso a esta conta compartilhada não está ativo. Por favor, contate o proprietário.");
                 return;
            }
            if (!sharedAccessRecord.ownerClient || sharedAccessRecord.ownerClient.status !== 'Ativo') {
                logger.warn(`[WHATSAPP SERVICE] SharedAccess para ${senderPhone}, mas proprietário ${ownerClientIdForContext} está inativo.`);
                await sendWhatsappMessage(senderPhone, "Olá! O proprietário da conta que compartilhou este acesso parece não estar ativo. Tente mais tarde ou contate-o.");
                return;
            }
            
            const allOwnerAccounts = sharedAccessRecord.ownerClient.financialAccounts || [];
            if (sharedAccessRecord.canAccessPersonalProfile) {
                const pfAccount = allOwnerAccounts.find(acc => acc.accountType === 'PF');
                if (pfAccount) ownerAccountsIfShared.push(pfAccount);
            }
            if (sharedAccessRecord.canAccessBusinessProfileId) {
                const bizAccount = allOwnerAccounts.find(acc => acc.id === sharedAccessRecord.canAccessBusinessProfileId);
                if (bizAccount) ownerAccountsIfShared.push(bizAccount);
            }

            if (ownerAccountsIfShared.length === 0 ) { 
                const ownerName = sharedAccessRecord.ownerClient?.name || 'o proprietário';
                logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas nenhuma conta do dono acessível foi encontrada.`);
                await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado, mas parece que ${ownerName} não possui contas ativas do tipo que você pode acessar (Pessoal ou o Empresarial específico). Peça para ele verificar, por favor! 😉`);
                return;
            }
        } else {
            // CASO 2: Não é um convidado. AGORA, VERIFICA SE É UM CLIENTE PRINCIPAL.
            logger.info(`[WHATSAPP SERVICE] ${senderPhone} não é um convidado. Verificando se é um cliente principal...`);
            actorClient = await clientService.findClientByPhone(senderPhone);

            if (actorClient) {
                // CASO 2.1: O número de telefone pertence a um cliente principal.
                logger.info(`[WHATSAPP SERVICE] Identificado CLIENTE PRINCIPAL: ${actorClient.name} (ID: ${actorClient.id}) pelo telefone ${senderPhone}.`);
                clientAccountsForOnboarding = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
            } else {
                // CASO 3: Não é convidado nem cliente principal. É um usuário novo.
                logger.info(`[WHATSAPP SERVICE] Telefone ${senderPhone} não reconhecido. Criando novo cliente para onboarding...`);
                actorClient = await clientService.createClientContact({ phone: senderPhone, name: pushNameFromPayload || pushName });
                const welcomeMsg = onboardingHandler.getOnboardingWelcomeNoPlanMessage(actorClient.name ? actorClient.name.split(" ")[0] : (pushNameFromPayload || "você"));
                await sendWhatsappMessage(senderPhone, welcomeMsg);
                const tempStateForNewUser = await initializeOrUpdateState(actorClient, null, null, [], []);
                tempStateForNewUser.data.onboardingStage = 'awaiting_plan_confirmation';
                tempStateForNewUser.currentAction = 'awaiting_plan_interest_generic';
                conversationState.set(senderPhone, tempStateForNewUser);
                pushNameFromPayload = null;
                return;
            }
        }
        
        // A partir daqui, 'actorClient' está definido, e 'sharedAccessRecord' também se for um convidado.
        const existingState = conversationState.get(senderPhone);
        state = await initializeOrUpdateState(actorClient, sharedAccessRecord, existingState, clientAccountsForOnboarding, ownerAccountsIfShared);
        state.isNewUserForSessionLogic = !existingState;

        // ETAPA 1.5: Tratamento de Comandos Diretos (Botões)
        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[MAESTRO] Botão clicado por ${senderPhone}: ID '${buttonId}'`);
            const buttonResult = await actionHandler.handleButtonInteraction(state, buttonId, senderPhone);
            if (buttonResult.stateUpdated) {
                conversationState.set(senderPhone, buttonResult.newState);
                return; 
            }
            if (buttonResult.flowCompleted) {
                return;
            }
            if (buttonResult.repromptWith) {
                logger.info(`[MAESTRO] Reprocessando clique de botão como nova mensagem: "${buttonResult.repromptWith}"`);
                messageText = buttonResult.repromptWith;
            } else {
                return;
            }
        }

        if (!(rawPayload && rawPayload.selectedButtonId)) {
            state.messageHistory.push({ role: 'user', content: messageText || "" }); 
            if (state.messageHistory.length > MAX_STATE_HISTORY) {
                state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
            }
        }

        // ETAPA 2: Delegar para o Handler de Onboarding, se aplicável
        if (state.data.onboardingStage !== 'onboarding_complete') {
            const onboardingResult = await onboardingHandler.handleOnboardingStep(state, messageText, actorClient);
            state = onboardingResult.updatedState;
            actorClient = onboardingResult.updatedActorClient;
            if (onboardingResult.onboardingReply) {
                state.messageHistory.push({ role: 'assistant', content: onboardingResult.onboardingReply });
                await sendWhatsappMessage(senderPhone, onboardingResult.onboardingReply);
            }
            conversationState.set(senderPhone, state);
            pushNameFromPayload = null;
            return;
        }

        // ETAPA 2.5: Tratamento de Respostas a Perguntas Diretas do Bot
        if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
            const pendingAction = state.pendingConfirmation;
            if (pendingAction.action === 'AWAITING_DELETION_CHOICE') {
                const userChoiceText = messageText.toLowerCase();
                let itemDeleted = false;
                if (userChoiceText.includes('todos')) {
                    let deletedCount = 0;
                    for (const resource of pendingAction.resources) {
                        try {
                            if (resource.type === 'transaction') {
                                await financialService.deleteTransaction(state.activeFinancialAccountId, resource.id);
                                deletedCount++;
                            }
                        } catch (e) { logger.error(`[DELETION ALL] Erro ao deletar item ${resource.id}: ${e.message}`); }
                    }
                    await sendWhatsappMessage(senderPhone, `✅ Prontinho! ${deletedCount} de ${pendingAction.resources.length} itens foram excluídos.`);
                    itemDeleted = true;
                } else {
                    const userWords = userChoiceText.split(' ').filter(word => word.length > 1);
                    const resourceToDelete = pendingAction.resources.find(r => {
                        const resourceWords = r.description.toLowerCase().split(' ');
                        return userWords.every(userWord => resourceWords.includes(userWord));
                    });                    
                    if (resourceToDelete) {
                        try {
                            if (resourceToDelete.type === 'transaction') {
                                await financialService.deleteTransaction(state.activeFinancialAccountId, resourceToDelete.id);
                            }
                            await sendWhatsappMessage(senderPhone, `✅ Item "${resourceToDelete.description}" excluído com sucesso!`);
                            itemDeleted = true;
                        } catch (e) {
                            await sendWhatsappMessage(senderPhone, `❌ Ops, tive um problema ao tentar excluir "${resourceToDelete.description}".`);
                        }
                    } else {
                        await sendWhatsappMessage(senderPhone, `🤔 Humm, não entendi qual item você quer excluir. Por favor, diga o nome exato ou 'todos'.`);
                    }
                }
                if (itemDeleted) {
                    state.pendingConfirmation = null;
                    state.currentAction = null;
                }
                conversationState.set(senderPhone, state);
                return;
            }
        }
        
        // ETAPA 3: Lógica de Fluxo Pós-Onboarding (Seleção de Conta)
        if (!state.activeFinancialAccountId) {
            const accountsForSelection = state.isSharedAccessContext
                ? ownerAccountsIfShared
                : await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
            if (accountsForSelection.length > 0) {
                if (accountsForSelection.length === 1) {
                    const acc = accountsForSelection[0];
                    state.activeFinancialAccountId = acc.id;
                    state.activeFinancialAccountName = acc.accountName || acc.name;
                    state.activeFinancialAccountType = acc.accountType || acc.type;
                    const ownerNameText = state.isSharedAccessContext ? `de ${state.ownerClientNameForContext} ` : '';
                    const selectMsg = `Tudo pronto, ${state.clientName}! 🎉\nA conta "${state.activeFinancialAccountName}" (${state.activeFinancialAccountType}) ${ownerNameText}já está selecionada. Como posso te ajudar a organizar suas finanças hoje? 🚀`;
                    state.messageHistory.push({ role: 'assistant', content: selectMsg });
                    state.currentAction = null;
                    await sendWhatsappMessage(senderPhone, selectMsg);
                } else {
                    const chosenIdentifier = messageText.trim();
                    let accountToSelect = null;
                    if (state.currentAction === 'selecting_account_flow_active') {
                        const accountsToList = state.data.accountsToList || accountsForSelection;
                        const chosenNumber = parseInt(chosenIdentifier, 10);
                        if (!isNaN(chosenNumber) && chosenNumber > 0 && chosenNumber <= accountsToList.length) {
                            accountToSelect = accountsToList[chosenNumber - 1];
                        } else {
                            accountToSelect = accountsToList.find(acc => (acc.name || acc.accountName).toLowerCase().includes(chosenIdentifier.toLowerCase()));
                        }
                    }
                    if (accountToSelect) {
                        state.activeFinancialAccountId = accountToSelect.id;
                        state.activeFinancialAccountName = accountToSelect.name || accountToSelect.accountName;
                        state.activeFinancialAccountType = accountToSelect.type || accountToSelect.accountType;
                        const confirmSelectionMsg = `Maravilha, ${state.clientName}!\nSelecionei a conta "${state.activeFinancialAccountName}" para você. Como posso te ajudar agora? 🚀`;
                        state.messageHistory.push({ role: 'assistant', content: confirmSelectionMsg });
                        state.currentAction = null;
                        await sendWhatsappMessage(senderPhone, confirmSelectionMsg);
                    } else {
                        state.currentAction = 'selecting_account_flow_active';
                        state.data.accountsToList = accountsForSelection.map(a => ({id: a.id, name: a.accountName || a.name, type: a.accountType || a.type}));
                        const ownerNameForMsg = state.isSharedAccessContext ? state.ownerClientNameForContext : null;
                        const accountOptionsText = formatter.formatListClientAccountsDataStructure(state.data.accountsToList, null, ownerNameForMsg) + "\n\n🤔 Qual delas vamos usar hoje? Me diga o nome ou o número.";
                        state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                        await sendWhatsappMessage(senderPhone, accountOptionsText);
                    }
                }
            } else {
                 await sendWhatsappMessage(senderPhone, `Olá ${state.clientName}! Parece que não há contas financeiras acessíveis para você no momento. ${state.isSharedAccessContext ? `Peça para ${state.ownerClientNameForContext} verificar.` : 'Diga "criar conta pessoal" para começar.'}`);
            }
            conversationState.set(senderPhone, state);
            if (!state.activeFinancialAccountId) return;
        }

        // ETAPA 4: Delegar para a IA e para o Action Handler
        const availableFinancialCategoriesForAI = await financialCategoryService.getAllCategoriesForAccountAI(state.activeFinancialAccountId);
        const availableCreditCardsForAI = await creditCardService.getActiveCreditCardsForAI(state.activeFinancialAccountId);

        const aiContext = {
            currentFinancialAccountId: state.activeFinancialAccountId,
            currentFinancialAccountType: state.activeFinancialAccountType,
            currentFinancialAccountName: state.activeFinancialAccountName,
            clientName: state.clientName,
            isSharedAccess: state.isSharedAccessContext,
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
            editingResource: state.editingResource,
            availableFinancialCategories: availableFinancialCategoriesForAI,
            availableCreditCards: availableCreditCardsForAI,
            pendingAction: state.currentAction === 'awaiting_clarification_response' ? state.pendingConfirmation : null
        };

        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        state.lastAiResponse = aiResponse;

        let finalMessageToSend = "";

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            state.pendingConfirmation = null;
            state.currentAction = null;
            let multipleActionBodiesList = [];
            let mainActionResult = null;
            const isOwnerActingOnOwnBehalfGlobal = !state.isSharedAccessContext || state.ownerClientIdForContext === actorClient.id;

            for (const detectedAction of aiResponse.detected_actions) {
                const actionName = detectedAction.action || detectedAction.action_type;
                const ownerOnlyActions = ['CREATE_FINANCIAL_ACCOUNT', 'UPDATE_FINANCIAL_ACCOUNT', 'DELETE_FINANCIAL_ACCOUNT', 'GRANT_ACCESS', 'LIST_GRANTED_ACCESS', 'UPDATE_GRANTED_ACCESS', 'REVOKE_ACCESS'];
                if (ownerOnlyActions.includes(actionName) && !isOwnerActingOnOwnBehalfGlobal) {
                    multipleActionBodiesList.push(`❌ Desculpe, ${state.clientName}, mas a ação de "${actionName.toLowerCase().replace(/_/g, " ")}" só pode ser realizada pelo proprietário da conta.`);
                    continue;
                }
                mainActionResult = await actionHandler.handleAction(state, detectedAction, state.clientName, isOwnerActingOnOwnBehalfGlobal, actorClient.id);
                if (mainActionResult.formattedData) {
                    multipleActionBodiesList.push(mainActionResult.formattedData);
                }
                if (mainActionResult.wasAnEdit) {
                    state.editingResource = null;
                }
                if (mainActionResult.resourceForButtonsContext?.id === 'account_switched') {
                    const newAccount = mainActionResult.resourceForButtonsContext.data;
                    state.activeFinancialAccountId = newAccount.id;
                    state.activeFinancialAccountName = newAccount.accountName || newAccount.name;
                    state.activeFinancialAccountType = newAccount.accountType || newAccount.type;
                }
            }

            if (state.pendingChainedAction && mainActionResult) {
                const primaryAction = aiResponse.detected_actions[0];
                const newResource = mainActionResult.resourceForButtonsContext?.resources?.[0];
                if (primaryAction.action === 'CREATE_CREDIT_CARD' && newResource?.type === 'credit_card') {
                    logger.info(`[MAESTRO] Ação principal (Criação de Cartão) concluída. Executando ação encadeada: ${state.pendingChainedAction.action}`);
                    const chainedAction = state.pendingChainedAction;
                    chainedAction.parameters.creditCardName = newResource.description;
                    const chainedActionResult = await actionHandler.handleAction(state, chainedAction, state.clientName, isOwnerActingOnOwnBehalfGlobal, actorClient.id);
                    if (chainedActionResult.formattedData) {
                        multipleActionBodiesList.push(chainedActionResult.formattedData);
                    }
                    if (chainedActionResult.resourceForButtonsContext?.resources) {
                         if (!mainActionResult.resourceForButtonsContext) {
                            mainActionResult.resourceForButtonsContext = { type: 'multi_action_block', resources: [] };
                        }
                        mainActionResult.resourceForButtonsContext.resources.push(...chainedActionResult.resourceForButtonsContext.resources);
                    }
                    state.pendingChainedAction = null;
                }
            }

            let aiMessageIntro = aiResponse.overall_summary_suggestion || `Ok, ${state.clientName}!`;
            if (state.pendingChainedAction === null && aiResponse.detected_actions[0]?.action === 'CREATE_CREDIT_CARD') {
                 aiMessageIntro = `Cartão na mão e gasto anotado! ✅ Seu novo cartão foi criado e o gasto original já foi registrado nele. Simples assim!`;
            }

            let structuredDataBody = multipleActionBodiesList.join("\n\n---\n\n");
            finalMessageToSend = aiMessageIntro.trim();
            if (structuredDataBody && structuredDataBody.trim() !== "") {
                finalMessageToSend += `\n\n${structuredDataBody.trim()}`;
            }

            const platformLinkFooter = formatter.formatPlatformLink();
            const platformBaseUrl = process.env.PLATFORM_URL || 'map-nocontrole.com.br/painel';
            if (!finalMessageToSend.includes(platformBaseUrl)) {
                 finalMessageToSend += `\n\n---\n\n${platformLinkFooter.trim()}`;
            }
            finalMessageToSend = finalMessageToSend.replace(/\n{3,}/g, '\n\n').trim();

            if (finalMessageToSend) {
                state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });
                const resourcesForButtons = mainActionResult?.resourceForButtonsContext?.resources || [];
                const hasMultipleResources = resourcesForButtons.length > 1;
                if (hasMultipleResources) {
                    const blockId = Buffer.from(JSON.stringify(resourcesForButtons)).toString('base64');
                    const buttons = [
                        { id: `edit:multi_action_block:${blockId}`, label: '✏️ Editar este bloco' },
                        { id: `delete:multi_action_block:${blockId}`, label: '🗑️ Excluir algo' }
                    ];
                    await sendButtonListMessage(senderPhone, finalMessageToSend, buttons, "Opções:");
                } else if (resourcesForButtons.length === 1) {
                    const singleResource = resourcesForButtons[0];
                    const buttons = [
                        { id: `edit:${singleResource.type}:${singleResource.id}`, label: '✏️ Editar' },
                        { id: `delete:${singleResource.type}:${singleResource.id}`, label: '🗑️ Excluir' }
                    ];
                    if (singleResource.type === 'credit_card') {
                        buttons.push({ id: `details:${singleResource.type}:${singleResource.id}`, label: 'Ver Fatura/Detalhes' });
                    }
                    await sendButtonListMessage(senderPhone, finalMessageToSend, buttons, "Opções:");
                } else {
                    await sendWhatsappMessage(senderPhone, finalMessageToSend);
                }
            }

        } else if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            const clarification = aiResponse.clarifications_needed[0];
            if (clarification.parameters_so_far && clarification.parameters_so_far.chained_action_context) {
                logger.info(`[MAESTRO] Ação encadeada detectada. Armazenando contexto para execução posterior.`);
                state.pendingChainedAction = clarification.parameters_so_far.chained_action_context;
                clarification.parameters_so_far = {}; 
            }
            state.pendingConfirmation = {
                action: clarification.original_intent_action_suggestion,
                parameters: clarification.parameters_so_far,
                timestamp: Date.now()
            };
            state.currentAction = 'awaiting_clarification_response';
            finalMessageToSend = clarification.clarification_question;
            state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });
            await sendWhatsappMessage(senderPhone, finalMessageToSend);

        } else {
            state.pendingConfirmation = null;
            state.currentAction = null;
            finalMessageToSend = aiResponse.reply_to_user_suggestion || `Olá, ${state.clientName}! Como posso te ajudar hoje?`;
            state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });
            await sendWhatsappMessage(senderPhone, finalMessageToSend);
        }

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000) });
        const errorMsg = `Puxa vida, ${state?.clientName || 'você'}! 😬 Tive um curto-circuito aqui... Minha equipe já foi notificada. Tente novamente em um instante.`;
        await sendWhatsappMessage(senderPhone, errorMsg);
    } finally {
        const endTime = Date.now();
        logger.info(`[WHATSAPP HANDLER] Processamento para ${senderPhone} (Ator: ${actorClient?.id || 'N/A'}) finalizado em ${endTime - startTime}ms.`);
        if (state) {
            conversationState.set(senderPhone, state);
        }
        pushNameFromPayload = null;
    }
}
// =========================================================================================
// <<< FIM DA FUNÇÃO `processIncomingMessage` CORRIGIDA >>>
// =========================================================================================

module.exports = { 
    processIncomingMessage, 
    processIncomingAudioMessage, 
    formatAppointmentDataStructure: formatter.formatAppointmentDataStructure 
};
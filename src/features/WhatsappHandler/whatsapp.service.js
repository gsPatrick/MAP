// src/features/WhatsappHandler/whatsapp.service.js
// VERSÃO FINAL REATORADA - O MAESTRO (COMPLETO)

// --- Imports dos Serviços de Negócio (Core) ---
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const sharedAccessService = require('../SharedAccess/sharedAccess.service');
const financialCategoryService = require('../FinancialCategory/financialCategory.service');

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

/**
 * Função principal que orquestra o processamento de mensagens recebidas.
 */
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
        // ETAPA 1: Obter Cliente e Estado da Sessão
        actorClient = await clientService.findClientByPhone(senderPhone);
        let sharedAccessRecord = null;
        let clientAccountsForOnboarding = [];
        let ownerAccountsIfShared = [];

        if (actorClient) {
            clientAccountsForOnboarding = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
        } else {
            sharedAccessRecord = await sharedAccessService.findActiveSharedAccessByPhone(senderPhone);
            if (sharedAccessRecord && sharedAccessRecord.sharedWithClient) {
                actorClient = sharedAccessRecord.sharedWithClient;
                const ownerClientIdForContext = sharedAccessRecord.ownerClientId;
                
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
                
                const allOwnerAccounts = await clientService.getClientFinancialAccounts(ownerClientIdForContext, { isActive: true });
                if (sharedAccessRecord.canAccessPersonalProfile) {
                    const pfAccount = allOwnerAccounts.find(acc => acc.accountType === 'PF');
                    if (pfAccount) ownerAccountsIfShared.push(pfAccount);
                }
                if (sharedAccessRecord.canAccessBusinessProfileId) {
                    const bizAccount = allOwnerAccounts.find(acc => acc.id === sharedAccessRecord.canAccessBusinessProfileId);
                    if (bizAccount) ownerAccountsIfShared.push(bizAccount);
                }

                if (ownerAccountsIfShared.length === 0 ) { 
                    if(sharedAccessRecord.canAccessPersonalProfile || sharedAccessRecord.canAccessBusinessProfileId){
                        logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas nenhuma conta do dono acessível encontrada (mesmo com permissões). Proprietário pode não ter contas do tipo permitido.`);
                        await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado para as contas de ${sharedAccessRecord.ownerClient?.name || 'um usuário'}, mas parece que o proprietário não possui contas ativas do tipo que você pode acessar (Pessoal ou o Empresarial específico). Peça para ele verificar, por favor! 😉`);
                    } else {
                        logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas NENHUMA permissão de acesso a perfil foi dada no sharedAccessRecord.`);
                        await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado para as contas de ${sharedAccessRecord.ownerClient?.name || 'um usuário'}, mas parece que nenhuma permissão para acessar perfis específicos (Pessoal ou Empresarial) foi configurada. Peça para ele verificar as permissões, por favor! 😉`);
                    }
                    return;
                }
            } else {
                logger.info(`[WHATSAPP SERVICE] Telefone ${senderPhone} não reconhecido. Criando novo cliente...`);
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
        
        const existingState = conversationState.get(senderPhone);
        state = await initializeOrUpdateState(actorClient, sharedAccessRecord, existingState, clientAccountsForOnboarding, ownerAccountsIfShared);
        state.isNewUserForSessionLogic = !existingState;

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

// ETAPA 4: Tratamento de Comandos Diretos (Botões)
        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${state.clientName}): ID '${buttonId}', Texto (label): '${messageText}'`);
            
            let buttonClickHandled = true; // Assumimos que vamos tratar, a menos que o ID seja desconhecido
            let aiMessageIntroForButton = "";
            let structuredDataBodyForButton = "";
            let platformLinkFooterForButton = formatter.formatPlatformLink();
            const isOwnerContextForEditDelete = !state.isSharedAccessContext;

            if (buttonId.startsWith('edit_')) {
                if (!isOwnerContextForEditDelete) {
                    aiMessageIntroForButton = `Ops, ${state.clientName}! 😬`;
                    structuredDataBodyForButton = "Em acessos compartilhados, apenas o proprietário pode fazer edições. Você pode visualizar os dados ou pedir para o dono da conta fazer a alteração!";
                    platformLinkFooterForButton = "";
                } else {
                    let resourceTypeForEditMessage = "item";
                    let resourceId;

                    if (buttonId.startsWith('edit_transaction_')) {
                        resourceId = buttonId.replace('edit_transaction_', '');
                        state.editingResource = { type: 'transaction', id: resourceId };
                        resourceTypeForEditMessage = "transação";
                        aiMessageIntroForButton = `Claro, ${state.clientName}! 😉`;
                        structuredDataBodyForButton = `Descreva na próxima mensagem o que você precisa que eu altere na ${resourceTypeForEditMessage} (ID: ${resourceId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                        platformLinkFooterForButton = "";
                        state.currentAction = 'awaiting_transaction_edit_details';
                    } else if (buttonId.startsWith('edit_appointment_')) {
                        resourceId = buttonId.replace('edit_appointment_', '');
                        state.editingResource = { type: 'appointment', id: resourceId };
                        resourceTypeForEditMessage = "compromisso";
                        aiMessageIntroForButton = `Beleza, ${state.clientName}! ✨`;
                        structuredDataBodyForButton = `Me diga na próxima mensagem o que você quer mudar no ${resourceTypeForEditMessage} (ID: ${resourceId}).`;
                        platformLinkFooterForButton = "";
                        state.currentAction = 'awaiting_appointment_edit_details';
                    } else if (buttonId.startsWith('edit_credit_card_')) {
                        resourceId = buttonId.replace('edit_credit_card_', '');
                        state.editingResource = { type: 'credit_card', id: resourceId };
                        resourceTypeForEditMessage = "cartão de crédito";
                        aiMessageIntroForButton = `Entendido, ${state.clientName}! 💳`;
                        structuredDataBodyForButton = `O que você gostaria de alterar no ${resourceTypeForEditMessage} (ID: ${resourceId})? Pode me dizer, por exemplo: "mudar o limite para 3000" ou "atualizar o dia de fechamento para 25".`;
                        platformLinkFooterForButton = "";
                        state.currentAction = 'awaiting_credit_card_edit_details';
                    } else if (buttonId.startsWith('edit_recurring_rule_')) {
                        resourceId = buttonId.replace('edit_recurring_rule_', '');
                        state.editingResource = { type: 'recurring_rule', id: resourceId };
                        resourceTypeForEditMessage = "regra de recorrência";
                        aiMessageIntroForButton = `Certo, ${state.clientName}! 🔄`;
                        structuredDataBodyForButton = `O que vamos ajustar na ${resourceTypeForEditMessage} (ID: ${resourceId})? Por exemplo: "mudar o valor para 60" ou "alterar a frequência para mensal".`;
                        platformLinkFooterForButton = "";
                        state.currentAction = 'awaiting_recurring_rule_edit_details';
                    } else if (buttonId.startsWith('edit_product_')) {
                        resourceId = buttonId.replace('edit_product_', '');
                        state.editingResource = { type: 'product', id: resourceId };
                        aiMessageIntroForButton = `Beleza, ${state.clientName}! 🛍️`;
                        structuredDataBodyForButton = `O que você gostaria de alterar no produto (ID: ${resourceId})? Por exemplo: "mudar o preço de venda para 150" ou "atualizar o estoque mínimo para 10".`;
                        platformLinkFooterForButton = "";
                        state.currentAction = 'awaiting_product_edit_details';
                    } else if (buttonId.startsWith('edit_parcelled_account_')) {
                        resourceId = buttonId.replace('edit_parcelled_account_', '');
                        const parcelGroupInfo = await financialService.getTransactionById(state.activeFinancialAccountId, resourceId);
                        let originalDescriptionForEdit = "sua compra parcelada";
                        if (parcelGroupInfo) {
                            originalDescriptionForEdit = parcelGroupInfo.isParcel && parcelGroupInfo.originalAccountId === parcelGroupInfo.id 
                                ? parcelGroupInfo.description.replace(/ - Parcela \d+\/\d+$/, '').trim() 
                                : parcelGroupInfo.description;
                        }
                        state.editingResource = { type: 'parcelled_account', id: resourceId, originalDescription: originalDescriptionForEdit };
                        aiMessageIntroForButton = `Ok, ${state.clientName}! Você quer editar a compra parcelada de "${originalDescriptionForEdit}".`;
                        structuredDataBodyForButton = `O que gostaria de alterar? Você pode me dizer os novos detalhes, como por exemplo: "mudar para R$250 em 5x no cartão XP com nova descrição 'Presente Dia das Mães'".\n\nLembre-se que alterar valor, número de parcelas ou o cartão irá refazer essa compra com os novos dados. Se quiser mudar apenas a descrição, diga "mudar descrição para [nova descrição]".`;
                        platformLinkFooterForButton = "";
                        state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                    } else {
                        buttonClickHandled = false;
                    }
                }
            } else if (buttonId.startsWith('delete_')) {
                 if (!isOwnerContextForEditDelete) {
                    aiMessageIntroForButton = `Ops, ${state.clientName}! 😬`;
                    structuredDataBodyForButton = "Em acessos compartilhados, apenas o proprietário pode excluir itens. Você pode pedir para o dono da conta fazer a remoção!";
                    platformLinkFooterForButton = "";
                } else {
                     if (buttonId.startsWith('delete_transaction_')) {
                        const transactionId = buttonId.replace('delete_transaction_', '');
                        try {
                            await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId, actorClient.id);
                            aiMessageIntroForButton = `Transação removida com sucesso, ${state.clientName}! 👍`;
                            structuredDataBodyForButton = "Se precisar de mais alguma coisa, é só chamar.";
                        } catch (e) { 
                            logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                            aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a transação.`;
                            structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                         }
                    } else if (buttonId.startsWith('delete_appointment_')) {
                        const appointmentId = buttonId.replace('delete_appointment_', '');
                        try {
                            await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, true, actorClient.id);
                            aiMessageIntroForButton = `Compromisso removido da sua agenda, ${state.clientName}! ✅`;
                        } catch (e) { 
                            logger.error(`[WHATSAPP SERVICE] Erro ao excluir compromisso ${appointmentId} por botão: ${e.message}`);
                            aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir o compromisso.`;
                            structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                         }
                    } else if (buttonId.startsWith('delete_credit_card_')) {
                        const cardId = buttonId.replace('delete_credit_card_', '');
                        try {
                            await creditCardService.deleteCreditCard(state.activeFinancialAccountId, cardId, actorClient.id);
                            aiMessageIntroForButton = `Cartão de crédito removido, ${state.clientName}! 🗑️`;
                        } catch (e) { 
                            logger.error(`[WHATSAPP SERVICE] Erro ao excluir cartão ${cardId} por botão: ${e.message}`);
                            aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir o cartão.`;
                            structuredDataBodyForButton = `Detalhe: ${e.message.includes("transações") ? "Ele ainda tem transações associadas." : `(${e.message.substring(0,70)})` }`;
                        }
                    } else if (buttonId.startsWith('delete_recurring_rule_')) {
                        const ruleId = buttonId.replace('delete_recurring_rule_', '');
                        try {
                            await recurringTransactionService.deleteRecurringRule(state.activeFinancialAccountId, ruleId, actorClient.id);
                            aiMessageIntroForButton = `Regra de recorrência removida, ${state.clientName}! 👍`;
                        } catch (e) { 
                            logger.error(`[WHATSAPP SERVICE] Erro ao excluir regra ${ruleId} por botão: ${e.message}`);
                            aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a regra.`;
                            structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                        }
                    } else if (buttonId.startsWith('delete_parcelled_account_')) {
                        const originalAccountId = buttonId.replace('delete_parcelled_account_', '');
                        try {
                            await financialService.deleteParcelledAccountGroup(state.activeFinancialAccountId, originalAccountId, actorClient.id);
                            aiMessageIntroForButton = `Compra parcelada e todas as suas parcelas foram removidas, ${state.clientName}! 👍`;
                        } catch (e) { 
                            logger.error(`[WHATSAPP SERVICE] Erro ao excluir grupo de parcelas ${originalAccountId} por botão: ${e.message}`);
                            aiMessageIntroForButton = `Ops! Tive um problema ao tentar remover essa compra parcelada.`;
                            structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                        }
                    } else { 
                        buttonClickHandled = false; 
                    }
                    if (buttonClickHandled) {
                         state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    }
                }
            }
            else {
                buttonClickHandled = false;
            }
   
            if (buttonClickHandled) {
                const finalMsg = `${aiMessageIntroForButton}${structuredDataBodyForButton ? `\n\n${structuredDataBodyForButton}` : ''}${platformLinkFooterForButton ? `\n\n${platformLinkFooterForButton}` : ''}`.trim();
                state.messageHistory.push({ role: 'assistant', content: finalMsg });
                await sendWhatsappMessage(senderPhone, finalMsg);
                conversationState.set(senderPhone, state);
                pushNameFromPayload = null;
                return;
            }
        }

        // ETAPA 5: Delegar para a IA e para o Action Handler
        const availableFinancialCategoriesForAI = await financialCategoryService.getAllCategoriesForAccountAI(state.activeFinancialAccountId);
        const aiContext = {
            currentFinancialAccountId: state.activeFinancialAccountId,
            currentFinancialAccountType: state.activeFinancialAccountType,
            currentFinancialAccountName: state.activeFinancialAccountName,
            clientName: state.clientName,
            isSharedAccess: state.isSharedAccessContext,
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
            editingResource: state.editingResource,
            availableFinancialCategories: availableFinancialCategoriesForAI,
        };
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        state.lastAiResponse = aiResponse;

        let aiMessageIntro = aiResponse.overall_summary_suggestion || `Ok, ${state.clientName}!`;
        let multipleActionBodiesList = [];
        let resourceForButtonsContext = null;
        let finalMessageToSend = "";
        const isOwnerActingOnOwnBehalfGlobal = !state.isSharedAccessContext || state.ownerClientIdForContext === actorClient.id;

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            for (const detectedAction of aiResponse.detected_actions) {
                const actionName = detectedAction.action || detectedAction.action_type;
                
                // --- Lógica de verificação de permissão (bloqueio) ---
                const ownerOnlyActions = ['CREATE_FINANCIAL_ACCOUNT', 'UPDATE_FINANCIAL_ACCOUNT', 'DELETE_FINANCIAL_ACCOUNT', 'GRANT_ACCESS', 'LIST_GRANTED_ACCESS', 'UPDATE_GRANTED_ACCESS', 'REVOKE_ACCESS'];
                if (ownerOnlyActions.includes(actionName) && !isOwnerActingOnOwnBehalfGlobal) {
                    multipleActionBodiesList.push(`❌ Desculpe, ${state.clientName}, mas a ação de "${actionName.toLowerCase().replace(/_/g, " ")}" só pode ser realizada pelo proprietário da conta.`);
                    continue;
                }
                
                // DELEGA A EXECUÇÃO
                const actionResult = await actionHandler.handleAction(state, detectedAction, state.clientName, isOwnerActingOnOwnBehalfGlobal, actorClient.id);
                
                if (actionResult.formattedData) {
                    multipleActionBodiesList.push(actionResult.formattedData);
                }
                if (actionResult.resourceForButtonsContext) {
                    resourceForButtonsContext = actionResult.resourceForButtonsContext;
                }
                if (actionResult.wasAnEdit) {
                    state.editingResource = null;
                }
                if (actionResult.resourceForButtonsContext?.id === 'account_switched') {
                    const newAccount = actionResult.resourceForButtonsContext.data;
                    state.activeFinancialAccountId = newAccount.id;
                    state.activeFinancialAccountName = newAccount.accountName || newAccount.name;
                    state.activeFinancialAccountType = newAccount.accountType || newAccount.type;
                }
            }
        }
        
        // ETAPA 6: Montar e Enviar a Resposta Final
        let structuredDataBody = multipleActionBodiesList.join("\n\n---\n\n");
        if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            aiMessageIntro = aiResponse.reply_to_user_suggestion || `Opa, ${state.clientName}! Para continuarmos, preciso de um detalhe:`;
            structuredDataBody = structuredDataBody ? `${structuredDataBody}\n\n---\n\n${aiResponse.clarifications_needed[0].clarification_question}` : aiResponse.clarifications_needed[0].clarification_question;
            state.currentAction = 'awaiting_clarification_response';
        }

        finalMessageToSend = aiMessageIntro.trim();
        if (structuredDataBody && structuredDataBody.trim() !== "") {
            finalMessageToSend += `\n\n${structuredDataBody.trim()}`;
        }
        
        if (resourceForButtonsContext?.id === 'pending_confirmation') {
            finalMessageToSend = resourceForButtonsContext.data.message;
            state.pendingConfirmation = resourceForButtonsContext.data;
            state.currentAction = 'awaiting_confirmation';
        }

        const platformLinkFooter = formatter.formatPlatformLink();
        // Pega a URL base do ambiente para fazer a verificação.
        const platformBaseUrl = process.env.PLATFORM_URL || 'map-nocontrole.com.br/painel';

        // Verifica se a mensagem final já contém o link para a plataforma para não adicionar o rodapé duas vezes.
        if (!finalMessageToSend.includes(platformBaseUrl) && resourceForButtonsContext?.type !== 'system_action') {
             finalMessageToSend += `\n\n---\n\n${platformLinkFooter.trim()}`;
        }
        finalMessageToSend = finalMessageToSend.replace(/\n{3,}/g, '\n\n').trim();

        if (finalMessageToSend) {
            state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });
            if (resourceForButtonsContext && resourceForButtonsContext.type !== 'system_action') {
                const buttons = [];
                // ... sua lógica de criação de botões ...
                await sendButtonListMessage(senderPhone, finalMessageToSend, buttons, "Opções:");
            } else {
                await sendWhatsappMessage(senderPhone, finalMessageToSend);
            }
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

module.exports = { 
    processIncomingMessage, 
    processIncomingAudioMessage, 
    formatAppointmentDataStructure: formatter.formatAppointmentDataStructure 
};
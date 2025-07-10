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
const hydrationService = require('../Hydration/hydration.service'); // Adicionar import do serviço de hidratação
const systemService = require('../System/system.service'); // Adicionar import do serviço de sistema para formatar a resposta


// --- Gerenciamento de Estado da Conversa ---
const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;
let pushNameFromPayload = null;


// --- Funções de Controle de Fluxo e Estado (Core do Maestro) ---

async function initializeOrUpdateState(client, sharedAccessRecord = null, existingState = null, clientAccountsFromDb = [], ownerAccountsIfShared = []) {
    // MUDANÇA AQUI: Se o nome do cliente no DB for 'Convidado' (inicial),
    // o nome usado nas mensagens será um genérico ou o que já estiver no estado.
    const clientName = (client.name && client.name.trim() !== "" && client.name.trim().toLowerCase() !== "unknown" && client.name.trim().toLowerCase() !== "null" && client.name.trim().toLowerCase() !== "convidado")
        ? client.name.split(" ")[0]
        : (existingState?.clientName || "pessoa incrível"); // Se ainda for 'Convidado' no DB, use o nome do estado (se já foi atualizado) ou um genérico.
    
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
        logger.info(`[WHATSAPP SERVICE - Initialize/UpdateState] Contexto de Acesso Compartilhado ATIVO. Ator: ${client.id} (${client.name}), Dono: ${ownerClientIdForContext} (${ownerClientNameForContext})`);
    }

    let hasPaidAccess = false;
    let clientAccessLevel = ownerClientForContext.accessLevel || 'gratuito';
    let clientAccessExpiresAt = ownerClientForContext.accessExpiresAt;
    let accessLevelTextForUser = "Nenhum plano ativo";
    // Sempre assume o onboardingStage do estado existente para manter o progresso,
    // a menos que haja uma razão forte para sobrescrever (como a lógica abaixo).
    let onboardingStage = existingState?.data?.onboardingStage;


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
            logger.warn(`[WHATSAPP SERVICE - Initialize/UpdateState] Cliente DONO ${ownerClientForContext.id} com accessLevel ${ownerClientForContext.accessLevel} sem accessExpiresAt. Considerando como sem plano pago.`);
            clientAccessLevel = 'gratuito';
        }
    }
   
    const accountsForOperation = isSharedAccessContext ? ownerAccountsIfShared : clientAccountsFromDb;
   
    // RE-AVALIAR onboardingStage com PRIORIDADE
    // Se for um contexto de acesso compartilhado E o ator não tem passwordHash principal
    if (isSharedAccessContext && client.passwordHash === null) {
        if (client.name.toLowerCase() === 'convidado') { // Se o nome no DB ainda é 'Convidado'
            onboardingStage = 'awaiting_shared_user_name'; // Força a coletar o nome primeiro
        } else {
            // Se o nome já foi atualizado (não é mais 'Convidado') e o passwordHash ainda é null,
            // vai direto para coletar as credenciais principais.
            onboardingStage = 'setting_up_main_client_credentials';
        }
    } else if (!onboardingStage || onboardingStage === 'awaiting_plan_confirmation' || (existingState && !existingState.hasPaidAccess_whenStageLastSet) ) {
        // Se ainda não há um estágio definido ou está no estágio inicial de plano,
        // ou se o plano pago do dono foi desativado/expirado, reavalia o onboarding padrão.
        if (hasPaidAccess) {
            if (!client.email || !client.passwordHash) {
                onboardingStage = 'setting_up_credentials_email';
            } else { 
                if (!isSharedAccessContext) { // Onboarding padrão para PF/PJ só se não for acesso compartilhado.
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
                    // Para acesso compartilhado, se chegou aqui e o owner tem acesso pago,
                    // e o convidado já tem credenciais principais, o onboarding está completo.
                    onboardingStage = 'onboarding_complete';
                }
            }
        } else { 
            onboardingStage = 'awaiting_plan_confirmation'; // Sem plano pago, vai para o estágio de convite de plano.
        }
    } else if (onboardingStage === 'onboarding_complete' && isSharedAccessContext && client.passwordHash === null) {
        // REFORÇO: Se de alguma forma o estágio foi marcado como completo, mas o passwordHash ainda é null e é acesso compartilhado,
        // força de volta para o onboarding de credenciais.
        onboardingStage = 'setting_up_main_client_credentials';
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
        existingState.clientName = clientName; // Usar o nome determinado acima
        existingState.ownerClientIdForContext = ownerClientIdForContext;
        existingState.ownerClientNameForContext = ownerClientNameForContext;
        existingState.isSharedAccessContext = isSharedAccessContext;
        existingState.sharedAccessPermissions = sharedAccessPermissions;
        existingState.currentAccessLevel = clientAccessLevel;
        existingState.accessExpiresAt = clientAccessExpiresAt;
        existingState.hasPaidAccess = hasPaidAccess;
        existingState.accessLevelTextForUser = accessLevelTextForUser;
        // Se o stage mudou (ex: de 'awaiting_shared_user_name' para 'setting_up_main_client_credentials'),
        // ou de qualquer estágio para 'onboarding_complete', resetar currentAction
        if (existingState.data.onboardingStage !== onboardingStage || onboardingStage === 'onboarding_complete') {
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
                existingState.activeFinancialAccountId = null; // Força re-seleção se a conta ativa não for mais válida
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
        clientName: clientName, // Usar o nome determinado acima
        ownerClientIdForContext: ownerClientIdForContext, ownerClientNameForContext: ownerClientNameForContext,
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

async function processIncomingMessage(senderPhoneRaw, messageText, pushName, rawPayload) {
    const canonicalPhone = normalizePhoneNumberToCanonical(senderPhoneRaw);
    if (!canonicalPhone) {
        logger.error(`[WHATSAPP HANDLER] Falha ao normalizar o telefone: ${senderPhoneRaw}`);
        return;
    }
    const senderPhone = canonicalPhone;
    // O pushNameFromPayload só deve ser usado como fallback se o cliente não tiver nome no DB.
    // Não deve ser a primeira opção, para forçar o onboarding a pedir o nome.
    if (!pushNameFromPayload && pushName) { 
        pushNameFromPayload = pushName;
    }
    const startTime = Date.now();
    let state;

    // Adicione a declaração de actorClient aqui para garantir que esteja sempre definida
    let actorClient = null; 

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
                // MUDANÇA AQUI: Force o nome inicial para 'Convidado' para garantir que o onboarding peça o nome.
                actorClient = await clientService.createClientContact({ phone: senderPhone, name: 'Convidado' }); 
                // <<< INÍCIO DA MUDANÇA NA MENSAGEM INICIAL DE NOVO USUÁRIO >>>
                const welcomeMsg = onboardingHandler.getOnboardingWelcomeNoPlanMessage(actorClient.name ? actorClient.name.split(" ")[0] : (pushNameFromPayload || "você"));
                await sendWhatsappMessage(senderPhone, welcomeMsg);
                // <<< FIM DA MUDANÇA NA MENSAGEM INICIAL DE NOVO USUÁRIO >>>
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
        // Passe o pushNameFromPayload para o estado para ser usado no onboarding.handler como fallback inicial
        state.pushNameFromPayload = pushNameFromPayload; 

        // ETAPA 1.5: Tratamento de Comandos Diretos (Botões)
        // MUDANÇA: Se é um clique de botão de hidratação, tratar primeiro
        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[MAESTRO] Botão clicado por ${senderPhone}: ID '${buttonId}'`);
            
            // Tratamento específico para botões de hidratação
            if (buttonId.startsWith('water_intake:')) {
                const parts = buttonId.split(':');
                const actionType = parts[1]; // 'bebi' ou 'nao_bebi'
                const logId = parseInt(parts[2], 10);

                if (isNaN(logId)) {
                    logger.warn(`[WHATSAPP SERVICE] Botão de hidratação com ID de log inválido: ${buttonId}`);
                    await sendWhatsappMessage(senderPhone, "Ops, tive um problema para identificar qual lembrete era esse. Tente novamente ou digite sua mensagem!");
                    conversationState.set(senderPhone, state);
                    pushNameFromPayload = null;
                    return;
                }

                if (actionType === 'bebi') {
                    await hydrationService.updateLogStatus(actorClient.id, logId, 'completed');
                    const logs = await hydrationService.getTodaysLogsByClient(actorClient.id);
                    const prefs = await systemService.getSystemPreferences(); // Busca as preferências para formatar a mensagem
                    const hydrationSummary = formatter.formatHydrationLogDataStructure(logs, prefs, state.clientName);
                    await sendWhatsappMessage(senderPhone, `🎉 Boa, ${state.clientName}! Seu copo de água foi registrado! ${hydrationSummary}`);
                    conversationState.set(senderPhone, state);
                    pushNameFromPayload = null;
                    return;
                } else if (actionType === 'nao_bebi') {
                    await hydrationService.handleNegativeWaterResponse(actorClient.id, logId);
                    await sendWhatsappMessage(senderPhone, `Entendido, ${state.clientName}! Sem problemas. Que tal tentar beber um pouco de água agora? Te lembro novamente em 5 minutinhos! 😉`);
                    conversationState.set(senderPhone, state);
                    pushNameFromPayload = null;
                    return;
                }
            }

            // Se não for um botão de hidratação, processa como um botão genérico
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

        // Adiciona a mensagem do usuário ao histórico antes de qualquer processamento
        // EXCETO se for um botão (já tratado acima e pode levar a um reprompt)
        if (!(rawPayload && rawPayload.selectedButtonId)) {
            state.messageHistory.push({ role: 'user', content: messageText || "" }); 
            if (state.messageHistory.length > MAX_STATE_HISTORY) {
                state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
            }
        }


        // ETAPA 2: Delegar para o Handler de Onboarding, se aplicável
        // MUDANÇA PRINCIPAL AQUI:
        // Priorize o onboarding do acesso compartilhado e de credenciais principais (passwordHash === null)
        // Esta lógica deve ser a primeira a ser avaliada para garantir que o onboarding interativo aconteça.
        // A condição foi ajustada para ser MAIS ESPECÍFICA para o onboarding de credenciais.
        if (state.isSharedAccessContext && actorClient.passwordHash === null && 
            (state.data.onboardingStage === 'awaiting_shared_user_name' || state.data.onboardingStage === 'setting_up_main_client_credentials')) {
            
            logger.info(`[WHATSAPP SERVICE] Priorizando onboarding de acesso compartilhado para ${senderPhone}, stage: ${state.data.onboardingStage}`);
            const onboardingResult = await onboardingHandler.handleOnboardingStep(state, messageText, actorClient);
            state = onboardingResult.updatedState;
            actorClient = onboardingResult.updatedActorClient; // Atualiza actorClient com possíveis mudanças (nome, etc.)
            if (onboardingResult.onboardingReply) {
                state.messageHistory.push({ role: 'assistant', content: onboardingResult.onboardingReply });
                await sendWhatsappMessage(senderPhone, onboardingResult.onboardingReply);
            }
            conversationState.set(senderPhone, state);
            pushNameFromPayload = null;
            return; // Termina o processamento aqui, pois o onboarding está em andamento.
        }

        // Se não é um caso de onboarding de acesso compartilhado com passwordHash nulo que precisa de atenção,
        // então verifica os outros estágios de onboarding.
        if (state.data.onboardingStage !== 'onboarding_complete') {
            logger.info(`[WHATSAPP SERVICE] Processando onboarding padrão para ${senderPhone}, stage: ${state.data.onboardingStage}`);
            const onboardingResult = await onboardingHandler.handleOnboardingStep(state, messageText, actorClient);
            state = onboardingResult.updatedState;
            actorClient = onboardingResult.updatedActorClient;
            if (onboardingResult.onboardingReply) {
                state.messageHistory.push({ role: 'assistant', content: onboardingResult.onboardingReply });
                await sendWhatsappMessage(senderPhone, onboardingResult.onboardingReply);
            }
            conversationState.set(senderPhone, state);
            pushNameFromPayload = null;
            return; // Termina o processamento aqui, pois o onboarding está em andamento.
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
        // Esta etapa só deve ser atingida se o onboarding estiver realmente completo.
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
                const ownerOnlyActions = ['CREATE_FINANCIAL_ACCOUNT', 'UPDATE_FINANCIAL_ACCOUNT', 'DELETE_FINANCIAL_ACCOUNT', 'GRANT_ACCESS', 'LIST_GRANTED_ACCESS', 'UPDATE_GRANTED_ACCESS', 'REVOKE_ACCESS', 'CREATE_FINANCIAL_CATEGORY', 'UPDATE_FINANCIAL_CATEGORY', 'DELETE_FINANCIAL_CATEGORY', 'GET_AFFILIATE_DASHBOARD', 'CREATE_MOTIVATIONAL_PHRASE', 'UPDATE_MOTIVATIONAL_PHRASE', 'DELETE_MOTIVATIONAL_PHRASE']; // Adicionando ações de motivação que são do owner
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
                    const blockId = Buffer.from(JSON.stringify(resources)).toString('base64');
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


module.exports = { 
    processIncomingMessage, 
    processIncomingAudioMessage, 
    formatAppointmentDataStructure: formatter.formatAppointmentDataStructure 
};
```

---

### **2. Conteúdo do arquivo `src/features/SharedAccess/sharedAccess.service.js`**

```javascript
// src/features/SharedAccess/sharedAccess.service.js
const { SharedAccess, Client, FinancialAccount, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
const { sendWhatsappMessage } = require('../../services/whatsappService');

async function grantAccess(ownerClientId, grantData) {
  const t = await sequelize.transaction();
  try {
    const {
      sharedAccessEmail, // Vindo do front, mas pode ser nulo/indefinido se o dono não o preenche
      sharedAccessPhone, // Este é o único obrigatório que o dono fornece
      sharedAccessPassword, // Vindo do front, mas pode ser nulo/indefinido se o dono não o preenche
      sharedWithClientName,
      canAccessPersonalProfile,
      canAccessBusinessProfileId
    } = grantData;

    // Apenas sharedAccessPhone é obrigatório para o dono
    if (!sharedAccessPhone) {
        const error = new Error('O Telefone para WhatsApp para este acesso compartilhado é obrigatório.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    const ownerClient = await Client.findByPk(ownerClientId, {
        include: [{ model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType'] }],
        transaction: t
    });
    if (!ownerClient) {
        const error = new Error('Cliente proprietário não encontrado.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    let sharedWithClient;
    // O email e telefone para lookup do cliente principal virão do que o dono forneceu.
    // Se o dono não forneceu o email, será null para lookup.
    const clientEmailForLookup = sharedAccessEmail ? sharedAccessEmail.toLowerCase().trim() : null;
    const clientPhoneForLookup = sharedAccessPhone ? normalizePhoneNumberToCanonical(sharedAccessPhone) : null;

    if (clientPhoneForLookup && clientPhoneForLookup.length !== 12) {
        const error = new Error(`O telefone fornecido para o convidado ('${sharedAccessPhone}') parece ser inválido após a normalização.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    if (clientEmailForLookup) {
        sharedWithClient = await Client.findOne({ 
            where: { email: clientEmailForLookup }, 
            attributes: ['id', 'name', 'email', 'phone', 'status', 'passwordHash'], // Garante que passwordHash seja incluído
            transaction: t 
        });
    }
    // Se não encontrou por email (ou email não foi fornecido), tenta por telefone
    if (!sharedWithClient && clientPhoneForLookup) {
        sharedWithClient = await Client.findOne({ 
            where: { phone: clientPhoneForLookup }, 
            attributes: ['id', 'name', 'email', 'phone', 'status', 'passwordHash'], // Garante que passwordHash seja incluído
            transaction: t 
        });
    }

    if (!sharedWithClient) {
        logger.info(`[GrantAccess] Cliente convidado não encontrado. Criando novo Client... Tel: ${clientPhoneForLookup}`);
        const newClientDataForSharedWith = {
            name: 'Convidado', // MUDANÇA AQUI: Força o nome inicial para 'Convidado' para garantir que o onboarding peça o nome.
            status: 'Ativo',
            phone: clientPhoneForLookup,
            email: clientEmailForLookup, // Pode ser nulo se o dono não forneceu email
            passwordHash: null, // Deixamos o passwordHash nulo para forçar o onboarding de credenciais principais (nome, email, senha) pelo próprio convidado
        };
        // Validação adicional caso o dono não forneça nem telefone nem email (embora o controller já exija telefone)
        if (!newClientDataForSharedWith.phone && !newClientDataForSharedWith.email) {
             const error = new Error('Para criar um novo usuário convidado, é necessário pelo menos um email ou telefone principal.');
             error.statusCode = 400; error.status = 'fail'; throw error;
        }
        // Valida se o telefone principal ou email principal já está em uso por outro CLIENTE (não SharedAccess)
        if (newClientDataForSharedWith.phone) {
            const existingClientByMainPhone = await Client.findOne({ where: { phone: newClientDataForSharedWith.phone }, transaction: t });
            if (existingClientByMainPhone) {
                const error = new Error(`O telefone principal '${sharedAccessPhone}' já está cadastrado para outro usuário. Use um telefone diferente para o convidado.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        if (newClientDataForSharedWith.email) {
            const existingClientByMainEmail = await Client.findOne({ where: { email: newClientDataForSharedWith.email }, transaction: t });
            if (existingClientByMainEmail) {
                const error = new Error(`O email principal '${newClientDataForSharedWith.email}' já está cadastrado para outro usuário. Use um email diferente para o convidado.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }

        sharedWithClient = await Client.create(newClientDataForSharedWith, { transaction: t });
        logger.info(`[GrantAccess] Novo Client (ID ${sharedWithClient.id}) criado para receber acesso compartilhado.`);
    }

    if (sharedWithClient.id === ownerClientId) {
        const error = new Error('Você não pode compartilhar o acesso consigo mesmo.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    let effectiveBusinessProfileId = null;
    if (canAccessBusinessProfileId) {
        if (String(canAccessBusinessProfileId).trim() === '' || canAccessBusinessProfileId === 'null' || canAccessBusinessProfileId === undefined || canAccessBusinessProfileId === 0) {
            effectiveBusinessProfileId = null;
        } else {
            effectiveBusinessProfileId = parseInt(canAccessBusinessProfileId, 10);
            if (isNaN(effectiveBusinessProfileId)) {
                 const error = new Error(`ID do Perfil de Negócio inválido: ${canAccessBusinessProfileId}`);
                 error.statusCode = 400; error.status = 'fail'; throw error;
            }
            const businessProfile = await FinancialAccount.findOne({
                where: { id: effectiveBusinessProfileId, clientId: ownerClientId, accountType: { [Op.in]: ['PJ', 'MEI'] } },
                transaction: t
            });
            if (!businessProfile) {
                const error = new Error(`Perfil de negócio ID ${effectiveBusinessProfileId} não encontrado, não pertence a você ou não é PJ/MEI.`);
                error.statusCode = 404; error.status = 'fail'; throw error;
            }
        }
    }
    
    const accessTargetDescription = canAccessPersonalProfile ? "Perfil Pessoal" : (effectiveBusinessProfileId ? `Perfil Empresarial ID ${effectiveBusinessProfileId}` : "Nenhum Perfil Específico");
    
    // Verifica se já existe um acesso *idêntico* para a mesma combinação owner-sharedWith-perfis
    const existingIdenticalShare = await SharedAccess.findOne({
        where: {
            ownerClientId,
            sharedWithClientId: sharedWithClient.id,
            canAccessPersonalProfile: !!canAccessPersonalProfile,
            canAccessBusinessProfileId: effectiveBusinessProfileId
        },
        transaction: t
    });
    if (existingIdenticalShare) {
        const error = new Error(`O acesso a ${accessTargetDescription} já foi compartilhado com este usuário.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    // Valida se o email/telefone ESPECÍFICO DESTE ACESSO COMPARTILHADO já está em uso em OUTRO SharedAccess.
    const saEmailToSaveForSharedAccessRecord = clientEmailForLookup; // Pode ser null
    const saPhoneToSaveForSharedAccessRecord = clientPhoneForLookup; // Este virá do dono (obrigatório)
    const saPasswordToSaveForSharedAccessRecord = sharedAccessPassword || null; // Será null pois o dono não fornece

    if (saEmailToSaveForSharedAccessRecord) {
        const existingSharedAccessBySpecificEmail = await SharedAccess.findOne({
            where: { sharedAccessEmail: saEmailToSaveForSharedAccessRecord },
            transaction: t
        });
        if (existingSharedAccessBySpecificEmail) {
            const error = new Error(`O "Email de Login para este Acesso" (${sharedAccessEmail}) já está em uso em outro compartilhamento. Escolha um email único para este acesso específico.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    if (saPhoneToSaveForSharedAccessRecord) { // sharedAccessPhone é obrigatório do lado do dono.
        const existingSharedAccessBySpecificPhone = await SharedAccess.findOne({
            where: { sharedAccessPhone: saPhoneToSaveForSharedAccessRecord
                   },
            transaction: t
        });
        if (existingSharedAccessBySpecificPhone) {
            const error = new Error(`O "Telefone para WhatsApp deste Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento. Escolha um telefone único para este acesso específico.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }
    
    // sharedAccessEmail e sharedAccessPasswordHash serão null,
    // pois o login para o painel será sempre as credenciais principais do Client.
    const newSharedAccessRecordData = {
      ownerClientId,
      sharedWithClientId: sharedWithClient.id,
      canAccessPersonalProfile: !!canAccessPersonalProfile,
      canAccessBusinessProfileId: effectiveBusinessProfileId,
      sharedAccessEmail: saEmailToSaveForSharedAccessRecord, // Pode ser null
      sharedAccessPhone: saPhoneToSaveForSharedAccessRecord, // Virá do dono
      sharedAccessPasswordHash: saPasswordToSaveForSharedAccessRecord, // Será null
      status: 'Ativo',
    };

    const newSharedAccess = await SharedAccess.create(newSharedAccessRecordData, { transaction: t });

    await t.commit(); // Commita a transação antes de enviar a mensagem

    logger.info(`Acesso concedido pelo Cliente ID ${ownerClientId} para Cliente ID ${sharedWithClient.id}. SharedAccess ID: ${newSharedAccess.id}. Login SA: Tel=${newSharedAccess.sharedAccessPhone}`);

    // ENVIO DA MENSAGEM DE WHATSAPP PARA O CONVIDADO
    if (sharedWithClient.phone) {
        try {
            // MUDANÇA AQUI: Usa o nome do cliente que pode ser 'Convidado' inicialmente
            const guestNameForMessage = (sharedWithClient.name && sharedWithClient.name.toLowerCase() !== 'convidado') ? sharedWithClient.name.split(' ')[0] : 'Olá';
            const ownerName = ownerClient.name ? ownerClient.name.split(' ')[0] : 'um usuário';
            
            let sharedProfileText = [];
            if (newSharedAccess.canAccessPersonalProfile) {
                const pfAccount = ownerClient.financialAccounts.find(acc => acc.accountType === 'PF');
                sharedProfileText.push(pfAccount ? `o Perfil Pessoal ("${pfAccount.accountName}")` : 'o Perfil Pessoal');
            }
            if (newSharedAccess.canAccessBusinessProfileId) {
                const bizAccount = ownerClient.financialAccounts.find(acc => acc.id === newSharedAccess.canAccessBusinessProfileId);
                sharedProfileText.push(bizAccount ? `o Perfil Empresarial ("${bizAccount.accountName}")` : 'o Perfil Empresarial');
            }

            let notificationMessage = `${guestNameForMessage}! 👋\n\nBoas notícias! *${ownerName}* te concedeu acesso compartilhado a ${sharedProfileText.join(' e ')} no NoControle.\n\nAgora você pode me mandar mensagens por aqui para gerenciar essa(s) conta(s). Tente dizer "resumo" para começar! 🚀`;

            // Usa o sharedWithClient existente, que já possui o passwordHash (seja ele nulo ou preenchido)
            if (sharedWithClient && sharedWithClient.passwordHash === null) {
                // Cenário: O convidado é um usuário NOVO no sistema principal (ainda não tem email/senha principal).
                // A mensagem inicial é curta; o onboarding.handler fará as perguntas para configurar o login principal.
                notificationMessage += `\n\nEm breve, vou te guiar para configurar seu acesso completo ao painel web. Fique atento! 😉`;
            } else {
                 // Cenário: O convidado já é um usuário existente no sistema principal (já tem email/senha principal).
                 // Ele usará as credenciais PRINCIPAIS dele para acessar o painel, onde verá também as contas compartilhadas.
                 notificationMessage += `\n\nPara acessar o painel pela web (com este acesso), use *suas credenciais principais* em: https://www.map-nocontrole.com.br/login`;
                 notificationMessage += `\n\nQualquer dúvida, é só me chamar! 😉`;
            }

            await sendWhatsappMessage(sharedWithClient.phone, notificationMessage);
            logger.info(`[GrantAccess] Notificação de acesso compartilhado enviada com sucesso para ${sharedWithClient.phone}.`);
        } catch (notificationError) {
            logger.error(`[GrantAccess] Acesso concedido, mas FALHA ao enviar notificação de WhatsApp para ${sharedWithClient.phone}: ${notificationError.message}`);
        }
    }

    return SharedAccess.findByPk(newSharedAccess.id, {
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
            { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'] }
        ]
    }).then(sa => sa.toJSON());
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao conceder acesso: ${error.message}`, { error, grantData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getSharedAccessesByOwner(ownerClientId, queryParams = {}) {
    try {
        const { page = 1, limit = 10, status, guestIdentifier } = queryParams;
        const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const whereConditions = { ownerClientId };
        if (status) whereConditions.status = status;

        const includeSharedWithClient = {
            model: Client,
            as: 'sharedWithClient',
            attributes: ['id', 'name', 'email', 'phone'],
            where: {},
            required: true
        };

        if (guestIdentifier) {
            const guestIdLower = guestIdentifier.toLowerCase();
            const guestPhoneNorm = normalizePhoneNumberToCanonical(guestIdentifier); 
            includeSharedWithClient.where = {
                [Op.or]: [
                    { name: { [Op.iLike]: `%${guestIdLower}%` } },
                    { email: { [Op.iLike]: `%${guestIdLower}%` } },
                    ...(guestPhoneNorm ? [{ phone: guestPhoneNorm }] : [])
                ]
            };
        }

        const { count, rows } = await SharedAccess.findAndCountAll({
            where: whereConditions,
            include: [
                includeSharedWithClient,
                {
                    model: FinancialAccount,
                    as: 'accessibleBusinessProfile',
                    attributes: ['id', 'accountName', 'accountType'],
                    required: false
                },
                 { model: Client, as: 'ownerClient', attributes:['id'], include: [
                     {model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType']}
                 ]}
            ],
            limit: parseInt(limit, 10),
            offset,
            order: [['createdAt', 'DESC']],
            distinct: true
        });
        return {
            totalItems: count,
            totalPages: Math.ceil(count / parseInt(limit, 10)),
            currentPage: parseInt(page, 10),
            sharedAccesses: rows.map(sa => sa.toJSON())
        };
    } catch (error) {
        logger.error(`Erro ao listar acessos compartilhados pelo dono ${ownerClientId}: ${error.message}`, error);
        throw error;
    }
}

async function getSharedAccessesForUser(sharedWithClientId, queryParams = {}) {
    try {
        const { page = 1, limit = 10, status } = queryParams;
        const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const whereConditions = { sharedWithClientId };
        if (status) whereConditions.status = status;

        const { count, rows } = await SharedAccess.findAndCountAll({
            where: whereConditions,
            include: [
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'],
                    include: [
                        {model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType']}
                    ]
                },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
            ],
            limit: parseInt(limit, 10),
            offset,
            order: [['createdAt', 'DESC']]
        });
        return {
            totalItems: count,
            totalPages: Math.ceil(count / parseInt(limit, 10)),
            currentPage: parseInt(page, 10),
            sharedAccesses: rows.map(sa => sa.toJSON())
        };
    } catch (error) {
        logger.error(`Erro ao listar acessos compartilhados para o usuário ${sharedWithClientId}: ${error.message}`, error);
        throw error;
    }
}

async function getSharedAccessById(sharedAccessId) {
    try {
        const sharedAccess = await SharedAccess.findByPk(sharedAccessId, {
            include: [
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'],
                  include: [{model: FinancialAccount, as: 'financialAccounts', attributes:['id','accountName', 'accountType']}]
                },
                { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
            ]
        });
        if (!sharedAccess) {
            const error = new Error('Registro de acesso compartilhado não encontrado.');
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        return sharedAccess.toJSON();
    }
    catch (error) {
        logger.error(`Erro ao buscar acesso compartilhado ID ${sharedAccessId}: ${error.message}`, error);
        throw error;
    }
}


async function updateSharedAccess(ownerClientId, sharedAccessId, updateData) {
  const t = await sequelize.transaction();
  try {
    const sharedAccess = await SharedAccess.findOne({
      where: { id: sharedAccessId, ownerClientId },
      transaction: t
    });
    if (!sharedAccess) {
      await t.rollback();
      const error = new Error('Registro de acesso compartilhado não encontrado ou não pertence a você.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const {
      sharedAccessEmail,
      sharedAccessPhone,
      sharedAccessPassword,
      canAccessPersonalProfile,
      canAccessBusinessProfileId,
      status
    } = updateData;

    const filteredUpdateData = {};
    let requiresRevalidation = false;

    // A atualização de sharedAccessEmail e sharedAccessPhone continua possível
    // caso o proprietário queira alterar os metadados do acesso ou se futuramente
    // estes campos tiverem outra função para o acesso em si (não para login principal).
    if (sharedAccessEmail !== undefined) {
        const saEmailLower = sharedAccessEmail ? sharedAccessEmail.toLowerCase().trim() : null;
        if (saEmailLower !== sharedAccess.sharedAccessEmail) {
            if (saEmailLower && saEmailLower !== "") {
                const existingSharedEmail = await SharedAccess.findOne({ where: { sharedAccessEmail: saEmailLower, id: {[Op.ne]: sharedAccessId } }, transaction: t });
                if (existingSharedEmail) {
                    const error = new Error(`O "Email para Login deste Acesso" (${sharedAccessEmail}) já está em uso em outro compartilhamento.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            filteredUpdateData.sharedAccessEmail = (saEmailLower === '' || saEmailLower === null) ? null : saEmailLower;
        }
    }

    if (sharedAccessPhone !== undefined) {
        const saPhoneNorm = normalizePhoneNumberToCanonical(sharedAccessPhone);
        if (saPhoneNorm !== sharedAccess.sharedAccessPhone) {
            if (saPhoneNorm && saPhoneNorm !== "") {
                const existingSharedPhone = await SharedAccess.findOne({ where: { sharedAccessPhone: saPhoneNorm, id: {[Op.ne]: sharedAccessId } }, transaction: t });
                if (existingSharedPhone) {
                    const error = new Error(`O "Telefone WhatsApp para este Acesso" (${sharedAccessPhone}) já está em uso em outro compartilhamento. Escolha um telefone único para este acesso específico.`);
                    error.statusCode = 409; error.status = 'fail'; throw error;
                }
            }
            filteredUpdateData.sharedAccessPhone = (saPhoneNorm === '' || saPhoneNorm === null) ? null : saPhoneNorm;
        }
    }

    // A atualização da senha de acesso compartilhado via proprietário também foi removida.
    // O login principal do convidado é que terá a senha.
    // if (sharedAccessPassword && typeof sharedAccessPassword === 'string' && sharedAccessPassword.trim() !== '') {
    //     filteredUpdateData.sharedAccessPasswordHash = sharedAccessPassword;
    // } else if (sharedAccessPassword === null || sharedAccessPassword === '') {
    //     filteredUpdateData.sharedAccessPasswordHash = null;
    // }


    if (canAccessPersonalProfile !== undefined) {
        filteredUpdateData.canAccessPersonalProfile = !!canAccessPersonalProfile;
    }
    if (canAccessBusinessProfileId !== undefined) {
        filteredUpdateData.canAccessBusinessProfileId = (canAccessBusinessProfileId === null || String(canAccessBusinessProfileId).trim() === '' || canAccessBusinessProfileId === 0)
                                                        ? null
                                                        : parseInt(canAccessBusinessProfileId,10);
        if (isNaN(filteredUpdateData.canAccessBusinessProfileId) && filteredUpdateData.canAccessBusinessProfileId !== null) {
            const error = new Error(`ID do Perfil de Negócio inválido: ${canAccessBusinessProfileId}`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        requiresRevalidation = true;
    }
    if (status !== undefined && ['Ativo', 'Inativo', 'Pendente'].includes(status) ) {
        filteredUpdateData.status = status;
    }


    if (requiresRevalidation && filteredUpdateData.canAccessBusinessProfileId !== null) {
        const businessProfile = await FinancialAccount.findOne({
            where: { id: filteredUpdateData.canAccessBusinessProfileId, clientId: ownerClientId, accountType: { [Op.in]: ['PJ', 'MEI'] } },
            transaction: t
        });
        if (!businessProfile) {
            const error = new Error(`Perfil de negócio ID ${filteredUpdateData.canAccessBusinessProfileId} inválido para este compartilhamento.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }
    
    // As verificações de finalSharedAccessEmail/Phone/PasswordHash foram ajustadas
    // pois a senha não é mais fornecida pelo proprietário para este acesso.
    const finalSharedAccessEmail = filteredUpdateData.hasOwnProperty('sharedAccessEmail') ? filteredUpdateData.sharedAccessEmail : sharedAccess.sharedAccessEmail;
    const finalSharedAccessPhone = filteredUpdateData.hasOwnProperty('sharedAccessPhone') ? filteredUpdateData.sharedAccessPhone : sharedAccess.sharedAccessPhone;
    // const finalSharedAccessPasswordHash = filteredUpdateData.hasOwnProperty('sharedAccessPasswordHash') ? filteredUpdateData.sharedAccessPasswordHash : sharedAccess.sharedAccessPasswordHash;

    // if (finalSharedAccessPasswordHash && !finalSharedAccessEmail && !finalSharedAccessPhone) {
    //     const error = new Error('Não é possível ter uma senha para o acesso compartilhado sem um Email ou Telefone específico para este acesso.');
    //     error.statusCode = 400; error.status = 'fail'; throw error;
    // }


    if (Object.keys(filteredUpdateData).length === 0) {
        await t.rollback();
        logger.info(`Nenhum campo válido para atualizar para SharedAccess ID ${sharedAccessId}.`);
        const reloadedOriginal = await SharedAccess.findByPk(sharedAccessId, {
            include: [
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
                { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
            ]
        });
        return reloadedOriginal ? reloadedOriginal.toJSON() : null;
    }

    await sharedAccess.update(filteredUpdateData, { transaction: t });
    await t.commit();
    logger.info(`Acesso compartilhado ID ${sharedAccessId} atualizado.`);
    return SharedAccess.findByPk(sharedAccessId, {
        include: [
            { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
            { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
            { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
        ]
    }).then(sa => sa.toJSON());
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao atualizar acesso compartilhado ID ${sharedAccessId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function revokeAccess(ownerClientId, sharedAccessId) {
  const t = await sequelize.transaction();
  try {
    const sharedAccess = await SharedAccess.findOne({
      where: { id: sharedAccessId, ownerClientId },
      transaction: t
    });
    if (!sharedAccess) {
      await t.rollback();
      const error = new Error('Registro de acesso compartilhado não encontrado ou não pertence a você.');
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    await sharedAccess.destroy({ transaction: t });
    await t.commit();
    logger.info(`Acesso compartilhado ID ${sharedAccessId} revogado pelo dono ID ${ownerClientId}.`);
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao revogar acesso compartilhado ID ${sharedAccessId}: ${error.message}`, error);
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function findActiveSharedAccessByPhone(sharedPhone) {
    if (!sharedPhone) return null;
    const normalizedPhone = normalizePhoneNumberToCanonical(sharedPhone);
    if (!normalizedPhone) return null;
    
    try {
        const sharedAccess = await SharedAccess.findOne({
            where: {
                sharedAccessPhone: normalizedPhone, 
                status: 'Ativo'
            },
            include: [
                {
                    model: Client,
                    as: 'ownerClient',
                    attributes: ['id', 'name', 'email', 'status', 'accessLevel', 'accessExpiresAt'],
                    include: [{model: FinancialAccount, as: 'financialAccounts', attributes:['id', 'accountName', 'accountType', 'isDefault', 'isActive']}]
                },
                {
                    model: Client,
                    as: 'sharedWithClient',
                    attributes: ['id', 'name', 'email', 'phone', 'status', 'passwordHash'] // Adicionado passwordHash
                },
                {
                    model: FinancialAccount,
                    as: 'accessibleBusinessProfile',
                    attributes: ['id', 'accountName', 'accountType'],
                    required: false
                }
            ]
        });
        return sharedAccess;
    } catch (error) {
        logger.error(`[SharedAccessService] Erro ao buscar SharedAccess por telefone ${sharedPhone} (normalizado: ${normalizedPhone}): ${error.message}`, error);
        return null;
    }
}

async function respondToInvite(sharedWithClientId, sharedAccessId, response) {
    const t = await sequelize.transaction();
    try {
        const invite = await SharedAccess.findOne({
            where: {
                id: sharedAccessId,
                sharedWithClientId: sharedWithClientId,
                status: 'Pendente'
            },
            transaction: t
        });

        if (!invite) {
            await t.rollback();
            const error = new Error('Convite não encontrado, já respondido ou inválido para você.');
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        let newStatus;
        if (response === 'aceitar') {
            newStatus = 'Ativo';
        } else if (response === 'recusar') {
            newStatus = 'Inativo';
        } else {
            await t.rollback();
            const error = new Error("Resposta inválida. Use 'aceitar' ou 'recusar'.");
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        await invite.update({ status: newStatus }, { transaction: t });
        await t.commit();

        logger.info(`Cliente ID ${sharedWithClientId} ${response === 'aceitar' ? 'aceitou' : 'recusou'} o convite de acesso compartilhado ID ${sharedAccessId}. Novo status: ${newStatus}.`);
        return SharedAccess.findByPk(sharedAccessId, {
            include: [
                { model: Client, as: 'ownerClient', attributes: ['id', 'name', 'email'] },
                { model: Client, as: 'sharedWithClient', attributes: ['id', 'name', 'email', 'phone'] },
                { model: FinancialAccount, as: 'accessibleBusinessProfile', attributes: ['id', 'accountName', 'accountType'], required: false }
            ]
        }).then(sa => sa.toJSON());

    } catch (error) {
        if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
        logger.error(`Erro ao responder ao convite de acesso compartilhado ID ${sharedAccessId} por Cliente ${sharedWithClientId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}


module.exports = {
  grantAccess,
  getSharedAccessesByOwner,
  getSharedAccessesForUser,
  updateSharedAccess,
  revokeAccess,
  findActiveSharedAccessByPhone,
  getSharedAccessById,
  respondToInvite,
};
```

---

### **3. Conteúdo do arquivo `src/features/WhatsappHandler/onboarding.handler.js`**

```javascript
// src/features/WhatsappHandler/onboarding.handler.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const logger = require('../../utils/logger');

// Funções de formatação de mensagens de onboarding (copiadas de whatsapp.service.js)
function getOnboardingWelcomeNoPlanMessage(clientName) {
    const siteUrl = process.env.PLAN_SITE_URL || "https://map-nocontrole.com.br/#planos";
    const aiIntro = `🚀 Olá, ${clientName}! Preparado para simplificar suas finanças e ter tudo na palma da mão? Vamos juntos nessa jornada! 💪✨`;
    const dataStructure = `🎯 Planos MAP no Controle:\n\n` +
                          `📅 Opções disponíveis: Mensal e Anual\n` +
                          `🏷️ Para: Finanças pessoais e empresariais\n` +
                          `🌐 Página de planos: ${siteUrl}`;
    const linkText = `🤔 Quer saber mais detalhes por aqui? É só dizer "sim"! Ou, se preferir, já pode garantir seu plano no link acima. Assim que ativar, me chama com um "oi" que começamos a mágica! ✨`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForFullNameMessage(clientName, isSharedContext = false, ownerName = 'O proprietário') {
    if (isSharedContext) {
        const aiIntro = `Olá, ${clientName}! 👋 Bem-vindo(a) ao Acesso Compartilhado do NoControle! Que legal ter você por aqui para ajudar a gerenciar as contas de *${ownerName}*. 🤝`;
        
        const dataStructure = `*O que isso significa?*\n`+
                              `Significa que *${ownerName}* confia em você e te concedeu permissão para visualizar e registrar informações em nome dele(a). 📊 Você funcionará como um "braço direito", ajudando a manter tudo organizado!\n\n`+
                              `*O que você poderá fazer?*\n`+
                              `✅ Lançar despesas e receitas\n`+
                              `✅ Agendar compromissos\n`+
                              `✅ Consultar resumos e saldos`;
                              
        const linkText = `Para começarmos, e para que suas ações fiquem corretamente identificadas para o proprietário, por favor, me diga o seu *nome completo*.`;

        return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
    }
    const aiIntro = `🔐 Senha guardada com todo carinho e segurança! 🗝️`;
    const dataStructure = `😊 Agora, para a gente se conhecer melhor, qual nome completo podemos usar no seu perfil?`;
    const linkText = `📊 Assim seu cadastro fica completinho e personalizado para você!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForPFAccountNameMessage(clientName) {
    const aiIntro = `🎉 Uhuul, ${clientName}! Tudo certo com seu acesso e credenciais! 🚀`;
    const dataStructure = `📋 Próximo passo:\n\n` +
                          `📝 Vamos criar sua primeira conta financeira para seus gastos pessoais (PF).\n\n`+
                          `💡 Qual nome você gostaria de dar para ela? Algo como "Minhas Contas" ou "Pessoal do(a) ${clientName}" seria bem legal!`;
    return `${aiIntro}\n\n${dataStructure}`;
}

function getOnboardingConfirmPJAccountSetupMessage(clientName, pfAccountName, planDetailsText) {
    const aiIntro = `🏦 Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientName}! 🎉 Ela já está selecionada para você começar a usar.`;
    const dataStructure = `🚀 Próximo passo:\n\n` +
                          `📈 Como você tem o ${planDetailsText.split(' (')[0].trim()}, que tal configurarmos também uma conta para sua empresa (PJ) ou MEI?`;
    const linkText = `✨ Responda "sim" para configurar ou "não" para pular essa etapa.`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForPJTypeMessage(clientName) {
    const aiIntro = `👍 Excelente, ${clientName}! Sua nova conta será para qual tipo?`;
    const dataStructure = `🏢 Empresa (PJ) ou 👩‍💼 Microempreendedor Individual (MEI)?`;
    const linkText = `📲 Me diga "PJ" ou "MEI" para que eu possa configurar certinho para você!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForCompanyNameMessage(clientName, companyType) {
    const aiIntro = `🎉 Show, ${clientName}! Conta do tipo ${companyType} selecionada. 🚀`;
    const dataStructure = `🏢 Agora, me conta: qual nome incrível vamos dar para essa sua potência empresarial?`;
    const linkText = `💡 Pode ser algo como "Tech Solutions LTDA" ou "Consultoria ${clientName} MEI", use sua criatividade!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingCompanyCreatedMessage(clientName, companyType, companyName, activePersonalAccountName) {
    const aiIntro = `🎊 Sensacional, ${clientName}! Sua conta ${companyType} "${companyName}" foi criada e está pronta para brilhar! ✨`;
    const dataStructure = `🏦 Sua conta "${activePersonalAccountName}" continua selecionada no momento.\n\n` +
                          `🔄 Para mudar para a conta da empresa, é só me dizer: "mudar para conta ${companyName}".`;
    const linkText = `💪 E aí, o que vamos fazer agora? Estou pronto para a ação!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

/**
 * Lida com um passo do fluxo de onboarding.
 * @param {object} state - O estado da conversa atual.
 * @param {string} messageText - A mensagem recebida do usuário.
 * @param {object} actorClient - O objeto do cliente que está interagindo.
 * @returns {Promise<{onboardingReply: string, updatedState: object, updatedActorClient: object}>}
 */
async function handleOnboardingStep(state, messageText, actorClient) {
    let onboardingReply = "";
    // MUDANÇA AQUI: clientName para mensagens agora usa o nome do actorClient, que será 'Convidado'
    // Se o actorClient.name for "Convidado", o nome passado para as funções de mensagem será "você" ou o pushName (se for primeira saudação).
    const clientNameForMessages = (actorClient.name && actorClient.name.toLowerCase() !== 'convidado')
        ? actorClient.name.split(" ")[0]
        : (state.pushNameFromPayload || "você"); // Usar pushName apenas para a primeira saudação genérica, caso 'actorClient.name' seja 'Convidado'.

    const lowerMessageText = (messageText || "").toLowerCase().trim();
    const isSharedContext = state.isSharedAccessContext;

    // FASE 1: Acesso Compartilhado - Coleta do Nome (se for 'Convidado' no DB)
    // Isso se aplica se o actorClient.name no banco de dados ainda é 'Convidado'.
    if (isSharedContext && actorClient.name.toLowerCase() === 'convidado') { // Verifica o nome no DB
        if (state.currentAction === 'awaiting_shared_user_name') {
            const nameInput = messageText.trim();
            if (nameInput.length >= 3 && nameInput.includes(" ")) { // Exige nome completo
                const updatedClient = await clientService.updateClient(actorClient.id, { name: nameInput });
                state.clientName = updatedClient.name.split(" ")[0]; // Atualiza o nome de exibição no estado
                actorClient = updatedClient; // Atualiza o actorClient no estado com o novo nome
                logger.info(`[ONBOARDING HANDLER] Nome de convidado (ID ${actorClient.id}) definido para "${updatedClient.name}".`);
                
                // Após definir o nome, a próxima etapa é configurar credenciais principais se passwordHash for nulo
                if (actorClient.passwordHash === null) {
                    state.data.onboardingStage = 'setting_up_main_client_credentials'; // Transiciona para a próxima etapa
                    state.currentAction = 'awaiting_main_credentials_input'; // Define a ação esperada
                    onboardingReply = `Perfeito, ${state.clientName}! Nome salvo. Agora o proprietário saberá que é você. 😊\n\n`;
                    onboardingReply += `**✨ Primeiro Acesso Pessoal (Painel Web)!**\n`;
                    onboardingReply += `Para ter *seu próprio* acesso ao painel do NoControle (onde você verá *todas* as contas que *você possui* ou que *foram compartilhadas com você*), por favor, *me diga seu nome completo, seu email e uma senha que você quer usar*.\n`;
                    onboardingReply += `\n_Ex: Meu nome é *${state.clientName} Silva*, meu email é *${state.clientName.toLowerCase()}@email.com* e minha senha é *MinhaSenha123*._\n`;
                    onboardingReply += `Este será seu login pessoal para acessar o painel em: https://www.map-nocontrole.com.br/login`;
                    onboardingReply += `\n\nAssim que você me passar essas informações, estará tudo pronto para você dominar suas finanças! 🤩`;
                } else {
                    // Já possui credenciais principais, move para o final do onboarding do acesso compartilhado
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = 'selecting_account_flow_active'; // Força a seleção de conta compartilhada.
                    state.activeFinancialAccountId = null; // Zera para forçar a re-avaliação da conta ativa
                    onboardingReply = `Perfeito, ${state.clientName}! Nome salvo. 😊\n\nAgora, para a conta compartilhada, qual das contas de *${state.ownerClientNameForContext}* você gostaria de usar agora?`;
                }
            } else {
                onboardingReply = `Para que o proprietário da conta te identifique melhor, por favor, me diga seu nome completo (nome e sobrenome). ✨`;
            }
        } else {
            // Se ainda não estava esperando o nome, define a ação e envia a primeira mensagem
            state.currentAction = 'awaiting_shared_user_name';
            // MUDANÇA AQUI: Usar "você" ou "Olá" para o prompt inicial, ignorando o pushName para a sugestão de nome.
            const initialPromptName = 'você'; // Ou 'Olá'
            onboardingReply = getOnboardingAskForFullNameMessage(initialPromptName, true, state.ownerClientNameForContext);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }

    // FASE 2: Acesso Compartilhado - Coleta de Credenciais Principais (apenas se passwordHash for nulo e nome já definido)
    // O actorClient.name não é 'Convidado' aqui (já foi atualizado), mas o passwordHash ainda é null.
    if (isSharedContext && actorClient.passwordHash === null && state.data.onboardingStage === 'setting_up_main_client_credentials') {
        if (state.currentAction === 'awaiting_main_credentials_input') {
            // Regex para tentar extrair nome, email e senha
            // Ex: "Meu nome é João Silva, meu email é joao@email.com e minha senha é MinhaSenha123."
            const match = messageText.match(/(?:meu nome é|nome é)\s*(.+?),?\s*meu email é\s*([^\s,]+@[^\s,]+(?:com|br)),?\s*e minha senha é\s*(\S+)/i);
            
            if (match && match[1] && match[2] && match[3]) {
                const fullName = match[1].trim();
                const email = match[2].trim();
                const password = match[3].trim();

                try {
                    // Atualiza o cliente com o nome completo, email e gera o password hash
                    const updatedClient = await clientAuthService.registerNewUser(actorClient.phone, fullName, email, password);
                    actorClient = updatedClient; // Garante que o actorClient no estado seja atualizado
                    state.clientName = actorClient.name.split(" ")[0]; // Atualiza o nome usado nas mensagens

                    state.data.onboardingStage = 'onboarding_complete'; // Marca o onboarding como completo
                    state.currentAction = null; // Reseta a ação
                    onboardingReply = `🎉 Maravilha, ${state.clientName}! Seus dados pessoais foram salvos com sucesso! 🚀\n\n`;
                    onboardingReply += `Agora você pode usar seu email *${actorClient.email}* e a senha que escolheu para acessar o painel web em: https://www.map-nocontrole.com.br/login\n\n`;
                    onboardingReply += `E aqui pelo WhatsApp, você continua no modo de Acesso Compartilhado. Qual das contas de *${state.ownerClientNameForContext}* você gostaria de usar agora?`;

                    logger.info(`[ONBOARDING HANDLER] Credenciais principais definidas para convidado (ID ${actorClient.id}).`);
                } catch (e) {
                    logger.error(`[ONBOARDING HANDLER] Erro ao registrar credenciais principais para convidado (ID ${actorClient.id}): ${e.message}`);
                    onboardingReply = `Opa! 😬 Tive um probleminha para salvar suas credenciais principais: ${e.message}\n\nPor favor, tente novamente com seu nome completo, email e uma senha no formato sugerido. Ex: *Meu nome é João Silva, meu email é joao@email.com e minha senha é MinhaSenha123*.`;
                }
            } else {
                onboardingReply = `Não consegui entender seu nome, email e senha no formato esperado. Por favor, use o formato sugerido:\n\n_Ex: Meu nome é *João Silva*, meu email é *joao@email.com* e minha senha é *MinhaSenha123*._`;
            }
        } else {
            // Se o estágio foi definido, mas a ação não (primeira vez aqui), define a ação e re-prompt
            state.currentAction = 'awaiting_main_credentials_input';
            onboardingReply = `Olá, ${clientNameForMessages}! Por favor, para completar seu acesso, me diga seu nome completo, seu email e uma senha que você quer usar.\n\n_Ex: Meu nome é *João Silva*, meu email é *joao@email.com* e minha senha é *MinhaSenha123*._`;
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }

    // FASE 3: Fluxo de Onboarding Padrão (para usuários normais ou convidados que já têm credenciais principais)
    // Se o onboarding estiver em andamento E não for um contexto de acesso compartilhado
    // OU se for um contexto de acesso compartilhado, mas as credenciais principais já estiverem definidas
    if (state.data.onboardingStage !== 'onboarding_complete') {
        // MUDANÇA AQUI: Passa clientNameForMessages para as funções de mensagem.
        if (state.data.onboardingStage === 'awaiting_plan_confirmation') {
            if(state.hasPaidAccess_whenStageLastSet || !state.isNewUserForSessionLogic) {
                onboardingReply = getOnboardingWelcomeNoPlanMessage(clientNameForMessages);
            }
            state.currentAction = 'awaiting_plan_interest_generic';
        } else if (state.data.onboardingStage === 'setting_up_pf_account_name') {
             // Se for acesso compartilhado e chegou aqui, significa que o estágio foi definido para PF, mas não deveria.
             // Apenas força o onboarding para completo e sem ação.
             if (isSharedContext) { 
                state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null;
            } else if (state.currentAction !== 'awaiting_input_pf_name' || state.isNewUserForSessionLogic) {
                onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameForMessages);
                state.currentAction = 'awaiting_input_pf_name';
            } else { 
                const pfAccountName = messageText.trim();
                if (pfAccountName.length >= 3 && pfAccountName.length <= 50) {
                    try {
                        const newPfAccount = await clientService.createFinancialAccount(actorClient.id, {
                            accountName: pfAccountName, accountType: 'PF', isDefault: true
                        });
                        state.activeFinancialAccountId = newPfAccount.id;
                        state.activeFinancialAccountName = newPfAccount.accountName;
                        state.activeFinancialAccountType = newPfAccount.accountType;
                        logger.info(`[ONBOARDING HANDLER] Conta PF "${pfAccountName}" criada para ATOR ${actorClient.phone}.`);
                        const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                        if (planTier === 'avancado') {
                            state.data.onboardingStage = 'confirming_pj_mei_setup';
                            onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameForMessages, pfAccountName, state.accessLevelTextForUser);
                            state.currentAction = 'awaiting_pj_mei_confirm';
                        } else {
                            state.data.onboardingStage = 'onboarding_complete';
                            const aiIntro = `Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameForMessages}! 🏦`;
                            const dataStructure = `Ela já está selecionada e seu plano ${state.accessLevelTextForUser} está pronto para uso!`;
                            const linkText = `Como posso te ajudar agora? 🚀`;
                            onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                            const userAffiliateCode = actorClient.affiliateCode;
                            if (userAffiliateCode) {
                                const affiliateWelcomeMessage = `\n\nAh, e uma ótima notícia: você também já é um afiliado! 🤩\nSeu código de indicação é *${userAffiliateCode}*. Compartilhe com seus amigos e ganhe comissões! 💰`;
                                onboardingReply += affiliateWelcomeMessage;
                            }
                            state.currentAction = null;
                        }
                    } catch (e) {
                        logger.error(`[ONBOARDING HANDLER] Erro ao criar conta PF "${pfAccountName}" para ATOR ${actorClient.phone}: ${e.message}`);
                        onboardingReply = `Opa! 😬 Tive um probleminha para criar a conta "${pfAccountName}" (${e.message.substring(0,60)}). Que tal a gente tentar um nome diferente?`;
                    }
                } else {
                    onboardingReply = `Esse nome parece um pouquinho curto ou um cadinho longo demais, ${clientNameForMessages}. Para sua conta Pessoal, que tal um nome entre 3 e 50 letras? Assim fica perfeito! ✍️`;
                }
            }
        } else if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
            if (isSharedContext) {
                state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null;
             } else if (state.currentAction !== 'awaiting_pj_mei_confirm' || state.isNewUserForSessionLogic) {
                const actorPFAccount = (await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true })).find(a => a.accountType === 'PF');
                onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameForMessages, actorPFAccount?.accountName || "Pessoal", state.accessLevelTextForUser);
                state.currentAction = 'awaiting_pj_mei_confirm';
            } else { 
                const userResponseLower = lowerMessageText;
                let wantsPjMei = false; let pjMeiType = null;
                if (userResponseLower.includes("sim") || userResponseLower === "pj" || userResponseLower === "mei" || userResponseLower.includes("quero") || userResponseLower.includes("bora")) {
                    wantsPjMei = true;
                    if (userResponseLower.includes("pj")) pjMeiType = "PJ";
                    else if (userResponseLower.includes("mei")) pjMeiType = "MEI";
                }
                if (wantsPjMei) {
                    if (pjMeiType) {
                        state.data.tempPjMeiType = pjMeiType;
                        onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameForMessages, pjMeiType);
                        state.data.onboardingStage = 'creating_pj_mei_account_name';
                        state.currentAction = 'awaiting_input_pj_mei_name';
                    } else {
                        onboardingReply = getOnboardingAskForPJTypeMessage(clientNameForMessages);
                        state.data.onboardingStage = 'awaiting_pj_mei_type';
                        state.currentAction = 'awaiting_input_pj_mei_type';
                    }
                } else {
                    const aiIntro = `Tranquilo, ${clientNameForMessages}! Sem pressa. Se mais pra frente você quiser adicionar sua conta empresarial, é só me avisar! 😉`;
                    const dataStructure = `Sua conta "${state.activeFinancialAccountName || 'Pessoal'}" está prontinha para uso com seu plano ${state.accessLevelTextForUser}!`;
                    const linkText = `O que você gostaria de fazer primeiro? Estou a postos! 🚀`;
                    onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                    const userAffiliateCode = actorClient.affiliateCode;
                    if (userAffiliateCode) {
                        const affiliateWelcomeMessage = `\n\nAh, e uma ótima notícia: você também já é um afiliado! 🤩\nSeu código de indicação é *${userAffiliateCode}*. Compartilhe com seus amigos e ganhe comissões! 💰`;
                        onboardingReply += affiliateWelcomeMessage;
                    }
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = null;
                }
            }
        } else if (state.data.onboardingStage === 'awaiting_pj_mei_type') {
            if (isSharedContext) { state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null; }
            else {
                const typeInput = messageText.trim().toUpperCase();
                if (typeInput === 'PJ' || typeInput === 'MEI') {
                    state.data.tempPjMeiType = typeInput;
                    onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameForMessages, typeInput);
                    state.data.onboardingStage = 'creating_pj_mei_account_name';
                    state.currentAction = 'awaiting_input_pj_mei_name';
                } else {
                    onboardingReply = `Por favor, ${clientNameForMessages}, me diga se é "PJ" ou "MEI" para sua conta empresarial. Assim a gente configura tudo certinho! 😊`;
                }
            }
        } else if (state.data.onboardingStage === 'creating_pj_mei_account_name') {
            if (isSharedContext) { state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null; }
            else {
                const companyName = messageText.trim();
                const companyType = state.data.tempPjMeiType;
                if (companyName.length >= 3 && companyName.length <= 50) {
                    try {
                        await clientService.createFinancialAccount(actorClient.id, { 
                            accountName: companyName, accountType: companyType, isDefault: false
                        });
                        const personalAccountName = state.activeFinancialAccountName || (await clientService.getClientFinancialAccounts(actorClient.id, {isActive:true})).find(a => a.accountType === 'PF')?.accountName || "Pessoal";
                        onboardingReply = getOnboardingCompanyCreatedMessage(clientNameForMessages, companyType, companyName, personalAccountName);
                        logger.info(`[ONBOARDING HANDLER] Conta ${companyType} "${companyName}" criada para ATOR ${actorClient.phone}.`);
                        const userAffiliateCode = actorClient.affiliateCode;
                        if (userAffiliateCode) {
                            const affiliateWelcomeMessage = `\n\nAh, e uma ótima notícia: você também já é um afiliado! 🤩\nSeu código de indicação é *${userAffiliateCode}*. Compartilhe com seus amigos e ganhe comissões! 💰`;
                            onboardingReply += affiliateWelcomeMessage;
                        }
                        state.data.onboardingStage = 'onboarding_complete';
                        state.currentAction = null; delete state.data.tempPjMeiType;
                    } catch (e) {
                        logger.error(`[ONBOARDING HANDLER] Erro ao criar conta ${companyType} "${companyName}" para ATOR ${actorClient.phone}: ${e.message}`);
                        onboardingReply = `Eita! 😬 Parece que não consegui criar a conta ${companyType} "${companyName}" (${e.message.substring(0,60)}). Será que podemos tentar um nome um pouquinho diferente?`;
                    }
                } else {
                    onboardingReply = `Para o nome da sua ${companyType}, ${clientNameForMessages}, que tal algo entre 3 e 50 letras? Assim fica bem bacana! 🌟`;
                }
            }
        }
    }

    return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
}

module.exports = {
    handleOnboardingStep,
    getOnboardingWelcomeNoPlanMessage
};
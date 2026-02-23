// src/features/WhatsappHandler/whatsapp.service.js

// --- Imports dos Serviços de Negócio (Core) ---
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const sharedAccessService = require('../SharedAccess/sharedAccess.service');
const financialCategoryService = require('../FinancialCategory/financialCategory.service');
const financialService = require('../Financial/financial.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const businessClientService = require('../BusinessClient/BusinessClient.service');
const scheduleHandler = require('./schedule.handler');

// --- Imports dos Novos Especialistas e Utilitários ---
const onboardingHandler = require('./onboarding.handler');
const actionHandler = require('./action.handler');
const formatter = require('./response.formatter');
const { normalizePhoneNumberToCanonical } = require('../../utils/phoneUtils');
const { sendWhatsappMessage, sendButtonListMessage, downloadZapiMedia } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService'); // Importação do serviço de IA
const logger = require('../../utils/logger');
const path = require('path');
const hydrationService = require('../Hydration/hydration.service');
const systemService = require('../System/system.service');

// <<< INÍCIO DA OTIMIZAÇÃO: IMPLEMENTAÇÃO DO CACHE >>>
const NodeCache = require('node-cache');
// Cache de 5 minutos para os dados de contexto da conta (categorias, cartões, etc.)
// Isso reduz drasticamente as chamadas ao DB em conversas rápidas.
const appContextCache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
// <<< FIM DA OTIMIZAÇÃO: IMPLEMENTAÇÃO DO CACHE >>>


// --- Gerenciamento de Estado da Conversa ---
const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;
let pushNameFromPayload = null;


// --- Funções de Controle de Fluxo e Estado (Core do Maestro) ---

async function initializeOrUpdateState(client, sharedAccessRecord = null, existingState = null, clientAccountsFromDb = [], ownerAccountsIfShared = []) {
    // --- LÓGICA DE IDENTIFICAÇÃO E PERMISSÕES (PERMANECE IGUAL) ---
    const nameFromDb = (client.name && client.name.trim() !== "" && client.name.toLowerCase() !== 'convidado')
        ? client.name.split(" ")[0]
        : null;

    const clientName = nameFromDb || existingState?.clientName || "pessoa incrível";

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
            if (ownerClientTemp) {
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

    if (ownerClientForContext.accessLevel && ownerClientForContext.accessLevel !== 'gratuito') {
        if (ownerClientForContext.accessLevel.startsWith('vitalicio_')) {
            hasPaidAccess = true;
            accessLevelTextForUser = formatter.formatPlanName(ownerClientForContext.accessLevel);
        } else if (ownerClientForContext.accessExpiresAt) {
            const expiryDate = new Date(ownerClientForContext.accessExpiresAt + 'T23:59:59Z'); // Considera o dia todo
            const today = new Date();
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

    // <<< INÍCIO DA CORREÇÃO PRINCIPAL (ANTI-LOOP) >>>
    // Se já existe um estado e o usuário está no meio de um fluxo de onboarding, NÃO recalcule o estágio
    // a menos que o status de pagamento tenha mudado.
    if (existingState && existingState.data.onboardingStage && existingState.data.onboardingStage !== 'onboarding_complete') {
        const paidStatusChanged = existingState.hasPaidAccess_whenStageLastSet !== hasPaidAccess;
        if (!paidStatusChanged) {
            // Apenas atualiza os dados básicos, mas mantém o estágio atual do onboarding intacto.
            existingState.clientName = clientName;
            existingState.ownerClientNameForContext = ownerClientNameForContext;
            logger.debug(`[WHATSAPP SERVICE - UpdateState] Mantendo estágio de onboarding '${existingState.data.onboardingStage}' para evitar loop.`);
            return existingState;
        }
    }
    // <<< FIM DA CORREÇÃO PRINCIPAL >>>

    // <<< INÍCIO DA LÓGICA DE ESTÁGIO CORRIGIDA E HIERÁRQUICA >>>
    let onboardingStage;

    if (!hasPaidAccess) {
        onboardingStage = 'awaiting_plan_confirmation';
    } else if (!client.email || !client.passwordHash) {
        onboardingStage = 'setting_up_credentials_email';
    } else if (accountsForOperation.length === 0) {
        onboardingStage = 'setting_up_pf_account_name';
    } else {
        const hasPjMeiAccount = accountsForOperation.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
        const planTier = clientAccessLevel.startsWith('avancado') || clientAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';

        if (planTier === 'avancado' && !hasPjMeiAccount) {
            onboardingStage = 'confirming_pj_mei_setup';
        } else {
            onboardingStage = 'onboarding_complete';
        }
    }
    // <<< FIM DA LÓGICA DE ESTÁGIO CORRIGIDA >>>

    let defaultAccount = null;
    if (onboardingStage === 'onboarding_complete' && hasPaidAccess && accountsForOperation.length > 0) {
        defaultAccount = accountsForOperation.find(a => a.isDefault);
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
        if (!existingState.hasPaidAccess && hasPaidAccess) {
            existingState.justReactivated = true;
        }

        existingState.clientName = clientName;
        existingState.ownerClientIdForContext = ownerClientIdForContext;
        existingState.ownerClientNameForContext = ownerClientNameForContext;
        existingState.isSharedAccessContext = isSharedAccessContext;
        existingState.sharedAccessPermissions = sharedAccessPermissions;
        existingState.currentAccessLevel = clientAccessLevel;
        existingState.accessExpiresAt = clientAccessExpiresAt;
        existingState.hasPaidAccess = hasPaidAccess;
        existingState.accessLevelTextForUser = accessLevelTextForUser;
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
        clientName: clientName,
        ownerClientIdForContext: ownerClientIdForContext, ownerClientNameForContext: ownerClientNameForContext,
        isSharedAccessContext: isSharedAccessContext, sharedAccessPermissions: sharedAccessPermissions,
        messageHistory: [], pendingConfirmation: null, editingResource: null, lastAiResponse: null,
        currentAccessLevel: clientAccessLevel, accessExpiresAt: clientAccessExpiresAt,
        hasPaidAccess: hasPaidAccess, accessLevelTextForUser: accessLevelTextForUser,
        hasPaidAccess_whenStageLastSet: hasPaidAccess,
        justReactivated: false,
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

    // REVERTIDO: Voltando a usar Transcrição (Whisper) pois FFmpeg falha no servidor
    try {
        const downloadedMedia = await downloadZapiMedia(mediaUrl);
        if (downloadedMedia && downloadedMedia.stream) {

            logger.info(`[WHATSAPP SERVICE] Áudio baixado, enviando para transcrição (Whisper)...`);

            // Transcrever usando Whisper (via aiModelService)
            const transcriptionText = await aiModelService.transcribeAudioStream(downloadedMedia.stream);

            if (!transcriptionText) {
                logger.warn(`[WHATSAPP SERVICE] Transcrição retornou vazia para ${canonicalPhone}.`);
                await sendWhatsappMessage(canonicalPhone, "Não consegui entender o que você disse no áudio. 😕 Poderia tentar escrever?", { immediate: true });
                return;
            }

            logger.info(`[WHATSAPP SERVICE] Transcrição concluída: "${transcriptionText}"`);

            // Adiciona um marcador de que foi áudio
            const finalMessage = `[ÁUDIO TRANSCRITO]: ${transcriptionText}`;

            // Processa como se fosse uma mensagem de texto normal
            return await processIncomingMessage(canonicalPhone, finalMessage, pushName, rawPayload);

        } else {
            logger.error(`[WHATSAPP SERVICE] Falha ao baixar áudio de ${canonicalPhone} da URL: ${mediaUrl}.`);
            await sendWhatsappMessage(canonicalPhone, "Tive um problema ao baixar seu áudio. 🙁", { immediate: true });
        }
    } catch (error) {
        logger.error(`[WHATSAPP SERVICE] Erro ao processar áudio (Transcrição) de ${canonicalPhone}: ${error.message}`);
        await sendWhatsappMessage(canonicalPhone, "Puxa, falhei ao processar seu áudio. 😵‍💫 Pode tentar digitar?", { immediate: true });
    } finally {
        pushNameFromPayload = null;
    }
}

// ============================================================================
// === FUNÇÃO processIncomingMessage COMPLETA E ATUALIZADA ===
// ============================================================================
async function processIncomingMessage(senderPhoneRaw, messageText, pushName, rawPayload, audioPayload = null) {
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
    let actorClient = null;

    try {
        // ETAPA 1: Obter Cliente e Estado da Sessão
        let sharedAccessRecord = null;
        let clientAccountsForOnboarding = [];
        let ownerAccountsIfShared = [];

        sharedAccessRecord = await sharedAccessService.findActiveSharedAccessByPhone(senderPhone);

        if (sharedAccessRecord && sharedAccessRecord.sharedWithClient) {
            actorClient = sharedAccessRecord.sharedWithClient;
            const ownerClientIdForContext = sharedAccessRecord.ownerClientId;
            logger.info(`[WHATSAPP SERVICE] Identificado ACESSO COMPARTILHADO. Ator: ${actorClient.name} (ID: ${actorClient.id}), Dono: ${ownerClientIdForContext}`);

            if (!actorClient.status || actorClient.status !== 'Ativo') {
                logger.warn(`[WHATSAPP SERVICE] SharedAccess para ${senderPhone}, mas convidado (ator) ${actorClient.id} está inativo.`);
                await sendWhatsappMessage(senderPhone, "Olá! Seu acesso a esta conta compartilhada não está ativo. Por favor, contate o proprietário.", { immediate: true });
                return;
            }
            if (!sharedAccessRecord.ownerClient || sharedAccessRecord.ownerClient.status !== 'Ativo') {
                logger.warn(`[WHATSAPP SERVICE] SharedAccess para ${senderPhone}, mas proprietário ${ownerClientIdForContext} está inativo.`);
                await sendWhatsappMessage(senderPhone, "Olá! O proprietário da conta que compartilhou este acesso parece não estar ativo. Tente mais tarde ou contate-o.", { immediate: true });
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

            if (ownerAccountsIfShared.length === 0) {
                const ownerName = sharedAccessRecord.ownerClient?.name || 'o proprietário';
                logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas nenhuma conta do dono acessível foi encontrada.`);
                await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado, mas parece que ${ownerName} não possui contas ativas do tipo que você pode acessar (Pessoal ou o Empresarial específico). Peça para ele verificar, por favor! 😉`, { immediate: true });
                return;
            }
        } else {
            actorClient = await clientService.findClientByPhone(senderPhone);

            if (actorClient) {
                logger.info(`[WHATSAPP SERVICE] Identificado CLIENTE PRINCIPAL: ${actorClient.name} (ID: ${actorClient.id}) pelo telefone ${senderPhone}.`);
                clientAccountsForOnboarding = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
            } else {
                logger.info(`[WHATSAPP SERVICE] Telefone ${senderPhone} não reconhecido. Criando novo cliente para onboarding...`);
                actorClient = await clientService.createClientContact({ phone: senderPhone, name: 'Convidado' });
                const welcomeMsg = onboardingHandler.getOnboardingWelcomeNoPlanMessage(actorClient.name ? actorClient.name.split(" ")[0] : (pushNameFromPayload || "você"));
                await sendWhatsappMessage(senderPhone, welcomeMsg, { immediate: true });
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

        // --- ATUALIZAÇÃO DE ATIVIDADE WHATSAPP ---
        await actorClient.update({ lastActiveAt: new Date() }).catch(err => logger.error(`Erro ao atualizar lastActiveAt para ${senderPhone}: ${err.message}`));

        state.isNewUserForSessionLogic = !existingState;
        state.pushNameFromPayload = pushNameFromPayload;

        if (state.justReactivated) {
            const welcomeBackMessage = `🎉 Eba, que bom te ver de volta, ${state.clientName}! Sua assinatura foi reativada com sucesso e tudo está pronto para você continuar de onde parou. O que vamos organizar primeiro? 💪`;
            await sendWhatsappMessage(senderPhone, welcomeBackMessage, { immediate: true });
            state.justReactivated = false;
        }

        if (!state.isSharedAccessContext && state.data.onboardingStage === 'onboarding_complete' && !state.hasPaidAccess) {
            logger.info(`[WHATSAPP HANDLER] Bloqueando ação para ${senderPhone} devido à assinatura expirada.`);

            const checkoutBaseUrl = process.env.CHECKOUT_BASE_URL || "https://www.map-nocontrole.com.br";
            const expiredMessage =
                `Olá, ${state.clientName}! 👋\n\n` +
                `Sua assinatura do MAP no Controle não está ativa. Para reativar seu acesso completo e continuar no controle, escolha um dos planos abaixo:\n\n` +
                `*Plano Básico*\n` +
                `- Mensal (R$ 39,90): ${checkoutBaseUrl}/checkout/7\n` +
                `- Anual (R$ 389,90): ${checkoutBaseUrl}/checkout/8\n\n` +
                `*Plano Avançado (com Módulo de Negócios)*\n` +
                `- Mensal (R$ 79,90): ${checkoutBaseUrl}/checkout/9\n` +
                `- Anual (R$ 789,90): ${checkoutBaseUrl}/checkout/10\n\n` +
                `Assim que o pagamento for confirmado, seu acesso é liberado na hora! ✨`;

            await sendWhatsappMessage(senderPhone, expiredMessage, { immediate: true });
            conversationState.set(senderPhone, state);
            pushNameFromPayload = null;
            return;
        }

        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[MAESTRO] Botão clicado por ${senderPhone}: ID '${buttonId}'`);

            if (buttonId.startsWith('onboarding_')) {
                logger.info(`[MAESTRO] Roteando botão de onboarding para o Onboarding Handler.`);
                const onboardingResult = await onboardingHandler.handleOnboardingStep(state, buttonId, actorClient);
                state = onboardingResult.updatedState;
                actorClient = onboardingResult.updatedActorClient;
                if (onboardingResult.onboardingReply) {
                    state.messageHistory.push({ role: 'assistant', content: onboardingResult.onboardingReply });
                }
                conversationState.set(senderPhone, state);
                pushNameFromPayload = null;
                return;
            }

            // --- INÍCIO DO NOVO FLUXO DE BOTÃO DE HORÁRIO ---
            if (buttonId.startsWith('schedule_days_')) {
                logger.info(`[MAESTRO] Roteando botão de horário para o Schedule Handler.`);
                const scheduleResult = await scheduleHandler.handleScheduleUpdate(state, buttonId, actorClient);
                state = scheduleResult.updatedState;
                conversationState.set(senderPhone, state);
                return;
            }
            // --- FIM DO NOVO FLUXO DE BOTÃO DE HORÁRIO ---

            if (buttonId.startsWith('water_intake:')) {
                const parts = buttonId.split(':');
                const actionType = parts[1];
                const logId = parseInt(parts[2], 10);
                if (isNaN(logId)) {
                    logger.warn(`[WHATSAPP SERVICE] Botão de hidratação com ID de log inválido: ${buttonId}`);
                    await sendWhatsappMessage(senderPhone, "Ops, tive um problema para identificar qual lembrete era esse. Tente novamente ou digite sua mensagem!", { immediate: true });
                    conversationState.set(senderPhone, state);
                    pushNameFromPayload = null;
                    return;
                }
                if (actionType === 'bebi') {
                    await hydrationService.updateLogStatus(actorClient.id, logId, 'completed');
                    const logs = await hydrationService.getTodaysLogsByClient(actorClient.id);
                    const prefs = await systemService.getSystemPreferences();
                    const hydrationSummary = formatter.formatHydrationLogDataStructure(logs, prefs, state.clientName);
                    await sendWhatsappMessage(senderPhone, `🎉 Boa, ${state.clientName}! Seu copo de água foi registrado! ${hydrationSummary}`, { immediate: true });
                    conversationState.set(senderPhone, state);
                    pushNameFromPayload = null;
                    return;
                } else if (actionType === 'nao_bebi') {
                    await hydrationService.handleNegativeWaterResponse(actorClient.id, logId);
                    await sendWhatsappMessage(senderPhone, `Entendido, ${state.clientName}! Sem problemas. Que tal tentar beber um pouco de água agora? Te lembro novamente em 5 minutinhos! 😉`, { immediate: true });
                    conversationState.set(senderPhone, state);
                    pushNameFromPayload = null;
                    return;
                }
            }

            logger.info(`[MAESTRO] Roteando botão de ação para o Action Handler.`);
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
            const contentToStore = audioPayload ? "[ÁUDIO ENVIADO]" : (messageText || "");
            state.messageHistory.push({ role: 'user', content: contentToStore });
            if (state.messageHistory.length > MAX_STATE_HISTORY) {
                state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
            }
        }

        if (state.data.onboardingStage !== 'onboarding_complete') {
            logger.info(`[WHATSAPP SERVICE] Processando onboarding padrão para ${senderPhone}, stage: ${state.data.onboardingStage}`);
            const onboardingResult = await onboardingHandler.handleOnboardingStep(state, messageText, actorClient);
            state = onboardingResult.updatedState;
            actorClient = onboardingResult.updatedActorClient;
            if (onboardingResult.onboardingReply) {
                state.messageHistory.push({ role: 'assistant', content: onboardingResult.onboardingReply });
            }
            conversationState.set(senderPhone, state);
            pushNameFromPayload = null;
            return;
        }

        // --- INÍCIO DA MODIFICAÇÃO: VERIFICA SE ESTÁ EM UM FLUXO ATIVO ANTES DE CHAMAR A IA ---
        if (state.currentAction && state.currentAction.startsWith('awaiting_schedule_')) {
            logger.info(`[MAESTRO] Continuando fluxo de atualização de horário para ${senderPhone}. Ação: ${state.currentAction}`);
            const scheduleResult = await scheduleHandler.handleScheduleUpdate(state, messageText, actorClient);
            state = scheduleResult.updatedState;
            conversationState.set(senderPhone, state);
            return;
        }
        // --- FIM DA MODIFICAÇÃO ---

        if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
            const pendingAction = state.pendingConfirmation;
            if (pendingAction.action === 'AWAITING_DELETION_CHOICE') {
                // (código existente para deleção múltipla)
            }
        }

        if (!state.activeFinancialAccountId) {
            const accountsForSelection = state.isSharedAccessContext ? ownerAccountsIfShared : await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
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
                    await sendWhatsappMessage(senderPhone, selectMsg, { immediate: true });
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
                        state.activeFinancialAccountType = accountToSelect.type || accountToSelect.type;
                        const confirmSelectionMsg = `Maravilha, ${state.clientName}!\nSelecionei a conta "${state.activeFinancialAccountName}" para você. Como posso te ajudar agora? 🚀`;
                        state.messageHistory.push({ role: 'assistant', content: confirmSelectionMsg });
                        state.currentAction = null;
                        await sendWhatsappMessage(senderPhone, confirmSelectionMsg, { immediate: true });
                    } else {
                        state.currentAction = 'selecting_account_flow_active';
                        state.data.accountsToList = accountsForSelection.map(a => ({ id: a.id, name: a.accountName || a.name, type: a.accountType || a.type }));
                        const ownerNameForMsg = state.isSharedAccessContext ? state.ownerClientNameForContext : null;
                        const accountOptionsText = formatter.formatListClientAccountsDataStructure(state.data.accountsToList, null, ownerNameForMsg) + "\n\n🤔 Qual delas vamos usar hoje? Me diga o nome ou o número.";
                        state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                        await sendWhatsappMessage(senderPhone, accountOptionsText, { immediate: true });
                    }
                }
            } else {
                await sendWhatsappMessage(senderPhone, `Olá ${state.clientName}! Parece que não há contas financeiras acessíveis para você no momento. ${state.isSharedAccessContext ? `Peça para ${state.ownerClientNameForContext} verificar.` : 'Diga "criar conta pessoal" para começar.'}`, { immediate: true });
            }
            conversationState.set(senderPhone, state);
            if (!state.activeFinancialAccountId) return;
        }

        const cacheKey = `context:${state.activeFinancialAccountId}`;
        let contextData = appContextCache.get(cacheKey);

        if (!contextData) {
            logger.info(`[CACHE] Cache miss para conta ${state.activeFinancialAccountId}. Buscando dados em paralelo...`);
            const [categories, cards, allAccounts, bizClientsResult] = await Promise.all([
                financialCategoryService.getAllCategoriesForAccountAI(state.activeFinancialAccountId),
                creditCardService.getActiveCreditCardsForAI(state.activeFinancialAccountId),
                clientService.getClientFinancialAccounts(state.ownerClientIdForContext, { isActive: true }),
                ['PJ', 'MEI'].includes(state.activeFinancialAccountType) ? businessClientService.getAllBusinessClients(state.activeFinancialAccountId, { isActive: true, limit: 50 }) : Promise.resolve({ businessClients: [] })
            ]);
            let filteredAccounts = allAccounts;
            if (state.isSharedAccessContext) {
                filteredAccounts = allAccounts.filter(acc => {
                    if (acc.accountType === 'PF') return state.sharedAccessPermissions.canAccessPersonalProfile;
                    if (acc.accountType === 'PJ' || acc.accountType === 'MEI') return state.sharedAccessPermissions.canAccessBusinessProfileId === acc.id;
                    return false;
                });
            }
            contextData = {
                availableFinancialCategories: categories,
                availableCreditCards: cards,
                availableFinancialAccounts: filteredAccounts,
                availableBusinessClients: bizClientsResult.businessClients || [],
            };
            appContextCache.set(cacheKey, contextData);
            logger.info(`[CACHE] Contexto para conta ${state.activeFinancialAccountId} salvo no cache.`);
        } else {
            logger.info(`[CACHE] Cache hit para conta ${state.activeFinancialAccountId}. Usando dados do cache.`);
        }

        const aiContext = {
            currentFinancialAccountId: state.activeFinancialAccountId,
            currentFinancialAccountType: state.activeFinancialAccountType,
            currentFinancialAccountName: state.activeFinancialAccountName,
            clientName: state.clientName,
            isSharedAccess: state.isSharedAccessContext,
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
            editingResource: state.editingResource,
            availableFinancialCategories: contextData.availableFinancialCategories,
            availableCreditCards: contextData.availableCreditCards,
            availableFinancialAccounts: contextData.availableFinancialAccounts,
            availableBusinessClients: contextData.availableBusinessClients,
            pendingAction: state.currentAction === 'awaiting_clarification_response' ? state.pendingConfirmation : null,
            audioPayload: audioPayload // Passar payload de áudio se existir
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

            let contextWasMutated = false;
            const mutatingActions = new Set([
                'CREATE_FINANCIAL_ACCOUNT', 'UPDATE_FINANCIAL_ACCOUNT', 'DELETE_FINANCIAL_ACCOUNT',
                'GRANT_ACCESS', 'UPDATE_GRANTED_ACCESS', 'REVOKE_ACCESS',
                'CREATE_FINANCIAL_CATEGORY', 'UPDATE_FINANCIAL_CATEGORY', 'DELETE_FINANCIAL_CATEGORY',
                'CREATE_CREDIT_CARD', 'UPDATE_CREDIT_CARD', 'DELETE_CREDIT_CARD',
                'CREATE_BUSINESS_CLIENT', 'UPDATE_BUSINESS_CLIENT', 'DELETE_BUSINESS_CLIENT',
                'SWITCH_FINANCIAL_ACCOUNT'
            ]);

            for (const detectedAction of aiResponse.detected_actions) {
                const actionName = detectedAction.action || detectedAction.action_type;
                if (mutatingActions.has(actionName)) {
                    contextWasMutated = true;
                }
                const ownerOnlyActions = ['CREATE_FINANCIAL_ACCOUNT', 'UPDATE_FINANCIAL_ACCOUNT', 'DELETE_FINANCIAL_ACCOUNT', 'GRANT_ACCESS', 'LIST_GRANTED_ACCESS', 'UPDATE_GRANTED_ACCESS', 'REVOKE_ACCESS', 'CREATE_FINANCIAL_CATEGORY', 'UPDATE_FINANCIAL_CATEGORY', 'DELETE_FINANCIAL_CATEGORY', 'GET_AFFILIATE_DASHBOARD', 'CREATE_MOTIVATIONAL_PHRASE', 'UPDATE_MOTIVATIONAL_PHRASE', 'DELETE_MOTIVATIONAL_PHRASE'];
                if (ownerOnlyActions.includes(actionName) && !isOwnerActingOnOwnBehalfGlobal) {
                    multipleActionBodiesList.push(`❌ Desculpe, ${state.clientName}, mas a ação de "${actionName.toLowerCase().replace(/_/g, " ")}" só pode ser realizada pelo proprietário da conta.`);
                    continue;
                }
                mainActionResult = await actionHandler.handleAction(state, detectedAction, state.clientName, isOwnerActingOnOwnBehalfGlobal, actorClient.id);

                // =================================================================
                // === INÍCIO DA CORREÇÃO: VERIFICAÇÃO DE ERRO PARA INTERRUPÇÃO ===
                // =================================================================
                if (mainActionResult && mainActionResult.formattedData && mainActionResult.formattedData.trim().startsWith('❌')) {
                    logger.warn(`[WHATSAPP SERVICE] Erro retornado pelo Action Handler: "${mainActionResult.formattedData}". Interrompendo fluxo para ${senderPhone}.`);
                    await sendWhatsappMessage(senderPhone, mainActionResult.formattedData, { immediate: true });
                    return; // Interrompe a execução aqui para não enviar mais nada.
                }
                // =================================================================
                // === FIM DA CORREÇÃO: VERIFICAÇÃO DE ERRO PARA INTERRUPÇÃO ===
                // =================================================================

                if (mainActionResult && mainActionResult.resourceForButtonsContext?.id === 'start_schedule_update_flow') {
                    logger.info(`[MAESTRO] Iniciando fluxo de atualização de horário para ${senderPhone}.`);
                    const scheduleResult = await scheduleHandler.handleScheduleUpdate(state, messageText, actorClient);
                    state = scheduleResult.updatedState;
                    conversationState.set(senderPhone, state);
                    return;
                }

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
                    appContextCache.del(cacheKey);
                    appContextCache.del(`context:${newAccount.id}`);
                    logger.info(`[CACHE] Cache invalidado devido à troca de conta para ID ${newAccount.id}.`);
                }
            }

            if (contextWasMutated && mainActionResult.resourceForButtonsContext?.id !== 'account_switched') {
                appContextCache.del(cacheKey);
                logger.info(`[CACHE] Cache para conta ${state.activeFinancialAccountId} invalidado devido a uma ação de mutação.`);
            }

            if (state.pendingChainedAction && mainActionResult) {
                // (código existente para ações encadeadas)
            }

            let aiMessageIntro = aiResponse.overall_summary_suggestion || "";

            // ==================================================================================
            // === INÍCIO DA CORREÇÃO: LÓGICA DE FALLBACK PARA MENSAGEM DE SUCESSO COMPLETA ===
            // ==================================================================================
            // Se a sugestão da IA for muito curta ou genérica, criamos uma introdução padrão.
            if (aiMessageIntro.trim().length < 25 || aiMessageIntro.toLowerCase().startsWith(`ok, ${state.clientName.toLowerCase()}`)) {
                const actionName = aiResponse.detected_actions[0]?.action || 'Ação';
                // Mapeia nomes de ação para frases mais amigáveis
                const friendlyActionNames = {
                    'SCHEDULE_APPOINTMENT': 'Seu compromisso foi agendado',
                    'CREATE_FINANCIAL_TRANSACTION': 'Sua transação foi registrada',
                    'CREATE_RECURRING_RULE': 'Sua nova regra de recorrência foi criada',
                    'CREATE_PARCELLED_ACCOUNT': 'Sua compra parcelada foi registrada',
                    'CREATE_PRODUCT': 'Seu produto foi cadastrado',
                    'CREATE_CREDIT_CARD': 'Seu novo cartão foi criado',
                    'UPDATE_FINANCIAL_TRANSACTION': 'Sua transação foi atualizada',
                    'UPDATE_APPOINTMENT': 'Seu compromisso foi atualizado',
                };
                const friendlyName = friendlyActionNames[actionName] || 'Sua solicitação foi processada';

                aiMessageIntro = `Prontinho, ${state.clientName}! ✅ ${friendlyName} com sucesso. Dá uma olhada no resumo:`;
            }
            // ================================================================================
            // === FIM DA CORREÇÃO: LÓGICA DE FALLBACK PARA MENSAGEM DE SUCESSO COMPLETA ===
            // ================================================================================

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
                    await sendButtonListMessage(senderPhone, finalMessageToSend, buttons, "Opções:", "Ver Opções", { immediate: true });
                } else if (resourcesForButtons.length === 1) {
                    const singleResource = resourcesForButtons[0];
                    const buttons = [
                        { id: `edit:${singleResource.type}:${singleResource.id}`, label: '✏️ Editar' },
                        { id: `delete:${singleResource.type}:${singleResource.id}`, label: '🗑️ Excluir' }
                    ];
                    if (singleResource.type === 'credit_card') {
                        buttons.push({ id: `details:${singleResource.type}:${singleResource.id}`, label: 'Ver Fatura/Detalhes' });
                    }
                    await sendButtonListMessage(senderPhone, finalMessageToSend, buttons, "Opções:", "Ver Opções", { immediate: true });
                } else {
                    await sendWhatsappMessage(senderPhone, finalMessageToSend, { immediate: true });
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
            await sendWhatsappMessage(senderPhone, finalMessageToSend, { immediate: true });

        } else {
            state.pendingConfirmation = null;
            state.currentAction = null;
            finalMessageToSend = aiResponse.reply_to_user_suggestion || `Olá, ${state.clientName}! Como posso te ajudar hoje?`;
            state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });
            await sendWhatsappMessage(senderPhone, finalMessageToSend, { immediate: true });
        }

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0, 1000) });
        const errorMsg = `Puxa vida, ${state?.clientName || 'você'}! 😬 Tive um curto-circuito aqui... Minha equipe já foi notificada. Tente novamente em um instante.`;
        await sendWhatsappMessage(senderPhone, errorMsg, { immediate: true });
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
    formatAppointmentDataStructure: formatter.formatAppointmentDataStructure,
    initializeOrUpdateState,
    conversationState
};
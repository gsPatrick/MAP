// src/features/WhatsappHandler/whatsapp.service.js
// VERSÃO FINAL REATORADA - O MAESTRO (COMPLETO)

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
            // Se ownerClient não veio no include, buscar manualmente
            const ownerClientTemp = await clientService.getClientContactById(ownerClientIdForContext);
             if(ownerClientTemp) {
                ownerClientForContext = ownerClientTemp;
                ownerClientNameForContext = ownerClientTemp.name ? ownerClientTemp.name.split(" ")[0] : "Dono(a) da Conta";
            } else {
                 logger.error(`[InitializeState] CRITICAL: Dono da conta ${ownerClientIdForContext} não encontrado para acesso compartilhado.`);
                ownerClientNameForContext = "Dono(a) da Conta";
                // Criar um objeto mock para ownerClientForContext para evitar erros de null reference mais tarde
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

    // Determina se o dono da conta (ou o próprio cliente, se não for shared access) tem acesso pago
    if (ownerClientForContext.accessLevel && ownerClientForContext.accessLevel !== 'gratuito') {
        if (ownerClientForContext.accessLevel.startsWith('vitalicio_')) {
            hasPaidAccess = true;
            accessLevelTextForUser = formatter.formatPlanName(ownerClientForContext.accessLevel);
        } else if (ownerClientForContext.accessExpiresAt) {
            const expiryDate = new Date(ownerClientForContext.accessExpiresAt + 'T00:00:00Z'); // Garante UTC
            const today = new Date(); today.setUTCHours(0, 0, 0, 0); // Garante UTC para comparação
            if (expiryDate >= today) {
                hasPaidAccess = true;
                const planNamePart = formatter.formatPlanName(ownerClientForContext.accessLevel);
                accessLevelTextForUser = `${planNamePart} (válido até ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
            } else {
                // Plano expirou
                const planNamePart = formatter.formatPlanName(ownerClientForContext.accessLevel);
                accessLevelTextForUser = `Plano ${planNamePart} expirado`;
                clientAccessLevel = 'gratuito'; // Reverte para gratuito se expirado
            }
        } else {
            logger.warn(`[WHATSAPP SERVICE - Initialize/UpdateState] Cliente DONO ${ownerClientForContext.id} com accessLevel ${ownerClientForContext.accessLevel} mas sem accessExpiresAt. Considerando como sem plano pago.`);
            clientAccessLevel = 'gratuito';
        }
    }

    // Define quais contas estão disponíveis para operação, dependendo do contexto
    const accountsForOperation = isSharedAccessContext ? ownerAccountsIfShared : clientAccountsFromDb;

    // Lógica de transição do onboardingStage
    if (hasPaidAccess) {
        // Se tem acesso pago e o onboarding estava aguardando plano OU
        // se o estado de acesso pago mudou desde a última vez que o estágio foi setado
        if (onboardingStage === 'awaiting_plan_confirmation' || (existingState && !existingState.hasPaidAccess_whenStageLastSet) ) {
            if (!client.email || !client.passwordHash) { // Se o ATOR não tem credenciais
                onboardingStage = 'setting_up_credentials_email';
            } else { // ATOR tem credenciais
                if (!isSharedAccessContext) { // Se o ATOR é o DONO
                    const hasPfActor = accountsForOperation.some(acc => acc.accountType === 'PF');
                    if (!hasPfActor) {
                         onboardingStage = 'setting_up_pf_account_name';
                    } else { // Tem PF, verificar se precisa de PJ/MEI
                         const hasPjMeiActor = accountsForOperation.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                         const planTier = clientAccessLevel.startsWith('avancado') || clientAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                         if (planTier === 'avancado' && !hasPjMeiActor &&
                             existingState?.data?.onboardingStage !== 'confirming_pj_mei_setup' && // Evita resetar se já estiver nesse fluxo
                             existingState?.data?.onboardingStage !== 'awaiting_pj_mei_type' &&
                             existingState?.data?.onboardingStage !== 'creating_pj_mei_account_name') {
                            onboardingStage = 'confirming_pj_mei_setup';
                         } else { // Já tem PF, e ou não precisa de PJ/MEI ou já tem
                            onboardingStage = 'onboarding_complete';
                         }
                    }
                } else { // Se é Shared Access e o ATOR (convidado) tem credenciais, onboarding está completo para ele
                    onboardingStage = 'onboarding_complete';
                }
            }
        }
    } else { // Se NÃO tem acesso pago
        onboardingStage = 'awaiting_plan_confirmation';
    }

    // Define a conta financeira ativa padrão
    let defaultAccount = null;
    if (onboardingStage === 'onboarding_complete' && hasPaidAccess && accountsForOperation.length > 0) {
        defaultAccount = accountsForOperation.find(a=>a.isDefault);
        if (!defaultAccount && accountsForOperation.length === 1) {
            defaultAccount = accountsForOperation[0];
        } else if (!defaultAccount) {
            // Prioriza PF, depois PJ, depois MEI, ou a primeira da lista como fallback
            defaultAccount = accountsForOperation.find(a => a.accountType === 'PF') ||
                             accountsForOperation.find(a => a.accountType === 'PJ') ||
                             accountsForOperation.find(a => a.accountType === 'MEI') ||
                             accountsForOperation[0];
        }
    }

    // Atualiza o estado existente ou cria um novo
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
            existingState.currentAction = null; // Reseta a ação se o estágio de onboarding mudou (exceto para completo)
        }
        existingState.data.onboardingStage = onboardingStage;
        existingState.hasPaidAccess_whenStageLastSet = hasPaidAccess; // Atualiza se o status do plano mudou desde a última vez

        // >>> ADICIONADO: Garantir que pendingSystemPrompt exista <<<
        if (existingState.pendingSystemPrompt === undefined) {
            existingState.pendingSystemPrompt = null;
        }

        // Lógica para atualizar a conta ativa se necessário
        if (onboardingStage === 'onboarding_complete' && hasPaidAccess) {
            const currentActiveStillValid = existingState.activeFinancialAccountId && accountsForOperation.some(acc => acc.id === existingState.activeFinancialAccountId);
            if (!currentActiveStillValid && defaultAccount) {
                existingState.activeFinancialAccountId = defaultAccount.id;
                existingState.activeFinancialAccountName = defaultAccount.accountName || defaultAccount.name;
                existingState.activeFinancialAccountType = defaultAccount.accountType || defaultAccount.type;
            } else if (!currentActiveStillValid && accountsForOperation.length > 0) { // Tem contas, mas a ativa não é mais válida/não tem default
                existingState.activeFinancialAccountId = null; // Força seleção
                existingState.activeFinancialAccountName = null;
                existingState.activeFinancialAccountType = null;
            } else if (!currentActiveStillValid && accountsForOperation.length === 0) { // Nenhuma conta acessível
                existingState.activeFinancialAccountId = null;
                existingState.activeFinancialAccountName = null;
                existingState.activeFinancialAccountType = null;
            }
        } else { // Se não está no onboarding completo ou não tem acesso pago, não define conta ativa
            existingState.activeFinancialAccountId = null;
            existingState.activeFinancialAccountName = null;
            existingState.activeFinancialAccountType = null;
        }
        logger.debug(`[WHATSAPP SERVICE - UpdateState] Estado atualizado para ator ${client.id}: `, {
            onboardingStage: existingState.data.onboardingStage, currentAction: existingState.currentAction,
            hasPaidAccessDono: existingState.hasPaidAccess, activeAccountId: existingState.activeFinancialAccountId,
            isShared: existingState.isSharedAccessContext, ownerIdCtx: existingState.ownerClientIdForContext,
            pendingSystemPrompt: !!existingState.pendingSystemPrompt
        });
        return existingState;
    }

    // Cria um novo estado
    const newState = {
        currentAction: null,
        data: { onboardingStage }, // 'data' é um objeto para futuras expansões do onboarding
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? (defaultAccount.accountName || defaultAccount.name) : null,
        activeFinancialAccountType: defaultAccount ? (defaultAccount.accountType || defaultAccount.type) : null,
        clientName: clientName,
        ownerClientIdForContext: ownerClientIdForContext,
        ownerClientNameForContext: ownerClientNameForContext,
        isSharedAccessContext: isSharedAccessContext,
        sharedAccessPermissions: sharedAccessPermissions,
        messageHistory: [],
        pendingConfirmation: null, // Para confirmações multi-etapa da IA ou do sistema
        editingResource: null,     // Para quando o usuário clica em "Editar"
        lastAiResponse: null,      // Para debug ou lógica de fallback
        currentAccessLevel: clientAccessLevel,
        accessExpiresAt: clientAccessExpiresAt,
        hasPaidAccess: hasPaidAccess, // Se o dono da conta (ou o próprio cliente) tem acesso pago
        accessLevelTextForUser: accessLevelTextForUser, // Texto formatado do plano para o usuário
        hasPaidAccess_whenStageLastSet: hasPaidAccess, // Usado para reavaliar onboarding se o plano mudar
        pendingSystemPrompt: null, // >>> ADICIONADO: Para notificações com botões <<<
    };
    logger.debug(`[WHATSAPP SERVICE - InitializeState] Novo estado criado para ator ${client.id}: `, {
        onboardingStage: newState.data.onboardingStage, hasPaidAccessDono: newState.hasPaidAccess,
        activeAccountId: newState.activeFinancialAccountId, isShared: newState.isSharedAccessContext,
        pendingSystemPrompt: !!newState.pendingSystemPrompt
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

    // Define globalmente para uso em initializeOrUpdateState se for um novo cliente
    pushNameFromPayload = pushName; 
    
    // Tenta inferir o nome do arquivo e extensão do mimeType ou URL
    let filenameFromMime = 'audio.ogg'; // Default
    if (mimeType) { // Prioriza mimeType se disponível
        if (mimeType.includes('opus')) filenameFromMime = 'audio.opus';
        else if (mimeType.includes('aac')) filenameFromMime = 'audio.aac';
        else if (mimeType.includes('mpeg')) filenameFromMime = 'audio.mp3';
        else if (mimeType.includes('amr')) filenameFromMime = 'audio.amr';
        // Adicionar outros mapeamentos conforme necessário
    }
    // Se o mimeType não deu um nome bom, tenta extrair da URL
     try {
        const urlPath = new URL(mediaUrl).pathname;
        const baseName = path.basename(urlPath);
        if (baseName && baseName.includes('.')) { // Se tem um nome com extensão na URL
             filenameFromMime = baseName; // Sobrescreve o inferido pelo mimeType se a URL for mais específica
        }
    } catch (e) { // new URL() pode falhar se a URL for malformada
        logger.warn(`[WHATSAPP SERVICE] Não foi possível parsear a URL para extrair nome do arquivo da mídia: ${mediaUrl}. Usando nome inferido: ${filenameFromMime}`);
    }

    try {
        const processingMessage = `🎧 Opa, ${pushName || 'você'}! Já recebi seu áudio e tô aqui processando tudinho com carinho! 💻✨\nSó um segundinho 😉`;
        await sendWhatsappMessage(canonicalPhone, processingMessage);

        const downloadedMedia = await downloadZapiMedia(mediaUrl); // Seu serviço de download
        
        if (downloadedMedia && downloadedMedia.stream) {
            // Escolhe o nome de arquivo mais apropriado para o Whisper
            const finalFilenameForWhisper = downloadedMedia.filename && downloadedMedia.filename.includes('.')
                ? downloadedMedia.filename // Se o download já sugeriu um nome com extensão
                : filenameFromMime;       // Caso contrário, usa o inferido

            logger.info(`[WHATSAPP SERVICE] Áudio baixado, enviando para transcrição com nome de arquivo: ${finalFilenameForWhisper}`);
            const transcribedText = await aiModelService.transcribeAudioStream(downloadedMedia.stream, finalFilenameForWhisper);

            if (transcribedText && transcribedText.trim() !== "") {
                logger.info(`[WHATSAPP SERVICE] Áudio de ${canonicalPhone} transcrito com sucesso. Chamando processIncomingMessage com o texto.`);
                // Chama a função principal de processamento com o texto transcrito
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
        pushNameFromPayload = null; // Limpa a variável global
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
    if (!pushNameFromPayload && pushName) { // Se não veio de processIncomingAudioMessage
        pushNameFromPayload = pushName;
    }

    const startTime = Date.now();
    let state;
    let actorClient; // Cliente que está interagindo (pode ser o dono ou um convidado)

    try {
        // ETAPA 1: Obter Cliente e Estado da Sessão
        actorClient = await clientService.findClientByPhone(senderPhone);
        
        let sharedAccessRecord = null;
        let clientAccountsForOnboarding = []; // Contas do próprio actorClient (se ele for o dono)
        let ownerAccountsIfShared = [];     // Contas do dono, filtradas pelas permissões do sharedAccess

        if (actorClient) {
            // Se encontramos o actorClient pelo telefone, ele é o dono (ou um usuário direto)
            clientAccountsForOnboarding = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
        } else {
            // Se não encontramos pelo telefone, pode ser um sharedAccess com telefone específico
            sharedAccessRecord = await sharedAccessService.findActiveSharedAccessByPhone(senderPhone);
            if (sharedAccessRecord && sharedAccessRecord.sharedWithClient) {
                actorClient = sharedAccessRecord.sharedWithClient; // O ator é o convidado
                const ownerClientIdForContext = sharedAccessRecord.ownerClientId;
                
                // Validar status do convidado e do proprietário
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
                
                // ownerAccountsIfShared já vem populado pelo include no findActiveSharedAccessByPhone
                ownerAccountsIfShared = sharedAccessRecord.ownerClient.financialAccounts || [];
                // Filtra pelas permissões do sharedAccess e se a conta do dono está ativa
                ownerAccountsIfShared = ownerAccountsIfShared.filter(acc => {
                    if (acc.accountType === 'PF') return sharedAccessRecord.canAccessPersonalProfile && acc.isActive;
                    if (acc.accountType === 'PJ' || acc.accountType === 'MEI') return sharedAccessRecord.canAccessBusinessProfileId === acc.id && acc.isActive;
                    return false;
                });


                if (ownerAccountsIfShared.length === 0 ) { // Nenhuma conta acessível para o convidado
                    if(sharedAccessRecord.canAccessPersonalProfile || sharedAccessRecord.canAccessBusinessProfileId){
                        // Tinha permissão, mas o dono não tem contas daquele tipo ou estão inativas
                        logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas nenhuma conta do dono acessível encontrada (mesmo com permissões). Proprietário pode não ter contas do tipo permitido ou estão inativas.`);
                        await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado para as contas de ${sharedAccessRecord.ownerClient?.name || 'um usuário'}, mas parece que o proprietário não possui contas ativas do tipo que você pode acessar (Pessoal ou o Empresarial específico). Peça para ele verificar, por favor! 😉`);
                    } else {
                        // Nenhuma permissão foi dada no sharedAccess
                        logger.warn(`[WHATSAPP SERVICE] Acesso compartilhado para ${actorClient.name} (${senderPhone}) para contas de ${ownerClientIdForContext}, mas NENHUMA permissão de acesso a perfil foi dada no sharedAccessRecord.`);
                        await sendWhatsappMessage(senderPhone, `Olá ${actorClient.name.split(" ")[0]}! Você tem um acesso compartilhado para as contas de ${sharedAccessRecord.ownerClient?.name || 'um usuário'}, mas parece que nenhuma permissão para acessar perfis específicos (Pessoal ou Empresarial) foi configurada. Peça para ele verificar as permissões, por favor! 😉`);
                    }
                    return;
                }

            } else {
                // Se não é cliente direto nem shared access, é um novo usuário
                logger.info(`[WHATSAPP SERVICE] Telefone ${senderPhone} não reconhecido. Criando novo cliente...`);
                actorClient = await clientService.createClientContact({ phone: senderPhone, name: pushNameFromPayload || pushName });
                const welcomeMsg = onboardingHandler.getOnboardingWelcomeNoPlanMessage(actorClient.name ? actorClient.name.split(" ")[0] : (pushNameFromPayload || "você"));
                await sendWhatsappMessage(senderPhone, welcomeMsg);
                // Cria um estado temporário para o novo usuário
                const tempStateForNewUser = await initializeOrUpdateState(actorClient, null, null, [], []);
                tempStateForNewUser.data.onboardingStage = 'awaiting_plan_confirmation';
                tempStateForNewUser.currentAction = 'awaiting_plan_interest_generic';
                conversationState.set(senderPhone, tempStateForNewUser);
                pushNameFromPayload = null;
                return;
            }
        }
        
        // Recupera ou inicializa o estado da conversa
        const existingState = conversationState.get(senderPhone);
        state = await initializeOrUpdateState(actorClient, sharedAccessRecord, existingState, clientAccountsForOnboarding, ownerAccountsIfShared);
        state.isNewUserForSessionLogic = !existingState; // Flag para lógica de primeira mensagem da sessão

        // --- INÍCIO DA LÓGICA DE `pendingSystemPrompt` ---
        if (state.pendingSystemPrompt && messageText) {
            const lowerMessage = messageText.toLowerCase().trim();
            const promptContext = state.pendingSystemPrompt;
            let actionToSimulate = null;
            let simulatedActionParams = {};

            // Mapeia respostas textuais para ações simuladas
            if (promptContext.expectedActionPrefix === 'appointment_pj_confirm_cancel') {
                if (lowerMessage === 'sim' || lowerMessage === 's' || lowerMessage.includes('confirmo') || lowerMessage.includes('aceito')) {
                    actionToSimulate = 'CONFIRM_APPOINTMENT';
                    simulatedActionParams = { appointmentId: promptContext.relatedResourceId };
                } else if (lowerMessage === 'não' || lowerMessage === 'nao' || lowerMessage.includes('cancela') || lowerMessage.includes('rejeito')) {
                    actionToSimulate = 'CANCEL_APPOINTMENT'; // Ação de cancelar, não deletar
                    simulatedActionParams = { appointmentId: promptContext.relatedResourceId };
                }
            }
            // Adicionar outros 'else if (promptContext.expectedActionPrefix === ...)' para outros tipos de notificações

            if (actionToSimulate) {
                logger.info(`[WHATSAPP SERVICE] Resposta direta "${messageText}" para pendingSystemPrompt (Recurso ID: ${promptContext.relatedResourceId}). Simulando ação ${actionToSimulate} na conta ${promptContext.targetAccountId}.`);
                
                // Guarda o contexto ativo original
                const originalActiveAccountId = state.activeFinancialAccountId;
                const originalActiveAccountName = state.activeFinancialAccountName;
                const originalActiveAccountType = state.activeFinancialAccountType;

                // Define temporariamente o contexto para a conta alvo da notificação
                const targetAccountDetails = await clientService.getFinancialAccountById(promptContext.targetAccountId);
                if (!targetAccountDetails) {
                    logger.error(`[WHATSAPP SERVICE] Conta alvo ${promptContext.targetAccountId} do pendingSystemPrompt não encontrada.`);
                    await sendWhatsappMessage(senderPhone, "Ops! Não encontrei a conta relacionada a essa notificação. Por favor, contate o suporte.");
                    state.pendingSystemPrompt = null; // Limpa para evitar loop
                    conversationState.set(senderPhone, state);
                    return;
                }

                state.activeFinancialAccountId = promptContext.targetAccountId;
                state.activeFinancialAccountName = targetAccountDetails.accountName;
                state.activeFinancialAccountType = targetAccountDetails.accountType;
                
                try {
                    const simulatedAction = {
                        action: actionToSimulate,
                        parameters: simulatedActionParams
                    };
                    // O actorClient.id aqui é o ID do usuário que está respondendo (dono da conta PJ)
                    // A flag isOwnerActingOnOwnBehalfGlobal deve ser true pois estamos agindo na conta do dono.
                    const result = await actionHandler.handleAction(state, simulatedAction, state.clientName, true, actorClient.id);
                    
                    if (result.formattedData) {
                        await sendWhatsappMessage(senderPhone, result.formattedData);
                        state.messageHistory.push({ role: 'user', content: messageText });
                        state.messageHistory.push({ role: 'assistant', content: result.formattedData });
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP SERVICE] Erro ao processar resposta direta para pendingSystemPrompt: ${e.message}`);
                    await sendWhatsappMessage(senderPhone, `Ops, tive um problema ao processar sua resposta: ${e.message}. Tente novamente ou use os botões, se disponíveis.`);
                } finally {
                    // Restaura o estado da conta ativa original
                    state.activeFinancialAccountId = originalActiveAccountId;
                    state.activeFinancialAccountName = originalActiveAccountName;
                    state.activeFinancialAccountType = originalActiveAccountType;
                    state.pendingSystemPrompt = null; // Limpa o prompt após tentativa
                    state.currentAction = null; // Limpa qualquer ação pendente da IA
                    conversationState.set(senderPhone, state);
                }
                return; // Finaliza o processamento desta mensagem
            }
        }
        // --- FIM DA LÓGICA DE `pendingSystemPrompt` ---


        // ETAPA 1.5: Tratamento de Comandos Diretos (Botões)
        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[MAESTRO] Botão clicado por ${senderPhone}: ID '${buttonId}'`);

            const parts = buttonId.split(':');
            let targetAccountIdForButton = null;
            let effectiveButtonIdForHandler = buttonId; // ID que será passado para o handler

            // Tenta extrair targetAccountId do ID do botão. Formatos comuns:
            // action:TARGET_ACCOUNT_ID:resourceType:RESOURCE_ID
            // action:TARGET_ACCOUNT_ID:RESOURCE_ID
            if (parts.length >= 3 && !isNaN(parseInt(parts[1], 10))) {
                targetAccountIdForButton = parseInt(parts[1], 10);
                // Ajusta o ID do botão para o formato que o handler espera, se necessário
                if (parts.length === 3) { // action:ACCOUNT_ID:RESOURCE_ID
                    effectiveButtonIdForHandler = `${parts[0]}:${parts[2]}`;
                } else if (parts.length === 4) { // action:ACCOUNT_ID:resourceType:RESOURCE_ID
                     effectiveButtonIdForHandler = `${parts[0]}:${parts[2]}:${parts[3]}`;
                }
                // Adicionar mais lógicas de parse para outros formatos de ID de botão se existirem.
            }

            let stateForButtonAction = { ...state }; // Cria uma cópia para modificação temporária
            if (targetAccountIdForButton && targetAccountIdForButton !== state.activeFinancialAccountId) {
                logger.info(`[WHATSAPP SERVICE] Clique de botão para conta ${targetAccountIdForButton}, mas conta ativa é ${state.activeFinancialAccountId}. Tentando usar conta do botão temporariamente.`);
                const targetAccountDetails = await clientService.getFinancialAccountById(targetAccountIdForButton);
                
                // Verifica se o ator tem permissão para agir na conta alvo do botão
                let hasPermissionForTargetAccount = false;
                if (targetAccountDetails) {
                    if (actorClient.id === targetAccountDetails.clientId) { // Dono da conta
                        hasPermissionForTargetAccount = true;
                    } else if (state.isSharedAccessContext && state.ownerClientIdForContext === targetAccountDetails.clientId) {
                        // Convidado tentando agir na conta do dono, verificar permissões do sharedAccess
                        if (targetAccountDetails.accountType === 'PF' && state.sharedAccessPermissions.canAccessPersonalProfile) {
                            hasPermissionForTargetAccount = true;
                        } else if ((targetAccountDetails.accountType === 'PJ' || targetAccountDetails.accountType === 'MEI') && state.sharedAccessPermissions.canAccessBusinessProfileId === targetAccountDetails.id) {
                            hasPermissionForTargetAccount = true;
                        }
                    }
                }

                if (targetAccountDetails && hasPermissionForTargetAccount) {
                    stateForButtonAction.activeFinancialAccountId = targetAccountIdForButton;
                    stateForButtonAction.activeFinancialAccountName = targetAccountDetails.accountName;
                    stateForButtonAction.activeFinancialAccountType = targetAccountDetails.accountType;
                    logger.info(`[WHATSAPP SERVICE] Contexto temporariamente mudado para conta ${targetAccountIdForButton} para ação de botão.`);
                } else {
                     logger.error(`[WHATSAPP SERVICE] Conta alvo ${targetAccountIdForButton} do botão não encontrada ou usuário ${actorClient.id} não tem permissão. Usando conta ativa padrão ${state.activeFinancialAccountId}.`);
                     // Mantém stateForButtonAction como o estado original se não houver permissão ou a conta não for encontrada
                }
            }

            const buttonResult = await actionHandler.handleButtonInteraction(stateForButtonAction, effectiveButtonIdForHandler, senderPhone);

            if (buttonResult.stateUpdated) {
                // Se o estado foi atualizado (ex: entrou em modo de edição), salve o estado que foi passado para o handler.
                conversationState.set(senderPhone, buttonResult.newState);
                return; 
            }
            if (buttonResult.flowCompleted) {
                // Se o clique no botão resolveu um pendingSystemPrompt, limpa-o
                if (state.pendingSystemPrompt && buttonId.includes(state.pendingSystemPrompt.relatedResourceId?.toString())) {
                    state.pendingSystemPrompt = null;
                }
                conversationState.set(senderPhone, state); // Salva o estado com o prompt limpo, se aplicável
                return;
            }
            if (buttonResult.repromptWith) {
                logger.info(`[MAESTRO] Reprocessando clique de botão como nova mensagem: "${buttonResult.repromptWith}"`);
                // Se o clique no botão resolveu um pendingSystemPrompt, limpa-o antes de reprocessar
                if (state.pendingSystemPrompt && buttonId.includes(state.pendingSystemPrompt.relatedResourceId?.toString())) {
                    state.pendingSystemPrompt = null;
                }
                // Para o reprompt, usamos o estado que foi potencialmente modificado (stateForButtonAction)
                // porque a IA precisa do contexto correto da conta se a ação do botão mudou o contexto.
                // O estado global (state) será atualizado no final desta chamada recursiva de processIncomingMessage.
                conversationState.set(senderPhone, stateForButtonAction); // Salva o estado modificado ANTES da chamada recursiva
                return await processIncomingMessage(senderPhone, buttonResult.repromptWith, pushName, rawPayload);
            } else {
                // Se o clique no botão resolveu um pendingSystemPrompt, limpa-o
                if (state.pendingSystemPrompt && buttonId.includes(state.pendingSystemPrompt.relatedResourceId?.toString())) {
                    state.pendingSystemPrompt = null;
                }
                conversationState.set(senderPhone, state);
                return; // Fluxo não alterado significativamente, mas estado pode ter sido limpo
            }
        }

        // Adicionar mensagem ao histórico (se não for clique de botão já tratado que levou a um reprompt)
        if (!(rawPayload && rawPayload.selectedButtonId && (await actionHandler.handleButtonInteraction(state, rawPayload.selectedButtonId, senderPhone)).repromptWith )) {
            state.messageHistory.push({ role: 'user', content: messageText || "" }); 
            if (state.messageHistory.length > MAX_STATE_HISTORY) {
                state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
            }
        }


        // ETAPA 2: Delegar para o Handler de Onboarding, se aplicável
        if (state.data.onboardingStage !== 'onboarding_complete') {
            const onboardingResult = await onboardingHandler.handleOnboardingStep(state, messageText, actorClient);
            state = onboardingResult.updatedState;
            actorClient = onboardingResult.updatedActorClient; // Atualiza actorClient se o nome mudou no onboarding
            if (onboardingResult.onboardingReply) {
                state.messageHistory.push({ role: 'assistant', content: onboardingResult.onboardingReply });
                await sendWhatsappMessage(senderPhone, onboardingResult.onboardingReply);
            }
            conversationState.set(senderPhone, state);
            pushNameFromPayload = null;
            return;
        }

        // ETAPA 2.5: Tratamento de Respostas a Perguntas Diretas do Bot (MODO COPILOTO da IA ou Confirmações)
        if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
            const pendingActionData = state.pendingConfirmation; // Renomeado para evitar conflito com nome da action
            
            // Exemplo para exclusão de múltiplos itens de um bloco de ações
            if (pendingActionData.action === 'AWAITING_DELETION_CHOICE') {
                const userChoiceText = messageText.toLowerCase();
                let itemDeleted = false;
                let deletionMessage = "";

                if (userChoiceText.includes('todos')) {
                    let deletedCount = 0;
                    for (const resource of pendingActionData.resources) {
                        try {
                            // Adicionar lógica para cada tipo de recurso que pode ser excluído em bloco
                            if (resource.type === 'transaction') { 
                                await financialService.deleteTransaction(state.activeFinancialAccountId, resource.id);
                                deletedCount++;
                            }
                            // Adicionar outros tipos: product, appointment, etc.
                        } catch (e) { logger.error(`[DELETION ALL] Erro ao deletar item ${resource.id} do tipo ${resource.type}: ${e.message}`); }
                    }
                    deletionMessage = `✅ Prontinho! ${deletedCount} de ${pendingActionData.resources.length} itens foram excluídos.`;
                    itemDeleted = true;
                } else {
                    // Tenta encontrar o recurso pela descrição
                    const userWords = userChoiceText.split(' ').filter(word => word.length > 1); // Ignora palavras pequenas
                    const resourceToDelete = pendingActionData.resources.find(r => {
                        const resourceWords = r.description.toLowerCase().split(' ');
                        return userWords.every(userWord => resourceWords.includes(userWord)); // Todas as palavras do usuário devem estar na descrição
                    });                    
                    if (resourceToDelete) {
                        try {
                            // Adicionar lógica para cada tipo de recurso
                            if (resourceToDelete.type === 'transaction') { 
                                await financialService.deleteTransaction(state.activeFinancialAccountId, resourceToDelete.id);
                            }
                             // Adicionar outros tipos: product, appointment, etc.
                            deletionMessage = `✅ Item "${resourceToDelete.description}" excluído com sucesso!`;
                            itemDeleted = true;
                        } catch (e) {
                            deletionMessage = `❌ Ops, tive um problema ao tentar excluir "${resourceToDelete.description}". Detalhe: ${e.message}`;
                        }
                    } else {
                        deletionMessage = `🤔 Humm, não entendi qual item você quer excluir. Por favor, diga o nome exato como aparece na lista ou 'todos'.`;
                    }
                }
                await sendWhatsappMessage(senderPhone, deletionMessage);
                state.messageHistory.push({ role: 'assistant', content: deletionMessage });
                if (itemDeleted) { // Limpa o estado pendente apenas se algo foi efetivamente processado
                    state.pendingConfirmation = null;
                    state.currentAction = null;
                }
                conversationState.set(senderPhone, state);
                return;
            }
             // Adicionar outras lógicas de confirmação aqui (ex: para `CONFIRM_DELETE_FINANCIAL_ACCOUNT`)
            else if (pendingActionData.action === 'CONFIRM_DELETE_FINANCIAL_ACCOUNT') {
                const confirmText = `sim, excluir ${pendingActionData.parameters.accountNameToDelete}`.toLowerCase();
                if(messageText.toLowerCase().trim() === confirmText) {
                    try {
                        await clientService.deleteFinancialAccount(pendingActionData.parameters.accountIdToDelete);
                        await sendWhatsappMessage(senderPhone, `✅ Conta "${pendingActionData.parameters.accountNameToDelete}" excluída com sucesso!`);
                        state.activeFinancialAccountId = null; // Força a re-seleção de conta
                        state.activeFinancialAccountName = null;
                        state.activeFinancialAccountType = null;
                    } catch(deleteError) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao confirmar exclusão da conta ${pendingActionData.parameters.accountIdToDelete}: ${deleteError.message}`);
                        await sendWhatsappMessage(senderPhone, `❌ Ops! Não consegui excluir a conta. Detalhe: ${deleteError.message}`);
                    }
                } else if (messageText.toLowerCase().trim() === 'não' || messageText.toLowerCase().trim() === 'cancelar') {
                    await sendWhatsappMessage(senderPhone, "Ufa! Exclusão cancelada. 😉");
                } else {
                     await sendWhatsappMessage(senderPhone, `Entrada inválida. Para confirmar a exclusão, digite exatamente: "sim, excluir ${pendingActionData.parameters.accountNameToDelete}" ou "não" para cancelar.`);
                     // Mantém o estado de confirmação pendente
                     conversationState.set(senderPhone, state);
                     return;
                }
                state.pendingConfirmation = null;
                state.currentAction = null;
                conversationState.set(senderPhone, state);
                return;
            }
            // Se não for um tipo de confirmação conhecido aqui, deixar a IA tratar
        }
        
        // ETAPA 3: Lógica de Fluxo Pós-Onboarding (Seleção de Conta)
        if (!state.activeFinancialAccountId) {
            const accountsForSelection = state.isSharedAccessContext
                ? ownerAccountsIfShared // Já filtrado por permissão e atividade
                : await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
            
            if (accountsForSelection.length > 0) {
                if (accountsForSelection.length === 1) {
                    // Seleciona automaticamente se só tiver uma conta acessível
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
                    // Múltiplas contas, pede para o usuário escolher
                    const chosenIdentifier = messageText.trim();
                    let accountToSelect = null;
                    if (state.currentAction === 'selecting_account_flow_active') { // Se já está no fluxo de seleção
                        const accountsToList = state.data.accountsToList || accountsForSelection;
                        const chosenNumber = parseInt(chosenIdentifier, 10);
                        if (!isNaN(chosenNumber) && chosenNumber > 0 && chosenNumber <= accountsToList.length) {
                            accountToSelect = accountsToList[chosenNumber - 1];
                        } else {
                            // Tenta encontrar pelo nome
                            accountToSelect = accountsToList.find(acc => 
                                (acc.name || acc.accountName).toLowerCase().includes(chosenIdentifier.toLowerCase()) ||
                                (acc.type || acc.accountType).toLowerCase() === chosenIdentifier.toLowerCase()
                            );
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
                        // Se não escolheu ou a escolha foi inválida, apresenta as opções
                        state.currentAction = 'selecting_account_flow_active';
                        state.data.accountsToList = accountsForSelection.map(a => ({id: a.id, name: a.accountName || a.name, type: a.accountType || a.type})); // Guarda para próxima interação
                        const ownerNameForMsg = state.isSharedAccessContext ? state.ownerClientNameForContext : null;
                        const accountOptionsText = formatter.formatListClientAccountsDataStructure(state.data.accountsToList, null, ownerNameForMsg) + "\n\n🤔 Qual delas vamos usar hoje? Me diga o nome ou o número.";
                        state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                        await sendWhatsappMessage(senderPhone, accountOptionsText);
                    }
                }
            } else {
                 // Nenhuma conta acessível
                 await sendWhatsappMessage(senderPhone, `Olá ${state.clientName}! Parece que não há contas financeiras acessíveis para você no momento. ${state.isSharedAccessContext ? `Peça para ${state.ownerClientNameForContext} verificar as permissões e se as contas estão ativas.` : 'Diga "criar conta pessoal" para começar.'}`);
            }
            conversationState.set(senderPhone, state);
            if (!state.activeFinancialAccountId) { // Se ainda não tem conta ativa, não prossegue para IA
                pushNameFromPayload = null;
                return;
            }
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
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2), // Últimas N interações
            editingResource: state.editingResource,
            availableFinancialCategories: availableFinancialCategoriesForAI,
            availableCreditCards: availableCreditCardsForAI,
            // Se a IA estava aguardando uma clarificação e o usuário respondeu algo que não resolveu,
            // o pendingConfirmation ainda estará aqui para a IA tentar de novo.
            pendingAction: state.currentAction === 'awaiting_clarification_response' ? state.pendingConfirmation : null
        };

        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        state.lastAiResponse = aiResponse; // Guarda a resposta da IA para debug ou lógica futura

        let finalMessageToSend = "";
        let mainActionResult = null; // Para guardar o resultado da ação principal

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            state.pendingConfirmation = null; // Limpa confirmação pendente se IA detectou nova ação
            state.currentAction = null; // Limpa ação atual se IA prosseguiu

            let multipleActionBodiesList = [];
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
                    state.editingResource = null; // Limpa recurso em edição
                }
                if (mainActionResult.resourceForButtonsContext?.id === 'account_switched') {
                    // Se a ação foi uma troca de conta, atualiza o estado
                    const newAccount = mainActionResult.resourceForButtonsContext.data;
                    state.activeFinancialAccountId = newAccount.id;
                    state.activeFinancialAccountName = newAccount.accountName || newAccount.name;
                    state.activeFinancialAccountType = newAccount.accountType || newAccount.type;
                }

                // --- INÍCIO DA LÓGICA DE NOTIFICAÇÃO COM BOTÕES ---
                if (mainActionResult && mainActionResult.resourceForButtonsContext && 
                    mainActionResult.resourceForButtonsContext.type === 'system_action' && 
                    mainActionResult.resourceForButtonsContext.id === 'pending_notification_with_buttons' && // Adicionado id para clareza
                    mainActionResult.resourceForButtonsContext.data?.pendingConfirmationNotification) {
                    
                    const notificationData = mainActionResult.resourceForButtonsContext.data.pendingConfirmationNotification;
                    
                    if (senderPhone === notificationData.recipientPhone) {
                        // O remetente é o destinatário, a mensagem principal JÁ SERÁ a notificação com botões.
                        aiResponse.overall_summary_suggestion = notificationData.messageText.split('\n\n')[0]; // Pega a primeira parte como intro
                        multipleActionBodiesList = [notificationData.messageText.substring(aiResponse.overall_summary_suggestion.length).trim()];
                        // Os botões virão de notificationData.buttons
                        // Setar o pendingSystemPrompt para o próprio remetente
                        state.pendingSystemPrompt = {
                            targetAccountId: notificationData.targetAccountId,
                            expectedActionPrefix: notificationData.expectedActionPrefix,
                            relatedResourceId: notificationData.relatedResourceId,
                        };
                         mainActionResult.resourceForButtonsContext.buttons = notificationData.buttons; // Passa os botões corretos
                    } else {
                        // Enviar notificação separada para outro usuário (o dono da conta PJ)
                        logger.info(`[WHATSAPP SERVICE] Enviando notificação COM BOTÕES separada para ${notificationData.recipientPhone}`);
                        await sendButtonListMessage(
                            notificationData.recipientPhone,
                            notificationData.messageText,
                            notificationData.buttons,
                            "Ações Disponíveis:" // Título da lista de botões
                        );
                        // Setar o pendingSystemPrompt para o destinatário da notificação
                        let recipientState = conversationState.get(notificationData.recipientPhone);
                        if (!recipientState) {
                            const recipientClient = await clientService.findClientByPhone(notificationData.recipientPhone);
                            if (recipientClient) {
                                 recipientState = await initializeOrUpdateState(recipientClient, null, null, [], []);
                            }
                        }
                        if(recipientState) {
                            recipientState.pendingSystemPrompt = {
                                targetAccountId: notificationData.targetAccountId,
                                expectedActionPrefix: notificationData.expectedActionPrefix,
                                relatedResourceId: notificationData.relatedResourceId,
                            };
                            conversationState.set(notificationData.recipientPhone, recipientState);
                        }
                        // A resposta para o senderPhone original não terá esses botões específicos da notificação
                        // Se houver botões de edição/exclusão para o senderPhone, eles virão do fluxo normal de resourceForButtonsContext.resources
                        if (mainActionResult.resourceForButtonsContext.id === 'pending_notification_with_buttons') {
                           mainActionResult.resourceForButtonsContext = null; // Limpa para não tentar enviar botões de notificação para o sender errado
                        }
                    }
                }
               // --- FIM DA LÓGICA DE NOTIFICAÇÃO COM BOTÕES ---
            } // Fim do loop for detectedAction

            // Lógica de ação encadeada (ex: criar cartão e depois lançar gasto nele)
            if (state.pendingChainedAction && mainActionResult) {
                const primaryAction = aiResponse.detected_actions[0]; 
                // Verifica se a ação primária foi a esperada e se temos o recurso criado
                const newResourceFromPrimaryAction = mainActionResult.resourceForButtonsContext?.resources?.[0];
                if (primaryAction.action === 'CREATE_CREDIT_CARD' && newResourceFromPrimaryAction?.type === 'credit_card') {
                    logger.info(`[MAESTRO] Ação principal (Criação de Cartão) concluída. Executando ação encadeada: ${state.pendingChainedAction.action}`);
                    const chainedAction = state.pendingChainedAction;
                    // Preenche o parâmetro que faltava na ação encadeada com o resultado da primária
                    chainedAction.parameters.creditCardName = newResourceFromPrimaryAction.description; 
                    
                    const chainedActionResult = await actionHandler.handleAction(state, chainedAction, state.clientName, isOwnerActingOnOwnBehalfGlobal, actorClient.id);
                    if (chainedActionResult.formattedData) {
                        multipleActionBodiesList.push(chainedActionResult.formattedData);
                    }
                    // Adiciona botões da ação encadeada, se houver
                    if (chainedActionResult.resourceForButtonsContext?.resources) {
                         if (!mainActionResult.resourceForButtonsContext || !mainActionResult.resourceForButtonsContext.resources) { 
                            mainActionResult.resourceForButtonsContext = { type: 'multi_action_block', resources: [] };
                        }
                        mainActionResult.resourceForButtonsContext.resources.push(...chainedActionResult.resourceForButtonsContext.resources);
                    }
                    state.pendingChainedAction = null; // Limpa a ação encadeada após execução
                }
            }

            // Monta a mensagem final
            let aiMessageIntro = aiResponse.overall_summary_suggestion || `Ok, ${state.clientName}!`;
            // Caso especial para ação encadeada de criar cartão e lançar gasto
            if (state.pendingChainedAction === null && aiResponse.detected_actions[0]?.action === 'CREATE_CREDIT_CARD' && multipleActionBodiesList.length > 1) {
                 aiMessageIntro = `Cartão na mão e gasto anotado! ✅ Seu novo cartão foi criado e o gasto original já foi registrado nele. Simples assim!`;
            }

            let structuredDataBody = multipleActionBodiesList.join("\n\n---\n\n");
            finalMessageToSend = aiMessageIntro.trim();
            if (structuredDataBody && structuredDataBody.trim() !== "") {
                finalMessageToSend += `\n\n${structuredDataBody.trim()}`;
            }

            const platformLinkFooter = formatter.formatPlatformLink();
            const platformBaseUrl = process.env.PLATFORM_URL || 'map-nocontrole.com.br/painel';

            // Adiciona link da plataforma, exceto se a mensagem já o contém ou se foi uma troca de conta
            if (!finalMessageToSend.includes(platformBaseUrl) && mainActionResult?.resourceForButtonsContext?.id !== 'account_switched') {
                 finalMessageToSend += `\n\n---\n\n${platformLinkFooter.trim()}`;
            }
            finalMessageToSend = finalMessageToSend.replace(/\n{3,}/g, '\n\n').trim(); // Limpa quebras de linha excessivas

            if (finalMessageToSend) {
                state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });

                const buttonsForMessage = [];
                // Prioriza botões de notificação se houver
                if (mainActionResult?.resourceForButtonsContext?.id === 'pending_notification_with_buttons' && mainActionResult?.resourceForButtonsContext?.buttons) {
                    buttonsForMessage.push(...mainActionResult.resourceForButtonsContext.buttons);
                } 
                // Senão, verifica botões de edição/exclusão
                else if (mainActionResult?.resourceForButtonsContext?.resources) {
                    const resourcesForButtons = mainActionResult.resourceForButtonsContext.resources;
                    const hasMultipleResources = resourcesForButtons.length > 1;

                    if (hasMultipleResources) {
                        // Codifica os múltiplos recursos para o ID do botão
                        const blockId = Buffer.from(JSON.stringify(resourcesForButtons)).toString('base64');
                        buttonsForMessage.push(
                            { id: `edit:multi_action_block:${blockId}`, label: '✏️ Editar este bloco' },
                            { id: `delete:multi_action_block:${blockId}`, label: '🗑️ Excluir algo' }
                        );
                    } else if (resourcesForButtons.length === 1) {
                        const singleResource = resourcesForButtons[0];
                        // O ID do botão deve incluir o targetAccountId para que o contexto seja correto ao clicar
                        // Se a ação foi na activeFinancialAccountId, usa ela.
                        const accountIdForButtonAction = state.activeFinancialAccountId; 
                        const accountIdPrefix = accountIdForButtonAction ? `${accountIdForButtonAction}:` : '';

                        buttonsForMessage.push(
                            { id: `edit:${accountIdPrefix}${singleResource.type}:${singleResource.id}`, label: '✏️ Editar' },
                            { id: `delete:${accountIdPrefix}${singleResource.type}:${singleResource.id}`, label: '🗑️ Excluir' }
                        );
                        // Botão específico para cartão de crédito
                        if (singleResource.type === 'credit_card') {
                            buttonsForMessage.push({ id: `details:${accountIdPrefix}${singleResource.type}:${singleResource.id}`, label: 'Ver Fatura/Detalhes' });
                        }
                    }
                }

                if (buttonsForMessage.length > 0) {
                    await sendButtonListMessage(senderPhone, finalMessageToSend, buttonsForMessage, "Opções Rápidas:");
                } else {
                    await sendWhatsappMessage(senderPhone, finalMessageToSend);
                }
            }

        } else if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            // A IA precisa de mais informações
            const clarification = aiResponse.clarifications_needed[0];
            // Se a clarificação veio de uma tentativa de ação encadeada, guarda o contexto
            if (clarification.parameters_so_far && clarification.parameters_so_far.chained_action_context) {
                logger.info(`[MAESTRO] Ação encadeada detectada para clarificação. Armazenando contexto: ${JSON.stringify(clarification.parameters_so_far.chained_action_context)}`);
                state.pendingChainedAction = clarification.parameters_so_far.chained_action_context;
                // Remove do parameters_so_far para não ser enviado de volta para a IA na próxima rodada se ela ainda pedir clarificação
                delete clarification.parameters_so_far.chained_action_context;
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
            // Nenhuma ação detectada, nenhuma clarificação necessária (conversa geral)
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
            // Limpa o pendingChainedAction se não foi usado e não há mais clarificações pendentes
            if (state.pendingChainedAction && (!state.lastAiResponse?.clarifications_needed || state.lastAiResponse.clarifications_needed.length === 0)) {
                state.pendingChainedAction = null;
            }
            conversationState.set(senderPhone, state);
        }
        pushNameFromPayload = null; // Reset no final de CADA processIncomingMessage
    }
}

module.exports = { 
    processIncomingMessage, 
    processIncomingAudioMessage, 
    // Apenas para manter compatibilidade se algum outro lugar usava isso, mas idealmente o formatter é chamado internamente
    formatAppointmentDataStructure: formatter.formatAppointmentDataStructure 
};
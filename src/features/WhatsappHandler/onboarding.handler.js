// src/features/WhatsappHandler/onboarding.handler.js

const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const logger = require('../../utils/logger');
const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const availabilityService = require('../Availability/availability.service');
const onboardingAIService = require('./onboarding.ai.service');

// ============================================================================
// FUNÇÕES DE FORMATAÇÃO DE MENSAGEM (Templates de Resposta)
// ============================================================================

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

function getOnboardingAskForEmailMessage(clientName) {
    const greeting = clientName ? `Olá, ${clientName}! 👋` : 'Olá! 👋';
    const message = `${greeting} Notei que seu plano já está ativo (que demais!), mas ainda não definimos suas credenciais de acesso para o painel web.\n\n` +
                    `Para começarmos, qual é o seu melhor *e-mail*?`;
    return message;
}

function getOnboardingWelcomeMessage(clientName, hasPaidAccess, isSharedContext, accessLevelTextForUser) {
    if (isSharedContext) {
         return `Olá, ${clientName}! Você está usando um acesso compartilhado. Me diga "oi" novamente para começar a usar a conta do proprietário.`;
    }
    
    if (!hasPaidAccess) {
        const siteUrl = process.env.PLAN_SITE_URL || "https://map-nocontrole.com.br/#planos";
        return `🚀 Olá, ${clientName}! Você ainda está no plano Gratuito ou sua assinatura expirou. Para usar o controle total, acesse: ${siteUrl}`;
    }

    const accessText = accessLevelTextForUser || "seu plano";
    const aiIntro = `🎉 Olá, ${clientName}! Que bom ver você por aqui! Sua assinatura *${accessText}* foi confirmada com sucesso. Agora, vamos deixar tudo 100% pronto para você começar a organizar! 💪✨`;
    
    return aiIntro;
}

function getOnboardingAskForPasswordMessage() {
    const message = `Perfeito, e-mail anotado! ✅\n\n` +
                    `Agora, por favor, crie uma *senha* para seu acesso (ela deve ter no mínimo 6 caracteres).`;
    return message;
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

function getOnboardingAskForPJTypeMessage(clientName) {
    const aiIntro = `👍 Excelente, ${clientName}! Vamos criar sua conta empresarial.`;
    const dataStructure = `Para começar, me diga qual o tipo do seu negócio:`;
    return `${aiIntro}\n\n${dataStructure}`;
}

// <<< NOVOS TEMPLATES PARA O FLUXO HÍBRIDO >>>
function getOnboardingAskForWorkDaysMessage(clientName) {
    const aiIntro = `Ótimo, ${clientName}! Sua conta empresarial foi criada. Agora, vamos configurar sua agenda para que seus clientes possam marcar horários online. 🗓️`;
    const dataStructure = `Primeiro, me diga em quais dias da semana você trabalha:`;
    return `${aiIntro}\n\n${dataStructure}`;
}

function getOnboardingAskForCustomScheduleMessage(clientName) {
    return `Entendido, ${clientName}! Por favor, descreva seus dias e horários de trabalho.\n\n*Exemplo:* "trabalho somente às terças e quintas, das 10h até as 20h"`;
}

function getOnboardingAskForWorkTimesMessage(clientName) {
    const aiIntro = `Perfeito! 👍 Agora, qual é o seu horário de trabalho nesses dias?`;
    const dataStructure = `Me diga a hora que você começa e a hora que termina. Por exemplo:\n\n*"das 9h às 18h"*`;
    return `${aiIntro}\n\n${dataStructure}`;
}

function getOnboardingFinalStepsMessage(clientName, publicBookingLink) {
    const aiIntro = `🎉 Perfeito, ${clientName}! Sua agenda está configurada!`;
    const dataStructure = `Seu link público para agendamentos já está no ar:\n` +
                          `🔗 *${publicBookingLink}*\n\n` +
                          `*⚠️ Passo Final Importante:*\n` +
                          `Para que seus clientes possam agendar, você precisa ter pelo menos um *serviço* cadastrado. É super fácil!\n\n` +
                          `Me diga, por exemplo:\n` +
                          `*"criar serviço Consultoria com preço 150 e duração de 60 minutos"*`;
    const outro = `Assim que criar seu primeiro serviço, já pode compartilhar seu link e começar a encher sua agenda! 🚀`;
    return `${aiIntro}\n\n${dataStructure}\n\n${outro}`;
}


// ============================================================================
// FUNÇÃO PRINCIPAL DO HANDLER (Máquina de Estados)
// ============================================================================

/**
 * Processa a mensagem do usuário com base no estágio atual do onboarding.
 * @param {object} state - O estado atual da conversa do usuário.
 * @param {string} messageText - O texto da mensagem recebida (ou ID do botão).
 * @param {object} actorClient - O objeto do cliente que está interagindo.
 * @returns {Promise<object>} Um objeto com a resposta a ser enviada e o estado atualizado.
 */
async function handleOnboardingStep(state, messageText, actorClient) {
    let onboardingReply = "";
    const nameFromDb = (actorClient.name && actorClient.name.toLowerCase() !== 'convidado' && actorClient.name.toLowerCase() !== 'unknown')
        ? actorClient.name.split(" ")[0]
        : null;

    let clientNameForMessages = nameFromDb || state.pushNameFromPayload || "você";
    const lowerMessageText = (messageText || "").toLowerCase().trim();
    const isSharedContext = state.isSharedAccessContext;

    // --- ESTÁGIOS DE CREDENCIAIS E CONTA PF (permanecem os mesmos) ---
    if (state.data.onboardingStage === 'setting_up_credentials_email') {
        if (state.currentAction !== 'awaiting_input_email') {
            onboardingReply = getOnboardingAskForEmailMessage(clientNameForMessages);
            state.currentAction = 'awaiting_input_email';
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
            return { onboardingReply: 'Aguardando e-mail do usuário...', updatedState: state, updatedActorClient: actorClient };
        }
        const emailInput = lowerMessageText;
        if (emailInput.includes('@') && emailInput.includes('.')) {
            const existingClient = await clientService.findClientByEmail(emailInput);
            if (existingClient && existingClient.id !== actorClient.id) {
                onboardingReply = `Opa! O e-mail *${emailInput}* já está em uso. Por favor, tente outro.`;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
                return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
            }
            state.data.tempEmail = emailInput;
            state.data.onboardingStage = 'setting_up_credentials_password';
            state.currentAction = 'awaiting_input_password';
            onboardingReply = getOnboardingAskForPasswordMessage();
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = `Hmm, isso não parece um e-mail válido. Pode tentar de novo, por favor? 😊`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }

    if (state.data.onboardingStage === 'setting_up_credentials_password') {
        const passwordInput = messageText.trim();
        if (passwordInput.length >= 6) {
            const emailToSet = state.data.tempEmail;
            await clientAuthService.setClientCredentials(actorClient.phone, passwordInput, null, emailToSet);
            actorClient.email = emailToSet; 
            delete state.data.tempEmail;
            state.data.onboardingStage = 'setting_up_full_name';
            state.currentAction = 'awaiting_full_name';
            onboardingReply = getOnboardingAskForFullNameMessage(clientNameForMessages, isSharedContext);
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = `Sua senha precisa ter no mínimo 6 caracteres. Por favor, escolha uma senha mais forte.`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }

    if (state.data.onboardingStage === 'awaiting_plan_confirmation' && state.hasPaidAccess) {
        onboardingReply = getOnboardingWelcomeMessage(clientNameForMessages, state.hasPaidAccess, isSharedContext, state.accessLevelTextForUser);
        await sendWhatsappMessage(actorClient.phone, onboardingReply);
    }

    if (state.data.onboardingStage === 'setting_up_full_name') {
        const fullName = messageText.trim();
        if (fullName.length >= 3 && fullName.includes(' ')) {
            await clientService.updateClientContact(actorClient.id, { name: fullName });
            actorClient.name = fullName;
            clientNameForMessages = fullName.split(' ')[0];
            state.data.onboardingStage = 'setting_up_pf_account_name';
            state.currentAction = 'awaiting_input_pf_name';
            onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameForMessages);
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = `Por favor, me diga seu nome completo para personalizarmos sua conta. 😊`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    if (state.data.onboardingStage === 'setting_up_pf_account_name') {
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
                    state.currentAction = 'awaiting_pj_mei_confirm';
                    const messageTextAskPjType = `🏦 Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameForMessages}! 🎉 Ela já está selecionada. \n\nComo você tem um Plano Avançado, vamos agora configurar sua conta empresarial.`;
                    await sendWhatsappMessage(actorClient.phone, messageTextAskPjType);
                    return handleOnboardingStep(state, '', actorClient);
                } else {
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = null;
                    onboardingReply = `Tudo pronto! Sua conta "${pfAccountName}" está pronta para uso! Estou pronto para a ação! 🚀`;
                    await sendWhatsappMessage(actorClient.phone, onboardingReply);
                }
            } catch (e) {
                logger.error(`[ONBOARDING HANDLER] Erro ao criar conta PF "${pfAccountName}": ${e.message}`);
                onboardingReply = `Opa! 😬 Tive um probleminha para criar a conta "${pfAccountName}". Que tal a gente tentar um nome diferente?`;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
            }
        } else {
            onboardingReply = `O nome da sua conta Pessoal deve ter entre 3 e 50 letras. Por favor, tente um nome diferente.`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    // --- ESTÁGIOS DO ONBOARDING EMPRESARIAL (REESTRUTURADOS) ---

    if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
        const messageTextAskPjType = getOnboardingAskForPJTypeMessage(clientNameForMessages);
        state.data.onboardingStage = 'awaiting_pj_mei_type';
        state.currentAction = 'awaiting_input_pj_mei_type';
        await sendButtonListMessage(actorClient.phone, messageTextAskPjType, [
            { id: 'onboarding_select_pj', label: 'Empresa (PJ)' },
            { id: 'onboarding_select_mei', label: 'MEI' }
        ], 'Tipo de Conta');
        return { onboardingReply: null, updatedState: state, updatedActorClient: actorClient };
    }
    
    if (state.data.onboardingStage === 'awaiting_pj_mei_type') {
        const typeInput = messageText.trim().toLowerCase();
        let selectedType = null;
        if (typeInput === 'onboarding_select_pj' || typeInput === 'pj') {
            selectedType = 'PJ';
        } else if (typeInput === 'onboarding_select_mei' || typeInput === 'mei') {
            selectedType = 'MEI';
        }
        if (selectedType) {
            state.data.tempPjMeiType = selectedType;
            onboardingReply = `🎉 Show! Agora, qual nome vamos dar para sua potência empresarial do tipo *${selectedType}*?`;
            state.data.onboardingStage = 'creating_pj_mei_account_name';
            state.currentAction = 'awaiting_input_pj_mei_name';
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = getOnboardingAskForPJTypeMessage(clientNameForMessages);
            await sendButtonListMessage(actorClient.phone, onboardingReply, [
                { id: 'onboarding_select_pj', label: 'Empresa (PJ)' },
                { id: 'onboarding_select_mei', label: 'MEI' }
            ], 'Tipo de Conta');
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    if (state.data.onboardingStage === 'creating_pj_mei_account_name') {
        const companyName = messageText.trim();
        const companyType = state.data.tempPjMeiType;
        if (companyName.length >= 3 && companyName.length <= 50) {
            try {
                const newAccount = await clientService.createFinancialAccount(actorClient.id, { 
                    accountName: companyName, accountType: companyType, isDefault: false
                });
                state.data.newlyCreatedAccountId = newAccount.id;
                onboardingReply = getOnboardingAskForWorkDaysMessage(clientNameForMessages);
                state.data.onboardingStage = 'setting_up_work_days';
                state.currentAction = 'awaiting_work_days';
                await sendButtonListMessage(actorClient.phone, onboardingReply, [
                    { id: 'onboarding_days_seg_sex', label: 'Segunda a Sexta' },
                    { id: 'onboarding_days_seg_sab', label: 'Segunda a Sábado' },
                    { id: 'onboarding_days_todos', label: 'Todos os dias' },
                    { id: 'onboarding_days_outro', label: 'Outro (descrever)' }
                ], 'Dias de Trabalho');
            } catch (e) {
                logger.error(`[ONBOARDING HANDLER] Erro ao criar conta ${companyType} "${companyName}": ${e.message}`);
                onboardingReply = `Eita! 😬 Parece que o nome "${companyName}" já existe ou é inválido. Vamos tentar outro nome para a sua ${companyType}?`;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
            }
        } else {
            onboardingReply = `O nome da sua ${companyType} deve ter entre 3 e 50 letras. Por favor, tente um nome bacana! 🌟`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply: null, updatedState: state, updatedActorClient: actorClient };
    }

    if (state.data.onboardingStage === 'setting_up_work_days') {
        const selection = lowerMessageText;
        const daysMap = {
            'onboarding_days_seg_sex': 'MO,TU,WE,TH,FR',
            'onboarding_days_seg_sab': 'MO,TU,WE,TH,FR,SA',
            'onboarding_days_todos': 'SU,MO,TU,WE,TH,FR,SA',
        };

        if (daysMap[selection]) {
            state.data.tempWorkDays = daysMap[selection];
            onboardingReply = getOnboardingAskForWorkTimesMessage(clientNameForMessages);
            state.data.onboardingStage = 'setting_up_work_times';
            state.currentAction = 'awaiting_work_times';
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else if (selection === 'onboarding_days_outro') {
            onboardingReply = getOnboardingAskForCustomScheduleMessage(clientNameForMessages);
            state.data.onboardingStage = 'setting_up_custom_schedule';
            state.currentAction = 'awaiting_custom_schedule';
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = getOnboardingAskForWorkDaysMessage(clientNameForMessages);
            await sendButtonListMessage(actorClient.phone, onboardingReply, [
                { id: 'onboarding_days_seg_sex', label: 'Segunda a Sexta' },
                { id: 'onboarding_days_seg_sab', label: 'Segunda a Sábado' },
                { id: 'onboarding_days_todos', label: 'Todos os dias' },
                { id: 'onboarding_days_outro', label: 'Outro (descrever)' }
            ], 'Dias de Trabalho');
        }
        return { onboardingReply: null, updatedState: state, updatedActorClient: actorClient };
    }

    if (state.data.onboardingStage === 'setting_up_work_times') {
        const scheduleInfo = await onboardingAIService.interpretWorkSchedule(lowerMessageText);
        if (scheduleInfo && scheduleInfo.startTime && scheduleInfo.endTime) {
            // Horário foi interpretado com sucesso, agora finalizamos.
            try {
                await availabilityService.createDefaultWorkRule(
                    state.data.newlyCreatedAccountId,
                    scheduleInfo.startTime,
                    scheduleInfo.endTime,
                    state.data.tempWorkDays // Dias já estavam salvos no estado
                );
                const publicLink = `https://www.map-nocontrole.com.br/agendar/${state.data.newlyCreatedAccountId}`;
                onboardingReply = getOnboardingFinalStepsMessage(clientNameForMessages, publicLink);
                state.data.onboardingStage = 'onboarding_complete';
                state.currentAction = null; 
                delete state.data.tempWorkDays;
                delete state.data.newlyCreatedAccountId;
                delete state.data.tempPjMeiType;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
            } catch (error) {
                logger.error(`[ONBOARDING HANDLER] Erro ao criar regra de trabalho com horário da IA: ${error.message}`);
                onboardingReply = `Ops, tive um problema ao salvar seu horário. Vamos tentar de novo. Qual seu horário de trabalho? (Ex: das 9h às 18h)`;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
            }
        } else {
            onboardingReply = `Não entendi o formato do horário. Por favor, tente algo como *"das 8h às 17h30"* ou *"das 10h às 19h"*.`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    if (state.data.onboardingStage === 'setting_up_custom_schedule') {
        const scheduleInfo = await onboardingAIService.interpretWorkSchedule(lowerMessageText);
        if (scheduleInfo && scheduleInfo.startTime && scheduleInfo.endTime && scheduleInfo.rruleDays) {
            // IA conseguiu extrair tudo, então finalizamos.
            try {
                await availabilityService.createDefaultWorkRule(
                    state.data.newlyCreatedAccountId,
                    scheduleInfo.startTime,
                    scheduleInfo.endTime,
                    scheduleInfo.rruleDays
                );
                const publicLink = `https://www.map-nocontrole.com.br/agendar/${state.data.newlyCreatedAccountId}`;
                onboardingReply = getOnboardingFinalStepsMessage(clientNameForMessages, publicLink);
                state.data.onboardingStage = 'onboarding_complete';
                state.currentAction = null;
                delete state.data.newlyCreatedAccountId;
                delete state.data.tempPjMeiType;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
            } catch (error) {
                logger.error(`[ONBOARDING HANDLER] Erro ao criar regra de trabalho com dados custom da IA: ${error.message}`);
                onboardingReply = `Ops, tive um problema ao salvar seu horário. Vamos tentar de novo. Por favor, descreva seus dias e horários.`;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
            }
        } else {
            onboardingReply = `Hmm, não consegui entender perfeitamente. 🤔\n\nPor favor, tente ser mais completo, dizendo os *dias e os horários* na mesma frase.\n\n*Exemplo:* "trabalho de terça a sábado, das 10h às 19h30"`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    return { onboardingReply: null, updatedState: state, updatedActorClient: actorClient };
}

// ============================================================================
// FUNÇÃO DE GATILHO PROATIVO
// ============================================================================

async function triggerOnboarding(phone, customWelcomeMessage = null) {
    logger.info(`[ONBOARDING TRIGGER] Iniciando onboarding proativo para ${phone}.`);
    try {
        if (customWelcomeMessage) {
            await sendWhatsappMessage(phone, customWelcomeMessage);
        }
        const whatsappService = require('./whatsapp.service');
        const actorClient = await clientService.findClientByPhone(phone);
        if (!actorClient) {
            logger.error(`[ONBOARDING TRIGGER] Cliente com telefone ${phone} não encontrado para iniciar onboarding.`);
            return;
        }
        const clientAccounts = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
        const state = await whatsappService.initializeOrUpdateState(actorClient, null, null, clientAccounts, []);
        const { updatedState } = await handleOnboardingStep(state, '', actorClient);
        if (updatedState) {
            whatsappService.conversationState.set(phone, updatedState);
            logger.info(`[ONBOARDING TRIGGER] Primeira etapa do onboarding enviada e estado inicial salvo para ${phone}.`);
        }
    } catch (error) {
        logger.error(`[ONBOARDING TRIGGER] Falha ao iniciar onboarding proativo para ${phone}: ${error.message}`, { stack: error.stack });
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    handleOnboardingStep,
    getOnboardingWelcomeNoPlanMessage,
    triggerOnboarding
};
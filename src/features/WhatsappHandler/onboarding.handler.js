// src/features/WhatsappHandler/onboarding.handler.js
// DESCRIÇÃO:
// Este handler é uma "máquina de estados" que gerencia o fluxo de onboarding de um cliente no WhatsApp.
// Ele é responsável por coletar informações essenciais para a configuração da conta,
// como a criação das contas financeiras (PF e PJ/MEI), e guiar o usuário até que sua conta esteja
// 100% pronta para uso. O fluxo é projetado para ser proativo e, em sua maioria, guiado por botões.

const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const logger = require('../../utils/logger');
const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');

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

function getOnboardingAskForPasswordMessage() {
    const message = `Perfeito, e-mail anotado! ✅\n\n` +
                    `Agora, por favor, crie uma *senha* para seu acesso (ela deve ter no mínimo 6 caracteres).`;
    return message;
}

function getOnboardingAskForFullNameMessage(clientName) {
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

    // --- ESTÁGIO DE CREDENCIAIS (Para usuários legados ou ativados pelo admin sem senha) ---
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

            onboardingReply = getOnboardingAskForFullNameMessage(clientNameForMessages);
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = `Sua senha precisa ter no mínimo 6 caracteres. Por favor, escolha uma senha mais forte.`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    // --- ESTÁGIO 1: COLETANDO NOME COMPLETO (Se necessário) ---
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
    
    // --- ESTÁGIO 2: CRIANDO CONTA PF (Passo obrigatório para todos) ---
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
                    // Chama recursivamente para entrar no próximo estágio imediatamente
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
    
    // --- ESTÁGIO 3: INÍCIO OBRIGATÓRIO DA CONFIGURAÇÃO EMPRESARIAL ---
    if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
        // Agora este passo é obrigatório e não pergunta mais "sim/não".
        const messageTextAskPjType = getOnboardingAskForPJTypeMessage(clientNameForMessages);
        
        state.data.onboardingStage = 'awaiting_pj_mei_type';
        state.currentAction = 'awaiting_input_pj_mei_type';

        await sendButtonListMessage(actorClient.phone, messageTextAskPjType, [
            { id: 'onboarding_select_pj', label: 'Empresa (PJ)' },
            { id: 'onboarding_select_mei', label: 'MEI' }
        ], 'Tipo de Conta');

        // Retorna null para não enviar outra mensagem de texto. Apenas o botão é enviado.
        return { onboardingReply: null, updatedState: state, updatedActorClient: actorClient };
    }
    
    // --- ESTÁGIO 4: ESCOLHENDO TIPO PJ/MEI (CORRIGIDO) ---
    if (state.data.onboardingStage === 'awaiting_pj_mei_type') {
        const typeInput = messageText.trim().toLowerCase();
        let selectedType = null;

        // Verifica tanto o ID do botão quanto o texto digitado
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
            // Se o usuário digitou algo inválido, reenviamos a pergunta com botões
            onboardingReply = getOnboardingAskForPJTypeMessage(clientNameForMessages);
            await sendButtonListMessage(actorClient.phone, onboardingReply, [
                { id: 'onboarding_select_pj', label: 'Empresa (PJ)' },
                { id: 'onboarding_select_mei', label: 'MEI' }
            ], 'Tipo de Conta');
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    // --- ESTÁGIO 5: CRIANDO NOME DA CONTA EMPRESARIAL ---
    if (state.data.onboardingStage === 'creating_pj_mei_account_name') {
        const companyName = messageText.trim();
        const companyType = state.data.tempPjMeiType;
        
        if (companyName.length >= 3 && companyName.length <= 50) {
            try {
                await clientService.createFinancialAccount(actorClient.id, { 
                    accountName: companyName, accountType: companyType, isDefault: false
                });
                
                onboardingReply = `🎊 Sensacional! Sua conta ${companyType} "${companyName}" foi criada e está pronta para brilhar! ✨\n\nSua conta pessoal continua ativa, mas se quiser mudar para a PJ/MEI, é só dizer "mudar para conta ${companyName}".\n\nEstou a postos! 💪`;
                logger.info(`[ONBOARDING HANDLER] Conta ${companyType} "${companyName}" criada para ATOR ${actorClient.phone}.`);
                
                state.data.onboardingStage = 'onboarding_complete';
                state.currentAction = null; 
                delete state.data.tempPjMeiType;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
                
            } catch (e) {
                logger.error(`[ONBOARDING HANDLER] Erro ao criar conta ${companyType} "${companyName}": ${e.message}`);
                onboardingReply = `Eita! 😬 Parece que o nome "${companyName}" já existe ou é inválido. Vamos tentar outro nome para a sua ${companyType}?`;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
            }
        } else {
            onboardingReply = `O nome da sua ${companyType} deve ter entre 3 e 50 letras. Por favor, tente um nome bacana! 🌟`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    // Fallback: se nenhum estágio for correspondido, retorna o estado sem alteração.
    return { onboardingReply: null, updatedState: state, updatedActorClient: actorClient };
}

// ============================================================================
// FUNÇÃO DE GATILHO PROATIVO
// ============================================================================

/**
 * Inicia proativamente a conversa de onboarding para um novo cliente ativado.
 * @param {string} phone - O número de telefone canônico do cliente (ex: 5511999999999).
 * @param {string} [customWelcomeMessage] - Uma mensagem de boas-vindas opcional para ser enviada antes do onboarding.
 */
async function triggerOnboarding(phone, customWelcomeMessage = null) {
    logger.info(`[ONBOARDING TRIGGER] Iniciando onboarding proativo para ${phone}.`);
    try {
        if (customWelcomeMessage) {
            await sendWhatsappMessage(phone, customWelcomeMessage);
        }

        // Usa require() aqui para quebrar a dependência circular
        const whatsappService = require('./whatsapp.service');
        const actorClient = await clientService.findClientByPhone(phone);
        if (!actorClient) {
            logger.error(`[ONBOARDING TRIGGER] Cliente com telefone ${phone} não encontrado para iniciar onboarding.`);
            return;
        }

        const clientAccounts = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
        
        // Simula um estado inicial para o cliente
        const state = await whatsappService.initializeOrUpdateState(actorClient, null, null, clientAccounts, []);

        // Chama o handler de onboarding com uma mensagem "vazia" para obter a primeira pergunta
        const { updatedState } = await handleOnboardingStep(state, '', actorClient);

        // O handleOnboardingStep já envia a mensagem, então só precisamos salvar o estado final
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
// src/features/WhatsappHandler/onboarding.handler.js
// DESCRIÇÃO:
// Este handler é uma "máquina de estados" que gerencia o fluxo de onboarding de um cliente no WhatsApp.
// Ele é responsável por coletar informações que não foram obtidas durante o cadastro inicial no site,
// como a configuração de contas financeiras (PF e PJ/MEI), e guiar o usuário até que sua conta esteja
// 100% pronta para uso. Ele NÃO lida mais com a coleta de email/senha, que agora é feita no frontend
// antes do pagamento.

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
    const aiIntro = `👍 Excelente, ${clientName}! Sua nova conta será para qual tipo?`;
    const dataStructure = `🏢 Empresa (PJ) ou 👩‍💼 Microempreendedor Individual (MEI)?`;
    const linkText = `📲 Me diga "PJ" ou "MEI" para que eu possa configurar certinho para você!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
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

            onboardingReply = getOnboardingAskForFullNameMessage(clientNameForMessages, isSharedContext);
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = `Sua senha precisa ter no mínimo 6 caracteres. Por favor, escolha uma senha mais forte.`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }

    // --- ESTÁGIO DE TRANSIÇÃO PÓS-PAGAMENTO ---
    if (state.data.onboardingStage === 'awaiting_plan_confirmation' && state.hasPaidAccess) {
        onboardingReply = getOnboardingWelcomeMessage(clientNameForMessages, state.hasPaidAccess, isSharedContext, state.accessLevelTextForUser);
        await sendWhatsappMessage(actorClient.phone, onboardingReply);
        // O fluxo continuará para a próxima etapa lógica (PF ou PJ) no mesmo ciclo.
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
    
    // --- ESTÁGIO 2: CRIANDO CONTA PF (Fallback se não foi criada no signup) ---
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
                    
                    const messageTextAskPj = `🏦 Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameForMessages}! 🎉 Ela já está selecionada. \n\nComo você tem um Plano Avançado, que tal configurarmos também uma conta para sua empresa (PJ) ou MEI?`;
                    
                    await sendButtonListMessage(actorClient.phone, messageTextAskPj, [
                        { id: 'onboarding_pj_yes', label: 'Sim, configurar agora' },
                        { id: 'onboarding_pj_no', label: 'Deixar para depois' }
                    ], "Configurar Conta Empresarial?");
                    onboardingReply = null; // Evita mensagem duplicada
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
    
    if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
        if (lowerMessageText === 'onboarding_pj_yes' || lowerMessageText.includes("sim") || lowerMessageText.includes("quero")) {
            onboardingReply = getOnboardingAskForPJTypeMessage(clientNameForMessages);
            state.data.onboardingStage = 'awaiting_pj_mei_type';
            state.currentAction = 'awaiting_input_pj_mei_type';
            // <<< MUDANÇA AQUI: Envia com botões >>>
            await sendButtonListMessage(actorClient.phone, onboardingReply, [
                { id: 'onboarding_select_pj', label: 'Empresa (PJ)' },
                { id: 'onboarding_select_mei', label: 'MEI' }
            ], 'Tipo de Conta');
            return { onboardingReply: null, updatedState: state, updatedActorClient: actorClient }; // Retorna null para não enviar msg duplicada

        } else if (lowerMessageText === 'onboarding_pj_no' || lowerMessageText.includes("não") || lowerMessageText.includes("nao")) {
            state.data.onboardingStage = 'onboarding_complete';
            state.currentAction = null;
            // <<< CORREÇÃO AQUI: Usa o nome da conta que já existe no estado >>>
            onboardingReply = `Tranquilo! Sua conta "${state.activeFinancialAccountName}" está pronta para uso. O que você gostaria de fazer primeiro? 🚀`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
            return { onboardingReply, updatedState: state, updatedActorClient: actorClient };

        } else {
            logger.info(`[ONBOARDING HANDLER] Usuário no estágio 'confirming_pj_mei_setup' enviou texto não conclusivo. Reenviando pergunta.`);
            
            const messageTextAskPj = `Olá, ${clientNameForMessages}! Notei que você tem um Plano Avançado. Que tal configurarmos agora sua conta empresarial (PJ ou MEI)?`;
            
            await sendButtonListMessage(actorClient.phone, messageTextAskPj, [
                { id: 'onboarding_pj_yes', label: 'Sim, configurar agora' },
                { id: 'onboarding_pj_no', label: 'Deixar para depois' }
            ], "Configurar Conta Empresarial?");

            onboardingReply = null; 
            state.currentAction = 'awaiting_pj_mei_confirm';
            return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
        }
    }
    
    // --- ESTÁGIO 4: ESCOLHENDO TIPO PJ/MEI ---
    if (state.data.onboardingStage === 'awaiting_pj_mei_type') {
        const typeInput = messageText.trim().toUpperCase();
        if (typeInput === 'PJ' || typeInput === 'MEI') {
            state.data.tempPjMeiType = typeInput;
            onboardingReply = `🎉 Show! Agora, qual nome vamos dar para sua potência empresarial do tipo *${typeInput}*?`;
            state.data.onboardingStage = 'creating_pj_mei_account_name';
            state.currentAction = 'awaiting_input_pj_mei_name';
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = `Por favor, me diga se é "PJ" ou "MEI" para que eu possa configurar corretamente.`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
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
// EXPORTS
// ============================================================================

module.exports = {
    handleOnboardingStep,
    getOnboardingWelcomeNoPlanMessage
};
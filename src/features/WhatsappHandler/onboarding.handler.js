// src/features/WhatsappHandler/onboarding.handler.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const logger = require('../../utils/logger');
 const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');

// Funções de formatação de mensagens de onboarding
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

// ============================================================================
// === INÍCIO DAS NOVAS FUNÇÕES DE MENSAGEM PARA O FLUXO ETAPA-POR-ETAPA ===
// ============================================================================

function getOnboardingAskForEmailMessage(clientName) {
    const greeting = clientName ? `Olá, ${clientName}! 👋` : 'Olá! 👋';
    const message = `${greeting} Notei que seu plano já está ativo (que demais!), mas ainda não definimos suas credenciais de acesso para o painel web.\n\n` +
                    `Para começarmos, qual é o seu melhor *e-mail*?`;
    return message;
}

function getOnboardingWelcomeMessage(clientName, hasPaidAccess, isSharedContext, accessLevelTextForUser) {
    if (isSharedContext) {
         // Esta mensagem deve ser tratada pelo whatsapp.service diretamente para não entrar no onboarding principal
         // Apenas como fallback:
         return `Olá, ${clientName}! Você está usando um acesso compartilhado. Me diga "oi" novamente para começar a usar a conta do proprietário.`;
    }
    
    if (!hasPaidAccess) {
        // Fluxo que não deve mais acontecer se o usuário vier da web, mas mantido como fallback
        const siteUrl = process.env.PLAN_SITE_URL || "https://map-nocontrole.com.br/#planos";
        return `🚀 Olá, ${clientName}! Você ainda está no plano Gratuito ou sua assinatura expirou. Para usar o controle total, acesse: ${siteUrl}`;
    }

    // Mensagem de boas-vindas pós-cadastro web
    const accessText = accessLevelTextForUser || "seu plano";
    const aiIntro = `🎉 Olá, ${clientName}! Que bom ver você por aqui! Sua assinatura *${accessText}* foi confirmada com sucesso. Agora, vamos deixar tudo 100% pronto para você começar a organizar! 💪✨`;
    
    // O próximo passo é sempre pedir o nome se for o primeiro contato (Convidado) ou configurar a conta PF/PJ
    return aiIntro;
}

function getOnboardingAskForPasswordMessage() {
    const message = `Perfeito, e-mail anotado! ✅\n\n` +
                    `Agora, por favor, crie uma *senha* para seu acesso (ela deve ter no mínimo 6 caracteres).`;
    return message;
}

// ============================================================================
// === FIM DAS NOVAS FUNÇÕES DE MENSAGEM ===
// ============================================================================

function getOnboardingAskForFullNameMessage(clientName, isSharedContext = false, ownerName = 'O proprietário') {
    // ... (esta função permanece a mesma)
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

// ... (outras funções de mensagem 'get...' permanecem as mesmas) ...
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

function getSubscriptionExpiredOrInactiveMessage(clientName) {
    const checkoutBaseUrl = process.env.CHECKOUT_BASE_URL || "https://www.map-nocontrole.com.br";
    const message =
        `Olá, ${clientName}! 👋\n\n` +
        `Sua assinatura do MAP no Controle não está ativa. Para reativar seu acesso completo e continuar no controle, escolha um dos planos abaixo:\n\n` +
        `*Plano Básico*\n` +
        `- Mensal: ${checkoutBaseUrl}/checkout/7\n` +
        `- Anual: ${checkoutBaseUrl}/checkout/8\n\n` +
        `*Plano Avançado (com Módulo de Negócios)*\n` +
        `- Mensal: ${checkoutBaseUrl}/checkout/9\n` +
        `- Anual: ${checkoutBaseUrl}/checkout/10\n\n` +
        `Assim que o pagamento for confirmado, seu acesso é liberado na hora! ✨`;
    return message;
}

async function handleOnboardingStep(state, messageText, actorClient) {
    let onboardingReply = "";
    const nameFromDb = (actorClient.name && actorClient.name.toLowerCase() !== 'convidado' && actorClient.name.toLowerCase() !== 'unknown')
        ? actorClient.name.split(" ")[0]
        : null;

    let clientNameForMessages = nameFromDb || state.pushNameFromPayload || "você";
    const lowerMessageText = (messageText || "").toLowerCase().trim();
    const isSharedContext = state.isSharedAccessContext;

    // --- INÍCIO DA CORREÇÃO PRINCIPAL ---
    // Etapa 0: Verifica se o usuário está no limbo (sem plano) e intercepta a conversa.
    if (state.data.onboardingStage === 'awaiting_plan_confirmation' && !state.hasPaidAccess) {
        // Se o usuário responder "sim" à pergunta inicial sobre ver planos, o fluxo continua.
        if (lowerMessageText.includes("sim") || lowerMessageText.includes("quero") || lowerMessageText.includes("bora")) {
            const planDetailsMessage = `Temos planos Mensais e Anuais, para controle Pessoal ou Empresarial (com o módulo de negócios!). Para ver todos os detalhes e valores, acesse nossa página de planos: https://map-nocontrole.com.br/#planos\n\nQuando sua assinatura estiver ativa, é só me dar um "oi" que começamos! 😉`;
            await sendWhatsappMessage(actorClient.phone, planDetailsMessage);
            onboardingReply = 'Detalhes do plano enviados.';
        } else {
            // Para qualquer outra mensagem (como "Olá"), envia o lembrete de assinatura.
            onboardingReply = getSubscriptionExpiredOrInactiveMessage(clientNameForMessages);
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        // Interrompe o fluxo aqui para não processar mais nada.
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    // --- FIM DA CORREÇÃO PRINCIPAL ---


    // Se o cliente ainda estiver no estágio 'awaiting_plan_confirmation' e tiver pago,
    // garantimos que ele avance para a próxima etapa: definir o nome completo.
    if (state.data.onboardingStage === 'awaiting_plan_confirmation' && state.hasPaidAccess) {
        // Se o nome ainda for genérico ('Convidado'), força a ir para a coleta de nome.
        if (actorClient.name === 'Convidado') {
            state.data.onboardingStage = 'setting_up_full_name';
        } else {
             // Se já pagou e tem nome, pula direto para a criação da conta PF (caso não a tenha)
            const accounts = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
            const hasPfAccount = accounts.some(acc => acc.accountType === 'PF');
            
            if (!hasPfAccount) {
                 state.data.onboardingStage = 'setting_up_pf_account_name';
                 state.currentAction = 'awaiting_input_pf_name'; // Prepara para receber o nome da conta
            } else {
                // Se já tem conta PF, verifica se é Avançado e se precisa configurar PJ/MEI
                const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                if (planTier === 'avancado' && accounts.every(a => a.accountType === 'PF')) {
                    state.data.onboardingStage = 'confirming_pj_mei_setup';
                    state.currentAction = 'awaiting_pj_mei_confirm';
                } else {
                    state.data.onboardingStage = 'onboarding_complete';
                }
            }
        }
        
        // Envia a mensagem de boas-vindas do plano ativado (somente na primeira vez que ele entra no chat após pagar)
        onboardingReply = getOnboardingWelcomeMessage(clientNameForMessages, state.hasPaidAccess, isSharedContext, state.accessLevelTextForUser);
        await sendWhatsappMessage(actorClient.phone, onboardingReply);
        // Não retorna aqui, deixa o fluxo cair para a próxima etapa (coleta de nome ou conta PF)
    }

    // --- ESTÁGIO 1: COLETANDO NOME COMPLETO (Se o cadastro veio de uma fonte sem nome) ---
    if (state.data.onboardingStage === 'setting_up_full_name' || state.currentAction === 'awaiting_full_name') {
        
        if (state.currentAction !== 'awaiting_full_name') {
             // Se caiu aqui após o "WELCOME", pergunta o nome.
             onboardingReply = getOnboardingAskForFullNameMessage(clientNameForMessages, isSharedContext);
             state.currentAction = 'awaiting_full_name';
             await sendWhatsappMessage(actorClient.phone, onboardingReply);
             return { onboardingReply: 'Aguardando nome completo...', updatedState: state, updatedActorClient: actorClient };
        } 
        
        // Processa o nome
        const fullName = messageText.trim();
        if (fullName.length >= 3 && fullName.includes(' ')) {
            // Atualiza o nome do cliente no banco de dados
            await clientService.updateClientContact(actorClient.id, { name: fullName });
            actorClient.name = fullName; // Atualiza o objeto em memória
            clientNameForMessages = fullName.split(' ')[0]; // Atualiza o nome para as próximas msgs
            
            // Avança para a próxima etapa: conta PF
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
    
    // Se não for onboarding de nome, a próxima lógica se concentra em contas financeiras.
    
    // --- ESTÁGIO 2: CRIANDO CONTA PF (Se ela ainda não foi criada) ---
    if (state.data.onboardingStage === 'setting_up_pf_account_name') {
        // Se a ação não é awaiting_input, o usuário acabou de passar pelo estágio anterior, então apenas reenvia a pergunta.
        if (state.currentAction !== 'awaiting_input_pf_name') {
            onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameForMessages);
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
            state.currentAction = 'awaiting_input_pf_name';
            return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
        }
        
        const pfAccountName = messageText.trim();
        if (pfAccountName.length >= 3 && pfAccountName.length <= 50) {
            try {
                const newPfAccount = await clientService.createFinancialAccount(actorClient.id, {
                    accountName: pfAccountName, accountType: 'PF', isDefault: true
                });
                // Atualiza o estado da conversa com a conta ativa
                state.activeFinancialAccountId = newPfAccount.id;
                state.activeFinancialAccountName = newPfAccount.accountName;
                state.activeFinancialAccountType = newPfAccount.accountType;
                
                logger.info(`[ONBOARDING HANDLER] Conta PF "${pfAccountName}" criada para ATOR ${actorClient.phone}.`);

                const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                
                // Se o plano for Avançado, passa para a pergunta sobre PJ/MEI
                if (planTier === 'avancado') {
                    state.data.onboardingStage = 'confirming_pj_mei_setup';
                    state.currentAction = 'awaiting_pj_mei_confirm';
                    
                    const messageTextAskPj = `🏦 Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameForMessages}! 🎉 Ela já está selecionada. \n\nComo você tem um Plano Avançado, que tal configurarmos também uma conta para sua empresa (PJ) ou MEI?`;
                    
                    await sendButtonListMessage(actorClient.phone, messageTextAskPj, [
                        { id: 'onboarding_pj_yes', label: 'Sim, quero configurar PJ/MEI' },
                        { id: 'onboarding_pj_no', label: 'Não, agora não' }
                    ], "Configurar PJ/MEI?");

                    onboardingReply = 'Pergunta sobre PJ/MEI enviada via botões.';

                } else {
                    // Finaliza para plano Básico
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = null;
                    onboardingReply = `Tudo pronto! Sua conta "${pfAccountName}" está pronta para uso! Estou pronto para a ação! 🚀`;
                    await sendWhatsappMessage(actorClient.phone, onboardingReply);
                }
                
            } catch (e) {
                logger.error(`[ONBOARDING HANDLER] Erro ao criar conta PF "${pfAccountName}" para ATOR ${actorClient.phone}: ${e.message}`);
                onboardingReply = `Opa! 😬 Tive um probleminha para criar a conta "${pfAccountName}". Que tal a gente tentar um nome diferente?`;
                await sendWhatsappMessage(actorClient.phone, onboardingReply);
            }
        } else {
            onboardingReply = `O nome da sua conta Pessoal deve ter entre 3 e 50 letras. Por favor, tente um nome diferente.`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }
    
    // --- ESTÁGIO 3: CONFIRMANDO CRIAÇÃO DE CONTA EMPRESARIAL (Tratada no action.handler para botões) ---
    // A lógica de processamento desta etapa deve estar em 'handleButtonInteraction' no whatsapp.service
    // para capturar cliques nos botões 'onboarding_pj_yes' e 'onboarding_pj_no'.
    
    // Se o usuário digitar algo em vez de clicar no botão:
    if (state.data.onboardingStage === 'confirming_pj_mei_setup' && state.currentAction === 'awaiting_pj_mei_confirm') {
        const userResponseLower = lowerMessageText;
        if (userResponseLower.includes("sim") || userResponseLower.includes("quero") || userResponseLower.includes("bora")) {
            onboardingReply = `Qual tipo de conta empresarial? PJ ou MEI?`;
            state.data.onboardingStage = 'awaiting_pj_mei_type';
            state.currentAction = 'awaiting_input_pj_mei_type';
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else if (userResponseLower.includes("não") || userResponseLower.includes("nao") || userResponseLower.includes("pular")) {
            state.data.onboardingStage = 'onboarding_complete';
            state.currentAction = null;
            onboardingReply = `Tranquilo! Sua conta "${state.activeFinancialAccountName}" está pronta para uso. O que você gostaria de fazer primeiro? 🚀`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        } else {
            onboardingReply = `Por favor, clique em "Sim" ou "Não" para prosseguirmos com a configuração da conta empresarial! 😊`;
            await sendWhatsappMessage(actorClient.phone, onboardingReply);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
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
    
    return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
}


module.exports = {
    handleOnboardingStep,
    getOnboardingWelcomeNoPlanMessage
};
// src/features/WhatsappHandler/onboarding.handler.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const logger = require('../../utils/logger');

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

async function handleOnboardingStep(state, messageText, actorClient) {
    let onboardingReply = "";
    const nameFromDb = (actorClient.name && actorClient.name.toLowerCase() !== 'convidado')
        ? actorClient.name.split(" ")[0]
        : null;

    let clientNameForMessages;
    if (state.data.onboardingStage === 'setting_up_credentials_email' || 
        state.data.onboardingStage === 'awaiting_shared_user_name') {
        clientNameForMessages = null;
    } else {
        clientNameForMessages = nameFromDb || state.pushNameFromPayload || "você";
    }

    const lowerMessageText = (messageText || "").toLowerCase().trim();
    const isSharedContext = state.isSharedAccessContext;

    if (isSharedContext && actorClient.name.toLowerCase() === 'convidado') {
        // ... (lógica de acesso compartilhado permanece a mesma)
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }

    if (isSharedContext && actorClient.passwordHash === null && state.data.onboardingStage === 'setting_up_main_client_credentials') {
        // ... (lógica de acesso compartilhado permanece a mesma)
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }

    if (state.data.onboardingStage !== 'onboarding_complete') {
        if (state.data.onboardingStage === 'awaiting_plan_confirmation') {
            if(state.hasPaidAccess_whenStageLastSet || !state.isNewUserForSessionLogic) {
                onboardingReply = getOnboardingWelcomeNoPlanMessage(clientNameForMessages);
            }
            state.currentAction = 'awaiting_plan_interest_generic';
        
        // ============================================================================
        // === INÍCIO DA LÓGICA REESTRUTURADA PARA CADASTRO EM ETAPAS ===
        // ============================================================================
        } else if (state.data.onboardingStage === 'setting_up_credentials_email') {
            
            // ETAPA 1: Pedir o E-mail
            if (state.currentAction !== 'awaiting_email' && state.currentAction !== 'awaiting_password') {
                onboardingReply = getOnboardingAskForEmailMessage(clientNameForMessages);
                state.currentAction = 'awaiting_email';
            
            // ETAPA 2: Processar o E-mail e Pedir a Senha
            } else if (state.currentAction === 'awaiting_email') {
                const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
                const emailMatch = messageText.match(emailRegex);
                const email = emailMatch ? emailMatch[0] : null;

                if (email) {
                    // Armazena o e-mail temporariamente no estado da conversa
                    state.data.tempEmail = email;
                    onboardingReply = getOnboardingAskForPasswordMessage();
                    // Avança para a próxima sub-etapa
                    state.currentAction = 'awaiting_password';
                } else {
                    onboardingReply = "Hum, isso não parece um e-mail válido. 😅 Por favor, tente me enviar seu e-mail novamente.";
                    // Mantém a ação como 'awaiting_email' para a próxima tentativa
                }

            // ETAPA 3: Processar a Senha e Finalizar
            } else if (state.currentAction === 'awaiting_password') {
                const password = messageText.trim();
                const email = state.data.tempEmail; // Recupera o e-mail salvo

                if (!email) { // Verificação de segurança, caso o estado se perca
                    logger.error(`[ONBOARDING] Chegou na etapa de senha sem um e-mail salvo no estado para o cliente ${actorClient.phone}. Reiniciando.`);
                    onboardingReply = "Opa, me perdi um pouco. Vamos começar de novo. Qual é o seu e-mail, por favor?";
                    state.currentAction = 'awaiting_email';
                    delete state.data.tempEmail;
                } else if (password.length < 6) {
                    onboardingReply = "A senha precisa ter pelo menos 6 caracteres. Por favor, escolha uma senha um pouco mais forte.";
                    // Mantém a ação como 'awaiting_password'
                } else {
                    try {
                        const currentName = actorClient.name === 'Convidado' ? (state.pushNameFromPayload || 'Cliente') : actorClient.name;
                        await clientAuthService.setClientCredentials(actorClient.phone, password, currentName, email);
                        
                        // Limpa os dados temporários e avança no onboarding
                        delete state.data.tempEmail;
                        state.data.onboardingStage = 'setting_up_pf_account_name'; 
                        state.currentAction = 'awaiting_input_pf_name';
                        
                        const finalNameForMessage = currentName.split(' ')[0];
                        onboardingReply = getOnboardingAskForPFAccountNameMessage(finalNameForMessage);
                        
                    } catch (e) {
                        logger.error(`[ONBOARDING HANDLER] Erro ao salvar credenciais para ${actorClient.phone}: ${e.message}`);
                        onboardingReply = `Opa! Tive um problema para salvar seus dados: ${e.message}. Poderia tentar novamente?`;
                    }
                }
            }
        // ============================================================================
        // === FIM DA LÓGICA REESTRUTURADA ===
        // ============================================================================
        
        } else if (state.data.onboardingStage === 'setting_up_pf_account_name') {
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
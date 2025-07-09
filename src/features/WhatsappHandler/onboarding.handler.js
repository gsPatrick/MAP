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

function getOnboardingAskForEmailMessage(clientName, planDetailsText, isSharedContext = false) {
    if (isSharedContext) {
        const aiIntro = `🎉 E aí, ${clientName}! Bem-vindo(a) ao acesso compartilhado!`;
        const dataStructure = `📧 Para podermos criar seu login de acesso à plataforma web (caso queira usar no futuro), qual é o seu melhor e-mail?`;
        const linkText = `Fique tranquilo, esta etapa é só para garantir seu acesso futuro à plataforma. Para usar o WhatsApp, não será necessário.`;
        return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
    }
    const aiIntro = `🎉 E aí, ${clientName}! Seja muito bem-vindo ao seu ${planDetailsText}! 🚀`;
    const dataStructure = `📋 Detalhes do Plano:\n\n` +
                          `🗓️ Validade: ${planDetailsText.includes('válido até') ? planDetailsText.split('válido até ')[1].replace(')!','').trim() : (planDetailsText.toLowerCase().includes('vitalício') ? 'Vitalício' : 'N/A')}\n`+
                          `💼 Tipo: ${planDetailsText.split(' (')[0].trim()}\n` +
                          `🌐 Acesso: Configuração do login para o app web`;
    const linkText = `📧 Para finalizar seu cadastro, me diga qual é o melhor e-mail para usarmos no acesso. Assim você poderá conferir tudo detalhado quando quiser!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForPasswordMessage(clientName, email) {
    const aiIntro = `👍 Perfeito, ${clientName}! Seu e-mail ${email} foi anotado com sucesso! 🎉`;
    const dataStructure = `🔐 Próximo passo:\n\n` +
                          `✍️ Crie uma senha bem legal e segura, com pelo menos 6 caracteres, para proteger suas informações com total segurança.`;
    const linkText = `🛡️ Segurança em primeiro lugar para manter tudo protegido!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForFullNameMessage(clientName, isSharedContext = false, ownerName = 'O proprietário') {
    if (isSharedContext) {
        // <<< INÍCIO DA ALTERAÇÃO DA MENSAGEM >>>
        const aiIntro = `Olá, ${clientName}! 👋 Bem-vindo(a) ao Acesso Compartilhado do NoControle! Que legal ter você por aqui para ajudar a gerenciar as contas de *${ownerName}*. 🤝`;
        
        const dataStructure = `*O que isso significa?*\n`+
                              `Significa que *${ownerName}* confia em você e te concedeu permissão para visualizar e registrar informações em nome dele(a). 📊 Você funcionará como um "braço direito", ajudando a manter tudo organizado!\n\n`+
                              `*O que você poderá fazer?*\n`+
                              `✅ Lançar despesas e receitas\n`+
                              `✅ Agendar compromissos\n`+
                              `✅ Consultar resumos e saldos`;
                              
        const linkText = `Para começarmos, e para que suas ações fiquem corretamente identificadas para o proprietário, por favor, me diga o seu *nome completo*.`;

        return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
        // <<< FIM DA ALTERAÇÃO DA MENSAGEM >>>
    }
    // Mensagem original para o dono da conta
    const aiIntro = `🔐 Senha guardada com todo carinho e segurança! 🗝️`;
    const dataStructure = `😊 Agora, para a gente se conhecer melhor, qual nome completo podemos usar no seu perfil?`;
    const linkText = `📊 Assim seu cadastro fica completinho e personalizado para você!`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForAffiliateCodeMessage(clientName, isSharedContext = false) {
    // A pergunta sobre afiliado pode ser a mesma para ambos, pois é sobre como o convidado conheceu a plataforma
    const aiIntro = isSharedContext 
        ? `Perfeito, ${clientName}! Agora o proprietário saberá quem está acessando. 👍`
        : `Legal, ${clientName}! Nome anotado. 😊`;
    const dataStructure = `🤝 Para finalizar: você foi indicado(a) por alguém para usar o NoControle? Se sim, digite o código de indicação aqui.`;
    const linkText = `Se não foi indicado(a), não tem problema! É só digitar "não" ou "pular" que a gente continua. 😉`;
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
    const clientNameToUse = state.clientName;
    const lowerMessageText = (messageText || "").toLowerCase().trim();
    const isSharedContext = state.isSharedAccessContext;

    // Se for um usuário convidado (shared context) e ele ainda não tem nome, vamos pedir apenas isso.
    if (isSharedContext && (!actorClient.name || actorClient.name.startsWith('Convidado') || actorClient.name === state.pushNameFromPayload)) {
        // Se já estamos aguardando o nome, processa a entrada
        if (state.currentAction === 'awaiting_shared_user_name') {
            const nameInput = messageText.trim();
            if (nameInput.length >= 3 && nameInput.includes(" ")) {
                // Atualiza o nome do cliente convidado
                const updatedClient = await clientService.updateClient(actorClient.id, { name: nameInput });
                state.clientName = updatedClient.name.split(" ")[0]; // Atualiza o primeiro nome no estado
                actorClient = updatedClient; // Atualiza o objeto do ator
                
                // Finaliza o onboarding do convidado e o move para a seleção de conta
                state.data.onboardingStage = 'onboarding_complete';
                state.currentAction = 'selecting_account_flow_active';
                state.activeFinancialAccountId = null;
                onboardingReply = `Perfeito, ${state.clientName}! Nome salvo. Agora o proprietário saberá que é você. 😊\n\nVamos começar? Qual das contas compartilhadas você gostaria de usar agora?`;
            } else {
                onboardingReply = `Para um toque mais pessoal, ${clientNameToUse}, poderia me dizer seu nome completo? ✨ Assim o proprietário da conta te identifica melhor!`;
            }
        } else {
            // Se ainda não pedimos o nome, pede agora com a nova mensagem.
            state.currentAction = 'awaiting_shared_user_name';
            // <<< CORREÇÃO: Passando o nome do proprietário para a mensagem >>>
            onboardingReply = getOnboardingAskForFullNameMessage(clientNameToUse, true, state.ownerClientNameForContext);
        }
        return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
    }

    // Fluxo normal de onboarding para proprietários de conta ou convidados que já têm nome
    if (state.data.onboardingStage === 'awaiting_plan_confirmation') {
        if(state.hasPaidAccess_whenStageLastSet || !state.isNewUserForSessionLogic) {
            onboardingReply = getOnboardingWelcomeNoPlanMessage(clientNameToUse);
        }
        state.currentAction = 'awaiting_plan_interest_generic';
    } else if (state.data.onboardingStage === 'setting_up_credentials_email') {
         if (state.currentAction !== 'awaiting_input_email_for_credentials' || state.isNewUserForSessionLogic) {
             onboardingReply = getOnboardingAskForEmailMessage(clientNameToUse, state.accessLevelTextForUser, isSharedContext);
             state.currentAction = 'awaiting_input_email_for_credentials';
        } else { 
            const emailInput = messageText.trim();
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (emailRegex.test(emailInput)) {
                state.data.tempEmail = emailInput;
                onboardingReply = getOnboardingAskForPasswordMessage(clientNameToUse, emailInput);
                state.data.onboardingStage = 'setting_up_credentials_password';
                state.currentAction = 'awaiting_input_password_for_credentials';
            } else {
                onboardingReply = `Opa, ${clientNameToUse}! Esse e-mail não me pareceu muito certo... 🤔 Poderia tentar de novo, por favor? Algo como "seu_nome@exemplo.com".`;
            }
        }
    } else if (state.data.onboardingStage === 'setting_up_credentials_password') {
        const passwordInput = messageText.trim();
        if (passwordInput.length >= 6) {
            state.data.tempPassword = passwordInput;
            onboardingReply = getOnboardingAskForFullNameMessage(clientNameToUse, isSharedContext, state.ownerClientNameForContext);
            state.data.onboardingStage = 'setting_up_credentials_name';
            state.currentAction = 'awaiting_input_name_for_credentials';
        } else {
            onboardingReply = `Para sua segurança, ${clientNameToUse}, a senha precisa ter pelo menos 6 caracteres. 😉 Pode me dizer uma senha um pouquinho maior?`;
        }
    } else if (state.data.onboardingStage === 'setting_up_credentials_name') {
        const nameInput = messageText.trim();
        if (nameInput.length >= 3 && nameInput.includes(" ")) {
            state.data.tempName = nameInput;
            onboardingReply = getOnboardingAskForAffiliateCodeMessage(clientNameToUse, isSharedContext);
            state.data.onboardingStage = 'setting_up_affiliate_code';
            state.currentAction = 'awaiting_input_affiliate_code';
        } else {
            onboardingReply = `Para um toque mais pessoal, ${clientNameToUse}, poderia me dizer seu nome completo? ✨ Assim fica mais bacana no seu perfil!`;
        }
    } else if (state.data.onboardingStage === 'setting_up_affiliate_code') {
        const codeInput = messageText.trim().toUpperCase();
        let affiliateCodeToUse = null;
        if (codeInput !== "NÃO" && codeInput !== "NAO" && codeInput !== "PULAR") {
            affiliateCodeToUse = codeInput;
        }
        try {
            await clientAuthService.setClientCredentialsAndAffiliate(
                actorClient.phone, state.data.tempPassword, state.data.tempName, state.data.tempEmail, affiliateCodeToUse
            );
            const updatedActorClient = await clientService.findClientByPhone(actorClient.phone);
            if (updatedActorClient) actorClient = updatedActorClient;
            state.clientName = actorClient.name.split(" ")[0];
            logger.info(`[ONBOARDING HANDLER] Credenciais e indicação (código: ${affiliateCodeToUse}) definidas para ATOR ${actorClient.phone}.`);
            delete state.data.tempEmail; delete state.data.tempPassword; delete state.data.tempName;
            
            if (isSharedContext) {
                state.data.onboardingStage = 'onboarding_complete';
                const aiIntro = `Maravilha, ${clientNameToUse}! Suas credenciais para a plataforma web estão configuradas! 🎉`;
                const dataStructure = `Agora você pode acessar as contas de ${state.ownerClientNameForContext} com o plano ${state.accessLevelTextForUser}.`;
                const linkText = `Vamos ver quais contas estão disponíveis?`;
                onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                state.currentAction = 'selecting_account_flow_active'; 
                state.activeFinancialAccountId = null; 
            } else {
                const actorAccounts = await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true });
                const hasPfActor = actorAccounts.some(acc => acc.accountType === 'PF');
                if (!hasPfActor) {
                    state.data.onboardingStage = 'setting_up_pf_account_name';
                    onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
                    state.currentAction = 'awaiting_input_pf_name';
                } else {
                    const hasPjMeiActor = actorAccounts.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                    const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                    if (planTier === 'avancado' && !hasPjMeiActor) {
                        state.data.onboardingStage = 'confirming_pj_mei_setup';
                        const pfAccName = actorAccounts.find(a => a.accountType === 'PF')?.accountName || "Pessoal";
                        onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, pfAccName, state.accessLevelTextForUser);
                        state.currentAction = 'awaiting_pj_mei_confirm';
                    } else {
                        state.data.onboardingStage = 'onboarding_complete';
                        const aiIntro = `Uhuul, ${clientNameToUse}! Tudo certo com seu acesso e credenciais! 🎉`;
                        const dataStructure = `💼 O plano ${state.accessLevelTextForUser} ${state.isSharedAccessContext ? `de ${state.ownerClientNameForContext} ` : ''}está pronto para uso!`;
                        const linkText = `Como posso te ajudar agora? 🚀`;
                        onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                        state.currentAction = null;
                    }
                }
            }
        } catch (e) { 
            logger.error(`[ONBOARDING HANDLER] Erro ao definir credenciais/afiliado para ATOR ${actorClient.phone}: ${e.message}`);
            if (e.message && e.message.toLowerCase().includes('email já está em uso')) {
                 onboardingReply = `Puxa, ${clientNameToUse}, parece que o e-mail "${state.data.tempEmail}" já está sendo usado por outra pessoa. 😬 Você teria outro e-mail para cadastrarmos?`;
                 state.data.onboardingStage = 'setting_up_credentials_email';
                 state.currentAction = 'awaiting_input_email_for_credentials';
                 delete state.data.tempEmail; delete state.data.tempPassword;
            } else {
                onboardingReply = `Xi, ${clientNameToUse}, algo não saiu como o esperado ao salvar seus dados. 😥 Vamos tentar seu nome completo de novo?`;
                state.data.onboardingStage = 'setting_up_credentials_name'; 
                state.currentAction = 'awaiting_input_name_for_credentials';
            }
        }
    } else if (state.data.onboardingStage === 'setting_up_pf_account_name') {
         if (isSharedContext) { 
            state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null;
        } else if (state.currentAction !== 'awaiting_input_pf_name' || state.isNewUserForSessionLogic) {
            onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
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
                        onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, pfAccountName, state.accessLevelTextForUser);
                        state.currentAction = 'awaiting_pj_mei_confirm';
                    } else {
                        state.data.onboardingStage = 'onboarding_complete';
                        const aiIntro = `Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameToUse}! 🏦`;
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
                onboardingReply = `Esse nome parece um pouquinho curto ou um cadinho longo demais, ${clientNameToUse}. Para sua conta Pessoal, que tal um nome entre 3 e 50 letras? Assim fica perfeito! ✍️`;
            }
        }
    } else if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
        if (isSharedContext) {
            state.data.onboardingStage = 'onboarding_complete'; state.currentAction = null;
         } else if (state.currentAction !== 'awaiting_pj_mei_confirm' || state.isNewUserForSessionLogic) {
            const actorPFAccount = (await clientService.getClientFinancialAccounts(actorClient.id, { isActive: true })).find(a => a.accountType === 'PF');
            onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, actorPFAccount?.accountName || "Pessoal", state.accessLevelTextForUser);
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
                    onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameToUse, pjMeiType);
                    state.data.onboardingStage = 'creating_pj_mei_account_name';
                    state.currentAction = 'awaiting_input_pj_mei_name';
                } else {
                    onboardingReply = getOnboardingAskForPJTypeMessage(clientNameToUse);
                    state.data.onboardingStage = 'awaiting_pj_mei_type';
                    state.currentAction = 'awaiting_input_pj_mei_type';
                }
            } else {
                const aiIntro = `Tranquilo, ${clientNameToUse}! Sem pressa. Se mais pra frente você quiser adicionar sua conta empresarial, é só me avisar! 😉`;
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
                onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameToUse, typeInput);
                state.data.onboardingStage = 'creating_pj_mei_account_name';
                state.currentAction = 'awaiting_input_pj_mei_name';
            } else {
                onboardingReply = `Por favor, ${clientNameToUse}, me diga se é "PJ" ou "MEI" para sua conta empresarial. Assim a gente configura tudo certinho! 😊`;
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
                    onboardingReply = getOnboardingCompanyCreatedMessage(clientNameToUse, companyType, companyName, personalAccountName);
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
                onboardingReply = `Para o nome da sua ${companyType}, ${clientNameToUse}, que tal algo entre 3 e 50 letras? Assim fica bem bacana! 🌟`;
            }
        }
    }

    return { onboardingReply, updatedState: state, updatedActorClient: actorClient };
}

module.exports = {
    handleOnboardingStep,
    getOnboardingWelcomeNoPlanMessage
};
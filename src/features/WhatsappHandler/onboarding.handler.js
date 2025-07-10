
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
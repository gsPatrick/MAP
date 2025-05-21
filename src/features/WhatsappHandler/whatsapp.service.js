// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const clientAuthService = require('../ClientAuth/clientAuth.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service');

const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8;
const MAX_STATE_HISTORY = 20;

// --- Helper Functions (mantidas como antes) ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) { /* ... */ }
async function findCreditCardIdByName(name, financialAccountId) { /* ... */ }
async function findProductIdByNameOrCode(nameOrCode, financialAccountId) { /* ... */ }

// --- Funções de Formatação de Resumo (mantidas como antes) ---
function formatFinancialTransactionSummary(transaction, clientName, forMulti = false, forEdit = false) { /* ... */ }
function formatAppointmentSummary(appointment, clientName, forMulti = false, forEdit = false) { /* ... */ }
function formatRecurringRuleSummary(rule, clientName, forMulti = false, forEdit = false) { /* ... */ }
function formatProductSummary(product, clientName, forMulti = false, forEdit = false) { /* ... */ }
function formatCreditCardSummary(card, clientName, forMulti = false, forEdit = false) { /* ... */ }
function formatCreditCardInvoiceSummary(invoiceDetails, clientName, listTransactions = true) { /* ... */ }
function formatAvailableLimitSummary(limitInfo, clientName) { /* ... */ }
function formatParcelledAccountSummary(params, parcelResult, clientName, forEdit = false) { /* ... */ }


// --- Initialize State ---
function initializeState(client, defaultAccount = null, clientFinancialAccounts = []) {
    const clientName = client ? (client.name || "pessoa incrível") : "pessoa incrível";

    let hasPaidAccess = false;
    let clientAccessLevel = client ? (client.accessLevel || 'gratuito') : 'gratuito';
    let clientAccessExpiresAt = client ? client.accessExpiresAt : null;
    let accessLevelTextForUser = "Nenhum plano ativo";
    let onboardingStage = 'awaiting_plan_confirmation';

    if (client) {
        if (client.accessLevel && client.accessLevel !== 'gratuito') {
            if (client.accessLevel.startsWith('vitalicio_')) {
                hasPaidAccess = true;
                accessLevelTextForUser = client.accessLevel.replace('vitalicio_', 'Vitalício ').replace('_', ' ');
            } else if (client.accessExpiresAt) {
                const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0, 0, 0, 0);
                if (expiryDate >= today) {
                    hasPaidAccess = true;
                    accessLevelTextForUser = `${client.accessLevel.replace(/_/g, ' ')} (expira em ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
                } else {
                    accessLevelTextForUser = `Plano ${client.accessLevel.replace(/_/g, ' ')} expirado`;
                    clientAccessLevel = 'gratuito';
                }
            } else {
                logger.warn(`[WHATSAPP SERVICE - InitializeState] Cliente ${client.id} com accessLevel ${client.accessLevel} mas sem accessExpiresAt. Considerando como sem plano pago.`);
                clientAccessLevel = 'gratuito';
            }
        }
    }
    
    if (hasPaidAccess) {
        if (!client.email || !client.passwordHash) {
            onboardingStage = 'setting_up_credentials_email';
        } else {
            const hasPf = clientFinancialAccounts.some(acc => acc.accountType === 'PF');
            if (!hasPf) {
                 onboardingStage = 'setting_up_pf_account_name';
            } else {
                 const hasPjMei = clientFinancialAccounts.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                 if (clientAccessLevel.startsWith('avancado') && !hasPjMei) {
                    onboardingStage = 'confirming_pj_mei_setup';
                 } else {
                    onboardingStage = 'onboarding_complete';
                 }
            }
        }
    }

    const newState = {
        currentAction: null, 
        data: { onboardingStage }, 
        activeFinancialAccountId: defaultAccount && hasPaidAccess && onboardingStage === 'onboarding_complete' ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount && hasPaidAccess && onboardingStage === 'onboarding_complete' ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount && hasPaidAccess && onboardingStage === 'onboarding_complete' ? defaultAccount.accountType : null,
        clientName: clientName,
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null,
        lastAiResponse: null,
        
        currentAccessLevel: clientAccessLevel, 
        accessExpiresAt: clientAccessExpiresAt,
        hasPaidAccess: hasPaidAccess,
        accessLevelTextForUser: accessLevelTextForUser,
    };
    
    logger.debug(`[WHATSAPP SERVICE - InitializeState] Estado inicial para cliente ${client ? client.id : 'novo'}: `, {
        onboardingStage: newState.data.onboardingStage,
        hasPaidAccess: newState.hasPaidAccess,
        currentAccessLevel: newState.currentAccessLevel,
    });
    return newState;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    try {
        let client = await clientService.findClientByPhone(senderPhone);
        let isNewClientForSession = !conversationState.has(senderPhone); // Se não tem estado, é como se fosse nova sessão para o state
        let clientFinancialAccounts = [];

        if (!client) {
            logger.info(`[WHATSAPP SERVICE] Cliente com telefone ${senderPhone} não encontrado no banco. Criando novo...`);
            client = await clientService.createClient({ phone: senderPhone, name: pushName });
            logger.info(`[WHATSAPP SERVICE] Novo Cliente criado: ID ${client.id}, Telefone: ${client.phone}, Nome: ${client.name}`);
            // clientFinancialAccounts ainda estará vazio aqui
        } else {
            clientFinancialAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
        }
        
        state = conversationState.get(senderPhone) || initializeState(client, await clientService.getActiveOrDefaultFinancialAccount(client.id), clientFinancialAccounts);
        
        const clientNameToUse = client.name && client.name.trim() !== "" && client.name.trim().toLowerCase() !== "unknown" && client.name.trim().toLowerCase() !== "null"
            ? client.name.split(" ")[0]
            : (pushName || "pessoa incrível");
        state.clientName = clientNameToUse; // Atualiza sempre o nome no estado

        // RE-SINCRONIZAÇÃO CRUCIAL DO ESTADO DO PLANO E ONBOARDING STAGE
        let previousHasPaidAccess = state.hasPaidAccess;
        let currentHasPaidAccess = false;
        let currentAccessLevelTextForUser = "Nenhum plano ativo";
        let currentClientAccessLevel = client.accessLevel || 'gratuito';

        if (client.accessLevel && client.accessLevel !== 'gratuito') {
            if (client.accessLevel.startsWith('vitalicio_')) {
                currentHasPaidAccess = true;
                currentAccessLevelTextForUser = client.accessLevel.replace('vitalicio_', 'Vitalício ').replace('_', ' ');
            } else if (client.accessExpiresAt) {
                const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
                const today = new Date(); today.setUTCHours(0, 0, 0, 0);
                if (expiryDate >= today) {
                    currentHasPaidAccess = true;
                    currentAccessLevelTextForUser = `${client.accessLevel.replace(/_/g, ' ')} (expira em ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
                } else {
                    currentAccessLevelTextForUser = `Plano ${client.accessLevel.replace(/_/g, ' ')} expirado`;
                    currentClientAccessLevel = 'gratuito';
                }
            } else {
                currentClientAccessLevel = 'gratuito';
            }
        }
        state.hasPaidAccess = currentHasPaidAccess;
        state.currentAccessLevel = currentClientAccessLevel;
        state.accessExpiresAt = client.accessExpiresAt;
        state.accessLevelTextForUser = currentAccessLevelTextForUser;

        // SE O PLANO FOI ATIVADO DESDE A ÚLTIMA INTERAÇÃO, REAVALIA onboardingStage
        if (state.hasPaidAccess && !previousHasPaidAccess && state.data.onboardingStage === 'awaiting_plan_confirmation') {
             logger.info(`[WHATSAPP SERVICE] Cliente ${client.id} adquiriu plano. Reavaliando onboarding stage a partir de 'awaiting_plan_confirmation'.`);
             if (!client.email || !client.passwordHash) {
                state.data.onboardingStage = 'setting_up_credentials_email';
                state.currentAction = null; // Limpa qualquer sub-ação anterior
             } else {
                const hasPf = clientFinancialAccounts.some(acc => acc.accountType === 'PF');
                if (!hasPf) {
                    state.data.onboardingStage = 'setting_up_pf_account_name';
                    state.currentAction = null;
                } else {
                    const hasPjMei = clientFinancialAccounts.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                    if (state.currentAccessLevel.startsWith('avancado') && !hasPjMei) {
                        state.data.onboardingStage = 'confirming_pj_mei_setup';
                        state.currentAction = null;
                    } else {
                        state.data.onboardingStage = 'onboarding_complete';
                        state.currentAction = null;
                        // Se onboarding está completo e não tem conta ativa, mas tem contas, seleciona a default
                        if (!state.activeFinancialAccountId && clientFinancialAccounts.length > 0) {
                            const defaultAcc = clientFinancialAccounts.find(a => a.isDefault) || clientFinancialAccounts[0];
                            if (defaultAcc) {
                                state.activeFinancialAccountId = defaultAcc.id;
                                state.activeFinancialAccountName = defaultAcc.accountName;
                                state.activeFinancialAccountType = defaultAcc.accountType;
                            }
                        }
                    }
                }
             }
             isNewClientForSession = true; // Trata como se fosse uma nova sessão para o fluxo de onboarding
        }


        if (!(rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string')) {
            state.messageHistory.push({ role: 'user', content: messageText });
        }
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }
        
        let onboardingReply = "";
        const lowerMessageText = messageText.toLowerCase().trim();
        const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";

        // ---- FLUXO DE ONBOARDING COM state.data.onboardingStage ----
        logger.debug(`[WHATSAPP ONBOARDING] Iniciando checagem de onboarding. Stage: ${state.data.onboardingStage}, currentAction: ${state.currentAction}, isNewClientForSession: ${isNewClientForSession}`);

        if (state.data.onboardingStage === 'awaiting_plan_confirmation') {
            // Se o usuário mandar "sim" ou algo do tipo E ele ainda não viu a info do plano
            if (state.currentAction !== 'showing_plans_info_after_no_plan' && (lowerMessageText === 'sim' || lowerMessageText === 's' || lowerMessageText.includes('quero') || lowerMessageText.includes('saber mais'))) {
                onboardingReply = `Que legal que você quer saber mais, ${clientNameToUse}! 🎉\n\n` +
                              `Temos dois tipos de planos incríveis para você decolar suas finanças:\n\n` +
                              `🚀 *Plano Básico (Mensal ou Anual):* Perfeito para organizar suas finanças pessoais (PF) com todas as ferramentas que você precisa! \n\n` +
                              `🌟 *Plano Avançado (Mensal ou Anual):* Turbine sua gestão! Além de todas as funcionalidades do Pessoal, você ainda gerencia as finanças da sua empresa (PJ) ou MEI, incluindo controle de estoque! \n\n` +
                              `Para ver os valores e todos os detalhes de cada um, e garantir o seu, é só acessar: ${siteUrl}\n\n` +
                              `Depois de escolher e assinar, me manda um "oi" por aqui que eu já libero tudo pra você! Mal posso esperar! 😉`;
                state.currentAction = 'showing_plans_info_after_no_plan';
            } else if (state.currentAction !== 'showing_plans_info_after_no_plan') { // Se não é "sim" e não acabou de mostrar os planos
                onboardingReply = `Olá ${clientNameToUse}! Tudo pronto para simplificar suas finanças? 🚀\n\n` +
                              `Para usar o ${aiModelService.ASSISTANT_NAME} e ter suas contas na palma da mão, você precisa de um dos nossos planos. ` +
                              `Temos opções mensais e anuais, tanto para suas finanças pessoais quanto para sua empresa!\n\n` +
                              `Quer saber mais detalhes sobre eles por aqui? Só dizer *"sim"*! 😊\n\n` +
                              `Ou, se preferir, pode ir direto para nossa página de planos e já garantir o seu: ${siteUrl}\n\n` +
                              `Assim que seu plano estiver ativo, é só me dar um "oi" para começarmos a mágica! ✨`;
                state.currentAction = 'awaiting_plan_interest_generic';
            }
            // Se currentAction é 'showing_plans_info_after_no_plan', ele já recebeu a info, aguarda "oi" ou outra msg.
        } else if (state.data.onboardingStage === 'setting_up_credentials_email') {
            if (isNewClientForSession || state.currentAction !== 'awaiting_input_email_for_credentials') {
                 onboardingReply = `E aí, ${clientNameToUse}! Boas-vindas ao seu plano ${state.accessLevelTextForUser}! 🎉\n\nPara que você também possa acessar nosso aplicativo web e ver tudo detalhado, vamos configurar seu acesso rapidinho. Qual o seu melhor e-mail para usarmos? 📧`;
                 state.currentAction = 'awaiting_input_email_for_credentials';
            } else { // Usuário enviou algo, esperamos que seja o e-mail
                const emailInput = messageText.trim();
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (emailRegex.test(emailInput)) {
                    state.data.tempEmail = emailInput;
                    onboardingReply = `Perfeito, e-mail ${emailInput} anotado com sucesso! 👍 Agora, por favor, crie uma senha bem legal e segura (com pelo menos 6 caracteres, ok?) para proteger suas informações. 🛡️`;
                    state.data.onboardingStage = 'setting_up_credentials_password';
                    state.currentAction = 'awaiting_input_password_for_credentials';
                } else {
                    onboardingReply = `Opa, ${clientNameToUse}! Esse e-mail não me pareceu muito certo... 🤔 Poderia tentar de novo, por favor? Algo como "seu_nome@exemplo.com".`;
                    // Mantém currentAction e onboardingStage
                }
            }
        } else if (state.data.onboardingStage === 'setting_up_credentials_password') {
            // state.currentAction já deve ser 'awaiting_input_password_for_credentials'
            const passwordInput = messageText.trim();
            if (passwordInput.length >= 6) {
                state.data.tempPassword = passwordInput;
                onboardingReply = `Senha guardada com todo carinho e segurança! 🗝️ E para a gente se conhecer um pouquinho melhor, qual nome completo podemos usar no seu perfil? 😊`;
                state.data.onboardingStage = 'setting_up_credentials_name';
                state.currentAction = 'awaiting_input_name_for_credentials';
            } else {
                onboardingReply = `Para sua segurança, ${clientNameToUse}, a senha precisa ter pelo menos 6 caracteres. 😉 Pode me dizer uma senha um pouquinho maior?`;
            }
        } else if (state.data.onboardingStage === 'setting_up_credentials_name') {
            // state.currentAction já deve ser 'awaiting_input_name_for_credentials'
            const nameInput = messageText.trim();
            if (nameInput.length >= 3 && nameInput.includes(" ")) { 
                try {
                    await clientAuthService.setClientCredentials(senderPhone, state.data.tempPassword, nameInput, state.data.tempEmail);
                    client = await clientService.findClientByPhone(senderPhone); 
                    state.clientName = client.name.split(" ")[0];
                    logger.info(`[WHATSAPP ONBOARDING] Credenciais definidas para ${senderPhone}.`);
                    delete state.data.tempEmail; delete state.data.tempPassword; // Limpa dados temporários
                    state.currentAction = null;
                    
                    clientFinancialAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true }); // Atualiza lista de contas
                    const hasPf = clientFinancialAccounts.some(acc => acc.accountType === 'PF');
                    if (!hasPf) {
                        state.data.onboardingStage = 'setting_up_pf_account_name';
                        onboardingReply = `Uhuul, ${clientNameToUse}! Tudo certo com seu acesso e credenciais! 🎉\n\nAgora, vamos criar sua primeira conta financeira para seus gastos pessoais (PF). Qual nome você gostaria de dar pra ela? Algo como "Minhas Contas" ou "Pessoal do(a) ${clientNameToUse}" seria legal! 📝`;
                        state.currentAction = 'awaiting_input_pf_name';
                    } else {
                        // Se já tem PF, verifica PJ/MEI
                        const hasPjMei = clientFinancialAccounts.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                        if (state.currentAccessLevel.startsWith('avancado') && !hasPjMei) {
                            state.data.onboardingStage = 'confirming_pj_mei_setup';
                             onboardingReply = `Uhuul, ${clientNameToUse}! Tudo certo com seu acesso e credenciais! 🎉\n\nComo você tem o plano ${state.accessLevelTextForUser.split(' (')[0]}, que tal configurarmos também uma conta para sua empresa (PJ) ou MEI? (Responda "sim" ou "não") ✨`;
                             state.currentAction = 'awaiting_pj_mei_confirm';
                        } else {
                            state.data.onboardingStage = 'onboarding_complete';
                            onboardingReply = `Uhuul, ${clientNameToUse}! Tudo certo com seu acesso e credenciais! 🎉 Seu plano ${state.accessLevelTextForUser.split(' (')[0]} está pronto para uso! Como posso te ajudar agora? 🚀`;
                        }
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP ONBOARDING] Erro ao definir credenciais para ${senderPhone}: ${e.message}`);
                    if (e.message && e.message.toLowerCase().includes('email já está em uso')) {
                         onboardingReply = `Puxa, ${clientNameToUse}, parece que o e-mail "${state.data.tempEmail}" já está sendo usado por outra pessoa. 😬 Você teria outro e-mail para cadastrarmos?`;
                         state.data.onboardingStage = 'setting_up_credentials_email'; // Volta para pedir email
                         state.currentAction = 'awaiting_input_email_for_credentials';
                         delete state.data.tempEmail; delete state.data.tempPassword; 
                    } else {
                        onboardingReply = `Xi, ${clientNameToUse}, algo não saiu como o esperado ao salvar seus dados (${e.message.substring(0,60)}). 😥 Vamos tentar seu nome completo de novo?`;
                    }
                }
            } else {
                onboardingReply = `Para um toque mais pessoal, ${clientNameToUse}, poderia me dizer seu nome completo? ✨ Assim fica mais bacana no seu perfil!`;
            }
        } else if (state.data.onboardingStage === 'setting_up_pf_account_name') {
            // state.currentAction já deve ser 'awaiting_input_pf_name'
            const pfAccountName = messageText.trim();
            if (pfAccountName.length >= 3 && pfAccountName.length <= 50) {
                try {
                    const newPfAccount = await clientService.createFinancialAccount(client.id, {
                        accountName: pfAccountName, accountType: 'PF', isDefault: true 
                    });
                    state.activeFinancialAccountId = newPfAccount.id;
                    state.activeFinancialAccountName = newPfAccount.accountName;
                    state.activeFinancialAccountType = newPfAccount.accountType;
                    logger.info(`[WHATSAPP ONBOARDING] Conta PF "${pfAccountName}" criada para ${senderPhone}.`);
                    state.currentAction = null;
                    clientFinancialAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true }); // Atualiza

                    const hasPjMei = clientFinancialAccounts.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                    if (state.currentAccessLevel.startsWith('avancado') && !hasPjMei) {
                        state.data.onboardingStage = 'confirming_pj_mei_setup';
                        onboardingReply = `Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameToUse}! 🏦 Ela já está selecionada!\n\nComo você tem o plano ${state.accessLevelTextForUser.split(' (')[0]}, que tal configurarmos também uma conta para sua empresa (PJ) ou MEI? (Responda "sim" ou "não") ✨`;
                        state.currentAction = 'awaiting_pj_mei_confirm';
                    } else {
                        state.data.onboardingStage = 'onboarding_complete';
                        onboardingReply = `Conta Pessoal "${pfAccountName}" criada com sucesso, ${clientNameToUse}! 🏦 Ela já está selecionada e seu plano ${state.accessLevelTextForUser.split(' (')[0]} está pronto para uso! Como posso te ajudar agora? 🚀`;
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta PF "${pfAccountName}" para ${senderPhone}: ${e.message}`);
                    onboardingReply = `Opa! 😬 Tive um probleminha para criar a conta "${pfAccountName}" (${e.message.substring(0,60)}). Que tal a gente tentar um nome diferente?`;
                }
            } else {
                onboardingReply = `Esse nome parece um pouquinho curto ou um cadinho longo demais, ${clientNameToUse}. Para sua conta Pessoal, que tal um nome entre 3 e 50 letras? Assim fica perfeito! ✍️`;
            }
        } else if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
            // state.currentAction já deve ser 'awaiting_pj_mei_confirm'
            if (lowerMessageText === 'sim' || lowerMessageText === 's' || lowerMessageText.includes('quero')) {
                onboardingReply = `Excelente, ${clientNameToUse}! 👍 Essa sua nova conta será para uma *Empresa (PJ)* ou para seu *Microempreendedor Individual (MEI)*? Me diga "PJ" ou "MEI" para eu saber.`;
                state.data.onboardingStage = 'awaiting_pj_mei_type';
                state.currentAction = 'awaiting_input_pj_mei_type';
            } else {
                onboardingReply = `Tranquilo, ${clientNameToUse}! Sem pressa. Se mais pra frente você quiser adicionar sua conta empresarial, é só me avisar! 😉\n\nSua conta "${state.activeFinancialAccountName || 'Pessoal'}" está prontinha para uso com seu plano ${state.accessLevelTextForUser.split(' (')[0]}! O que você gostaria de fazer primeiro? Estou a postos! 🚀`;
                state.data.onboardingStage = 'onboarding_complete';
                state.currentAction = null;
            }
        } else if (state.data.onboardingStage === 'awaiting_pj_mei_type') {
            // state.currentAction já deve ser 'awaiting_input_pj_mei_type'
            const typeInput = messageText.trim().toUpperCase();
            if (typeInput === 'PJ' || typeInput === 'MEI') {
                state.data.tempPjMeiType = typeInput;
                onboardingReply = `Show! Conta do tipo ${typeInput} então. E qual nome incrível vamos dar para essa sua potência empresarial? 🏢 (Ex: "Tech Solutions LTDA", "Consultoria ${clientNameToUse} MEI")`;
                state.data.onboardingStage = 'creating_pj_mei_account_name';
                state.currentAction = 'awaiting_input_pj_mei_name';
            } else {
                onboardingReply = `Por favor, ${clientNameToUse}, me diga se é "PJ" ou "MEI" para sua conta empresarial. Assim a gente configura tudo certinho! 😊`;
            }
        } else if (state.data.onboardingStage === 'creating_pj_mei_account_name') {
            // state.currentAction já deve ser 'awaiting_input_pj_mei_name'
            const companyName = messageText.trim();
            const companyType = state.data.tempPjMeiType;
            if (companyName.length >= 3 && companyName.length <= 50) {
                try {
                    await clientService.createFinancialAccount(client.id, {
                        accountName: companyName, accountType: companyType, isDefault: false 
                    });
                     onboardingReply = `Sensacional, ${clientNameToUse}! 🎊 Sua conta ${companyType} "${companyName}" foi criada e está pronta para brilhar!\n\nLembrando que sua conta "${state.activeFinancialAccountName || 'Pessoal'}" ainda está selecionada. Se quiser mudar para a conta da empresa, é só me dizer "mudar para conta ${companyName}".\n\nE aí, o que vamos fazer agora? Estou pronto para a ação! 💪`;
                    logger.info(`[WHATSAPP ONBOARDING] Conta ${companyType} "${companyName}" criada para ${senderPhone}.`);
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = null; delete state.data.tempPjMeiType;
                } catch (e) {
                    logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta ${companyType} "${companyName}" para ${senderPhone}: ${e.message}`);
                    onboardingReply = `Eita! 😬 Parece que não consegui criar a conta ${companyType} "${companyName}" (${e.message.substring(0,60)}). Será que podemos tentar um nome um pouquinho diferente?`;
                }
            } else {
                onboardingReply = `Para o nome da sua ${companyType}, ${clientNameToUse}, que tal algo entre 3 e 50 letras? Assim fica bem bacana! 🌟`;
            }
        }

        // Se uma mensagem de onboarding foi definida, envia e possivelmente retorna
        if (onboardingReply) {
            state.messageHistory.push({ role: 'assistant', content: onboardingReply });
            await sendWhatsappMessage(senderPhone, onboardingReply);
            conversationState.set(senderPhone, state);
            // Retorna se ainda estivermos em uma etapa que aguarda input do usuário para continuar o onboarding.
            if (state.data.onboardingStage !== 'onboarding_complete' && 
                (state.currentAction && (state.currentAction.startsWith('awaiting_input_') || state.currentAction.startsWith('awaiting_pj_mei_confirm') || state.currentAction.startsWith('awaiting_plan_interest')))) {
                return;
            }
        }
        
        // Se o onboardingStage é 'onboarding_complete' OU se não havia onboardingReply (fluxo normal da IA)
        if (state.data.onboardingStage === 'onboarding_complete' || !onboardingReply) {
            if (state.data.onboardingStage === 'onboarding_complete' && state.currentAction && state.currentAction.startsWith('awaiting_input_')) {
                 // Se o onboarding foi concluído, mas uma ação de input anterior não foi limpa, limpa agora.
                state.currentAction = null;
            }
            
            // SELEÇÃO DE CONTA ATIVA, se o onboarding está completo e ainda não tem conta ativa no estado.
            const currentClientAccountsAfterOnboarding = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
            if (state.data.onboardingStage === 'onboarding_complete' && !state.activeFinancialAccountId && currentClientAccountsAfterOnboarding.length > 0) {
                if (currentClientAccountsAfterOnboarding.length === 1) {
                    const acc = currentClientAccountsAfterOnboarding[0];
                    state.activeFinancialAccountId = acc.id;
                    state.activeFinancialAccountName = acc.accountName;
                    state.activeFinancialAccountType = acc.accountType;
                    const selectMsg = `Tudo pronto, ${clientNameToUse}! 🎉 Sua conta "${acc.accountName}" (${acc.accountType}) já está selecionada com seu plano ${state.accessLevelTextForUser}. Como posso te ajudar a organizar suas finanças hoje? 🚀`;
                    state.messageHistory.push({ role: 'assistant', content: selectMsg });
                    state.currentAction = null; 
                    if(state.data) state.data.accountsToList = null;
                    await sendWhatsappMessage(senderPhone, selectMsg);
                } else if (state.currentAction !== 'selecting_account_flow_active') { 
                    state.currentAction = 'selecting_account_flow_active';
                    state.data.accountsToList = currentClientAccountsAfterOnboarding.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                    let accountOptionsText = `Que bom te ver, ${clientNameToUse}! 👋 Seu plano ${state.accessLevelTextForUser} está ativo! Você tem estas contas configuradas:\n`;
                    state.data.accountsToList.forEach((acc, index) => { accountOptionsText += `\n${index + 1}. *${acc.name}* (${acc.accountType})`; });
                    accountOptionsText += `\n\nEm qual delas vamos trabalhar hoje? É só me dizer o *nome* ou o *número* da conta. Estou no aguardo! 😉`;
                    state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                    await sendWhatsappMessage(senderPhone, accountOptionsText);
                } else { 
                    const chosenIdentifier = messageText.trim();
                    let accountToSelect = null;
                    const chosenNumber = parseInt(chosenIdentifier, 10);

                    if (state.data.accountsToList && !isNaN(chosenNumber) && chosenNumber > 0 && chosenNumber <= state.data.accountsToList.length) {
                        accountToSelect = state.data.accountsToList[chosenNumber - 1];
                    } else if (state.data.accountsToList) {
                        accountToSelect = state.data.accountsToList.find(acc =>
                            acc.name.toLowerCase() === chosenIdentifier.toLowerCase() ||
                            acc.name.toLowerCase().includes(chosenIdentifier.toLowerCase())
                        );
                    }

                    if (accountToSelect) {
                        state.activeFinancialAccountId = accountToSelect.id;
                        state.activeFinancialAccountName = accountToSelect.name;
                        state.activeFinancialAccountType = accountToSelect.type;
                        const confirmSelectionMsg = `Maravilha, ${clientNameToUse}! Selecionei a conta "${state.activeFinancialAccountName}" para você. Como posso te ajudar a colocar tudo em ordem agora? 🚀`;
                        state.messageHistory.push({ role: 'assistant', content: confirmSelectionMsg });
                        state.currentAction = null; 
                        if(state.data) state.data.accountsToList = null;
                        await sendWhatsappMessage(senderPhone, confirmSelectionMsg);
                    } else {
                        let errorReply = `Hummm, ${clientNameToUse}, não consegui identificar essa conta. 😕 Poderia escolher uma da lista?\n`;
                        if (state.data.accountsToList) {
                            state.data.accountsToList.forEach((acc, index) => {errorReply += `\n${index + 1}. *${acc.name}* (${acc.type})`});
                        }
                        errorReply += "\n\nÉ só me dizer o nome ou o número. Estou aqui para ajudar! 🤔"
                        state.messageHistory.push({ role: 'assistant', content: errorReply });
                        await sendWhatsappMessage(senderPhone, errorReply);
                    }
                }
                conversationState.set(senderPhone, state);
                if (state.currentAction === 'selecting_account_flow_active' || !state.activeFinancialAccountId) return;
            } else if (state.data.onboardingStage === 'onboarding_complete' && !state.activeFinancialAccountId && currentClientAccountsAfterOnboarding.length === 0) {
                const noAccountsMsg = `Olá ${clientNameToUse}! Seu plano ${state.accessLevelTextForUser} está tinindo, mas não encontrei nenhuma conta financeira. Vamos criar sua conta Pessoal? Só dizer "criar conta pessoal"! 😉`;
                state.messageHistory.push({ role: 'assistant', content: noAccountsMsg });
                state.data.onboardingStage = 'setting_up_pf_account_name';
                state.currentAction = 'awaiting_input_pf_name';
                await sendWhatsappMessage(senderPhone, noAccountsMsg);
                conversationState.set(senderPhone, state);
                return;
            }

            // ---- PROCESSAMENTO COM IA (SE ONBOARDING COMPLETO E CONTA SELECIONADA) ----
            // ... (o restante do código de tratamento de botões, chamada da IA, execução de ações, etc.)
            // O código a partir daqui é o mesmo da versão anterior, pois assume que o onboarding e a seleção de conta já ocorreram.
            if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
                // ... (código de tratamento de botões, mantido como antes)
                const buttonId = rawPayload.selectedButtonId;
                logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ID '${buttonId}', Texto: '${messageText}'`);
                let buttonClickHandledByServiceLogic = true;
                let replyForButtonClick = "";
                let resourceTypeForEditMessage = "item";
    
                if (buttonId.startsWith('edit_transaction_')) {
                    const transactionId = buttonId.replace('edit_transaction_', '');
                    state.editingResource = { type: 'transaction', id: transactionId };
                    resourceTypeForEditMessage = "transação";
                    replyForButtonClick = `Claro, ${clientNameToUse}! 😉 Descreva na próxima mensagem o que você precisa que eu altere na ${resourceTypeForEditMessage} (ID: ${transactionId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                    state.currentAction = 'awaiting_transaction_edit_details';
                } else if (buttonId.startsWith('delete_transaction_')) {
                    const transactionId = buttonId.replace('delete_transaction_', '');
                    try {
                        await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId);
                        replyForButtonClick = `Transação removida com sucesso, ${clientNameToUse}! 👍 Se precisar de mais alguma coisa, é só chamar.`;
                    } catch (e) { 
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                        replyForButtonClick = `Ops! Tive um problema ao tentar excluir a transação. (${e.message.substring(0,70)})`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                } else if (buttonId.startsWith('edit_appointment_')) {
                    const appointmentId = buttonId.replace('edit_appointment_', '');
                    state.editingResource = { type: 'appointment', id: appointmentId };
                    resourceTypeForEditMessage = "compromisso";
                    replyForButtonClick = `Beleza, ${clientNameToUse}! ✨ Me diga na próxima mensagem o que você quer mudar no ${resourceTypeForEditMessage} (ID: ${appointmentId}).`;
                    state.currentAction = 'awaiting_appointment_edit_details';
                } else if (buttonId.startsWith('delete_appointment_')) {
                    const appointmentId = buttonId.replace('delete_appointment_', '');
                    try {
                        await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, true);
                        replyForButtonClick = `Compromisso removido da sua agenda, ${clientNameToUse}! ✅ Fico à disposição se precisar de algo mais.`;
                    } catch (e) { 
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir compromisso ${appointmentId} por botão: ${e.message}`);
                        replyForButtonClick = `Ops! Tive um problema ao tentar excluir o compromisso. (${e.message.substring(0,70)})`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                else if (buttonId.startsWith('edit_credit_card_')) {
                    const cardId = buttonId.replace('edit_credit_card_', '');
                    state.editingResource = { type: 'credit_card', id: cardId };
                    resourceTypeForEditMessage = "cartão de crédito";
                    replyForButtonClick = `Entendido, ${clientNameToUse}! 💳 O que você gostaria de alterar no ${resourceTypeForEditMessage} (ID: ${cardId})? Pode me dizer, por exemplo: "mudar o limite para 3000" ou "atualizar o dia de fechamento para 25".`;
                    state.currentAction = 'awaiting_credit_card_edit_details';
                } else if (buttonId.startsWith('delete_credit_card_')) {
                    const cardId = buttonId.replace('delete_credit_card_', '');
                    try {
                        await creditCardService.deleteCreditCard(state.activeFinancialAccountId, cardId);
                        replyForButtonClick = `Cartão de crédito removido com sucesso, ${clientNameToUse}! 🗑️`;
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir cartão ${cardId} por botão: ${e.message}`);
                        replyForButtonClick = `Ops! Tive um problema ao tentar excluir o cartão. ${e.message.includes("transações") ? "Ele ainda tem transações associadas." : `(${e.message.substring(0,70)})` }`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                } else if (buttonId.startsWith('edit_recurring_rule_')) {
                    const ruleId = buttonId.replace('edit_recurring_rule_', '');
                    state.editingResource = { type: 'recurring_rule', id: ruleId };
                    resourceTypeForEditMessage = "regra de recorrência";
                    replyForButtonClick = `Certo, ${clientNameToUse}! 🔄 O que vamos ajustar na ${resourceTypeForEditMessage} (ID: ${ruleId})? Por exemplo: "mudar o valor para 60" ou "alterar a frequência para mensal".`;
                    state.currentAction = 'awaiting_recurring_rule_edit_details';
                } else if (buttonId.startsWith('delete_recurring_rule_')) {
                    const ruleId = buttonId.replace('delete_recurring_rule_', '');
                    try {
                        await recurringTransactionService.deleteRecurringRule(state.activeFinancialAccountId, ruleId);
                        replyForButtonClick = `Regra de recorrência removida, ${clientNameToUse}! 👍`;
                    } catch (e) { 
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir regra ${ruleId} por botão: ${e.message}`);
                        replyForButtonClick = `Ops! Tive um problema ao tentar excluir a regra. (${e.message.substring(0,70)})`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                else if (buttonId.startsWith('edit_parcelled_account_')) {
                    const originalAccountId = buttonId.replace('edit_parcelled_account_', '');
                    const parcelGroupInfo = await financialService.getTransactionById(state.activeFinancialAccountId, originalAccountId);
                    let originalDescriptionForEdit = "sua compra parcelada";
                    if (parcelGroupInfo && parcelGroupInfo.isParcel && parcelGroupInfo.originalAccountId === parcelGroupInfo.id) {
                        originalDescriptionForEdit = parcelGroupInfo.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                    } else if (parcelGroupInfo) {
                        originalDescriptionForEdit = parcelGroupInfo.description;
                    }
        
                    state.editingResource = { 
                        type: 'parcelled_account', 
                        id: originalAccountId,
                        originalDescription: originalDescriptionForEdit
                    };
                    replyForButtonClick = `Ok, ${clientNameToUse}! Você quer editar a compra parcelada de "${originalDescriptionForEdit}".\n\nO que gostaria de alterar? Você pode me dizer os novos detalhes, como por exemplo: "mudar para R$250 em 5x no cartão XP com nova descrição 'Presente Dia das Mães'".\n\nLembre-se que alterar valor, número de parcelas ou o cartão irá refazer essa compra com os novos dados. Se quiser mudar apenas a descrição, diga "mudar descrição para [nova descrição]".`;
                    state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                } else if (buttonId.startsWith('delete_parcelled_account_')) {
                    const originalAccountId = buttonId.replace('delete_parcelled_account_', '');
                    try {
                        const success = await financialService.deleteParcelledAccountGroup(state.activeFinancialAccountId, originalAccountId);
                        replyForButtonClick = success ? `Compra parcelada e todas as suas parcelas foram removidas, ${clientNameToUse}! 👍` : `Não consegui remover essa compra parcelada. Pode ter ocorrido um erro.`;
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir grupo de parcelas ${originalAccountId} por botão: ${e.message}`);
                        replyForButtonClick = `Ops! Tive um problema ao tentar remover essa compra parcelada. (${e.message.substring(0,70)})`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                else {
                    buttonClickHandledByServiceLogic = false; 
                }
        
                if (buttonClickHandledByServiceLogic) {
                    state.messageHistory.push({ role: 'assistant', content: replyForButtonClick });
                    await sendWhatsappMessage(senderPhone, replyForButtonClick);
                    conversationState.set(senderPhone, state); 
                    return;
                }
            }
        
            if (state.currentAction && state.data.onboardingStage === 'onboarding_complete') {
                 let stateHandledInPreProcessing = false;
                let replyForPreProcessing = "";
        
                if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                     const lowerMsg = messageText.toLowerCase().trim();
                     if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                        if (state.pendingConfirmation.action === 'RECREATE_PARCELLED_ACCOUNT' && state.pendingConfirmation.parameters) {
                            try {
                                const { financialAccountId, originalAccountIdToDelete, newParcelData } = state.pendingConfirmation.parameters;
                                const oldParcelInfo = await financialService.getTransactionById(financialAccountId, originalAccountIdToDelete);
                                const oldDescription = oldParcelInfo ? oldParcelInfo.description.replace(/ - Parcela \d+\/\d+$/, '').trim() : "compra anterior";
        
                                const recreatedResult = await financialService.recreateParcelledAccount(financialAccountId, originalAccountIdToDelete, newParcelData);
                                
                                let successMsg = state.lastAiResponse?.detected_actions?.find(a => a.action === 'RECREATE_PARCELLED_ACCOUNT')?.action_specific_reply_suggestion;
                                if (!successMsg) {
                                    successMsg = `🎉 Sensacional, ${clientNameToUse}! Sua compra parcelada de "${oldDescription}" foi atualizada para os novos detalhes:\n\n${formatParcelledAccountSummary(newParcelData, recreatedResult, clientNameToUse, true)}`;
                                }
                                replyForPreProcessing = successMsg;
                                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                                stateHandledInPreProcessing = true;
                            } catch(e) {
                                logger.error(`[WHATSAPP SERVICE] Erro ao recriar compra parcelada após confirmação: ${e.message}`);
                                replyForPreProcessing = `Puxa, ${clientNameToUse}, algo deu errado ao tentar atualizar sua compra parcelada. 😥 (${e.message.substring(0,70)}). A compra original não foi alterada. Quer tentar de novo os detalhes ou cancelar?`;
                                state.currentAction = 'awaiting_confirmation'; 
                                stateHandledInPreProcessing = true;
                            }
                        } else {
                            replyForPreProcessing = `Entendido, ${clientNameToUse}! Confirmado! 👍 Vou prosseguir com base nisso. O que mais posso fazer?`;
                            state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                            stateHandledInPreProcessing = true;
                        }
                    } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) {
                        replyForPreProcessing = `Ok, ${clientNameToUse}, cancelado! Sem problemas. O que gostaria de fazer então? 😊`;
                        state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                        stateHandledInPreProcessing = true;
                    }
                }
                else if (state.currentAction === 'awaiting_transaction_edit_details' || 
                         state.currentAction === 'awaiting_appointment_edit_details' ||
                         state.currentAction === 'awaiting_credit_card_edit_details' || 
                         state.currentAction === 'awaiting_recurring_rule_edit_details' ||
                         state.currentAction === 'awaiting_parcelled_account_full_edit_details' ||
                         state.currentAction === 'awaiting_parcelled_account_description_edit'
                        ) {
                    stateHandledInPreProcessing = false; 
                }
                else if (state.currentAction === 'awaiting_clarification_response'){
                    stateHandledInPreProcessing = false;
                }
                
                // Sub-fluxos para criação explícita de conta pela IA (quando onboarding já está completo)
                else if (state.currentAction === 'awaiting_explicit_account_type_from_ai') {
                    const typeInput = messageText.trim().toUpperCase();
                    if (typeInput === 'PF' || typeInput === 'PJ' || typeInput === 'MEI') {
                        state.data.accountTypeToCreate = typeInput;
                        replyForPreProcessing = `Ótimo, ${clientNameToUse}! E qual nome você gostaria de dar para esta nova conta ${typeInput}? 🏷️`;
                        state.currentAction = 'awaiting_explicit_account_name_from_ai';
                    } else {
                        replyForPreProcessing = `Por favor, ${clientNameToUse}, me diga se o tipo da nova conta é "PF", "PJ" ou "MEI". 😊`;
                    }
                    stateHandledInPreProcessing = true;
                } else if (state.currentAction === 'awaiting_explicit_account_name_from_ai') {
                    const newAccName = messageText.trim();
                    const typeToCreate = state.data.accountTypeToCreate;
                    if (newAccName.length >= 3 && newAccName.length <= 50) {
                        try {
                            const currentClientAccountsForCreate = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                            const existingPjMei = currentClientAccountsForCreate.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                            if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && existingPjMei) {
                                replyForPreProcessing = `Opa, ${clientNameToUse}! Você já tem uma conta empresarial (${existingPjMei.accountType}) chamada "${existingPjMei.accountName}". Só podemos ter uma conta PJ ou MEI por vez. 😉`;
                            } else if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && !state.currentAccessLevel.startsWith('avancado')) {
                                replyForPreProcessing = `Ah, ${clientNameToUse}! Para criar uma conta empresarial (${typeToCreate}), você precisa de um dos nossos Planos Avançados. 🚀 Confira em ${siteUrl} e depois me avise! 😉`;
                                state.data.onboardingStage = 'awaiting_plan_confirmation'; // Reverte para fluxo de plano
                            } else {
                                const newFA = await clientService.createFinancialAccount(client.id, { accountName: newAccName, accountType: typeToCreate });
                                replyForPreProcessing = `Conta "${newFA.accountName}" (${newFA.accountType}) criada com sucesso, ${clientNameToUse}! 🎉 Ela já está selecionada. O que vamos fazer?`;
                                state.activeFinancialAccountId = newFA.id;
                                state.activeFinancialAccountName = newFA.accountName;
                                state.activeFinancialAccountType = newFA.accountType;
                            }
                        } catch(e) {
                            replyForPreProcessing = `Ops, não consegui criar a conta "${newAccName}" (${typeToCreate}). ${e.message.substring(0,70)}. Tente um nome diferente.`;
                        }
                    } else {
                         replyForPreProcessing = `Esse nome parece um pouco curto ou longo demais, ${clientNameToUse}. Para sua conta ${typeToCreate}, que tal um nome entre 3 e 50 letras? ✍️`;
                    }
                    state.currentAction = null; delete state.data.accountTypeToCreate;
                    stateHandledInPreProcessing = true;
                }
        
        
                if (stateHandledInPreProcessing && replyForPreProcessing) {
                    state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                    await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                    conversationState.set(senderPhone, state); 
                    if (state.currentAction === null && !state.pendingConfirmation && !state.currentAction?.startsWith('awaiting_explicit_')) return;
                }
            }
        
            logger.info(`[WHATSAPP HANDLER - PÓS-ONBOARDING] Cliente: ${client.id} (${clientNameToUse}), Plano: ${state.currentAccessLevel}, Conta Ativa: ${state.activeFinancialAccountName || 'N/A'} (ID: ${state.activeFinancialAccountId || 'N/A'}), Msg: "${messageText}"`);
            if(!state.activeFinancialAccountId && state.hasPaidAccess && state.data.onboardingStage === 'onboarding_complete') {
                 logger.error(`[WHATSAPP HANDLER CRITICAL - PÓS-ONBOARDING] Cliente ${client.id} tem acesso pago e onboarding completo, mas NENHUMA conta financeira ativa no estado ANTES DE CHAMAR A IA. Isso indica falha na seleção ou criação de conta default.`);
                 let noActiveAccountForAIMsg = `Olá ${clientNameToUse}! Notei que está tudo certo com seu plano, mas não temos uma conta financeira selecionada. `;
                 const clientAccountsForAI = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                 if (clientAccountsForAI.length > 0) {
                     noActiveAccountForAIMsg += `Você tem ${clientAccountsForAI.length} conta(s). Qual gostaria de usar?`;
                     state.currentAction = 'selecting_account_flow_active'; // Força seleção
                     state.data.accountsToList = clientAccountsForAI.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                 } else {
                     noActiveAccountForAIMsg += `Vamos configurar sua conta Pessoal agora? Diga "criar conta pessoal". 😊`;
                     state.data.onboardingStage = 'setting_up_pf_account_name';
                     state.currentAction = 'awaiting_input_pf_name';
                 }
                 state.messageHistory.push({ role: 'assistant', content: noActiveAccountForAIMsg });
                 await sendWhatsappMessage(senderPhone, noActiveAccountForAIMsg);
                 conversationState.set(senderPhone, state);
                 return;
            }
        
        
            const aiContext = {
                currentFinancialAccountId: state.activeFinancialAccountId,
                currentFinancialAccountType: state.activeFinancialAccountType,
                currentFinancialAccountName: state.activeFinancialAccountName,
                clientName: clientNameToUse,
                conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2),
                currentStateData: state.data, // Envia o .data que contém onboardingStage
                editingResource: state.editingResource,
                currentAccessLevel: state.currentAccessLevel, 
                hasPaidAccess: state.hasPaidAccess, 
            };
            const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
            logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponsePreview: JSON.stringify(aiResponse).substring(0,500) + "..."});
            state.lastAiResponse = aiResponse;
        
            if(state.currentAction && typeof state.currentAction === 'string' &&
               (state.currentAction.startsWith('awaiting_')) && 
               state.data.onboardingStage === 'onboarding_complete' &&
               (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0) ) {
                    if (!state.currentAction.includes('_edit_') && !state.currentAction.includes('_choice') && state.currentAction !== 'awaiting_confirmation' && !state.currentAction.startsWith('awaiting_explicit_')) { 
                        state.currentAction = null;
                    }
            }
            
            finalReplyParts = [];
            if (aiResponse.overall_summary_suggestion) {
                finalReplyParts.push(aiResponse.overall_summary_suggestion);
            }
        
            state.pendingConfirmation = null;
        
            singleActionFormattedResult = null;
            multipleActionFormattedResults = [];
            actionWasAnEdit = false;
            resourceForButtonsContext = null;
        
            if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
                for (const detectedAction of aiResponse.detected_actions) {
                    const params = detectedAction.parameters || {};
                    let currentActionFormatted = "";
                    let isEditActionCurrentLoop = false;
                    let actionBlockedNoAccessLoop = false;
        
                    const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SWITCH_FINANCIAL_ACCOUNT', 'CREATE_FINANCIAL_ACCOUNT'];
                    if (!state.hasPaidAccess && !publicActions.includes(detectedAction.action)) {
                        const siteUrlNoAccess = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                        currentActionFormatted = `Ah, ${clientNameToUse}, para eu poder te ajudar com "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", você precisa de um dos nossos planos (Básico ou Avançado). 🌟\n\nEles liberam todas as minhas mágicas financeiras! ✨\n\nDá uma espiadinha em ${siteUrlNoAccess} e escolha o que mais combina com você. Depois me chama aqui! 😉`;
                        state.data.onboardingStage = 'awaiting_plan_confirmation'; 
                        actionBlockedNoAccessLoop = true;
                    }
                    const accountRequiredActions = [
                        'CREATE_FINANCIAL_TRANSACTION', 'SCHEDULE_APPOINTMENT', 'CREATE_PARCELLED_ACCOUNT',
                        'UPDATE_FINANCIAL_TRANSACTION', 'UPDATE_APPOINTMENT', 'GET_FINANCIAL_SUMMARY',
                        'LIST_FINANCIAL_TRANSACTIONS', 'MARK_TRANSACTION_AS_PAID_RECEIVED',
                        'CREATE_RECURRING_RULE', 'CREATE_PRODUCT', 'GET_STOCK_INFO',
                        'RECORD_STOCK_MOVEMENT', 'LIST_APPOINTMENTS', 'CREATE_CREDIT_CARD',
                        'LIST_CREDIT_CARDS', 'LIST_RECURRING_RULES', 'UPDATE_CREDIT_CARD', 'UPDATE_RECURRING_RULE', 'UPDATE_PRODUCT',
                        'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION', 'RECREATE_PARCELLED_ACCOUNT',
                        'GET_CREDIT_CARD_INVOICE', 'GET_CREDIT_CARD_AVAILABLE_LIMIT', 'PAY_CREDIT_CARD_INVOICE'
                    ];
                    if (accountRequiredActions.includes(detectedAction.action) && !state.activeFinancialAccountId) {
                        currentActionFormatted = `Opa, ${clientNameToUse}! Para eu poder "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", preciso que você selecione uma conta financeira primeiro. Se você já configurou alguma, me diga o nome dela. Se não, diga "criar conta pessoal"! 😊`;
                        state.currentAction = 'selecting_account_flow_active'; 
                        actionBlockedNoAccessLoop = true;
                    }
                    const pjMeiActions = ['CREATE_PRODUCT', 'GET_STOCK_INFO', 'RECORD_STOCK_MOVEMENT', 'UPDATE_PRODUCT'];
                    if (pjMeiActions.includes(detectedAction.action) && state.activeFinancialAccountType && ['PJ', 'MEI'].includes(state.activeFinancialAccountType) && !state.currentAccessLevel.startsWith('avancado')) {
                        const siteUrlPjMei = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                        currentActionFormatted = `Ah, ${clientNameToUse}! Para usar as funcionalidades de ${state.activeFinancialAccountType === 'PJ' ? 'Empresa (PJ)' : 'MEI'}, como "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", você precisa de um dos nossos Planos Avançados. 🚀\n\nEles são perfeitos para quem quer ir além! Confira em ${siteUrlPjMei} e depois me avise para continuarmos! 😉`;
                        state.data.onboardingStage = 'awaiting_plan_confirmation'; 
                        actionBlockedNoAccessLoop = true;
                    }
        
        
                    if (actionBlockedNoAccessLoop) {
                        if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = currentActionFormatted;
                        else multipleActionFormattedResults.push(currentActionFormatted);
                        finalReplyParts = []; 
                        break; 
                    }
        
                    try {
                        switch (detectedAction.action) {
                            case 'CREATE_FINANCIAL_TRANSACTION': {
                                const categoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                                const cardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                                const txData = {
                                    description: params.description, type: params.type, value: parseFloat(params.value),
                                    transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                    financialCategoryId: categoryId, creditCardId: cardId, notes: params.notes,
                                    isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : (cardId ? false : false)),
                                    dueDate: cardId ? null : params.dueDate, 
                                    isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (cardId ? true : (!params.dueDate))
                                };
                                const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                                const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                                currentActionFormatted = formatFinancialTransactionSummary(reloadedTx, clientNameToUse);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'transaction', id: newTx.id, description: newTx.description };
                                break;
                            }
                            case 'UPDATE_FINANCIAL_TRANSACTION': {
                                isEditActionCurrentLoop = true;
                                actionWasAnEdit = true;
                                const transactionIdToUpdate = params.transactionIdToUpdate || state.editingResource?.id;
                                if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não foi fornecido pela IA ou não estava no contexto de edição.");
        
                                const updateTxData = { ...params };
                                if (params.financialCategoryName) updateTxData.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || null);
                                if (params.creditCardName) updateTxData.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                delete updateTxData.transactionIdToUpdate; delete updateTxData.financialCategoryName; delete updateTxData.creditCardName;
        
                                const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateTxData);
                                const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatFinancialTransactionSummary(reloadedUpdatedTx, clientNameToUse, false, true);
                                state.editingResource = null; 
                                state.currentAction = null;   
                                break;
                            }
                            case 'SCHEDULE_APPOINTMENT': {
                                let eventDateTime = params.eventDateTime;
                                if (params.eventDateTime && params.eventDateTime.length === 10) { 
                                    eventDateTime += ' 09:00'; 
                                } else if (params.eventDateTime && params.eventDateTime.includes("T") && params.eventDateTime.endsWith("Z")) { 
                                    const d = new Date(params.eventDateTime);
                                    const year = d.getFullYear(); const month = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
                                    const hour = String(d.getHours()).padStart(2, '0'); const minute = String(d.getMinutes()).padStart(2, '0');
                                    eventDateTime = `${year}-${month}-${day} ${hour}:${minute}`;
                                }
        
                                const appData = {
                                    title: params.title, eventDateTime: eventDateTime,
                                    durationMinutes: params.durationMinutes, location: params.location,
                                    reminderLeadTimeMinutes: params.reminderLeadTimeMinutes, notes: params.notes,
                                    associatedValue: params.associatedValue ? parseFloat(params.associatedValue) : null,
                                    associatedTransactionType: params.associatedTransactionType || null,
                                };
                                const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                                const reloadedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newApp.id);
                                currentActionFormatted = formatAppointmentSummary(reloadedApp, clientNameToUse);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'appointment', id: newApp.id, description: newApp.title };
                                break;
                            }
                            case 'UPDATE_APPOINTMENT': {
                                isEditActionCurrentLoop = true;
                                actionWasAnEdit = true;
                                const appointmentIdToUpdate = params.appointmentIdToUpdate || state.editingResource?.id;
                                if (!appointmentIdToUpdate) throw new Error("ID do compromisso para atualizar não fornecido pela IA ou não estava no contexto de edição.");
        
                                const updateAppData = { ...params };
                                if (params.eventDateTime && params.eventDateTime.length === 10) {
                                    updateAppData.eventDateTime += ' 09:00';
                                } else if (params.eventDateTime && params.eventDateTime.includes("T") && params.eventDateTime.endsWith("Z")) {
                                   const d = new Date(params.eventDateTime);
                                    const year = d.getFullYear(); const month = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
                                    const hour = String(d.getHours()).padStart(2, '0'); const minute = String(d.getMinutes()).padStart(2, '0');
                                    updateAppData.eventDateTime = `${year}-${month}-${day} ${hour}:${minute}`;
                                }
                                delete updateAppData.appointmentIdToUpdate;
                                if (params.hasOwnProperty('associatedValue')) updateAppData.associatedValue = params.associatedValue ? parseFloat(params.associatedValue) : null;
        
                                const updatedApp = await appointmentService.updateAppointment(state.activeFinancialAccountId, appointmentIdToUpdate, updateAppData);
                                const reloadedUpdatedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, updatedApp.id);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatAppointmentSummary(reloadedUpdatedApp, clientNameToUse, false, true);
                                state.editingResource = null;
                                state.currentAction = null;
                                break;
                            }
                            case 'CREATE_PARCELLED_ACCOUNT': {
                                const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                                const cardIdParcel = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
        
                                if (params.creditCardName && !cardIdParcel) {
                                    currentActionFormatted = `Hum, ${clientNameToUse}, não encontrei um cartão chamado "${params.creditCardName}" para registrar essa compra parcelada. 😕 Você pode cadastrar o cartão primeiro ou tentar com outro nome.`;
                                    break;
                                }
        
                                const parcelData = {
                                    description: params.description, type: params.type, totalValue: parseFloat(params.totalValue),
                                    numberOfParcels: parseInt(params.numberOfParcels), initialDueDate: params.initialDueDate,
                                    financialCategoryId: catIdParcel, creditCardId: cardIdParcel, notes: params.notes,
                                    transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                };
                                const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatParcelledAccountSummary(params, parcelResult, clientNameToUse);
                                if (aiResponse.detected_actions.length === 1 && parcelResult.parcels && parcelResult.parcels.length > 0) {
                                    const originalTxId = parcelResult.parcels[0].originalAccountId || parcelResult.parcels[0].id;
                                    resourceForButtonsContext = { type: 'parcelled_account', id: originalTxId, description: params.description };
                                }
                                break;
                            }
                            case 'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION': {
                                isEditActionCurrentLoop = true;
                                actionWasAnEdit = true;
                                const originalAccountIdToUpdate = params.originalAccountIdToUpdate || state.editingResource?.id;
                                if (!originalAccountIdToUpdate) throw new Error("ID da compra parcelada para atualizar a descrição não foi fornecido.");
                            
                                const newDescription = params.newDescription;
                                if (!newDescription || newDescription.trim() === '') {
                                    currentActionFormatted = `Por favor, me diga a nova descrição para esta compra parcelada, ${clientNameToUse}. 😊`;
                                    state.currentAction = 'awaiting_parcelled_account_description_edit'; 
                                    state.editingResource = { type: 'parcelled_account', id: originalAccountIdToUpdate }; 
                                    break; 
                                }
                                await financialService.updateParcelledAccountDescription(state.activeFinancialAccountId, originalAccountIdToUpdate, newDescription);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || `A descrição da sua compra parcelada foi atualizada para "${newDescription}" em todas as parcelas! ✨`;
                                state.editingResource = null;
                                state.currentAction = null;
                                break;
                            }
                            case 'RECREATE_PARCELLED_ACCOUNT': {
                                isEditActionCurrentLoop = true;
                                actionWasAnEdit = true;
                                const originalAccountIdToRecreate = params.originalAccountIdToUpdate || state.editingResource?.id;
                                if (!originalAccountIdToRecreate) throw new Error("ID da compra parcelada original não fornecido para recriação.");
                            
                                const newParcelData = {
                                    description: params.newDescription,
                                    type: params.newType || 'Saída',
                                    totalValue: parseFloat(params.newTotalValue),
                                    numberOfParcels: parseInt(params.newNumberOfParcels),
                                    initialDueDate: params.newInitialDueDate,
                                    transactionDate: params.newTransactionDate || params.newInitialDueDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                    financialCategoryId: params.newFinancialCategoryName ? await findFinancialCategoryIdByName(params.newFinancialCategoryName, state.activeFinancialAccountId, params.newType || 'Saída') : null,
                                    creditCardId: params.newCreditCardName ? await findCreditCardIdByName(params.newCreditCardName, state.activeFinancialAccountId) : null,
                                    notes: params.newNotes,
                                };
                            
                                if (!newParcelData.description || !newParcelData.totalValue || !newParcelData.numberOfParcels || !newParcelData.initialDueDate || ( (params.newCreditCardName) && !newParcelData.creditCardId) ) {
                                    currentActionFormatted = `Para refazer essa compra parcelada, preciso de todos os detalhes: nova descrição, valor total, número de parcelas, data da primeira parcela e o cartão (se houver). Parece que algo ficou faltando. Vamos tentar de novo?`;
                                    state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                                    state.editingResource = { type: 'parcelled_account', id: originalAccountIdToRecreate, originalData: state.editingResource?.originalData };
                                    break;
                                }
                                if (params.newCreditCardName && !newParcelData.creditCardId){
                                    currentActionFormatted = `Hum, não encontrei um cartão chamado "${params.newCreditCardName}" para esta nova compra parcelada. 😕 Pode verificar o nome ou cadastrar o cartão?`;
                                    state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                                    state.editingResource = { type: 'parcelled_account', id: originalAccountIdToRecreate, originalData: state.editingResource?.originalData };
                                    break;
                                }
                            
                                const confirmationMessage = `Ok, ${clientNameToUse}! Você quer alterar a compra para:\n` +
                                                            `Descrição: ${newParcelData.description}\n` +
                                                            `Valor Total: R$ ${newParcelData.totalValue.toFixed(2)} em ${newParcelData.numberOfParcels}x\n` +
                                                            `Primeira Parcela: ${new Date(newParcelData.initialDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'})}\n` +
                                                            (newParcelData.creditCardId ? `Cartão: ${params.newCreditCardName}\n` : '') +
                                                            `Isso substituirá a compra original. Confirmar? (Sim/Não)`;
                                
                                state.pendingConfirmation = {
                                    action: 'RECREATE_PARCELLED_ACCOUNT',
                                    parameters: { 
                                        financialAccountId: state.activeFinancialAccountId,
                                        originalAccountIdToDelete: originalAccountIdToRecreate,
                                        newParcelData: newParcelData
                                    },
                                    messageToConfirm: confirmationMessage
                                };
                                currentActionFormatted = confirmationMessage;
                                state.currentAction = 'awaiting_confirmation';
                                break;
                            }
                            case 'UPDATE_PRODUCT': { 
                                isEditActionCurrentLoop = true;
                                actionWasAnEdit = true;
                                const productIdToUpdate = params.productIdToUpdate || state.editingResource?.id;
                                if (!productIdToUpdate) throw new Error("ID do produto para atualizar não fornecido pela IA ou não estava no contexto de edição.");
        
                                const updateProdData = { ...params };
                                delete updateProdData.productIdToUpdate;
        
                                const updatedProd = await productService.updateProduct(state.activeFinancialAccountId, productIdToUpdate, updateProdData);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatProductSummary(updatedProd, clientNameToUse, false, true);
                                state.editingResource = null;
                                state.currentAction = null;
                                break;
                            }
                            case 'GET_FINANCIAL_SUMMARY': {
                                const filterParams = {
                                    dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                    financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                                };
                                if (params.period) {
                                    const todayLocale = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
                                    todayLocale.setHours(0,0,0,0);
                                    switch(params.period.toLowerCase().replace("_", " ")) {
                                        case 'hoje': filterParams.dateStart = filterParams.dateEnd = todayLocale.toISOString().split('T')[0]; break;
                                        case 'ontem': const y = new Date(todayLocale); y.setDate(y.getDate() - 1); filterParams.dateStart = filterParams.dateEnd = y.toISOString().split('T')[0]; break;
                                        case 'esta semana':
                                            const day = todayLocale.getDay(); const diff = todayLocale.getDate() - day + (day === 0 ? -6 : 1);
                                            const first = new Date(todayLocale.setDate(diff));
                                            const last = new Date(first); last.setDate(first.getDate() + 6);
                                            filterParams.dateStart = first.toISOString().split('T')[0]; filterParams.dateEnd = last.toISOString().split('T')[0]; break;
                                        case 'semana passada':
                                            const prevWeekEnd = new Date(todayLocale); prevWeekEnd.setDate(todayLocale.getDate() - todayLocale.getDay() -1);
                                            const prevWeekStart = new Date(prevWeekEnd); prevWeekStart.setDate(prevWeekEnd.getDate() - 6);
                                            filterParams.dateStart = prevWeekStart.toISOString().split('T')[0]; filterParams.dateEnd = prevWeekEnd.toISOString().split('T')[0]; break;
                                        case 'este mes': case 'este mês':
                                            filterParams.dateStart = new Date(todayLocale.getFullYear(), todayLocale.getMonth(), 1).toISOString().split('T')[0];
                                            filterParams.dateEnd = new Date(todayLocale.getFullYear(), todayLocale.getMonth() + 1, 0).toISOString().split('T')[0]; break;
                                        case 'mes passado': case 'mês passado':
                                            filterParams.dateStart = new Date(todayLocale.getFullYear(), todayLocale.getMonth() - 1, 1).toISOString().split('T')[0];
                                            filterParams.dateEnd = new Date(todayLocale.getFullYear(), todayLocale.getMonth(), 0).toISOString().split('T')[0]; break;
                                        case 'este ano':
                                            filterParams.dateStart = new Date(todayLocale.getFullYear(), 0, 1).toISOString().split('T')[0];
                                            filterParams.dateEnd = new Date(todayLocale.getFullYear(), 11, 31).toISOString().split('T')[0]; break;
                                    }
                                }
                                const summaryData = await financialService.getFinancialSummary(state.activeFinancialAccountId, filterParams);
                                let periodText = params.period ? params.period.replace("_", " ") : (filterParams.dateStart && filterParams.dateEnd ? `${new Date(filterParams.dateStart+'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'})} a ${new Date(filterParams.dateEnd+'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'})}` : "geral");
                                currentActionFormatted = `📊 Resumo Financeiro (${periodText} para ${state.activeFinancialAccountName}):\n\n` +
                                              `🟢 Entradas: R$ ${summaryData.totalEntradas.toFixed(2)}\n` +
                                              `🔴 Saídas: R$ ${summaryData.totalSaidas.toFixed(2)}\n` +
                                              `💰 *Saldo Efetivado (Caixa): R$ ${summaryData.saldoEfetivado.toFixed(2)}*\n\n` +
                                              `📈 A Receber (Pend.): R$ ${summaryData.totalAReceberPendente.toFixed(2)}\n` +
                                              `📉 A Pagar (Pend.): R$ ${summaryData.totalAPagarPendente.toFixed(2)}`;
                                break;
                            }
                             case 'LIST_FINANCIAL_TRANSACTIONS': {
                                 const filterParamsList = {
                                    dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                    financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                                    creditCardId: params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null,
                                    isPayableOrReceivable: params.isPayableOrReceivable,
                                    isPaidOrReceived: params.isPaidOrReceived,
                                    search: params.searchTerm || params.description,
                                    limit: params.limit || 7, page: params.page || 1,
                                    sortBy: params.sortBy || 'transactionDate', sortOrder: params.sortOrder || 'DESC'
                                };
                                const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList);
                                if (totalItems === 0) {
                                    currentActionFormatted = `Nenhuma transação encontrada para os filtros que você pediu, ${clientNameToUse}. 👍 Tente outros filtros!`;
                                } else {
                                    let listText = `📜 Encontrei ${totalItems} transações. As ${transactions.length > 1 ? transactions.length + " " : ""}mais recentes são:\n`;
                                    for (const t of transactions) {
                                        const catName = t.category ? t.category.name : 'Sem Categoria';
                                        let emoji = t.type === 'Entrada' ? '🟢' : (t.creditCardId ? '💳' : '🔴');
                                        if (t.isParcel && t.originalAccount) emoji = '📦';
        
                                        const date = new Date(t.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {day:'2-digit',month:'2-digit',timeZone:'UTC'});
                                        let descriptionText = t.description;
                                        if (t.isParcel && t.parcelNumber && t.totalParcels && t.originalAccount) {
                                            const originalDesc = t.originalAccount.description.replace(/ - Parcela \d+\/\d+$/, '').trim();
                                             if (!descriptionText.toLowerCase().includes(`parcela ${t.parcelNumber}/${t.totalParcels}`)) {
                                                descriptionText = `${originalDesc} - Pcl ${t.parcelNumber}/${t.totalParcels}`;
                                             }
                                        }
        
                                        listText += `\n${emoji} ${descriptionText} - R$ ${parseFloat(t.value).toFixed(2)}\n    (Cat: ${catName}, Data: ${date}, ID: ${t.id})`;
                                        if (t.isPayableOrReceivable && !t.creditCardId) {
                                            listText += t.isPaidOrReceived ? " (Liquidada ✅)" : ` (Vence ${new Date(t.dueDate+'T00:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',timeZone:'UTC'})} 🗓️)`;
                                        }
                                    }
                                    if (totalItems > transactions.length) listText += `\n\nE mais ${totalItems - transactions.length} transações. Peça para ver mais se quiser! 😉`;
                                    currentActionFormatted = listText;
                                }
                                break;
                            }
                            case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                                let transactionToMark = null;
                                if (params.transactionIdToUpdate && !isNaN(parseInt(params.transactionIdToUpdate))) {
                                    transactionToMark = await financialService.getTransactionById(state.activeFinancialAccountId, parseInt(params.transactionIdToUpdate));
                                } else if (state.editingResource && state.editingResource.type === 'transaction') {
                                    transactionToMark = await financialService.getTransactionById(state.activeFinancialAccountId, state.editingResource.id);
                                } else if (params.transactionDescription) {
                                    const searchResults = await financialService.getAllTransactions(state.activeFinancialAccountId, {
                                        search: params.transactionDescription,
                                        isPayableOrReceivable: true,
                                        isPaidOrReceived: false,
                                        limit: 1,
                                        value: params.transactionValue ? parseFloat(params.transactionValue) : undefined
                                    });
                                    if (searchResults.transactions.length === 1) {
                                        transactionToMark = searchResults.transactions[0];
                                    } else if (searchResults.transactions.length > 1) {
                                        currentActionFormatted = `Encontrei várias transações pendentes com essa descrição, ${clientNameToUse}. 🤔 Poderia ser mais específico (ex: mencionar o valor ou ID) ou usar a plataforma para marcar?`;
                                        break;
                                    }
                                }
        
                                if (!transactionToMark) {
                                    currentActionFormatted = `Não encontrei uma transação pendente clara para "${params.transactionDescription || 'a transação mencionada'}" para marcar como paga/recebida, ${clientNameToUse}. 😕 (ID Pesquisado: ${params.transactionIdToUpdate || 'N/A'})`;
                                } else {
                                    const updatedTx = await financialService.markAsPaidOrReceived(state.activeFinancialAccountId, transactionToMark.id, params.paymentDate);
                                    currentActionFormatted = detectedAction.action_specific_reply_suggestion || `✨ Resumo do registro:\n\n🔄 Atualizamos o status da transação "${updatedTx.description}" e agora ela está como ${updatedTx.type === 'Entrada' ? '"recebida"' : '"paga"'}. A data marcada foi ${new Date(updatedTx.paymentDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})}. 🎉`;
                                    state.editingResource = null;
                                }
                                break;
                            }
                            case 'CREATE_RECURRING_RULE': {
                                const catRecId = params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null;
                                let ruleValue = parseFloat(params.value);
                                if ((isNaN(ruleValue) || ruleValue <= 0) && params.description && params.description.toLowerCase().includes('netflix')) {
                                    ruleValue = 55.90;
                                    logger.info(`[WHATSAPP SERVICE] Valor para Netflix não fornecido, usando padrão ${ruleValue}`);
                                }
                                const ruleData = {
                                    description: params.description, type: params.type, value: ruleValue || 0,
                                    frequency: params.frequency, startDate: params.startDate,
                                    interval: params.interval || 1, dayOfMonth: params.dayOfMonth, dayOfWeek: params.dayOfWeek,
                                    endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction === undefined ? false : params.autoCreateTransaction,
                                    financialCategoryId: catRecId, notes: params.notes,
                                    isPayableOrReceivable: true,
                                };
                                const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                                const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);
                                currentActionFormatted = formatRecurringRuleSummary(reloadedRule, clientNameToUse);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'recurring_rule', id: newRule.id, description: newRule.description };
                                break;
                            }
                             case 'CREATE_PRODUCT': {
                                if (!state.currentAccessLevel.startsWith('avancado')) {
                                    currentActionFormatted = `Ah, ${clientNameToUse}, o cadastro de produtos é uma funcionalidade dos nossos Planos Avançados! 🚀 Eles são perfeitos para quem gerencia um negócio. Quer saber mais sobre eles?`;
                                    state.data.onboardingStage = 'awaiting_plan_confirmation'; 
                                    break;
                                }
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                    currentActionFormatted = `Desculpe, ${clientNameToUse}, mas o cadastro de produtos é apenas para contas PJ ou MEI. Sua conta "${state.activeFinancialAccountName}" é do tipo ${state.activeFinancialAccountType}. Você pode criar uma conta empresarial ou mudar para ela! 😉`;
                                    break;
                                }
                                const productData = {
                                    name: params.name, salePrice: parseFloat(params.salePrice), code: params.code,
                                    costPrice: params.costPrice ? parseFloat(params.costPrice) : null,
                                    quantity: params.initialQuantity !== undefined ? parseInt(params.initialQuantity) : 0,
                                    minimumStock: params.minimumStock !== undefined ? parseInt(params.minimumStock) : 0,
                                    unit: params.unit
                                };
                                const newProd = await productService.createProduct(state.activeFinancialAccountId, productData);
                                currentActionFormatted = formatProductSummary(newProd, clientNameToUse);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'product', id: newProd.id, description: newProd.name };
                                break;
                            }
                            case 'GET_STOCK_INFO': {
                                if (!state.currentAccessLevel.startsWith('avancado')) {
                                    currentActionFormatted = `Opa, ${clientNameToUse}! Para consultar o estoque, você precisa de um dos nossos Planos Avançados. 🌟 Eles são ideais para quem tem empresa ou MEI! Quer mais detalhes?`;
                                    state.data.onboardingStage = 'awaiting_plan_confirmation';
                                    break;
                                }
                                 if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                    currentActionFormatted = `Ops, ${clientNameToUse}, a consulta de estoque é só para contas PJ ou MEI. Parece que estamos na sua conta ${state.activeFinancialAccountType}.`;
                                    break;
                                }
                                const productId = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                                 if(!productId) {
                                    currentActionFormatted = `Hum... não encontrei nenhum produto parecido com "${params.productNameOrCode}" na sua conta ${state.activeFinancialAccountName}, ${clientNameToUse}. 🧐`;
                                    break;
                                }
                                const stockBalance = await stockService.getProductStockBalance(productId);
                                currentActionFormatted = `📦 Estoque de *${stockBalance.name}* (${state.activeFinancialAccountName}):\n` +
                                                      `Disponível: ${stockBalance.quantity} ${stockBalance.unit || 'UN'}\n` +
                                                      (stockBalance.minimumStock ? `Mínimo: ${stockBalance.minimumStock} ${stockBalance.unit || 'UN'}` : '');
                                if(stockBalance.minimumStock && stockBalance.quantity <= stockBalance.minimumStock) currentActionFormatted += " 📉 Atenção, estoque baixo!";
                                break;
                            }
                            case 'RECORD_STOCK_MOVEMENT': {
                                 if (!state.currentAccessLevel.startsWith('avancado')) {
                                    currentActionFormatted = `Sinto muito, ${clientNameToUse}, mas para movimentar o estoque, você precisa de um Plano Avançado. 📈 Que tal dar uma olhada nas opções?`;
                                    state.data.onboardingStage = 'awaiting_plan_confirmation';
                                    break;
                                }
                                if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                    currentActionFormatted = `Sinto muito, ${clientNameToUse}, movimentação de estoque é para contas PJ ou MEI. No momento, estamos na sua conta ${state.activeFinancialAccountType}.`;
                                    break;
                                }
                                const productIdStock = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                                 if(!productIdStock) {
                                    currentActionFormatted = `Não encontrei o produto "${params.productNameOrCode}" para movimentar o estoque, ${clientNameToUse}. 😬`;
                                    break;
                                }
                                const movementData = {
                                    type: params.movementType,
                                    quantity: parseInt(params.quantity),
                                    reason: params.reason
                                };
                                const movement = await stockService.recordStockMovement(productIdStock, movementData);
                                const updatedProduct = await productService.getProductById(state.activeFinancialAccountId, productIdStock);
                                currentActionFormatted = `📝 Movimentação de estoque para *${updatedProduct.name}* registrada!\n`+
                                                       `Tipo: ${movement.type}, Quantidade: ${movement.quantity}\n`+
                                                       `Novo Saldo: ${updatedProduct.quantity} ${updatedProduct.unit || 'UN'}`;
                                break;
                            }
                            case 'CREATE_CREDIT_CARD': {
                                const cardData = {
                                    name: params.name, limit: parseFloat(params.limit),
                                    closingDay: parseInt(params.closingDay), paymentDay: parseInt(params.paymentDay),
                                    lastFourDigits: params.lastFourDigits, flag: params.flag,
                                    isDefault: params.isDefault === undefined ? false : params.isDefault
                                };
                                const newCard = await creditCardService.createCreditCard(state.activeFinancialAccountId, cardData);
                                currentActionFormatted = formatCreditCardSummary(newCard, clientNameToUse);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'credit_card', id: newCard.id, description: newCard.name };
                                break;
                            }
                            case 'UPDATE_CREDIT_CARD': {
                                isEditActionCurrentLoop = true;
                                actionWasAnEdit = true;
                                const cardIdToUpdate = params.cardIdToUpdate || state.editingResource?.id;
                                if (!cardIdToUpdate) throw new Error("ID do cartão para atualizar não fornecido pela IA ou não estava no contexto de edição.");
        
                                const updateCardData = { ...params };
                                delete updateCardData.cardIdToUpdate;
        
                                const updatedCard = await creditCardService.updateCreditCard(state.activeFinancialAccountId, cardIdToUpdate, updateCardData);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatCreditCardSummary(updatedCard, clientNameToUse, false, true);
                                state.editingResource = null;
                                state.currentAction = null;
                                break;
                            }
                            case 'UPDATE_RECURRING_RULE': {
                                isEditActionCurrentLoop = true;
                                actionWasAnEdit = true;
                                const ruleIdToUpdate = params.ruleIdToUpdate || state.editingResource?.id;
                                if (!ruleIdToUpdate) throw new Error("ID da regra de recorrência para atualizar não fornecido pela IA ou não estava no contexto de edição.");
        
                                const updateRuleData = { ...params };
                                delete updateRuleData.ruleIdToUpdate;
        
                                const updatedRule = await recurringTransactionService.updateRecurringRule(state.activeFinancialAccountId, ruleIdToUpdate, updateRuleData);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatRecurringRuleSummary(updatedRule, clientNameToUse, false, true);
                                state.editingResource = null;
                                state.currentAction = null;
                                break;
                            }
                            case 'UPDATE_PRODUCT': {
                                isEditActionCurrentLoop = true;
                                actionWasAnEdit = true;
                                const productIdToUpdate = params.productIdToUpdate || state.editingResource?.id;
                                if (!productIdToUpdate) throw new Error("ID do produto para atualizar não fornecido pela IA ou não estava no contexto de edição.");
        
                                const updateProdData = { ...params };
                                delete updateProdData.productIdToUpdate;
        
                                const updatedProd = await productService.updateProduct(state.activeFinancialAccountId, productIdToUpdate, updateProdData);
                                currentActionFormatted = detectedAction.action_specific_reply_suggestion || formatProductSummary(updatedProd, clientNameToUse, false, true);
                                state.editingResource = null;
                                state.currentAction = null;
                                break;
                            }
                            case 'LIST_APPOINTMENTS': {
                                const filterAppList = {
                                    dateStart: params.dateStart, dateEnd: params.dateEnd, status: params.status,
                                    limit: params.limit || 5, page: params.page || 1,
                                    sortBy: params.sortBy || 'eventDateTime', sortOrder: params.sortOrder || 'ASC'
                                };
                                 if (params.period) {
                                    const todayLocaleApp = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
                                    todayLocaleApp.setHours(0,0,0,0);
                                    switch(params.period.toLowerCase().replace("_", " ")) {
                                        case 'hoje': filterAppList.specificDate = todayLocaleApp.toISOString().split('T')[0]; break;
                                        case 'amanha': const tomorrow = new Date(todayLocaleApp); tomorrow.setDate(tomorrow.getDate() + 1); filterAppList.specificDate = tomorrow.toISOString().split('T')[0]; break;
                                        case 'esta semana':
                                            const dayApp = todayLocaleApp.getDay(); const diffApp = todayLocaleApp.getDate() - dayApp + (dayApp === 0 ? -6 : 1);
                                            const firstApp = new Date(todayLocaleApp.setDate(diffApp));
                                            const lastApp = new Date(firstApp); lastApp.setDate(firstApp.getDate() + 6);
                                            filterAppList.dateStart = firstApp.toISOString().split('T')[0]; filterAppList.dateEnd = lastApp.toISOString().split('T')[0]; break;
                                        case 'proximos 7 dias':
                                            filterAppList.dateStart = todayLocaleApp.toISOString().split('T')[0];
                                            const sevenDays = new Date(todayLocaleApp); sevenDays.setDate(todayLocaleApp.getDate() + 6);
                                            filterAppList.dateEnd = sevenDays.toISOString().split('T')[0]; break;
                                    }
                                }
                                const { appointments, totalItems: totalApps } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, filterAppList);
                                if (totalApps === 0) {
                                    currentActionFormatted = `Você não tem compromissos agendados para os filtros informados, ${clientNameToUse}. Que tal agendar algo? 😉`;
                                } else {
                                    let appListText = `🗓️ Você tem ${totalApps} compromissos. Os próximos são:\n`;
                                    for (const app of appointments) {
                                        const eventDT = new Date(app.eventDateTime);
                                        const dateStr = eventDT.toLocaleDateString('pt-BR', {day:'2-digit', month:'2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo'});
                                        const timeStr = eventDT.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo'});
                                        appListText += `\n- ${app.title} em ${dateStr} às ${timeStr} (ID: ${app.id})`;
                                    }
                                    if (totalApps > appointments.length) appListText += `\n\nE mais ${totalApps - appointments.length}. Peça para ver mais ou filtre!`;
                                    currentActionFormatted = appListText;
                                }
                                break;
                            }
                            case 'LIST_CREDIT_CARDS': {
                                const cards = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                                if(cards.length === 0) {
                                    currentActionFormatted = `Você ainda não cadastrou nenhum cartão de crédito na conta "${state.activeFinancialAccountName}", ${clientNameToUse}. 💳 Que tal cadastrar um agora? Diga "criar cartão [nome] limite [valor] fecha dia [dia] paga dia [dia]".`;
                                } else {
                                    let cardListText = `Estes são seus cartões de crédito ativos para "${state.activeFinancialAccountName}", ${clientNameToUse}:\n`;
                                    cards.forEach(c => {
                                        cardListText += `\n- *${c.name}* (Limite: R$ ${parseFloat(c.limit).toFixed(2)})${c.isDefault ? ' ⭐Padrão' : ''}${c.lastFourDigits ? ` Final ${c.lastFourDigits}` : ''}`;
                                    });
                                    currentActionFormatted = cardListText;
                                }
                                break;
                            }
                            case 'LIST_RECURRING_RULES': {
                                const rules = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, { isActive: true });
                                if(rules.length === 0) {
                                    currentActionFormatted = `Nenhuma regra de recorrência ativa encontrada para "${state.activeFinancialAccountName}", ${clientNameToUse}. 🔄 Para criar uma, diga "criar recorrência [descrição] valor [valor] todo [dia/mês/ano]".`;
                                } else {
                                    let ruleListText = `Suas regras de recorrência ativas para "${state.activeFinancialAccountName}", ${clientNameToUse}:\n`;
                                    rules.forEach(r => {
                                        const nextDue = new Date(r.nextDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'});
                                        ruleListText += `\n- ${r.description} (R$ ${parseFloat(r.value).toFixed(2)} ${r.type}, Próx: ${nextDue})`;
                                    });
                                    currentActionFormatted = ruleListText;
                                }
                                break;
                            }
                            case 'SWITCH_FINANCIAL_ACCOUNT': {
                                const targetAccountName = params.targetAccountNameOrType;
                                const allClientAccountsForSwitch = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                                if (!targetAccountName) {
                                    if (allClientAccountsForSwitch.length <= 1 && state.activeFinancialAccountId) {
                                        currentActionFormatted = `Você só tem a conta "${state.activeFinancialAccountName}" configurada por enquanto, ${clientNameToUse}. Se quiser criar outra, me diga "criar conta"! 😉`;
                                    } else if (allClientAccountsForSwitch.length === 0) {
                                         currentActionFormatted = `Puxa, ${clientNameToUse}, parece que ainda não temos nenhuma conta financeira configurada para você. Vamos criar sua primeira conta pessoal? Só dizer "criar conta pessoal". 😊`;
                                         state.data.onboardingStage = 'setting_up_pf_account_name';
                                         state.currentAction = 'awaiting_input_pf_name';
                                    } else {
                                        let accList = `Você tem estas contas, ${clientNameToUse}:\n`;
                                        allClientAccountsForSwitch.forEach(acc => { accList += `\n- *${acc.accountName}* (${acc.accountType}) ${acc.id === state.activeFinancialAccountId ? ' (Selecionada ✨)' : ''}`; });
                                        accList += "\n\nPara qual delas você gostaria de mudar? Só me dizer o nome.";
                                        currentActionFormatted = accList;
                                        state.currentAction = 'selecting_account_flow_active'; 
                                        state.data.accountsToList = allClientAccountsForSwitch.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                                    }
                                } else {
                                    const foundAcc = allClientAccountsForSwitch.find(acc => acc.accountName.toLowerCase() === targetAccountName.toLowerCase() || acc.accountType.toLowerCase() === targetAccountName.toLowerCase());
                                    if (foundAcc && foundAcc.id !== state.activeFinancialAccountId) {
                                        state.activeFinancialAccountId = foundAcc.id;
                                        state.activeFinancialAccountName = foundAcc.accountName;
                                        state.activeFinancialAccountType = foundAcc.accountType;
                                        currentActionFormatted = `Prontinho, ${clientNameToUse}! Mudei para sua conta "${state.activeFinancialAccountName}". O que faremos agora? 😊`;
                                        state.currentAction = null;
                                    } else if (foundAcc && foundAcc.id === state.activeFinancialAccountId) {
                                        currentActionFormatted = `Você já está usando a conta "${state.activeFinancialAccountName}", ${clientNameToUse}! 😉`;
                                    } else {
                                        currentActionFormatted = `Não encontrei uma conta chamada ou do tipo "${targetAccountName}", ${clientNameToUse}. 😕 Tente de novo com o nome exato ou o tipo (PF, PJ, MEI).`;
                                    }
                                }
                                break;
                            }
                            case 'CREATE_FINANCIAL_ACCOUNT': { 
                                const typeToCreate = params.accountTypeToCreate;
                                const newAccName = params.newAccountName;
                                const currentClientAccountsForCreate = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                                const existingPjMei = currentClientAccountsForCreate.find(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
        
                                if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && existingPjMei) {
                                    currentActionFormatted = `Opa, ${clientNameToUse}! Você já tem uma conta empresarial (${existingPjMei.accountType}) chamada "${existingPjMei.accountName}". No momento, só é possível ter uma conta PJ ou MEI. 😉`;
                                    break;
                                }
                                if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && !state.currentAccessLevel.startsWith('avancado')) {
                                    const siteUrlCreateAcc = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                                    currentActionFormatted = `Ah, ${clientNameToUse}! Para criar uma conta empresarial (${typeToCreate}), você precisa de um dos nossos Planos Avançados. 🚀 Eles são demais! Confira em ${siteUrlCreateAcc} e depois me avise para continuarmos! 😉`;
                                    state.data.onboardingStage = 'awaiting_plan_confirmation';
                                    break;
                                }
        
        
                                if (!typeToCreate) {
                                    currentActionFormatted = `Para criar uma nova conta financeira, preciso saber o tipo: Pessoal (PF), Empresa (PJ) ou MEI? Qual você prefere, ${clientNameToUse}? 🤔`;
                                    state.currentAction = 'awaiting_explicit_account_type_from_ai';
                                } else if (!newAccName) {
                                    currentActionFormatted = `Entendi que você quer criar uma conta do tipo ${typeToCreate}, ${clientNameToUse}. Qual nome você gostaria de dar para ela? ✍️`;
                                    state.currentAction = 'awaiting_explicit_account_name_from_ai';
                                    state.data.accountTypeToCreate = typeToCreate;
                                } else {
                                    try {
                                        const newFA = await clientService.createFinancialAccount(client.id, { accountName: newAccName, accountType: typeToCreate });
                                        currentActionFormatted = `Conta "${newFA.accountName}" (${newFA.accountType}) criada com sucesso, ${clientNameToUse}! 🎉 Ela já está selecionada. O que vamos fazer?`;
                                        state.activeFinancialAccountId = newFA.id;
                                        state.activeFinancialAccountName = newFA.accountName;
                                        state.activeFinancialAccountType = newFA.accountType;
                                        state.currentAction = null; 
                                        // Mantém o onboardingStage como 'onboarding_complete' se já estava
                                        if (state.data.onboardingStage !== 'onboarding_complete') {
                                            // Se a criação de conta foi o último passo do onboarding (improvável chegar aqui nesse caso)
                                            state.data.onboardingStage = 'onboarding_complete';
                                        }
                                        // Limpa dados temporários de criação de conta, se houver
                                        if (state.data.accountTypeToCreate) delete state.data.accountTypeToCreate;
                                    } catch(e) {
                                        currentActionFormatted = `Ops, não consegui criar a conta "${newAccName}" (${typeToCreate}). ${e.message.substring(0,70)}. Tente um nome diferente.`;
                                        state.currentAction = 'awaiting_explicit_account_name_from_ai';
                                        state.data.accountTypeToCreate = typeToCreate;
                                    }
                                }
                                break;
                            }
                            case 'GET_CREDIT_CARD_INVOICE': {
                                const cardIdForInvoice = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                if (!cardIdForInvoice) {
                                    currentActionFormatted = `Hum, não consegui identificar o cartão "${params.creditCardName}", ${clientNameToUse}. Pode tentar de novo ou verificar se ele está cadastrado? 🤔`;
                                    break;
                                }
                                const periodOpts = {
                                    type: params.invoicePeriodType || 'aberta',
                                    month: params.invoiceMonth,
                                    year: params.invoiceYear
                                };
                                const invoiceDetails = await creditCardService.getCreditCardInvoiceDetails(state.activeFinancialAccountId, cardIdForInvoice, periodOpts);
                                currentActionFormatted = formatCreditCardInvoiceSummary(invoiceDetails, clientNameToUse, params.listTransactions !== false);
                                break;
                            }
                            case 'GET_CREDIT_CARD_AVAILABLE_LIMIT': {
                                const cardIdForLimit = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                if (!cardIdForLimit) {
                                    currentActionFormatted = `Não encontrei o cartão "${params.creditCardName}" para verificar o limite, ${clientNameToUse}. 😬`;
                                    break;
                                }
                                const limitInfo = await creditCardService.getAvailableCreditLimit(state.activeFinancialAccountId, cardIdForLimit);
                                currentActionFormatted = formatAvailableLimitSummary(limitInfo, clientNameToUse);
                                break;
                            }
                            case 'PAY_CREDIT_CARD_INVOICE': {
                                const cardIdForPayment = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                if (!cardIdForPayment) {
                                    currentActionFormatted = `Não identifiquei o cartão "${params.creditCardName}" para registrar o pagamento da fatura, ${clientNameToUse}. 🧐`;
                                    break;
                                }
                                const paymentAmount = parseFloat(params.paymentAmount);
                                const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
        
                                const paymentDescription = `Pagamento Fatura ${params.creditCardName} - R$ ${paymentAmount.toFixed(2)}`;
                                const categoryName = params.financialCategoryName || "Pagamento de Fatura";
                                const paymentCategoryId = await findFinancialCategoryIdByName(categoryName, state.activeFinancialAccountId, 'Saída');
        
                                try {
                                    const paymentTx = await financialService.createTransaction(state.activeFinancialAccountId, {
                                        description: paymentDescription,
                                        type: 'Saída',
                                        value: paymentAmount,
                                        transactionDate: paymentDate,
                                        financialCategoryId: paymentCategoryId,
                                        isPayableOrReceivable: false,
                                        isPaidOrReceived: true,
                                    });
                                    currentActionFormatted = `Pagamento da fatura do cartão ${params.creditCardName} no valor de R$ ${paymentAmount.toFixed(2)} registrado com sucesso na sua conta ${state.activeFinancialAccountName}! 🎉 Bom demais ter as contas em dia!`;
                                } catch (e) {
                                    logger.error(`Erro ao registrar pagamento de fatura para cartão ${params.creditCardName} na conta ${state.activeFinancialAccountName}: ${e.message}`);
                                    currentActionFormatted = `Ops! Tive um problema ao tentar registrar o pagamento da fatura do ${params.creditCardName}. (${e.message.substring(0,60)}) 😥`;
                                }
                                break;
                            }
                            case 'GENERAL_GREETING_OR_SMALLTALK':
                            case 'GENERAL_QUESTION_OR_HELP':
                            case 'ACTION_CONFIRMATION_YES':
                            case 'ACTION_CONFIRMATION_NO':
                                if(messageText.toLowerCase().includes("pagar fatura de um item") || messageText.toLowerCase().includes("antecipar fatura") || messageText.toLowerCase().includes("pagar antecipado")){
                                    currentActionFormatted = `Entendo que você quer fazer um pagamento específico ou antecipar algo da fatura, ${clientNameToUse}. Essa é uma função mais avançada que ainda estou aprendendo a fazer direitinho! 😅 Por enquanto, posso te mostrar a fatura total, o limite, ou registrar o pagamento total da fatura. O que prefere?`;
                                } else if (aiResponse.reply_to_user_suggestion) {
                                    currentActionFormatted = aiResponse.reply_to_user_suggestion;
                                } else {
                                    currentActionFormatted = `Entendido, ${clientNameToUse}! 😊`;
                                }
        
                                if (detectedAction.action === 'ACTION_CONFIRMATION_YES' || detectedAction.action === 'ACTION_CONFIRMATION_NO') {
                                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                                }
                                if (aiResponse.reply_to_user_suggestion && !(messageText.toLowerCase().includes("pagar fatura de um item") || messageText.toLowerCase().includes("antecipar fatura"))) {
                                    if(finalReplyParts.length > 0 && finalReplyParts[0] === aiResponse.reply_to_user_suggestion) {
                                         multipleActionFormattedResults = [];
                                         singleActionFormattedResult = null; 
                                    } else {
                                        finalReplyParts = [aiResponse.reply_to_user_suggestion];
                                        multipleActionFormattedResults = [];
                                    }
                                }
                                break;
                            default:
                                if (aiResponse.detected_actions.length === 1 && aiResponse.reply_to_user_suggestion && !aiResponse.overall_summary_suggestion) {
                                    currentActionFormatted = aiResponse.reply_to_user_suggestion;
                                } else {
                                    currentActionFormatted = `Ação "${detectedAction.action}" ${params.description ? `para "${params.description}"` : ''} foi entendida, ${clientNameToUse}, mas ainda não sei como processá-la completamente. 😅 Minha equipe está trabalhando para me deixar mais esperto!`;
                                    logger.warn(`[WHATSAPP SERVICE] Ação da IA não implementada no switch: ${detectedAction.action}`);
                                }
                                break;
                        }
        
                        if (actionBlockedNoAccessLoop) continue;
        
                        if (detectedAction.action_specific_reply_suggestion) {
                            currentActionFormatted = detectedAction.action_specific_reply_suggestion;
                        }
        
                        if (currentActionFormatted) {
                            if (aiResponse.detected_actions.length === 1 && !isEditActionCurrentLoop) {
                                singleActionFormattedResult = currentActionFormatted;
                            } else if (!isEditActionCurrentLoop) {
                                multipleActionFormattedResults.push(currentActionFormatted);
                            } else { 
                                singleActionFormattedResult = currentActionFormatted;
                            }
                        }
        
                    } catch (e) {
                        logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack?.substring(0,300), params: params });
                        if (detectedAction.action === 'CREATE_CREDIT_CARD' && e.statusCode === 409 && e.message.toLowerCase().includes('já existe um cartão com o nome')) {
                            singleActionFormattedResult = `Opa, ${clientNameToUse}! 😅 Parece que você já tem um cartão chamado "*${params.name}*" cadastrado nessa conta. Que tal dar outro nome ou verificar seus cartões existentes com "listar cartões"?`;
                            finalReplyParts = []; 
                        } else {
                            const errorMsgPart = `Ops! 😬 Tive um problema ao tentar processar "${params.description || detectedAction.action.toLowerCase().replace(/_/g," ")}". (${e.message.length < 80 ? e.message : 'Erro interno, desculpe!'}). Pode tentar de novo ou com outros termos?`;
                            if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = errorMsgPart;
                            else multipleActionFormattedResults.push(errorMsgPart);
                        }
                    }
                }
            }
        
            if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
                finalReplyParts = [aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe: ${aiResponse.clarifications_needed[0].clarification_question}`];
                state.currentAction = 'awaiting_clarification_response'; 
                state.data.clarificationContext = { 
                    action: aiResponse.clarifications_needed[0].original_intent_action_suggestion,
                    original_message: messageText,
                    parameters_so_far: aiResponse.clarifications_needed[0].parameters_so_far || {}
                };
                singleActionFormattedResult = null;
                multipleActionFormattedResults = [];
            } else if (singleActionFormattedResult) {
                if (finalReplyParts.length > 0 && !actionWasAnEdit) {
                    if (aiResponse.reply_to_user_suggestion &&
                        aiResponse.reply_to_user_suggestion !== aiResponse.overall_summary_suggestion &&
                        (!singleActionFormattedResult.toLowerCase().includes(aiResponse.reply_to_user_suggestion.substring(0, 20).toLowerCase())) &&
                        aiResponse.reply_to_user_suggestion !== singleActionFormattedResult &&
                        finalReplyParts.indexOf(aiResponse.reply_to_user_suggestion) === -1 ) {
                        finalReplyParts.push(aiResponse.reply_to_user_suggestion);
                    }
                     if (finalReplyParts.indexOf(singleActionFormattedResult) === -1) {
                        finalReplyParts.push(singleActionFormattedResult);
                     }
                } else {
                     if(finalReplyParts.length > 0 && aiResponse.detected_actions && aiResponse.detected_actions.length > 0 && aiResponse.detected_actions[0]?.action.startsWith("GENERAL_")){
                        if(aiResponse.reply_to_user_suggestion !== singleActionFormattedResult && finalReplyParts.indexOf(singleActionFormattedResult) === -1){
                             finalReplyParts.push(singleActionFormattedResult);
                        }
                    } else if (finalReplyParts.indexOf(singleActionFormattedResult) === -1) {
                        finalReplyParts.push(singleActionFormattedResult);
                    } else if (finalReplyParts.length === 0) {
                         finalReplyParts = [singleActionFormattedResult];
                    }
                }
            } else if (multipleActionFormattedResults.length > 0) {
                if (finalReplyParts.length === 0) { 
                    finalReplyParts.push(`${clientNameToUse}, aqui está o que eu fiz pra você! 😉`);
                } else if (aiResponse.reply_to_user_suggestion && finalReplyParts.indexOf(aiResponse.reply_to_user_suggestion) === -1) {
                     finalReplyParts.push(aiResponse.reply_to_user_suggestion);
                }
                finalReplyParts.push(multipleActionFormattedResults.join("\n\n---\n\n"));
            } else if (aiResponse.reply_to_user_suggestion) { 
                if (finalReplyParts.length === 0 || (finalReplyParts.length === 1 && finalReplyParts[0] === aiResponse.overall_summary_suggestion)) {
                    finalReplyParts = [aiResponse.reply_to_user_suggestion];
                } else if (finalReplyParts.indexOf(aiResponse.reply_to_user_suggestion) === -1) {
                     finalReplyParts.push(aiResponse.reply_to_user_suggestion);
                }
            } else if (finalReplyParts.length === 0 && !state.currentAction && state.data.onboardingStage === 'onboarding_complete') { 
                finalReplyParts.push(`Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊 Estou por aqui!`);
            }
        
            finalReplyParts = finalReplyParts.filter((item, index, self) =>
                item && typeof item === 'string' && item.trim() !== "" && self.findIndex(t => t && typeof t === 'string' && t.trim() === item.trim()) === index
            );
        
            const performedConcreteAction = (aiResponse.detected_actions && aiResponse.detected_actions.length > 0 &&
                                           aiResponse.detected_actions.some(a => !a.action.startsWith("GENERAL_") && !a.action.startsWith("LIST_") && !a.action.startsWith("GET_") && !a.action.startsWith("SWITCH_") )
                                          ) &&
                                           (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0);
        
            let completeFinalReply = finalReplyParts.join("\n\n").trim();
        
            if (performedConcreteAction && state.hasPaidAccess) { 
                const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
                const dashboardMessage = `📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}`;
                if (completeFinalReply && !completeFinalReply.includes(platformUrl)) {
                    completeFinalReply += `\n\n${dashboardMessage}`;
                }
                const helpMessage = "Se precisar de algo a mais é só me chamar! 😃📈";
                if(completeFinalReply && !completeFinalReply.includes(helpMessage.substring(0,20))){ 
                     completeFinalReply += `\n\n${helpMessage}`;
                }
            }
        
            completeFinalReply = completeFinalReply.replace(/\n{3,}/g, '\n\n'); 
        
            if (completeFinalReply) { 
                state.messageHistory.push({ role: 'assistant', content: completeFinalReply });
            }
        
        
            if (actionWasAnEdit || (state.editingResource && (!aiResponse.detected_actions || aiResponse.detected_actions.every(a => !a.action.startsWith("UPDATE_") && a.action !== 'RECREATE_PARCELLED_ACCOUNT')))) {
                state.editingResource = null;
            }
            if (state.data.clarificationContext && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
                delete state.data.clarificationContext;
            }
        
        
            if (completeFinalReply) {
                if (resourceForButtonsContext && aiResponse.detected_actions?.length === 1 && !actionWasAnEdit && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
                    let buttons = [];
                    let buttonItemDesc = "item";
                    if (resourceForButtonsContext.description && typeof resourceForButtonsContext.description === 'string') {
                        buttonItemDesc = resourceForButtonsContext.description.length > 24 ? resourceForButtonsContext.description.substring(0, 21) + "..." : resourceForButtonsContext.description;
                    }
                    const buttonTitle = `Opções para "${buttonItemDesc}":`;
        
                    switch(resourceForButtonsContext.type) {
                        case 'transaction':
                            buttons = [
                                { id: `edit_transaction_${resourceForButtonsContext.id}`, label: "Editar Transação ✍️" },
                                { id: `delete_transaction_${resourceForButtonsContext.id}`, label: "Excluir Transação 🗑️" },
                            ];
                            break;
                        case 'appointment':
                            buttons = [
                                { id: `edit_appointment_${resourceForButtonsContext.id}`, label: "Editar Compromisso ✍️" },
                                { id: `delete_appointment_${resourceForButtonsContext.id}`, label: "Excluir Compromisso 🗑️" },
                            ];
                            break;
                        case 'credit_card':
                            buttons = [
                                { id: `edit_credit_card_${resourceForButtonsContext.id}`, label: "Editar Cartão ✍️" },
                                { id: `delete_credit_card_${resourceForButtonsContext.id}`, label: "Excluir Cartão 🗑️" },
                            ];
                            break;
                        case 'recurring_rule':
                            buttons = [
                                { id: `edit_recurring_rule_${resourceForButtonsContext.id}`, label: "Editar Recorrência ✍️" },
                                { id: `delete_recurring_rule_${resourceForButtonsContext.id}`, label: "Excluir Recorrência 🗑️" },
                            ];
                            break;
                        case 'product':
                            buttons = [
                                { id: `edit_product_${resourceForButtonsContext.id}`, label: "Editar Produto ✍️" },
                                { id: `delete_product_${resourceForButtonsContext.id}`, label: "Excluir Produto 🗑️" },
                            ];
                            break;
                        case 'parcelled_account': 
                            buttons = [
                                { id: `edit_parcelled_account_${resourceForButtonsContext.id}`, label: "Alterar Compra Parcelada ✍️" },
                                { id: `delete_parcelled_account_${resourceForButtonsContext.id}`, label: "Excluir Compra Parcelada 🗑️" },
                            ];
                            break;
                    }
        
                    if (buttons.length > 0) {
                        await sendButtonListMessage(senderPhone, completeFinalReply, buttons, buttonTitle, "Clique aqui 👇");
                    } else {
                        await sendWhatsappMessage(senderPhone, completeFinalReply);
                    }
                } else {
                    await sendWhatsappMessage(senderPhone, completeFinalReply);
                    if(state.editingResource && !resourceForButtonsContext) state.editingResource = null;
                }
            }
        } // Fim do if (state.data.onboardingStage === 'onboarding_complete' || !onboardingReply)

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000), messageText, rawPayload });
        const clientNameToUseInError = state ? state.clientName : (pushName || "você");
        try {
            await sendWhatsappMessage(senderPhone, `Puxa vida, ${clientNameToUseInError}! 😬 Parece que tive um curto-circuito aqui e não consegui processar sua mensagem. Minha equipe de engenheiros já está de olho nisso! 👩‍💻👨‍💻 Por favor, tente de novo em um momentinho. Desculpe o transtorno!`);
        } catch (sendError) {
            logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro crítico para ${senderPhone}: ${sendError.message}`);
        }
    } finally {
        const endTime = Date.now();
        logger.info(`[WHATSAPP HANDLER] Processamento para ${senderPhone} finalizado em ${endTime - startTime}ms.`);
        if (state) { 
            logger.debug(`[WHATSAPP HANDLER] Estado final da sessão para ${senderPhone}:`, { 
                currentAction: state.currentAction, 
                onboardingStage: state.data.onboardingStage,
                hasPaidAccess: state.hasPaidAccess,
                activeFinancialAccountId: state.activeFinancialAccountId 
            });
            conversationState.set(senderPhone, state); 
        }
    }
}

module.exports = { processIncomingMessage };
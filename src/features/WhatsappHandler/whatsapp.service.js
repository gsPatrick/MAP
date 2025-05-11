// src/features/WhatsappHandler/whatsapp.service.js
const clientService = require('../Client/client.service');
const financialService = require('../Financial/financial.service');
const productService = require('../Product/product.service');
const stockService = require('../Stock/stock.service');
const appointmentService = require('../Appointment/appointment.service');
const recurringTransactionService = require('../RecurringTransaction/recurringTransaction.service');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service'); // Para categorias
const subscriptionService = require('../Subscription/subscription.service'); // <<< Importado
const { Plan } = require('../../database'); // <<< Importado para listar planos

const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
const logger = require('../../utils/logger');

const conversationState = new Map();
const MAX_HISTORY_FOR_AI = 8; // Pares de mensagens (usuário/assistente)
const MAX_STATE_HISTORY = 20; // Total de mensagens no estado

// --- Helper Functions ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    logger.debug(`[WHATSAPP SERVICE] Buscando categoria financeira por nome: "${name}" para conta ${financialAccountId}, tipo ${transactionType}`);
    let foundCategory = await systemService.findFinancialCategoryByNameAndType(name, transactionType, financialAccountId);
    if (foundCategory) return foundCategory.id;
    foundCategory = await systemService.findFinancialCategoryByName(name, financialAccountId);
    if (foundCategory) {
        logger.info(`[WHATSAPP SERVICE] Categoria por nome "${name}" (tipo ${transactionType || 'qualquer'}) não encontrada exatamente. Usando correspondência por nome: "${foundCategory.name}" (ID: ${foundCategory.id})`);
        return foundCategory.id;
    }
    logger.warn(`[WHATSAPP SERVICE] Categoria financeira com nome "${name}" não encontrada.`);
    return null;
}

async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const cards = await creditCardService.getAllCreditCards(financialAccountId, { isActive: true });
    const found = cards.find(card => card.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const partialFound = cards.find(card => card.name.toLowerCase().includes(name.toLowerCase()));
    if (partialFound) {
        logger.info(`[WHATSAPP SERVICE] Cartão por nome "${name}" não encontrado exatamente. Usando correspondência parcial: "${partialFound.name}" (ID: ${partialFound.id})`);
        return partialFound.id;
    }
    logger.warn(`[WHATSAPP SERVICE] Cartão de crédito com nome "${name}" não encontrado para a conta ${financialAccountId}.`);
    return null;
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    const { products } = await productService.getAllProducts(financialAccountId, { search: nameOrCode, isActive: true, limit: 5 });
    if (products && products.length > 0) {
        const exactMatch = products.find(p => p.name.toLowerCase() === nameOrCode.toLowerCase() || (p.code && p.code.toLowerCase() === nameOrCode.toLowerCase()));
        if (exactMatch) return exactMatch.id;
        logger.info(`[WHATSAPP SERVICE] Produto por nome/código "${nameOrCode}" não encontrado exatamente. Usando o primeiro da busca: "${products[0].name}" (ID: ${products[0].id})`);
        return products[0].id;
    }
    logger.warn(`[WHATSAPP SERVICE] Produto com nome/código "${nameOrCode}" não encontrado para a conta ${financialAccountId}.`);
    return null;
}

function initializeState(client, defaultAccount = null, activeSubscription = null) {
    const clientName = client ? (client.name || "pessoa incrível") : "pessoa incrível";
    const subscriptionEndDateFormatted = activeSubscription ? new Date(activeSubscription.endDate + 'T00:00:00Z').toLocaleDateString('pt-BR') : null;

    const newState = {
        currentAction: null,
        data: {},
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount ? defaultAccount.accountType : null,
        clientName: clientName,
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null,
        lastAiResponse: null,
        hasActiveSubscription: !!activeSubscription,
        subscriptionEndDate: activeSubscription ? activeSubscription.endDate : null,
        isFirstInteractionWithAccounts: false, // Nova flag
        accountsToCreate: [], // Para o fluxo de criação de contas PF/PJ/MEI
        currentAccountCreationStep: null, // 'type', 'name_PF', 'name_PJ', 'name_MEI'
    };

    if (!newState.hasActiveSubscription && client) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Para aproveitar ao máximo o ${aiModelService.ASSISTANT_NAME}, é preciso ter uma assinatura ativa. Gostaria de conhecer nossos planos? É rapidinho! ✨ (Responda 'sim' para ver os planos)` });
        newState.currentAction = 'awaiting_plan_interest';
    } else if (defaultAccount && client && newState.hasActiveSubscription) {
        newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 Bem-vindo(a) de volta à sua conta "${newState.activeFinancialAccountName}" (Plano ativo até ${subscriptionEndDateFormatted}). Como posso te ajudar hoje? Estou pronto para anotar tudo! 📝` });
    } else if (client && newState.hasActiveSubscription) {
        // Se tem assinatura mas não tem conta default (ou nenhuma conta), será tratado no fluxo principal
         newState.messageHistory.push({ role: 'assistant', content: `Olá ${clientName}! 😊 (Plano ativo até ${subscriptionEndDateFormatted}). Como posso te ajudar hoje? Estou aqui para o que precisar! ✨` });
    }
    return newState;
}

// --- Funções de Formatação de Resumo (Caprichadas) ---
function formatFinancialTransactionSummary(transaction, forMulti = false, forEdit = false) {
    const dateFormatted = transaction.transactionDate
        ? new Date(transaction.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' })
        : 'Data não informada';

    let statusText = "";
    let statusEmoji = "";
    if (transaction.isPayableOrReceivable) {
        const dueDateFormatted = transaction.dueDate ? new Date(transaction.dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';
        if (transaction.isPaidOrReceived) {
            statusText = transaction.type === 'Entrada' ? "Recebido!" : "Pago!";
            statusEmoji = "✅";
        } else {
            statusText = ` ${transaction.type === 'Entrada' ? 'A receber' : 'A pagar'} em ${dueDateFormatted}`;
            statusEmoji = "🗓️";
        }
    } else {
        statusText = transaction.type === 'Entrada' ? "Recebido!" : "Pago!";
        statusEmoji = "✅";
    }

    let categoryEmoji = transaction.type === 'Entrada' ? '📥' : '💸';
    if (transaction.category && transaction.category.name) {
        const catNameLower = transaction.category.name.toLowerCase();
        if (catNameLower.includes('lazer') || catNameLower.includes('jogo') || catNameLower.includes('entretenimento')) categoryEmoji = '🎮';
        else if (catNameLower.includes('alimentação') || catNameLower.includes('restaurante') || catNameLower.includes('ifood') || catNameLower.includes('mercado')) categoryEmoji = '🍔';
        else if (catNameLower.includes('salário') || catNameLower.includes('recebimento') || catNameLower.includes('presente')) categoryEmoji = '💰';
        else if (catNameLower.includes('transporte') || catNameLower.includes('uber') || catNameLower.includes('gasolina')) categoryEmoji = '🚗';
        else if (catNameLower.includes('saúde') || catNameLower.includes('farmácia') || catNameLower.includes('médico')) categoryEmoji = '🩺';
        else if (catNameLower.includes('casa') || catNameLower.includes('aluguel') || catNameLower.includes('moradia')) categoryEmoji = '🏡';
        else if (catNameLower.includes('educação') || catNameLower.includes('curso')) categoryEmoji = '📚';
        else if (catNameLower.includes('pet')) categoryEmoji = '🐾';
        else if (catNameLower.includes('investimento')) categoryEmoji = '📈';
        else if (catNameLower.includes('doação') || catNameLower.includes('dívida')) categoryEmoji = '👐';
        else if (catNameLower.includes('outros')) categoryEmoji = '📎';
    }
    if (transaction.creditCard && transaction.creditCard.name) categoryEmoji = '💳';


    let summary = "";
    if (!forMulti && !forEdit) summary += "📋 Resumo da Transação:\n\n";
    else if (forEdit) summary += "✅ Transação Editada:\n\n";


    summary += `${categoryEmoji} Descrição: ${transaction.description}\n`;
    summary += `💰 Valor: R$ ${parseFloat(transaction.value).toFixed(2)}\n`;
    if (transaction.category && transaction.category.name) {
        summary += `🏷️ Categoria: ${transaction.category.name}\n`;
    }
    if (transaction.creditCard && transaction.creditCard.name) {
        summary += `💳 Cartão: ${transaction.creditCard.name}${transaction.creditCard.lastFourDigits ? ` (**** ${transaction.creditCard.lastFourDigits})` : ''}\n`;
    }
    summary += `📅 Data: ${dateFormatted}\n`;
    summary += `\n${statusEmoji} Status: ${statusText}`;
    if (transaction.notes) summary += `\n📝 Obs: ${transaction.notes}`;
    return summary;
}

function formatAppointmentSummary(appointment, forMulti = false, forEdit = false) {
    const displayTimeZone = process.env.TZ || 'America/Sao_Paulo';
    const eventDateTime = new Date(appointment.eventDateTime);

    const eventDateFormatted = eventDateTime.toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: displayTimeZone
    });
    const eventTimeFormatted = eventDateTime.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone
    });

    let summary = "";
    if (!forMulti && !forEdit) summary += "📅 Resumo do Compromisso:\n\n";
    else if (forEdit) summary += "✅ Compromisso Atualizado:\n\n";

    let titleEmoji = "📝";
    const titleLower = appointment.title?.toLowerCase() || "";
    if(titleLower.includes("pagar") || titleLower.includes("dívida") || appointment.associatedValue) titleEmoji = "💸";
    else if(titleLower.includes("receber")) titleEmoji = "💰";
    else if(titleLower.includes("reunião")) titleEmoji = "🤝";
    else if(titleLower.includes("médico") || titleLower.includes("dentista")) titleEmoji = "🩺";


    summary += `${titleEmoji} Descrição: ${appointment.title}\n`;
    summary += `📆 Data: ${eventDateFormatted}\n`;
    summary += `🕑 Horário: ${eventTimeFormatted}\n`;

    if (appointment.durationMinutes) {
        const endTime = new Date(eventDateTime.getTime() + appointment.durationMinutes * 60000);
        const endTimeFormatted = endTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone });
        summary += `⏳ Duração: ${appointment.durationMinutes} min (até ${endTimeFormatted})\n`;
    }
    if (appointment.location) summary += `📍 Local: ${appointment.location}\n`;

    if (appointment.associatedValue && appointment.associatedTransactionType) {
        summary += `💲 Valor Associado: R$ ${parseFloat(appointment.associatedValue).toFixed(2)} (${appointment.associatedTransactionType})\n`;
    }

    summary += `🚦 Status: ${appointment.status}`;
    if(appointment.reminderEnabled && appointment.reminderLeadTimeMinutes) {
        summary += `\n🔔 Lembrete: Sim (${appointment.reminderLeadTimeMinutes} min antes)`;
    } else if (appointment.reminderEnabled && !appointment.reminderLeadTimeMinutes) {
        summary += `\n🔔 Lembrete: Sim (Padrão)`;
    }
    if (appointment.notes) summary += `\n💬 Notas: ${appointment.notes}`;
    return summary;
}

function formatRecurringRuleSummary(rule, forMulti = false, forEdit = false) {
    const startDateFormatted = rule.startDate ? new Date(rule.startDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/I';
    const endDateFormatted = rule.endDate ? new Date(rule.endDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'Sem data final';
    const nextDateFormatted = rule.nextDueDate ? new Date(rule.nextDueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';

    let categoryEmoji = rule.type === 'Entrada' ? '💰' : '💸';
     if (rule.category && rule.category.name) {
        const catNameLower = rule.category.name.toLowerCase();
        if (catNameLower.includes('assinatura') || catNameLower.includes('streaming') || catNameLower.includes('netflix')) categoryEmoji = '🎬';
        else if (catNameLower.includes('aluguel') || catNameLower.includes('condomínio')) categoryEmoji = '🏡';
        else if (catNameLower.includes('salário')) categoryEmoji = '💼';
    }

    let summary = "";
    if(!forMulti && !forEdit) summary += "🔄 Resumo da Recorrência:\n\n";
    else if (forEdit) summary += "✅ Recorrência Atualizada:\n\n";


    summary += `${categoryEmoji} Descrição: ${rule.description}\n`;
    summary += `💰 Valor: R$ ${parseFloat(rule.value).toFixed(2)} (${rule.type})\n`;
    if (rule.category && rule.category.name) {
        summary += `🏷️ Categoria: ${rule.category.name}\n`;
    }
    summary += `📅 Início: ${startDateFormatted}\n`;
    if(rule.endDate) summary += `🏁 Fim: ${endDateFormatted}\n`;
    summary += `🔁 Frequência: ${rule.frequency} (a cada ${rule.interval})\n`;
    if (rule.dayOfMonth) summary += `🗓️ Dia do Mês: ${rule.dayOfMonth}\n`;
    if (rule.dayOfWeek !== null && rule.dayOfWeek !== undefined) summary += `🗓️ Dia da Semana: ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][rule.dayOfWeek]}\n`;
    summary += `➡️ Próximo Vencimento: ${nextDateFormatted}\n`;
    summary += `🤖 Automático: ${rule.autoCreateTransaction ? 'Sim (Cria Transação)' : 'Não (Apenas Lembrete)'}\n`;
    summary += `🚦 Status da Regra: ${rule.isActive ? 'Ativa ✔️' : 'Inativa ❌'}`;
    return summary;
}

function formatProductSummary(product, forMulti = false, forEdit = false) {
    let summary = "";
    if(!forMulti && !forEdit) summary += "📦 Resumo do Produto:\n\n";
    else if (forEdit) summary += "✅ Produto Atualizado:\n\n";

    summary += `🏷️ Nome: ${product.name}\n`;
    if (product.code) summary += `🔢 Código: ${product.code}\n`;
    summary += `💲 Preço Venda: R$ ${parseFloat(product.salePrice).toFixed(2)}\n`;
    if (product.costPrice) summary += `📉 Preço Custo: R$ ${parseFloat(product.costPrice).toFixed(2)}\n`;
    summary += `📊 Estoque Atual: ${product.quantity} ${product.unit || 'UN'}\n`;
    if (product.minimumStock) summary += `🔔 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    summary += `🚦 Status: ${product.isActive ? 'Ativo ✔️' : 'Inativo ❌'}`;
    return summary;
}

function formatCreditCardSummary(card, forMulti = false, forEdit = false) {
    let summary = "";
    if(!forMulti && !forEdit) summary += "💳 Resumo do Cartão de Crédito:\n\n";
    else if (forEdit) summary += "✅ Cartão Atualizado:\n\n";

    summary += `✨ Nome: ${card.name}\n`;
    if(card.lastFourDigits) summary += `🔢 Final: **** ${card.lastFourDigits}\n`;
    if(card.flag) summary += `🚩 Bandeira: ${card.flag}\n`;
    summary += `💰 Limite: R$ ${parseFloat(card.limit).toFixed(2)}\n`;
    summary += `🗓️ Dia Fechamento: ${card.closingDay}\n`;
    summary += `💸 Dia Pagamento: ${card.paymentDay}\n`;
    summary += `⭐ Padrão: ${card.isDefault ? 'Sim ✔️' : 'Não ❌'}\n`;
    summary += `🚦 Status: ${card.isActive ? 'Ativo ✔️' : 'Inativo ❌'}`;
    return summary;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    try {
        // 1. BUSCAR OU CRIAR CLIENTE
        // A função findOrCreateClientByPhone não cria FinancialAccounts por padrão (o terceiro parâmetro é true por default)
        // Para este novo fluxo, vamos setar para false, pois a criação de contas será guiada.
        let client = await clientService.findOrCreateClientByPhone(senderPhone, { name: pushName }, false);
        if (!client) {
            await sendWhatsappMessage(senderPhone, `Desculpe, ${pushName || 'você'}, estou com um problema para identificar/registrar você. Por favor, tente mais tarde. 😕`);
            return;
        }
        const clientNameToUse = client.name || "pessoa incrível";

        // 2. VERIFICAR ASSINATURA
        const activeSubscription = await subscriptionService.getActiveSubscription(client.id);
        state = conversationState.get(senderPhone) || initializeState(client, null, activeSubscription);

        // Atualiza estado da assinatura e nome do cliente no state, caso tenha mudado
        state.hasActiveSubscription = !!activeSubscription;
        state.subscriptionEndDate = activeSubscription ? activeSubscription.endDate : null;
        if (client.name && state.clientName !== client.name) state.clientName = client.name;

        // Adiciona a mensagem atual ao histórico do estado ANTES de qualquer lógica de bloqueio ou ação
        // Exceto se for um clique de botão que o serviço já vai tratar e responder.
        if (!(rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string')) {
            state.messageHistory.push({ role: 'user', content: messageText });
        }
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }
        conversationState.set(senderPhone, state); // Salva o estado inicial e a msg do user

        // 3. SE NÃO TIVER ASSINATURA ATIVA
        if (!state.hasActiveSubscription) {
            if (state.currentAction === 'awaiting_plan_interest') {
                const lowerMsg = messageText.toLowerCase().trim();
                if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('quero') || lowerMsg.includes('planos')) {
                    const plans = await Plan.findAll({where: {isActive: true}, order: [['price', 'ASC']]});
                    if(!plans || plans.length === 0) {
                        const noPlansMsg = `Que pena, ${clientNameToUse}, parece que não temos planos disponíveis no momento. 😅 Por favor, verifique mais tarde!`;
                        state.messageHistory.push({ role: 'assistant', content: noPlansMsg });
                        state.currentAction = null;
                        await sendWhatsappMessage(senderPhone, noPlansMsg);
                    } else {
                        let planMessage = `Que demais, ${clientNameToUse}! 🎉 Temos estes planos super bacanas para você:\n\n`;
                        plans.forEach(p => {
                            planMessage += `*${p.name}*\n`;
                            planMessage += `Preço: R$ ${parseFloat(p.price).toFixed(2)} / ${p.durationDays <= 31 ? 'mês' : (p.durationDays >= 360 ? 'ano' : `${p.durationDays} dias`)}\n`;
                            if(p.description) planMessage += `Descrição: ${p.description}\n`;
                            planMessage += `\n`;
                        });
                        const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"; // Exemplo
                        planMessage += `Para assinar, acesse nosso site: ${siteUrl}\n\nApós assinar, me mande um "oi" aqui para continuarmos! 😉`;
                        state.messageHistory.push({ role: 'assistant', content: planMessage });
                        state.currentAction = 'showing_plans';
                        await sendWhatsappMessage(senderPhone, planMessage);
                    }
                } else {
                    const noInterestReply = `Tudo bem, ${clientNameToUse}! Se mudar de ideia sobre os planos, é só me chamar. 😊 Lembre-se que sem uma assinatura, as funcionalidades ficam limitadas. Para assinar, acesse nosso site: ${process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"}`;
                    state.messageHistory.push({ role: 'assistant', content: noInterestReply });
                    state.currentAction = null;
                    await sendWhatsappMessage(senderPhone, noInterestReply);
                }
            } else if (state.currentAction !== 'showing_plans') { // Se não estava esperando interesse nem mostrando
                const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"; // Exemplo
                const noSubMessage = `Olá ${clientNameToUse}! 😊 Notei que você ainda não tem uma assinatura ativa. Para usar todas as funcionalidades incríveis do ${aiModelService.ASSISTANT_NAME}, é preciso assinar um de nossos planos! Acesse ${siteUrl} para conhecer e escolher o seu. Depois me chame aqui! ✨`;
                state.messageHistory.push({ role: 'assistant', content: noSubMessage });
                state.currentAction = 'awaiting_plan_interest'; // Agora espera um "sim" ou outra mensagem
                await sendWhatsappMessage(senderPhone, noSubMessage);
            }
            conversationState.set(senderPhone, state);
            return; // Interrompe o fluxo aqui se não tem assinatura
        }

        // 4. SE TEM ASSINATURA ATIVA - VERIFICAR CONTAS FINANCEIRAS
        const clientFinancialAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });

        // Se é a "primeira vez" (não tem contas ou a flag `isFirstInteractionWithAccounts` não foi explicitamente setada para false)
        if (clientFinancialAccounts.length === 0 && !state.data.accountsSetupCompleted) {
            state.isFirstInteractionWithAccounts = true;
            state.data.accountsSetupCompleted = false; // Marca que o setup não foi completado
        }

        // FLUXO DE CRIAÇÃO GUIADA DE CONTAS (PF, PJ, MEI) para primeira interação
        if (state.isFirstInteractionWithAccounts && state.currentAction !== 'awaiting_financial_account_selection') {
            if (!state.currentAction || state.currentAction.startsWith('creating_guided_account_')) {
                let replyMsg = "";
                let nextStepAction = null;
                let accountTypeToCreateNow = null;

                if (!state.data.askedAboutAccountTypes) {
                    replyMsg = `Eba, ${clientNameToUse}! Que bom ter você por aqui com seu plano ativo! 🎉\n\nPara organizar tudo direitinho, o ${aiModelService.ASSISTANT_NAME} trabalha com diferentes tipos de "contas financeiras". Você pode ter uma para suas finanças:\n\n🧑‍💼 *Pessoais (PF)*\n🏢 *Da sua Empresa (PJ)*\n🚀 *Do seu MEI*\n\nVamos configurar as que você precisa? (Responda "sim" para começar ou "não" para pular por agora)`;
                    state.data.askedAboutAccountTypes = true;
                    state.currentAction = 'creating_guided_account_confirm_setup';
                } else if (state.currentAction === 'creating_guided_account_confirm_setup') {
                    if (messageText.toLowerCase().includes('sim') || messageText.toLowerCase().includes('s')) {
                        state.accountsToCreate = ['PF', 'PJ', 'MEI']; // Tipos a oferecer
                        accountTypeToCreateNow = state.accountsToCreate.shift(); // Pega o primeiro (PF)
                        replyMsg = `Ótimo! Vamos começar com a conta de *Pessoa Física (PF)*. Qual nome você gostaria de dar para ela? (Ex: "Minhas Finanças", "Pessoal")`;
                        nextStepAction = `creating_guided_account_name_${accountTypeToCreateNow}`;
                    } else {
                        replyMsg = `Sem problemas, ${clientNameToUse}! Você pode configurar suas contas financeiras a qualquer momento depois, ok? 😊 Por enquanto, como posso te ajudar?`;
                        state.isFirstInteractionWithAccounts = false; // Marca que o fluxo guiado foi pulado
                        state.data.accountsSetupCompleted = true; // Considera pulado como "completo" para este fluxo
                        state.currentAction = null;
                    }
                } else if (state.currentAction.startsWith('creating_guided_account_name_')) {
                    const currentTypeBeingNamed = state.currentAction.replace('creating_guided_account_name_', '');
                    const accountName = messageText.trim();
                    if (accountName.length > 2 && accountName.length < 100) {
                        try {
                            const newFA = await clientService.createFinancialAccount(client.id, {
                                accountName: accountName,
                                accountType: currentTypeBeingNamed,
                                isDefault: clientFinancialAccounts.length === 0 && !state.activeFinancialAccountId // Primeira criada é default
                            });
                            logger.info(`[WHATSAPP SERVICE] Conta guiada ${currentTypeBeingNamed} "${accountName}" criada para cliente ${client.id}`);
                            if (!state.activeFinancialAccountId) { // Se ainda não tem conta ativa, seta esta
                                state.activeFinancialAccountId = newFA.id;
                                state.activeFinancialAccountName = newFA.accountName;
                                state.activeFinancialAccountType = newFA.accountType;
                            }
                            clientFinancialAccounts.push(newFA); // Adiciona à lista local

                            if (state.accountsToCreate.length > 0) {
                                accountTypeToCreateNow = state.accountsToCreate.shift();
                                let typeText = accountTypeToCreateNow === 'PJ' ? 'Empresa (PJ)' : 'MEI';
                                replyMsg = `Legal! Conta "${accountName}" (${currentTypeBeingNamed}) criada! 👍\n\nAgora, para a conta de *${typeText}*. Qual nome você quer dar a ela? (Ou diga "pular" se não precisar desta)`;
                                nextStepAction = `creating_guided_account_name_${accountTypeToCreateNow}`;
                            } else {
                                replyMsg = `Perfeito! Conta "${accountName}" (${currentTypeBeingNamed}) criada! 👍\n\nTodas as contas que você indicou foram configuradas. Estou pronto para te ajudar a organizar suas finanças! O que você gostaria de fazer primeiro na sua conta "${state.activeFinancialAccountName || accountName}"?`;
                                state.isFirstInteractionWithAccounts = false; // Finalizou o fluxo guiado
                                state.data.accountsSetupCompleted = true;
                                nextStepAction = null;
                            }
                        } catch (createError) {
                            logger.error(`[WHATSAPP SERVICE] Erro ao criar conta guiada ${currentTypeBeingNamed}: ${createError.message}`);
                            replyMsg = `Ops! Tive um problema ao criar a conta ${currentTypeBeingNamed} chamada "${accountName}". (${createError.message.substring(0,60)}). Que tal tentar outro nome ou pular esta por agora?`;
                            // Não muda o nextStepAction, continua esperando um nome para o tipo atual ou "pular"
                            nextStepAction = state.currentAction;
                        }
                    } else {
                        replyMsg = `Esse nome parece um pouco curto ou longo demais. Para a conta de ${currentTypeBeingNamed}, poderia me dizer um nome entre 3 e 100 letras? Ou diga "pular". ✍️`;
                        nextStepAction = state.currentAction; // Continua no mesmo passo
                    }
                }

                if (messageText.toLowerCase().includes('pular') && state.currentAction.startsWith('creating_guided_account_name_')) {
                     const typeSkipped = state.currentAction.replace('creating_guided_account_name_', '');
                     logger.info(`[WHATSAPP SERVICE] Cliente ${client.id} pulou criação da conta ${typeSkipped}.`);
                     if (state.accountsToCreate.length > 0) {
                        accountTypeToCreateNow = state.accountsToCreate.shift();
                        let typeText = accountTypeToCreateNow === 'PJ' ? 'Empresa (PJ)' : 'MEI';
                        replyMsg = `Entendido! Pulamos a conta ${typeSkipped}.\n\nVamos para a conta de *${typeText}*. Qual nome você quer dar a ela? (Ou diga "pular" novamente)`;
                        nextStepAction = `creating_guided_account_name_${accountTypeToCreateNow}`;
                    } else {
                        replyMsg = `Entendido! Pulamos a conta ${typeSkipped}.\n\nNão há mais tipos de conta para configurar por agora. Estou pronto para te ajudar! ${state.activeFinancialAccountId ? `O que gostaria de fazer na sua conta "${state.activeFinancialAccountName}"?` : 'Como posso te ajudar?'}`;
                        state.isFirstInteractionWithAccounts = false;
                        state.data.accountsSetupCompleted = true;
                        nextStepAction = null;
                    }
                }


                if (replyMsg) {
                    state.currentAction = nextStepAction;
                    state.messageHistory.push({ role: 'assistant', content: replyMsg });
                    await sendWhatsappMessage(senderPhone, replyMsg);
                    conversationState.set(senderPhone, state);
                    return;
                }
            }
        }


        // 5. SELEÇÃO DE CONTA FINANCEIRA (SE TEM ASSINATURA E JÁ PASSOU DO SETUP INICIAL)
        if (!state.activeFinancialAccountId && clientFinancialAccounts.length > 0) {
            // Se tem várias contas e nenhuma ativa no state, ou se a ação é 'selecting_initial_financial_account'
            if (clientFinancialAccounts.length === 1) {
                const acc = clientFinancialAccounts[0];
                state.activeFinancialAccountId = acc.id;
                state.activeFinancialAccountName = acc.accountName;
                state.activeFinancialAccountType = acc.accountType;
                const selectMsg = `Beleza, ${clientNameToUse}! Notei que você tem a conta "${acc.accountName}" (${acc.accountType}). Já selecionei ela para você. Como posso ajudar? 🚀`;
                state.messageHistory.push({ role: 'assistant', content: selectMsg });
                state.currentAction = null; state.data.accountsToList = null;
                await sendWhatsappMessage(senderPhone, selectMsg);
            } else if (state.currentAction === 'selecting_initial_financial_account' || !state.data.accountsToList) { // Entra no fluxo de seleção
                state.currentAction = 'selecting_initial_financial_account';
                state.data.accountsToList = clientFinancialAccounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                let accountOptionsText = `Olá ${clientNameToUse}! 👋 Você tem estas contas configuradas:\n`;
                state.data.accountsToList.forEach((acc, index) => { accountOptionsText += `\n${index + 1}. *${acc.name}* (${acc.type})`; });
                accountOptionsText += `\n\nQual delas você gostaria de usar agora? Me diga o *nome* ou o *número* da conta. 😉 Estou no aguardo!`;
                state.messageHistory.push({ role: 'assistant', content: accountOptionsText });
                await sendWhatsappMessage(senderPhone, accountOptionsText);
            } else { // Está esperando a escolha da conta
                 const chosenIdentifier = messageText.trim();
                 let accountToSelect = null;
                 const chosenNumber = parseInt(chosenIdentifier, 10);

                 if (!isNaN(chosenNumber) && chosenNumber > 0 && chosenNumber <= state.data.accountsToList.length) {
                     accountToSelect = state.data.accountsToList[chosenNumber - 1];
                 } else {
                     accountToSelect = state.data.accountsToList.find(acc =>
                        acc.name.toLowerCase() === chosenIdentifier.toLowerCase() ||
                        acc.name.toLowerCase().includes(chosenIdentifier.toLowerCase())
                     );
                 }

                 if (accountToSelect) {
                    state.activeFinancialAccountId = accountToSelect.id;
                    state.activeFinancialAccountName = accountToSelect.name;
                    state.activeFinancialAccountType = accountToSelect.type;
                    const confirmSelectionMsg = `Entendido, ${clientNameToUse}! Selecionei a conta "${state.activeFinancialAccountName}". Como posso ajudar? 🚀`;
                    state.messageHistory.push({ role: 'assistant', content: confirmSelectionMsg });
                    state.currentAction = null; state.data.accountsToList = null;
                    await sendWhatsappMessage(senderPhone, confirmSelectionMsg);
                 } else {
                    let errorReply = `Hum, ${clientNameToUse}, não identifiquei essa conta. 😕 Você tem estas opções:\n`;
                    state.data.accountsToList.forEach((acc, index) => {errorReply += `\n${index + 1}. *${acc.name}* (${acc.type})`});
                    errorReply += "\n\nQual delas gostaria de usar (nome ou número)? 🤔"
                    state.messageHistory.push({ role: 'assistant', content: errorReply });
                    await sendWhatsappMessage(senderPhone, errorReply); // Continua esperando a seleção
                 }
            }
            conversationState.set(senderPhone, state);
            if (state.currentAction === 'selecting_initial_financial_account' || !state.activeFinancialAccountId) return; // Aguarda resposta se ainda está selecionando ou se não conseguiu selecionar
        } else if (!state.activeFinancialAccountId && clientFinancialAccounts.length === 0) {
            // Tem assinatura, mas NENHUMA conta financeira. Deve ter pulado o setup inicial.
            // Poderia iniciar o fluxo de `creating_first_account_type` aqui, mas para evitar loop,
            // vamos pedir para o usuário ser explícito
            const noAccountsMsg = `Olá ${clientNameToUse}! Você tem uma assinatura ativa, mas parece que ainda não configuramos nenhuma conta financeira (PF, PJ ou MEI). Diga "criar conta" para começarmos! 😉`;
            state.messageHistory.push({ role: 'assistant', content: noAccountsMsg });
            state.currentAction = null; // Limpa qualquer ação anterior, espera comando "criar conta"
            await sendWhatsappMessage(senderPhone, noAccountsMsg);
            conversationState.set(senderPhone, state);
            return;
        }


        // Se chegou aqui, TEM assinatura ATIVA e uma FinancialAccount ativa no state.activeFinancialAccountId

        // 6. PROCESSAR CLIQUES EM BOTÕES (se houver)
        if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
            const buttonId = rawPayload.selectedButtonId;
            logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ID '${buttonId}', Texto: '${messageText}'`); // messageText aqui é o label do botão
            let buttonClickHandledByServiceLogic = true;
            let replyForButtonClick = "";

            if (buttonId.startsWith('edit_transaction_')) {
                const transactionId = buttonId.replace('edit_transaction_', '');
                state.editingResource = { type: 'transaction', id: transactionId };
                replyForButtonClick = `Claro, ${clientNameToUse}! 😉 Descreva na próxima mensagem o que você precisa que eu altere na transação (ID: ${transactionId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                state.currentAction = 'awaiting_transaction_edit_details';
            } else if (buttonId.startsWith('delete_transaction_')) {
                const transactionId = buttonId.replace('delete_transaction_', '');
                try {
                    const success = await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId);
                    replyForButtonClick = success ? `Transação removida com sucesso, ${clientNameToUse}! 👍 Se precisar de mais alguma coisa, é só chamar.` : "Não consegui excluir a transação. Pode ter sido um erro ou ela já foi removida.";
                } catch (e) {
                    logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar excluir a transação. (${e.message.substring(0,50)})`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            } else if (buttonId.startsWith('edit_appointment_')) {
                const appointmentId = buttonId.replace('edit_appointment_', '');
                state.editingResource = { type: 'appointment', id: appointmentId };
                replyForButtonClick = `Beleza, ${clientNameToUse}! ✨ Me diga na próxima mensagem o que você quer mudar no compromisso (ID: ${appointmentId}).`;
                state.currentAction = 'awaiting_appointment_edit_details';
            } else if (buttonId.startsWith('delete_appointment_')) {
                const appointmentId = buttonId.replace('delete_appointment_', '');
                try {
                    const success = await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, true); // true para deletar
                    replyForButtonClick = success ? `Compromisso removido da sua agenda, ${clientNameToUse}! ✅ Fico à disposição se precisar de algo mais.` : "Não foi possível excluir o compromisso.";
                } catch (e) {
                     logger.error(`[WHATSAPP SERVICE] Erro ao excluir compromisso ${appointmentId} por botão: ${e.message}`);
                    replyForButtonClick = `Ops! Tive um problema ao tentar excluir o compromisso. (${e.message.substring(0,50)})`;
                }
                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
            }
            // Adicionar mais lógicas de botões aqui se necessário (ex: para edição/exclusão de produtos, cartões, etc.)
            else {
                buttonClickHandledByServiceLogic = false; // Se não for um dos botões conhecidos, deixa a IA tentar interpretar o texto do botão
            }

            if (buttonClickHandledByServiceLogic) {
                // state.messageHistory já tem o clique do botão como 'user'
                state.messageHistory.push({ role: 'assistant', content: replyForButtonClick });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForButtonClick);
                return; // Ação do botão tratada, não precisa da IA para esta rodada
            }
        }


        // 7. TRATAR ESTADOS DE AÇÕES PENDENTES (confirmações, edições, etc.)
        if (state.currentAction) {
            let stateHandledInPreProcessing = false;
            let replyForPreProcessing = "";

            if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                 const lowerMsg = messageText.toLowerCase().trim();
                 if (lowerMsg === 'sim' || lowerMsg === 's' || lowerMsg.includes('correto') || lowerMsg.includes('ok') || lowerMsg.includes('pode')) {
                    // A IA deve ter retornado a ação original em pendingConfirmation.
                    // Aqui, idealmente, a IA seria chamada de novo com o contexto de confirmação,
                    // ou a ação pendente seria executada diretamente.
                    // Por simplicidade agora, vamos apenas confirmar e limpar. A IA processará a "nova" intenção.
                    replyForPreProcessing = `Entendido, ${clientNameToUse}! Confirmado! 👍 Vou prosseguir com base nisso. O que mais posso fazer?`;
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    stateHandledInPreProcessing = true;
                } else if (lowerMsg === 'não' || lowerMsg === 'n' || lowerMsg.includes('incorreto') || lowerMsg.includes('cancela')) {
                    replyForPreProcessing = `Ok, ${clientNameToUse}, cancelado! Sem problemas. O que gostaria de fazer então? 😊`;
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                    stateHandledInPreProcessing = true;
                }
                // Se não for sim/não, deixa a IA tentar interpretar a nova mensagem.
            }
            else if (state.currentAction === 'awaiting_transaction_edit_details' || state.currentAction === 'awaiting_appointment_edit_details') {
                // A mensagem atual é a descrição da edição. A IA deve tratar isso.
                // Limpamos o currentAction aqui para que a IA não fique presa.
                // state.currentAction = null; // Removido, pois a IA usará o editingResource
                stateHandledInPreProcessing = false; // Deixa a IA processar
            }
            else if (state.currentAction === 'awaiting_clarification_response'){
                // A mensagem é a resposta para a pergunta de clarificação.
                // A IA deve conseguir usar isso para completar a ação original.
                stateHandledInPreProcessing = false;
            }


            if (stateHandledInPreProcessing && replyForPreProcessing) {
                state.messageHistory.push({ role: 'assistant', content: replyForPreProcessing });
                conversationState.set(senderPhone, state);
                await sendWhatsappMessage(senderPhone, replyForPreProcessing);
                if (state.currentAction === null && !state.pendingConfirmation) return; // Se a ação foi resolvida, não precisa da IA.
            }
        }

        // 8. CHAMAR A IA PARA INTERPRETAR A MENSAGEM
        logger.info(`[WHATSAPP HANDLER] Cliente: ${client.id} (${clientNameToUse}), Conta Ativa: ${state.activeFinancialAccountName || 'N/A'} (ID: ${state.activeFinancialAccountId || 'N/A'}), Msg: "${messageText}"`);
        if(!state.activeFinancialAccountId && state.hasActiveSubscription) {
            logger.warn(`[WHATSAPP HANDLER] Cliente ${client.id} tem assinatura mas NENHUMA conta financeira ativa no estado para IA. Isso não deveria acontecer se o fluxo de seleção/criação estiver correto.`);
            // Pode ser necessário forçar o fluxo de seleção de conta aqui novamente.
            // Por ora, a IA pode responder de forma genérica.
        }


        const aiContext = {
            currentFinancialAccountId: state.activeFinancialAccountId,
            currentFinancialAccountType: state.activeFinancialAccountType,
            currentFinancialAccountName: state.activeFinancialAccountName,
            clientName: clientNameToUse,
            conversationHistory: state.messageHistory.slice(-MAX_HISTORY_FOR_AI * 2), // Envia as últimas N interações
            currentStateData: state.data,
            editingResource: state.editingResource,
            hasActiveSubscription: state.hasActiveSubscription,
        };
        const aiResponse = await aiModelService.interpretUserMessage(messageText, aiContext);
        logger.info(`[WHATSAPP HANDLER] AI Response for ${senderPhone}:`, {aiResponsePreview: JSON.stringify(aiResponse).substring(0,500) + "..."});
        state.lastAiResponse = aiResponse;

        // Limpa o currentAction se a IA não pediu clarificação (ou seja, ela entendeu ou vai executar algo)
        // Exceto se a IA explicitamente pedir uma confirmação, o que ela faria via reply_to_user_suggestion e clarifications_needed.
        if(state.currentAction === 'awaiting_transaction_edit_details' || state.currentAction === 'awaiting_appointment_edit_details' || state.currentAction === 'awaiting_clarification_response') {
            if (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0) {
                 state.currentAction = null; // A IA está prosseguindo, não precisa mais do estado de espera.
            }
        }


        // 9. PROCESSAR AÇÕES DETECTADAS PELA IA
        let finalReplyParts = [];
        if (aiResponse.overall_summary_suggestion) {
            finalReplyParts.push(aiResponse.overall_summary_suggestion);
        }

        state.pendingConfirmation = null; // Limpa confirmação pendente antes de processar novas ações

        let singleActionFormattedResult = null;
        let multipleActionFormattedResults = [];
        let actionWasAnEdit = false;
        let resourceForButtonsContext = null; // Usado para os botões de editar/excluir

        if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
            for (const detectedAction of aiResponse.detected_actions) {
                const params = detectedAction.parameters || {};
                let currentActionFormatted = "";
                let isEditActionCurrentLoop = false;
                let actionBlockedNoSubscriptionLoop = false;

                const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SWITCH_FINANCIAL_ACCOUNT', 'CREATE_FINANCIAL_ACCOUNT'];
                if (!state.hasActiveSubscription && !publicActions.includes(detectedAction.action)) {
                    currentActionFormatted = `Sinto muito, ${clientNameToUse}, mas para realizar a ação de "${detectedAction.action}", você precisa de uma assinatura ativa. Para assinar, acesse nosso site: ${process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"} e depois me chame aqui! 😉`;
                    state.currentAction = 'awaiting_plan_interest'; // Direciona para o fluxo de planos
                    actionBlockedNoSubscriptionLoop = true;
                }
                // Ações que exigem uma conta financeira selecionada
                const accountRequiredActions = [
                    'CREATE_FINANCIAL_TRANSACTION', 'SCHEDULE_APPOINTMENT', 'CREATE_PARCELLED_ACCOUNT',
                    'UPDATE_FINANCIAL_TRANSACTION', 'UPDATE_APPOINTMENT', 'GET_FINANCIAL_SUMMARY',
                    'LIST_FINANCIAL_TRANSACTIONS', 'MARK_TRANSACTION_AS_PAID_RECEIVED',
                    'CREATE_RECURRING_RULE', 'CREATE_PRODUCT', 'GET_STOCK_INFO',
                    'RECORD_STOCK_MOVEMENT', 'LIST_APPOINTMENTS', 'CREATE_CREDIT_CARD',
                    'LIST_CREDIT_CARDS', 'LIST_RECURRING_RULES'
                ];
                if (accountRequiredActions.includes(detectedAction.action) && !state.activeFinancialAccountId) {
                    currentActionFormatted = `Opa, ${clientNameToUse}! Para eu poder "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", preciso que você selecione uma conta financeira primeiro. Se você já configurou alguma, me diga o nome dela. Se não, diga "criar conta"! 😊`;
                    state.currentAction = 'selecting_initial_financial_account'; // Força a seleção
                    actionBlockedNoSubscriptionLoop = true; // Reutiliza a flag para bloquear
                }


                if (actionBlockedNoSubscriptionLoop) {
                    if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = currentActionFormatted;
                    else multipleActionFormattedResults.push(currentActionFormatted);
                    break; // Interrompe o processamento de outras ações se uma crucial foi bloqueada
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
                                isPayableOrReceivable: params.isPayableOrReceivable !== undefined ? params.isPayableOrReceivable : (params.dueDate ? true : false),
                                dueDate: params.dueDate,
                                isPaidOrReceived: params.isPaidOrReceived !== undefined ? params.isPaidOrReceived : (!params.dueDate)
                            };
                            const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                            const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                            currentActionFormatted = formatFinancialTransactionSummary(reloadedTx, aiResponse.detected_actions.length > 1);
                            if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'transaction', id: newTx.id, description: newTx.description };
                            break;
                        }
                        case 'UPDATE_FINANCIAL_TRANSACTION': {
                            isEditActionCurrentLoop = true;
                            actionWasAnEdit = true; // Seta a flag global de edição
                            const transactionIdToUpdate = params.transactionIdToUpdate || state.editingResource?.id;
                            if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não foi fornecido pela IA ou não estava no contexto de edição.");

                            const updateTxData = { ...params };
                            if (params.financialCategoryName) updateTxData.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || null);
                            if (params.creditCardName) updateTxData.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                            delete updateTxData.transactionIdToUpdate; delete updateTxData.financialCategoryName; delete updateTxData.creditCardName;

                            const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateTxData);
                            const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);
                            currentActionFormatted = aiResponse.reply_to_user_suggestion || formatFinancialTransactionSummary(reloadedUpdatedTx, false, true);
                            state.editingResource = null; // Limpa o recurso de edição
                            break;
                        }
                        case 'SCHEDULE_APPOINTMENT': {
                            let eventDateTime = params.eventDateTime; // Assume "YYYY-MM-DD HH:MM"
                            // Se IA retornar apenas data, adicionar horário padrão
                            if (params.eventDateTime && params.eventDateTime.length === 10) { // YYYY-MM-DD
                                eventDateTime += ' 09:00'; // Default 9 AM
                            } else if (params.eventDateTime && params.eventDateTime.includes("T") && params.eventDateTime.endsWith("Z")) { // Formato ISO completo
                                const d = new Date(params.eventDateTime);
                                const year = d.getFullYear();
                                const month = String(d.getMonth() + 1).padStart(2, '0');
                                const day = String(d.getDate()).padStart(2, '0');
                                const hour = String(d.getHours()).padStart(2, '0');
                                const minute = String(d.getMinutes()).padStart(2, '0');
                                eventDateTime = `${year}-${month}-${day} ${hour}:${minute}`;
                            }

                            const appData = {
                                title: params.title, eventDateTime: eventDateTime,
                                durationMinutes: params.durationMinutes, location: params.location,
                                reminderLeadTimeMinutes: params.reminderLeadTimeMinutes, notes: params.notes,
                                associatedValue: params.associatedValue ? parseFloat(params.associatedValue) : null,
                                associatedTransactionType: params.associatedTransactionType || null,
                                // status: 'Scheduled' // O service já faz isso por padrão
                            };
                            const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                            const reloadedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newApp.id);
                            currentActionFormatted = formatAppointmentSummary(reloadedApp, aiResponse.detected_actions.length > 1);
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
                                const year = d.getFullYear();
                                const month = String(d.getMonth() + 1).padStart(2, '0');
                                const day = String(d.getDate()).padStart(2, '0');
                                const hour = String(d.getHours()).padStart(2, '0');
                                const minute = String(d.getMinutes()).padStart(2, '0');
                                updateAppData.eventDateTime = `${year}-${month}-${day} ${hour}:${minute}`;
                            }
                            delete updateAppData.appointmentIdToUpdate;
                            if (params.hasOwnProperty('associatedValue')) updateAppData.associatedValue = params.associatedValue ? parseFloat(params.associatedValue) : null;

                            const updatedApp = await appointmentService.updateAppointment(state.activeFinancialAccountId, appointmentIdToUpdate, updateAppData);
                            const reloadedUpdatedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, updatedApp.id);
                            currentActionFormatted = aiResponse.reply_to_user_suggestion || formatAppointmentSummary(reloadedUpdatedApp, false, true);
                            state.editingResource = null;
                            break;
                        }
                        case 'CREATE_PARCELLED_ACCOUNT': {
                            const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                            const cardIdParcel = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                            const parcelData = {
                                description: params.description, type: params.type, totalValue: parseFloat(params.totalValue),
                                numberOfParcels: parseInt(params.numberOfParcels), initialDueDate: params.initialDueDate,
                                financialCategoryId: catIdParcel, creditCardId: cardIdParcel, notes: params.notes,
                                transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                            };
                            const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData);
                            currentActionFormatted = `Conta parcelada "${params.description}" (${parcelResult.parcels.length}x) registrada com sucesso! 🥳 A primeira parcela vence em ${new Date(parcelResult.parcels[0].dueDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'})}.`;
                            break;
                        }
                        case 'GET_FINANCIAL_SUMMARY': {
                            const filterParams = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                            };
                            if (params.period) {
                                const todayLocale = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
                                todayLocale.setHours(0,0,0,0); // Zera a hora para cálculos de data
                                switch(params.period.toLowerCase().replace("_", " ")) { // Normaliza o período
                                    case 'hoje': filterParams.dateStart = filterParams.dateEnd = todayLocale.toISOString().split('T')[0]; break;
                                    case 'ontem': const y = new Date(todayLocale); y.setDate(y.getDate() - 1); filterParams.dateStart = filterParams.dateEnd = y.toISOString().split('T')[0]; break;
                                    case 'esta semana':
                                        const day = todayLocale.getDay(); const diff = todayLocale.getDate() - day + (day === 0 ? -6 : 1); // Ajusta para segunda-feira como início da semana
                                        const first = new Date(todayLocale.setDate(diff));
                                        const last = new Date(first); last.setDate(first.getDate() + 6);
                                        filterParams.dateStart = first.toISOString().split('T')[0]; filterParams.dateEnd = last.toISOString().split('T')[0]; break;
                                    case 'semana passada':
                                        const prevWeekEnd = new Date(todayLocale); prevWeekEnd.setDate(todayLocale.getDate() - todayLocale.getDay() -1); // Domingo passado
                                        const prevWeekStart = new Date(prevWeekEnd); prevWeekStart.setDate(prevWeekEnd.getDate() - 6); // Segunda da semana passada
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
                                          `💰 *Saldo Efetivado: R$ ${summaryData.saldoEfetivado.toFixed(2)}*\n\n` +
                                          `📈 A Receber (Pend.): R$ ${summaryData.totalAReceberPendente.toFixed(2)}\n` +
                                          `📉 A Pagar (Pend.): R$ ${summaryData.totalAPagarPendente.toFixed(2)}`;
                            break;
                        }
                         case 'LIST_FINANCIAL_TRANSACTIONS': {
                             const filterParamsList = {
                                dateStart: params.dateStart, dateEnd: params.dateEnd, type: params.type,
                                financialCategoryId: params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null,
                                isPaidOrReceived: params.isPaidOrReceived,
                                search: params.searchTerm || params.description, // IA pode usar 'searchTerm' ou 'description'
                                limit: params.limit || 5, page: params.page || 1,
                                sortBy: params.sortBy || 'transactionDate', sortOrder: params.sortOrder || 'DESC'
                            };
                            const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList);
                            if (totalItems === 0) {
                                currentActionFormatted = `Nenhuma transação encontrada para os filtros que você pediu, ${clientNameToUse}. 👍 Tente outros filtros!`;
                            } else {
                                let listText = `📜 Encontrei ${totalItems} transações. As ${transactions.length > 1 ? transactions.length + " " : ""}mais recentes são:\n`;
                                for (const t of transactions) {
                                    const catName = t.category ? t.category.name : 'Sem Categoria';
                                    const emoji = t.type === 'Entrada' ? '🟢' : '🔴';
                                    const date = new Date(t.transactionDate + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'});
                                    listText += `\n${emoji} ${t.description} - R$ ${parseFloat(t.value).toFixed(2)}\n    (Cat: ${catName}, Data: ${date}, ID: ${t.id})`; // Adicionado ID para referência
                                    if (t.isPayableOrReceivable) {
                                        listText += t.isPaidOrReceived ? " (Liquidada ✅)" : ` (Vence ${new Date(t.dueDate+'T00:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'})} 🗓️)`;
                                    }
                                }
                                if (totalItems > transactions.length) listText += `\n\nE mais ${totalItems - transactions.length} transações. Peça para ver mais se quiser! 😉`;
                                currentActionFormatted = listText;
                            }
                            break;
                        }
                        case 'MARK_TRANSACTION_AS_PAID_RECEIVED': {
                            let transactionToMark = null;
                            if (params.transactionIdToUpdate && !isNaN(parseInt(params.transactionIdToUpdate))) { // Se a IA fornecer um ID direto
                                transactionToMark = await financialService.getTransactionById(state.activeFinancialAccountId, parseInt(params.transactionIdToUpdate));
                            } else if (state.editingResource && state.editingResource.type === 'transaction') { // Se estava no contexto de edição
                                transactionToMark = await financialService.getTransactionById(state.activeFinancialAccountId, state.editingResource.id);
                            } else if (params.transactionDescription) { // Busca por descrição
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
                                currentActionFormatted = ` Oba, ${clientNameToUse}! 🎉 Transação "${updatedTx.description}" marcada como ${updatedTx.type === 'Entrada' ? 'recebida' : 'paga'} com sucesso!`;
                                state.editingResource = null;
                            }
                            break;
                        }
                        case 'CREATE_RECURRING_RULE': {
                            const catRecId = params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null;
                            let ruleValue = parseFloat(params.value);
                            if ((isNaN(ruleValue) || ruleValue <= 0) && params.description && params.description.toLowerCase().includes('netflix')) {
                                ruleValue = 55.90; // Exemplo de valor padrão
                                logger.info(`[WHATSAPP SERVICE] Valor para Netflix não fornecido, usando padrão ${ruleValue}`);
                            }
                            const ruleData = {
                                description: params.description, type: params.type, value: ruleValue || 0,
                                frequency: params.frequency, startDate: params.startDate, // IA deve prover no formato YYYY-MM-DD
                                interval: params.interval || 1, dayOfMonth: params.dayOfMonth, dayOfWeek: params.dayOfWeek,
                                endDate: params.endDate, autoCreateTransaction: params.autoCreateTransaction === undefined ? false : params.autoCreateTransaction,
                                financialCategoryId: catRecId, notes: params.notes,
                                isPayableOrReceivable: true, // Recorrências são contas por padrão
                            };
                            const newRule = await recurringTransactionService.createRecurringRule(state.activeFinancialAccountId, ruleData);
                            const reloadedRule = await recurringTransactionService.getRecurringRuleById(state.activeFinancialAccountId, newRule.id);
                            currentActionFormatted = formatRecurringRuleSummary(reloadedRule, aiResponse.detected_actions.length > 1);
                            break;
                        }
                         case 'CREATE_PRODUCT': {
                            if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                currentActionFormatted = `Desculpe, ${clientNameToUse}, mas o cadastro de produtos é apenas para contas PJ ou MEI. Sua conta "${state.activeFinancialAccountName}" é do tipo ${state.activeFinancialAccountType}.`;
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
                            currentActionFormatted = formatProductSummary(newProd, aiResponse.detected_actions.length > 1);
                            break;
                        }
                        case 'GET_STOCK_INFO': {
                             if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                currentActionFormatted = `Ops, ${clientNameToUse}, a consulta de estoque é só para contas PJ ou MEI.`;
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
                            break;
                        }
                        case 'RECORD_STOCK_MOVEMENT': {
                            if (!['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                                currentActionFormatted = `Sinto muito, ${clientNameToUse}, movimentação de estoque é para contas PJ ou MEI.`;
                                break;
                            }
                            const productIdStock = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                             if(!productIdStock) {
                                currentActionFormatted = `Não encontrei o produto "${params.productNameOrCode}" para movimentar o estoque, ${clientNameToUse}. 😬`;
                                break;
                            }
                            const movementData = {
                                type: params.movementType, // "Entrada", "Saída", "Ajuste"
                                quantity: parseInt(params.quantity),
                                reason: params.reason
                            };
                            const movement = await stockService.recordStockMovement(productIdStock, movementData);
                            const updatedProduct = await productService.getProductById(state.activeFinancialAccountId, productIdStock); // Pega o saldo atualizado
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
                            currentActionFormatted = formatCreditCardSummary(newCard, aiResponse.detected_actions.length > 1);
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
                                    const dateStr = eventDT.toLocaleDateString('pt-BR', {timeZone: process.env.TZ || 'America/Sao_Paulo'});
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
                                currentActionFormatted = `Você ainda não cadastrou nenhum cartão de crédito na conta "${state.activeFinancialAccountName}", ${clientNameToUse}. 💳`;
                            } else {
                                let cardListText = `Estes são seus cartões de crédito ativos para "${state.activeFinancialAccountName}":\n`;
                                cards.forEach(c => {
                                    cardListText += `\n- *${c.name}* (Limite: R$ ${parseFloat(c.limit).toFixed(2)})${c.isDefault ? ' ⭐Padrão' : ''}`;
                                });
                                currentActionFormatted = cardListText;
                            }
                            break;
                        }
                        case 'LIST_RECURRING_RULES': {
                            const rules = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, { isActive: true });
                            if(rules.length === 0) {
                                currentActionFormatted = `Nenhuma regra de recorrência ativa encontrada para "${state.activeFinancialAccountName}", ${clientNameToUse}. 🔄`;
                            } else {
                                let ruleListText = `Suas regras de recorrência ativas para "${state.activeFinancialAccountName}":\n`;
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
                            const allClientAccounts = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                            if (!targetAccountName) {
                                if (allClientAccounts.length <= 1) {
                                    currentActionFormatted = `Você só tem a conta "${state.activeFinancialAccountName}" configurada por enquanto, ${clientNameToUse}. Se quiser criar outra, me diga! 😉`;
                                } else {
                                    let accList = `Você tem estas contas, ${clientNameToUse}:\n`;
                                    allClientAccounts.forEach(acc => { accList += `\n- *${acc.accountName}* (${acc.accountType}) ${acc.id === state.activeFinancialAccountId ? ' (Selecionada ✨)' : ''}`; });
                                    accList += "\n\nPara qual delas você gostaria de mudar? Só me dizer o nome.";
                                    currentActionFormatted = accList;
                                    state.currentAction = 'selecting_initial_financial_account'; // Reusa o estado de seleção
                                    state.data.accountsToList = allClientAccounts.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                                }
                            } else {
                                const foundAcc = allClientAccounts.find(acc => acc.accountName.toLowerCase() === targetAccountName.toLowerCase() || acc.accountType.toLowerCase() === targetAccountName.toLowerCase());
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
                        case 'CREATE_FINANCIAL_ACCOUNT': { // Se a IA identificar explicitamente a intenção de criar
                            const typeToCreate = params.accountTypeToCreate; // PF, PJ, MEI
                            const newAccName = params.newAccountName;
                            if (!typeToCreate) {
                                currentActionFormatted = `Para criar uma nova conta financeira, preciso saber o tipo: Pessoal (PF), Empresa (PJ) ou MEI?`;
                                state.currentAction = 'creating_first_account_type'; // Reutiliza estado do fluxo inicial
                            } else if (!newAccName) {
                                currentActionFormatted = `Entendi que você quer criar uma conta do tipo ${typeToCreate}. Qual nome você gostaria de dar para ela?`;
                                state.currentAction = 'awaiting_first_account_name';
                                state.data.accountTypeToCreate = typeToCreate;
                            } else {
                                // Lógica de criação de conta (similar ao fluxo guiado)
                                try {
                                    const newFA = await clientService.createFinancialAccount(client.id, { accountName: newAccName, accountType: typeToCreate });
                                    currentActionFormatted = `Conta "${newFA.accountName}" (${newFA.accountType}) criada com sucesso, ${clientNameToUse}! 🎉 Ela já está selecionada. O que vamos fazer?`;
                                    state.activeFinancialAccountId = newFA.id;
                                    state.activeFinancialAccountName = newFA.accountName;
                                    state.activeFinancialAccountType = newFA.accountType;
                                    state.currentAction = null; state.data = {};
                                } catch(e) {
                                    currentActionFormatted = `Ops, não consegui criar a conta "${newAccName}" (${typeToCreate}). ${e.message.substring(0,70)}. Tente um nome diferente.`;
                                    state.currentAction = 'awaiting_first_account_name';
                                    state.data.accountTypeToCreate = typeToCreate;
                                }
                            }
                            break;
                        }
                        case 'GENERAL_GREETING_OR_SMALLTALK':
                        case 'GENERAL_QUESTION_OR_HELP':
                        case 'ACTION_CONFIRMATION_YES':
                        case 'ACTION_CONFIRMATION_NO':
                            currentActionFormatted = aiResponse.reply_to_user_suggestion || `Entendido, ${clientNameToUse}! 😊`;
                            if (detectedAction.action === 'ACTION_CONFIRMATION_YES' || detectedAction.action === 'ACTION_CONFIRMATION_NO') {
                                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                            }
                            // Se for uma dessas ações e tiver um reply_to_user_suggestion, usamos ele como principal.
                            if (aiResponse.reply_to_user_suggestion) {
                                finalReplyParts = [aiResponse.reply_to_user_suggestion];
                                multipleActionFormattedResults = []; // Limpa outros resultados se for só uma saudação/pergunta
                            }
                            break;
                        default:
                            if (aiResponse.detected_actions.length === 1 && aiResponse.reply_to_user_suggestion && !aiResponse.overall_summary_suggestion) {
                                // Se é uma única ação e a IA já deu uma resposta completa, usa ela.
                                currentActionFormatted = aiResponse.reply_to_user_suggestion;
                            } else {
                                currentActionFormatted = `Ação "${detectedAction.action}" ${params.description ? `para "${params.description}"` : ''} foi entendida, ${clientNameToUse}, mas ainda não sei como processá-la completamente. 😅`;
                                logger.warn(`[WHATSAPP SERVICE] Ação da IA não implementada no switch: ${detectedAction.action}`);
                            }
                            break;
                    }

                    if (actionBlockedNoSubscriptionLoop) continue; // Pula para a próxima detectedAction se esta foi bloqueada

                    if (currentActionFormatted) {
                        if (aiResponse.detected_actions.length === 1 && !isEditActionCurrentLoop) {
                            singleActionFormattedResult = currentActionFormatted;
                        } else if (!isEditActionCurrentLoop) {
                            multipleActionFormattedResults.push(currentActionFormatted);
                        } else { // Se foi uma edição
                            singleActionFormattedResult = currentActionFormatted; // Edições geralmente são únicas na resposta
                        }
                    }
                    // resourceForButtonsContext já foi setado dentro dos cases relevantes
                } catch (e) {
                    logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack?.substring(0,300), params: params });
                    const errorMsgPart = `Ops! 😬 Tive um problema ao tentar processar "${params.description || detectedAction.action}". (${e.message.length < 80 ? e.message : 'Erro interno, desculpe!'}). Pode tentar de novo ou com outros termos?`;
                    if (aiResponse.detected_actions.length === 1) singleActionFormattedResult = errorMsgPart;
                    else multipleActionFormattedResults.push(errorMsgPart);
                }
            }
        }

        // 10. CONSTRUIR E ENVIAR RESPOSTA FINAL
        if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
            // Se precisa de clarificação, esta é a ÚNICA resposta.
            // A clarification_question já deve ser uma frase completa e amigável.
            finalReplyParts = [aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe: ${aiResponse.clarifications_needed[0].clarification_question}`];
            state.currentAction = 'awaiting_clarification_response'; // Define o estado para esperar a clarificação
            // Guarda o contexto da clarificação para a próxima rodada
            state.data.clarificationContext = {
                action: aiResponse.clarifications_needed[0].original_intent_action_suggestion,
                original_message: messageText,
                parameters_so_far: aiResponse.clarifications_needed[0].parameters_so_far || {}
            };
            singleActionFormattedResult = null; // Limpa resultados de ações
            multipleActionFormattedResults = [];
        } else if (singleActionFormattedResult) { // Se houve UMA ação principal
            if (finalReplyParts.length > 0 && !actionWasAnEdit && !finalReplyParts.join(" ").includes(singleActionFormattedResult.substring(0,20))) {
                // Se já tem um "overall_summary_suggestion" E NÃO FOI UMA EDIÇÃO, adiciona a sugestão de resposta da IA (se houver)
                if(aiResponse.reply_to_user_suggestion && !aiResponse.reply_to_user_suggestion.includes(aiResponse.overall_summary_suggestion) && !singleActionFormattedResult.includes(aiResponse.reply_to_user_suggestion.substring(0,20))) {
                    finalReplyParts.push(aiResponse.reply_to_user_suggestion);
                }
                finalReplyParts.push(singleActionFormattedResult);
            } else { // Se não tinha overall_summary OU se foi uma edição, o resultado da ação é o principal
                finalReplyParts = [singleActionFormattedResult];
            }
        } else if (multipleActionFormattedResults.length > 0) { // Se houve MÚLTIPLAS ações
            if (finalReplyParts.length === 0) { // Se não tem overall_summary
                finalReplyParts.push(`${clientNameToUse}, aqui está o que eu fiz pra você! 😉`);
            } else if (aiResponse.reply_to_user_suggestion && !finalReplyParts.join(" ").includes(aiResponse.reply_to_user_suggestion.substring(0,20))) {
                // Adiciona a sugestão da IA se ainda não estiver contida no overall_summary
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion);
            }
            finalReplyParts.push(multipleActionFormattedResults.join("\n\n---\n\n"));
        } else if (aiResponse.reply_to_user_suggestion) { // Se NENHUMA ação concreta, mas a IA tem uma resposta
            if (finalReplyParts.length === 0 || (finalReplyParts.length === 1 && finalReplyParts[0] === aiResponse.overall_summary_suggestion)) {
                 // Se só tinha o overall, substitui pelo reply_to_user se este for mais específico
                finalReplyParts = [aiResponse.reply_to_user_suggestion];
            } else if (!finalReplyParts.join(" ").includes(aiResponse.reply_to_user_suggestion.substring(0,30))) {
                 // Se já tem algo e o reply_to_user é diferente, adiciona.
                 finalReplyParts.push(aiResponse.reply_to_user_suggestion);
            }
        } else { // Fallback se a IA não deu nenhuma sugestão e nenhuma ação foi executada
            finalReplyParts.push(`Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊 Estou por aqui!`);
        }

        // Adiciona mensagem final se ações concretas foram realizadas (e não é só saudação/pergunta)
        const performedConcreteAction = (singleActionFormattedResult || multipleActionFormattedResults.length > 0) &&
                                       !(aiResponse.detected_actions?.some(a => a.action.startsWith("GENERAL_"))) &&
                                       (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0);

        if (performedConcreteAction && state.hasActiveSubscription) {
            const platformUrl = process.env.PLATFORM_URL || 'app.meuassessor.com';
            const dashboardMessage = `\n📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}`;
            if (!finalReplyParts.join(" ").includes(platformUrl)) {
                finalReplyParts.push(dashboardMessage);
            }

            const closingMessages = ["algo a mais", "só chamar", "à disposição", "o que mais", "como posso ajudar"];
            if (!finalReplyParts.some(p => closingMessages.some(cm => p.toLowerCase().includes(cm)))) {
                 finalReplyParts.push(`Se precisar de algo a mais é só me chamar, ${clientNameToUse}! 😄`);
            }
        } else if (!state.hasActiveSubscription && state.currentAction === 'showing_plans'){
            // Já mostrou os planos, não adiciona mais nada a não ser que a IA tenha uma resposta específica.
        } else if (!state.hasActiveSubscription && performedConcreteAction){
            // Não deveria acontecer, pois a ação deveria ser bloqueada. Mas se acontecer...
            logger.warn(`[WHATSAPP HANDLER] Ação concreta ${aiResponse.detected_actions[0]?.action} processada SEM assinatura ativa para ${client.id}. Revisar lógica.`);
        }


        const completeFinalReply = finalReplyParts.join("\n\n").trim();
        state.messageHistory.push({ role: 'assistant', content: completeFinalReply });

        // Limpa o editingResource se uma edição foi realmente processada OU se a IA não detectou uma ação de edição
        if (actionWasAnEdit || (state.editingResource && aiResponse.detected_actions?.every(a => !a.action.startsWith("UPDATE_")))) {
            state.editingResource = null;
        }
        // Limpa o contexto de clarificação se a IA não pedir mais clarificações
        if (state.data.clarificationContext && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
            delete state.data.clarificationContext;
        }


        conversationState.set(senderPhone, state);

        if (completeFinalReply) {
            // Enviar com botões apenas se UMA ação principal foi feita (não edição, não clarificação) e resourceForButtonsContext foi definido
            if (resourceForButtonsContext && aiResponse.detected_actions?.length === 1 && !actionWasAnEdit && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
                let buttons = [];
                let buttonItemDesc = "item";
                if (resourceForButtonsContext.description && typeof resourceForButtonsContext.description === 'string') {
                    buttonItemDesc = resourceForButtonsContext.description.length > 20 ? resourceForButtonsContext.description.substring(0, 17) + "..." : resourceForButtonsContext.description;
                }
                const buttonTitle = `Opções para "${buttonItemDesc}":`;

                if (resourceForButtonsContext.type === 'transaction') {
                    buttons = [
                        { id: `edit_transaction_${resourceForButtonsContext.id}`, label: "Editar Transação ✍️" },
                        { id: `delete_transaction_${resourceForButtonsContext.id}`, label: "Excluir Transação 🗑️" },
                    ];
                } else if (resourceForButtonsContext.type === 'appointment') {
                    buttons = [
                        { id: `edit_appointment_${resourceForButtonsContext.id}`, label: "Editar Compromisso ✍️" },
                        { id: `delete_appointment_${resourceForButtonsContext.id}`, label: "Excluir Compromisso 🗑️" },
                    ];
                }
                // Adicionar mais tipos de botões aqui (produto, cartão, etc.)

                if (buttons.length > 0) {
                    await sendButtonListMessage(senderPhone, completeFinalReply, buttons, buttonTitle);
                } else {
                    await sendWhatsappMessage(senderPhone, completeFinalReply);
                }
                state.editingResource = resourceForButtonsContext; // Mantém no estado para caso a próxima msg seja uma edição implícita
            } else {
                await sendWhatsappMessage(senderPhone, completeFinalReply);
                 // Se não enviou botões, e havia um editingResource, limpa para não interferir na próxima mensagem
                if(state.editingResource && !resourceForButtonsContext) state.editingResource = null;
            }
        }

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000), messageText, rawPayload });
        const clientNameToUseInError = state ? state.clientName : (pushName || "você");
        // Não deletar o estado em caso de erro, para não perder o histórico recente.
        // Apenas logar e enviar mensagem de erro.
        try {
            await sendWhatsappMessage(senderPhone, `Puxa vida, ${clientNameToUseInError}! 😬 Parece que tive um curto-circuito aqui e não consegui processar sua mensagem. Minha equipe de engenheiros já está de olho nisso! 👩‍💻👨‍💻 Por favor, tente de novo em um momentinho. Desculpe o transtorno!`);
        } catch (sendError) {
            logger.error(`[WHATSAPP HANDLER] Falha ao enviar msg de erro crítico para ${senderPhone}: ${sendError.message}`);
        }
    } finally {
        const endTime = Date.now();
        logger.info(`[WHATSAPP HANDLER] Processamento para ${senderPhone} finalizado em ${endTime - startTime}ms.`);
        if (state) conversationState.set(senderPhone, state); // Garante que o estado final seja salvo
    }
}

module.exports = { processIncomingMessage };
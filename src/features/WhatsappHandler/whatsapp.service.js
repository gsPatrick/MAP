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
let pushNameFromPayload = null; // Variável global temporária para o nome do WhatsApp


// --- Funções Auxiliares de Busca (sem alteração na assinatura, mas usadas pelas de formatação) ---
async function findFinancialCategoryIdByName(name, financialAccountId, transactionType = null) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    const category = await systemService.findFinancialCategoryByNameAndType(name, transactionType, financialAccountId);
    return category ? category.id : null;
}

async function findCreditCardIdByName(name, financialAccountId) {
    if (!name || typeof name !== 'string' || name.trim() === '') return null;
    try {
        const card = await creditCardService.findCreditCardByName(financialAccountId, name);
        return card ? card.id : null;
    } catch (error) {
        if (error.statusCode === 404) {
            logger.warn(`[WHATSAPP SERVICE HELPER] Cartão "${name}" não encontrado para conta ${financialAccountId} via findCreditCardIdByName.`);
            return null;
        }
        throw error;
    }
}

async function findProductIdByNameOrCode(nameOrCode, financialAccountId) {
    if (!nameOrCode || typeof nameOrCode !== 'string' || nameOrCode.trim() === '') return null;
    const productsResult = await productService.getAllProducts(financialAccountId, { search: nameOrCode, limit: 1 });
    if (productsResult.products && productsResult.products.length > 0) {
        return productsResult.products[0].id;
    }
    return null;
}

// --- Novas Funções de Formatação para "Estrutura de Dados" ---

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const safeDateString = dateString.length === 10 ? `${dateString}T00:00:00Z` : dateString;
    return new Date(safeDateString).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function formatTime(dateTimeString, includeSeconds = true) {
    if (!dateTimeString) return 'N/A';
    const options = { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' };
    if (includeSeconds) options.second = '2-digit';
    return new Date(dateTimeString).toLocaleTimeString('pt-BR', options);
}

function formatCurrency(value) {
    if (value === null || value === undefined) return 'R$ --,--';
    return `R$${parseFloat(value).toFixed(2).replace('.', ',')}`;
}

function formatPlatformLink(customText = "") {
    const platformUrl = process.env.PLATFORM_URL || 'app.mapnocontrole.com.br';
    const defaultText = `📊 Para visualizar mais detalhes e relatórios, acesse a plataforma em https://${platformUrl}. Qualquer coisa, estou por aqui! 😉`;
    return customText || defaultText;
}

function formatFinancialTransactionDataStructure(transaction) {
    if (!transaction) return "🎯 Resumo da Transação:\n\nDados não disponíveis.";
    let data = `🎯 Resumo da Transação:\n\n`;
    data += `📝 Descrição: ${transaction.description || 'N/A'}\n`;
    data += `💰 Valor: ${formatCurrency(transaction.value)}\n`;
    if (transaction.category && transaction.category.name) {
        data += `${transaction.type === 'Entrada' ? '💸' : (transaction.creditCardId ? '💳' : '🏷️')} Categoria: ${transaction.category.name}\n`;
    } else {
        data += `🏷️ Categoria: Não especificada\n`;
    }
    data += `📅 Data: ${formatDate(transaction.transactionDate)}\n`;

    if (transaction.creditCard && transaction.creditCard.name) {
        data += `💳 Cartão: ${transaction.creditCard.name}\n`;
    }

    if (transaction.isPayableOrReceivable && !transaction.creditCardId) {
        data += `🗓️ Vencimento: ${formatDate(transaction.dueDate)}\n`;
        data += `✅ Status: ${transaction.isPaidOrReceived ? (transaction.type === 'Entrada' ? 'Recebido' : 'Pago') : 'Pendente'}\n`;
        if (transaction.isPaidOrReceived && transaction.paymentDate) {
            data += `🧾 Data Pgto/Rec: ${formatDate(transaction.paymentDate)}\n`;
        }
    } else {
        data += `✅ Status: ${transaction.type === 'Entrada' ? 'Recebido' : 'Pago'}\n`;
    }
    if (transaction.notes) {
        data += `🗒️ Observações: ${transaction.notes}\n`;
    }
    return data.trim();
}

function formatAppointmentDataStructure(appointment) {
    if (!appointment) return "📅 Resumo do Compromisso:\n\nDados não disponíveis.";
    let data = `📅 Resumo do Compromisso:\n\n`;
    data += `💼 Descrição: ${appointment.title || 'N/A'}\n`;
    data += `📆 Data: ${formatDate(appointment.eventDateTime)}\n`;
    data += `🕔 Horário de início: ${formatTime(appointment.eventDateTime)}\n`;

    if (appointment.durationMinutes) {
        const endTime = new Date(new Date(appointment.eventDateTime).getTime() + appointment.durationMinutes * 60000);
        data += `🕔 Horário de término: ${formatTime(endTime)}\n`;
    }
    if (appointment.location) {
        data += `📍 Local: ${appointment.location}\n`;
    }
    if (appointment.status) {
        data += `🚦 Status: ${appointment.status}\n`;
    }
    if (appointment.associatedValue && appointment.associatedTransactionType) {
        data += `💰 Valor Associado: ${formatCurrency(appointment.associatedValue)} (${appointment.associatedTransactionType})\n`;
    }
    if (appointment.notes) {
        data += `🗒️ Observações: ${appointment.notes}\n`;
    }
    return data.trim();
}

function formatRecurringRuleDataStructure(rule) {
    if (!rule) return "🧾 Resumo da Transação Recorrente:\n\nDados não disponíveis.";
    let data = `🧾 Resumo da Transação Recorrente:\n\n`;
    data += `📜 Descrição: ${rule.description || 'N/A'}\n`;
    data += `💰 Valor: ${formatCurrency(rule.value)} (${rule.type})\n`;
    if (rule.category && rule.category.name) {
        data += `💼 Categoria: ${rule.category.name}\n`;
    } else {
        data += `💼 Categoria: Não especificada\n`;
    }
    data += `📅 Data inicial: ${formatDate(rule.startDate)}\n`;
    if (rule.endDate) {
        data += `📅 Data final: ${formatDate(rule.endDate)}\n`;
    }
    let frequencyText = rule.frequency.charAt(0).toUpperCase() + rule.frequency.slice(1);
    if (rule.interval && rule.interval > 1) {
        const pluralMap = { daily: 'dias', weekly: 'semanas', monthly: 'meses', annually: 'anos', 'bi-weekly': 'quinzenas', quarterly: 'trimestres', 'semi-annually': 'semestres' };
        frequencyText = `A cada ${rule.interval} ${pluralMap[rule.frequency] || rule.frequency.replace('ly', 's')}`;
    } else {
         const singleMap = { daily: 'Diária', weekly: 'Semanal', monthly: 'Mensal', annually: 'Anual', 'bi-weekly': 'Quinzenal', quarterly: 'Trimestral', 'semi-annually': 'Semestral' };
         frequencyText = singleMap[rule.frequency] || frequencyText;
    }
    data += `🔄 Frequência: ${frequencyText}\n`;

    if (rule.dayOfWeek !== null && rule.dayOfWeek !== undefined && (rule.frequency === 'weekly' || rule.frequency === 'bi-weekly')) {
        const days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
        data += `🗓️ Dia da Semana: ${days[rule.dayOfWeek]}\n`;
    }
    if (rule.dayOfMonth && rule.frequency === 'monthly') {
        data += `🗓️ Dia do Mês: ${rule.dayOfMonth}\n`;
    }
    data += `➡️ Próximo Vencimento: ${rule.nextDueDate ? formatDate(rule.nextDueDate) : 'N/A (Regra Inativa)'}\n`;
    data += `⚙️ Criação Automática: ${rule.autoCreateTransaction ? 'Sim' : 'Não (Apenas Lembrete)'}\n`;
    data += `🚦 Status da Regra: ${rule.isActive ? 'Ativa' : 'Inativa'}\n`;

    return data.trim();
}

function formatCreditCardListDataStructure(cards) {
    if (!cards || cards.length === 0) return "📋 Resumo dos Cartões:\n\nNenhum cartão de crédito cadastrado.";
    let data = `📋 Resumo dos Cartões:\n`;
    cards.forEach((card, index) => {
        // Correção: Usar template string para o número e emoji
        data += `\n${index + 1}️⃣ Cartão: ${card.name || 'N/A'}\n`; // Emoji fora da expressão do número
        if (card.flag) data += `🏷️ Bandeira: ${card.flag}\n`;
        if (card.lastFourDigits) data += `💳 Número: **** **** **** ${card.lastFourDigits}\n`;
        if (card.availableLimit !== undefined) {
            data += `💰 Limite disponível: ${formatCurrency(card.availableLimit)}\n`;
        } else {
            data += `💰 Limite Total: ${formatCurrency(card.limit)}\n`;
        }
        if (card.isDefault) data += `⭐ Cartão Padrão\n`;
    });
    return data.trim();
}

function formatCreditCardInvoiceDataStructure(invoiceDetails, listTransactions = true) {
    if (!invoiceDetails) return "🎯 Resumo da Fatura:\n\nDados da fatura não disponíveis.";
    let data = `🎯 Resumo da Fatura - Cartão ${invoiceDetails.cardName || 'N/A'}\n\n`;
    data += `📅 Mês de Referência: ${invoiceDetails.invoiceReferenceMonthYear || 'N/A'}\n`;
    data += `💰 Total da fatura: ${formatCurrency(invoiceDetails.totalAmount)}\n`;
    if(invoiceDetails.availableLimitAfterInvoice !== undefined) {
        data += `💳 Limite disponível (após esta fatura): ${formatCurrency(invoiceDetails.availableLimitAfterInvoice)}\n`;
    }
    data += `🗓️ Fechamento: ${formatDate(invoiceDetails.invoiceCycleEndDate)}\n`;
    data += `🗓️ Vencimento: ${formatDate(invoiceDetails.paymentDueDate)}\n`;

    if (listTransactions && invoiceDetails.transactions && invoiceDetails.transactions.length > 0) {
        data += `\n📄 Detalhamento das Compras:\n`;
        invoiceDetails.transactions.forEach((tx, index) => {
            let parcelInfo = "";
            if (tx.isParcel && tx.parcelNumber && tx.totalParcels) {
                parcelInfo = ` (${tx.parcelNumber}/${tx.totalParcels})`;
            } else {
                parcelInfo = ` — à vista`;
            }
            // Correção: Usar template string para o número e emoji
            data += `\n${index + 1}️⃣ ${tx.description} — ${formatCurrency(tx.value)}${parcelInfo}`;
        });
    } else if (listTransactions && (!invoiceDetails.transactions || invoiceDetails.transactions.length === 0)) {
        data += `\n📄 Nenhuma transação encontrada para esta fatura.\n`;
    }
    return data.trim();
}

function formatAvailableLimitDataStructure(limitInfo) {
    if (!limitInfo) return "💳 Limite Disponível:\n\nDados de limite não disponíveis.";
    let data = `💳 Limite Disponível - Cartão ${limitInfo.cardName || 'N/A'}:\n\n`;
    data += `💰 Limite Total: ${formatCurrency(limitInfo.totalLimit)}\n`;
    data += `💸 Valor Utilizado (Fatura Aberta): ${formatCurrency(limitInfo.netUsedAmount)}\n`;
    data += `✅ Limite Disponível Agora: ${formatCurrency(limitInfo.availableLimit)}\n`;
    data += `🗓️ Próximo Fechamento: Dia ${limitInfo.closingDay}\n`;
    data += `🗓️ Dia de Pagamento: Dia ${limitInfo.paymentDay}\n`;
    return data.trim();
}

function formatParcelledAccountDataStructure(parcelParams, parcelResult) {
    if (!parcelResult || !parcelResult.parcels || parcelResult.parcels.length === 0) return "🎯 Resumo da Compra Parcelada:\n\nDados não disponíveis.";

    const firstParcel = parcelResult.parcels[0];
    let data = `🎯 Resumo da Compra Parcelada:\n\n`;
    data += `📝 Descrição: ${parcelParams.description || firstParcel.description.replace(/ - Parcela \d+\/\d+$/, '')}\n`;
    data += `💰 Valor Total: ${formatCurrency(parcelParams.totalValue)}\n`;
    data += `📦 Parcelas: ${parcelParams.numberOfParcels}x de ${formatCurrency(firstParcel.value)} (aprox.)\n`;
    if (parcelParams.creditCardName) {
        data += `💳 Cartão: ${parcelParams.creditCardName}\n`;
    }
    if (parcelParams.financialCategoryName) {
        data += `🏷️ Categoria: ${parcelParams.financialCategoryName}\n`;
    }
    data += `📅 Data da Compra: ${formatDate(parcelParams.transactionDate || firstParcel.transactionDate)}\n`;
    data += `🗓️ Venc. 1ª Parcela: ${formatDate(parcelParams.initialDueDate || firstParcel.dueDate || firstParcel.transactionDate)}\n`;
    return data.trim();
}

function formatListClientAccountsDataStructure(accounts, currentAccountId = null) {
    if (!accounts || accounts.length === 0) return "🏷️ Perfis cadastrados:\n\nNenhum perfil/conta financeira cadastrado.";
    let data = `🏷️ Perfis cadastrados:\n`;
    accounts.forEach((acc, index) => {
        // Correção: Usar template string para o número e emoji
        data += `\n${index + 1}️⃣ ${acc.name} (${acc.type})${currentAccountId === acc.id ? ' (Selecionada ✨)' : ''}`;
    });
    return data.trim();
}

// --- Funções de Onboarding (Seguindo os novos padrões) ---
function getOnboardingWelcomeNoPlanMessage(clientName) {
    const siteUrl = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
    const aiIntro = `🚀 Olá, ${clientName}! Preparado para simplificar suas finanças e ter tudo na palma da mão? Vamos juntos nessa jornada! 💪✨`;
    const dataStructure = `🎯 Planos MAP no Controle:\n\n` +
                          `📅 Opções disponíveis: Mensal e Anual\n` +
                          `🏷️ Para: Finanças pessoais e empresariais\n` +
                          `🌐 Página de planos: ${siteUrl}`;
    const linkText = `🤔 Quer saber mais detalhes por aqui? É só dizer "sim"! Ou, se preferir, já pode garantir seu plano no link acima. Assim que ativar, me chama com um "oi" que começamos a mágica! ✨`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}

function getOnboardingAskForEmailMessage(clientName, planDetailsText) {
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

function formatAccountSelectionMessage(clientName, planDetailsText, accounts) {
    let aiIntro = `👋 Que bom te ver por aqui, ${clientName}! Seu ${planDetailsText} está a todo vapor! 🚀`;
    let dataStructure = `🏦 Contas configuradas:\n`;
    accounts.forEach((acc, index) => {
        // Correção: Usar template string para o número e emoji
        dataStructure += `\n${index + 1}️⃣ ${acc.name} (${acc.type})`;
    });
    let linkText = `🤔 Qual delas vamos usar hoje? Me diga o nome ou o número da conta para começarmos! 😉`;
    return `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
}


// --- Initialize or Update State (Mantido, apenas usa as novas funções de mensagem) ---
async function initializeOrUpdateState(client, existingState = null, clientAccountsFromDb = []) {
    const clientName = client.name && client.name.trim() !== "" && client.name.trim().toLowerCase() !== "unknown" && client.name.trim().toLowerCase() !== "null"
        ? client.name.split(" ")[0]
        : (pushNameFromPayload || "pessoa incrível");

    let hasPaidAccess = false;
    let clientAccessLevel = client.accessLevel || 'gratuito';
    let clientAccessExpiresAt = client.accessExpiresAt;
    let accessLevelTextForUser = "Nenhum plano ativo";
    let onboardingStage = existingState?.data?.onboardingStage || 'awaiting_plan_confirmation';

    if (client.accessLevel && client.accessLevel !== 'gratuito') {
        if (client.accessLevel.startsWith('vitalicio_')) {
            hasPaidAccess = true;
            accessLevelTextForUser = client.accessLevel.replace('vitalicio_', 'Vitalício ').replace('_', ' ').trim();
            accessLevelTextForUser = accessLevelTextForUser.charAt(0).toUpperCase() + accessLevelTextForUser.slice(1);
        } else if (client.accessExpiresAt) {
            const expiryDate = new Date(client.accessExpiresAt + 'T00:00:00Z');
            const today = new Date(); today.setUTCHours(0, 0, 0, 0);
            if (expiryDate >= today) {
                hasPaidAccess = true;
                let planNamePart = client.accessLevel.replace(/_/g, ' ');
                planNamePart = planNamePart.charAt(0).toUpperCase() + planNamePart.slice(1);
                accessLevelTextForUser = `${planNamePart} (válido até ${expiryDate.toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
            } else {
                let planNamePart = client.accessLevel.replace(/_/g, ' ');
                planNamePart = planNamePart.charAt(0).toUpperCase() + planNamePart.slice(1);
                accessLevelTextForUser = `Plano ${planNamePart} expirado`;
                clientAccessLevel = 'gratuito';
            }
        } else {
            logger.warn(`[WHATSAPP SERVICE - Initialize/UpdateState] Cliente ${client.id} com accessLevel ${client.accessLevel} mas sem accessExpiresAt. Considerando como sem plano pago.`);
            clientAccessLevel = 'gratuito';
        }
    } else {
         accessLevelTextForUser = "Nenhum plano ativo";
    }
    
    if (hasPaidAccess) {
        if (onboardingStage === 'awaiting_plan_confirmation' || (existingState && !existingState.hasPaidAccess_whenStageLastSet) ) {
            if (!client.email || !client.passwordHash) {
                onboardingStage = 'setting_up_credentials_email';
            } else {
                const hasPf = clientAccountsFromDb.some(acc => acc.accountType === 'PF');
                if (!hasPf) {
                     onboardingStage = 'setting_up_pf_account_name';
                } else {
                     const hasPjMei = clientAccountsFromDb.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                     const planTier = clientAccessLevel.startsWith('avancado') || clientAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                     
                     if (planTier === 'avancado' && !hasPjMei && existingState?.data?.onboardingStage !== 'confirming_pj_mei_setup' && existingState?.data?.onboardingStage !== 'awaiting_pj_mei_type' && existingState?.data?.onboardingStage !== 'creating_pj_mei_account_name') {
                        onboardingStage = 'confirming_pj_mei_setup';
                     } else if (existingState?.data?.onboardingStage !== 'onboarding_complete') { 
                        onboardingStage = 'onboarding_complete';
                     }
                }
            }
        }
    } else { 
        onboardingStage = 'awaiting_plan_confirmation';
    }

    const defaultAccount = (onboardingStage === 'onboarding_complete' && hasPaidAccess && clientAccountsFromDb.length > 0)
        ? (clientAccountsFromDb.find(a=>a.isDefault) || clientAccountsFromDb[0])
        : null;

    if (existingState) {
        existingState.clientName = clientName;
        existingState.currentAccessLevel = clientAccessLevel;
        existingState.accessExpiresAt = clientAccessExpiresAt;
        existingState.hasPaidAccess = hasPaidAccess;
        existingState.accessLevelTextForUser = accessLevelTextForUser;
        
        if (existingState.data.onboardingStage !== onboardingStage && onboardingStage !== 'onboarding_complete') {
            existingState.currentAction = null;
        }
        existingState.data.onboardingStage = onboardingStage;
        existingState.hasPaidAccess_whenStageLastSet = hasPaidAccess;

        if (onboardingStage === 'onboarding_complete' && hasPaidAccess) {
            if (!existingState.activeFinancialAccountId && defaultAccount) {
                existingState.activeFinancialAccountId = defaultAccount.id;
                existingState.activeFinancialAccountName = defaultAccount.accountName;
                existingState.activeFinancialAccountType = defaultAccount.accountType;
            }
        } else { 
            existingState.activeFinancialAccountId = null;
            existingState.activeFinancialAccountName = null;
            existingState.activeFinancialAccountType = null;
        }
        
        logger.debug(`[WHATSAPP SERVICE - UpdateState] Estado atualizado para cliente ${client.id}: `, {
            onboardingStage: existingState.data.onboardingStage,
            currentAction: existingState.currentAction,
            hasPaidAccess: existingState.hasPaidAccess,
            activeAccountId: existingState.activeFinancialAccountId,
            accessLevelTextForUser: existingState.accessLevelTextForUser,
        });
        return existingState;
    }

    const newState = {
        currentAction: null, 
        data: { onboardingStage }, 
        activeFinancialAccountId: defaultAccount ? defaultAccount.id : null,
        activeFinancialAccountName: defaultAccount ? defaultAccount.accountName : null,
        activeFinancialAccountType: defaultAccount ? defaultAccount.accountType : null,
        clientName: clientName,
        messageHistory: [],
        pendingConfirmation: null,
        editingResource: null,
        lastAiResponse: null,
        currentAccessLevel: clientAccessLevel, 
        accessExpiresAt: clientAccessExpiresAt,
        hasPaidAccess: hasPaidAccess,
        accessLevelTextForUser: accessLevelTextForUser,
        hasPaidAccess_whenStageLastSet: hasPaidAccess,
    };
    
    logger.debug(`[WHATSAPP SERVICE - InitializeState] Novo estado criado para cliente ${client.id}: `, {
        onboardingStage: newState.data.onboardingStage,
        hasPaidAccess: newState.hasPaidAccess,
        accessLevelTextForUser: newState.accessLevelTextForUser,
    });
    return newState;
}


async function processIncomingMessage(senderPhoneNormalized, messageText, pushName, rawPayload) {
    pushNameFromPayload = pushName;
    const senderPhone = senderPhoneNormalized;
    const startTime = Date.now();
    let state;

    try {
        let client = await clientService.findClientByPhone(senderPhone);
        let isNewUserForSessionLogic = !conversationState.has(senderPhone);
        let clientFinancialAccountsForOnboarding = [];

        if (!client) {
            logger.info(`[WHATSAPP SERVICE] Cliente com telefone ${senderPhone} não encontrado no banco. Criando novo...`);
            client = await clientService.createClient({ phone: senderPhone, name: pushName });
            logger.info(`[WHATSAPP SERVICE] Novo Cliente criado: ID ${client.id}, Telefone: ${client.phone}, Nome: ${client.name}`);
            state = await initializeOrUpdateState(client, null, []); 
            isNewUserForSessionLogic = true;
        } else {
            const existingState = conversationState.get(senderPhone);
            clientFinancialAccountsForOnboarding = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
            state = await initializeOrUpdateState(client, existingState, clientFinancialAccountsForOnboarding);
            if (!existingState) isNewUserForSessionLogic = true;
        }
        
        const clientNameToUse = state.clientName;

        if (!(rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string')) {
            state.messageHistory.push({ role: 'user', content: messageText });
        }
        if (state.messageHistory.length > MAX_STATE_HISTORY) {
            state.messageHistory = state.messageHistory.slice(-MAX_STATE_HISTORY);
        }
        
        let onboardingReply = "";
        const lowerMessageText = messageText.toLowerCase().trim();
        
        logger.debug(`[WHATSAPP ONBOARDING ENTRY] Cliente: ${client.id}, Stage: ${state.data.onboardingStage}, currentAction: ${state.currentAction}, hasPaidAccess: ${state.hasPaidAccess}, accessLevelText: ${state.accessLevelTextForUser}`);

        // ---- FLUXO DE ONBOARDING ----
        if (state.data.onboardingStage === 'awaiting_plan_confirmation') {
            onboardingReply = getOnboardingWelcomeNoPlanMessage(clientNameToUse);
            state.currentAction = 'awaiting_plan_interest_generic';
        } else if (state.data.onboardingStage === 'setting_up_credentials_email') {
            if (state.currentAction !== 'awaiting_input_email_for_credentials' || isNewUserForSessionLogic) {
                 onboardingReply = getOnboardingAskForEmailMessage(clientNameToUse, state.accessLevelTextForUser);
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
                onboardingReply = getOnboardingAskForFullNameMessage(clientNameToUse);
                state.data.onboardingStage = 'setting_up_credentials_name';
                state.currentAction = 'awaiting_input_name_for_credentials';
            } else {
                onboardingReply = `Para sua segurança, ${clientNameToUse}, a senha precisa ter pelo menos 6 caracteres. 😉 Pode me dizer uma senha um pouquinho maior?`;
            }
        } else if (state.data.onboardingStage === 'setting_up_credentials_name') {
            const nameInput = messageText.trim();
            if (nameInput.length >= 3 && nameInput.includes(" ")) { 
                try {
                    await clientAuthService.setClientCredentials(senderPhone, state.data.tempPassword, nameInput, state.data.tempEmail);
                    client = await clientService.findClientByPhone(senderPhone); 
                    state.clientName = client.name.split(" ")[0];
                    logger.info(`[WHATSAPP ONBOARDING] Credenciais definidas para ${senderPhone}.`);
                    delete state.data.tempEmail; delete state.data.tempPassword;
                    
                    clientFinancialAccountsForOnboarding = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                    const hasPf = clientFinancialAccountsForOnboarding.some(acc => acc.accountType === 'PF');
                    if (!hasPf) {
                        state.data.onboardingStage = 'setting_up_pf_account_name';
                        onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
                        state.currentAction = 'awaiting_input_pf_name';
                    } else {
                        const hasPjMei = clientFinancialAccountsForOnboarding.some(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                        const planTier = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                        if (planTier === 'avancado' && !hasPjMei) {
                            state.data.onboardingStage = 'confirming_pj_mei_setup';
                            const pfAccName = clientFinancialAccountsForOnboarding.find(a => a.accountType === 'PF')?.accountName || "Pessoal";
                            onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, pfAccName, state.accessLevelTextForUser);
                            state.currentAction = 'awaiting_pj_mei_confirm';
                        } else {
                            state.data.onboardingStage = 'onboarding_complete';
                            const aiIntro = `Uhuul, ${clientNameToUse}! Tudo certo com seu acesso e credenciais! 🎉`;
                            const dataStructure = `💼 Seu plano ${state.accessLevelTextForUser} está pronto para uso!`;
                            const linkText = `Como posso te ajudar agora? 🚀`;
                            onboardingReply = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                            state.currentAction = null; 
                        }
                    }
                } catch (e) {
                    logger.error(`[WHATSAPP ONBOARDING] Erro ao definir credenciais para ${senderPhone}: ${e.message}`);
                    if (e.message && e.message.toLowerCase().includes('email já está em uso')) {
                         onboardingReply = `Puxa, ${clientNameToUse}, parece que o e-mail "${state.data.tempEmail}" já está sendo usado por outra pessoa. 😬 Você teria outro e-mail para cadastrarmos?`;
                         state.data.onboardingStage = 'setting_up_credentials_email';
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
            if (state.currentAction !== 'awaiting_input_pf_name') { 
                onboardingReply = getOnboardingAskForPFAccountNameMessage(clientNameToUse);
                state.currentAction = 'awaiting_input_pf_name';
            } else { 
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
                            state.currentAction = null;
                        }
                    } catch (e) {
                        logger.error(`[WHATSAPP ONBOARDING] Erro ao criar conta PF "${pfAccountName}" para ${senderPhone}: ${e.message}`);
                        onboardingReply = `Opa! 😬 Tive um probleminha para criar a conta "${pfAccountName}" (${e.message.substring(0,60)}). Que tal a gente tentar um nome diferente?`;
                    }
                } else {
                    onboardingReply = `Esse nome parece um pouquinho curto ou um cadinho longo demais, ${clientNameToUse}. Para sua conta Pessoal, que tal um nome entre 3 e 50 letras? Assim fica perfeito! ✍️`;
                }
            }
        } else if (state.data.onboardingStage === 'confirming_pj_mei_setup') {
             if (state.currentAction !== 'awaiting_pj_mei_confirm') {
                const pfAccount = (await clientService.getClientFinancialAccounts(client.id, { isActive: true })).find(a => a.accountType === 'PF');
                onboardingReply = getOnboardingConfirmPJAccountSetupMessage(clientNameToUse, pfAccount?.accountName || "Pessoal", state.accessLevelTextForUser);
                state.currentAction = 'awaiting_pj_mei_confirm';
            } else {
                const userResponseLower = lowerMessageText;
                let wantsPjMei = false;
                let pjMeiType = null;
    
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
                    state.data.onboardingStage = 'onboarding_complete';
                    state.currentAction = null;
                }
            }
        } else if (state.data.onboardingStage === 'awaiting_pj_mei_type') {
            const typeInput = messageText.trim().toUpperCase();
            if (typeInput === 'PJ' || typeInput === 'MEI') {
                state.data.tempPjMeiType = typeInput;
                onboardingReply = getOnboardingAskForCompanyNameMessage(clientNameToUse, typeInput);
                state.data.onboardingStage = 'creating_pj_mei_account_name';
                state.currentAction = 'awaiting_input_pj_mei_name';
            } else {
                onboardingReply = `Por favor, ${clientNameToUse}, me diga se é "PJ" ou "MEI" para sua conta empresarial. Assim a gente configura tudo certinho! 😊`;
            }
        } else if (state.data.onboardingStage === 'creating_pj_mei_account_name') {
            const companyName = messageText.trim();
            const companyType = state.data.tempPjMeiType;
            if (companyName.length >= 3 && companyName.length <= 50) {
                try {
                    await clientService.createFinancialAccount(client.id, {
                        accountName: companyName, accountType: companyType, isDefault: false 
                    });
                    const personalAccountName = state.activeFinancialAccountName || (await clientService.getClientFinancialAccounts(client.id, {isActive:true})).find(a => a.accountType === 'PF')?.accountName || "Pessoal";
                    onboardingReply = getOnboardingCompanyCreatedMessage(clientNameToUse, companyType, companyName, personalAccountName);
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


        if (onboardingReply) {
            state.messageHistory.push({ role: 'assistant', content: onboardingReply });
            await sendWhatsappMessage(senderPhone, onboardingReply);
            conversationState.set(senderPhone, state);
            if (state.data.onboardingStage !== 'onboarding_complete' && state.currentAction !== null) {
                return; 
            }
        }
        
        if (state.data.onboardingStage === 'onboarding_complete' || !onboardingReply) {
            if (state.data.onboardingStage === 'onboarding_complete' && state.currentAction && 
                (state.currentAction.startsWith('awaiting_input_') || state.currentAction.startsWith('awaiting_pj_mei_') || state.currentAction.startsWith('awaiting_plan_'))) {
                state.currentAction = null;
            }
            
            if (state.data.onboardingStage === 'onboarding_complete' && !state.activeFinancialAccountId) {
                const accountsForSelection = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                if (accountsForSelection.length > 0) {
                    if (accountsForSelection.length === 1) {
                        const acc = accountsForSelection[0];
                        state.activeFinancialAccountId = acc.id;
                        state.activeFinancialAccountName = acc.accountName;
                        state.activeFinancialAccountType = acc.accountType;
                        const aiIntro = `Tudo pronto, ${clientNameToUse}! 🎉`;
                        const dataStructure = `Sua conta "${acc.accountName}" (${acc.accountType}) já está selecionada com seu plano ${state.accessLevelTextForUser}.`;
                        const linkText = `Como posso te ajudar a organizar suas finanças hoje? 🚀`;
                        const selectMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                        state.messageHistory.push({ role: 'assistant', content: selectMsg });
                        state.currentAction = null; 
                        if(state.data) state.data.accountsToList = null;
                        await sendWhatsappMessage(senderPhone, selectMsg);
                    } else if (state.currentAction !== 'selecting_account_flow_active') { 
                        state.currentAction = 'selecting_account_flow_active'; 
                        state.data.accountsToList = accountsForSelection.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                        const accountOptionsText = formatAccountSelectionMessage(clientNameToUse, state.accessLevelTextForUser, state.data.accountsToList);
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
                            const aiIntro = `Maravilha, ${clientNameToUse}!`;
                            const dataStructure = `Selecionei a conta "${state.activeFinancialAccountName}" para você.`;
                            const linkText = `Como posso te ajudar a colocar tudo em ordem agora? 🚀`;
                            const confirmSelectionMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                            state.messageHistory.push({ role: 'assistant', content: confirmSelectionMsg });
                            state.currentAction = null; 
                            if(state.data) state.data.accountsToList = null;
                            await sendWhatsappMessage(senderPhone, confirmSelectionMsg);
                        } else {
                            let errorReplyIntro = `Hummm, ${clientNameToUse}, não consegui identificar essa conta. 😕`;
                            let errorReplyData = "Poderia escolher uma da lista?\n";
                            if (state.data.accountsToList) {
                                state.data.accountsToList.forEach((acc, index) => {errorReplyData += `\n${index + 1}️⃣ *${acc.name}* (${acc.type})`});
                            }
                            let errorReplyLink = "\n\nÉ só me dizer o nome ou o número. Estou aqui para ajudar! 🤔";
                            const fullErrorReply = `${errorReplyIntro}\n\n${errorReplyData}\n${errorReplyLink}`;
                            state.messageHistory.push({ role: 'assistant', content: fullErrorReply });
                            await sendWhatsappMessage(senderPhone, fullErrorReply);
                        }
                    }
                    conversationState.set(senderPhone, state);
                    if (state.currentAction === 'selecting_account_flow_active' || !state.activeFinancialAccountId) return;
                } else { 
                    const aiIntro = `Olá ${clientNameToUse}! Seu plano ${state.accessLevelTextForUser} está tinindo, mas não encontrei nenhuma conta financeira.`;
                    const dataStructure = `Vamos criar sua conta Pessoal agora?`;
                    const linkText = `Diga "criar conta pessoal"! 😉`;
                    const noAccountsMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
                    state.messageHistory.push({ role: 'assistant', content: noAccountsMsg });
                    state.data.onboardingStage = 'setting_up_pf_account_name'; 
                    state.currentAction = 'awaiting_input_pf_name';
                    await sendWhatsappMessage(senderPhone, noAccountsMsg);
                    conversationState.set(senderPhone, state);
                    return;
                }
            }


            // ---- PROCESSAMENTO COM IA ----
            if (rawPayload && rawPayload.selectedButtonId && typeof rawPayload.selectedButtonId === 'string') {
                const buttonId = rawPayload.selectedButtonId;
                logger.info(`[WHATSAPP SERVICE] Botão clicado por ${senderPhone} (${clientNameToUse}): ID '${buttonId}', Texto: '${messageText}'`);
                let buttonClickHandledByServiceLogic = true;
                let aiMessageIntroForButton = "";
                let structuredDataBodyForButton = "";
                let platformLinkFooterForButton = formatPlatformLink();

                let resourceTypeForEditMessage = "item";
    
                if (buttonId.startsWith('edit_transaction_')) {
                    const transactionId = buttonId.replace('edit_transaction_', '');
                    state.editingResource = { type: 'transaction', id: transactionId };
                    resourceTypeForEditMessage = "transação";
                    aiMessageIntroForButton = `Claro, ${clientNameToUse}! 😉`;
                    structuredDataBodyForButton = `Descreva na próxima mensagem o que você precisa que eu altere na ${resourceTypeForEditMessage} (ID: ${transactionId}). Por exemplo: "mude a descrição para X e o valor para Y".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_transaction_edit_details';
                } else if (buttonId.startsWith('delete_transaction_')) {
                    const transactionId = buttonId.replace('delete_transaction_', '');
                    try {
                        await financialService.deleteTransaction(state.activeFinancialAccountId, transactionId);
                        aiMessageIntroForButton = `Transação removida com sucesso, ${clientNameToUse}! 👍`;
                        structuredDataBodyForButton = "Se precisar de mais alguma coisa, é só chamar.";
                    } catch (e) { 
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir transação ${transactionId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a transação.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                } else if (buttonId.startsWith('edit_appointment_')) {
                    const appointmentId = buttonId.replace('edit_appointment_', '');
                    state.editingResource = { type: 'appointment', id: appointmentId };
                    resourceTypeForEditMessage = "compromisso";
                    aiMessageIntroForButton = `Beleza, ${clientNameToUse}! ✨`;
                    structuredDataBodyForButton = `Me diga na próxima mensagem o que você quer mudar no ${resourceTypeForEditMessage} (ID: ${appointmentId}).`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_appointment_edit_details';
                } else if (buttonId.startsWith('delete_appointment_')) {
                    const appointmentId = buttonId.replace('delete_appointment_', '');
                    try {
                        await appointmentService.deleteOrCancelAppointment(state.activeFinancialAccountId, appointmentId, true);
                        aiMessageIntroForButton = `Compromisso removido da sua agenda, ${clientNameToUse}! ✅`;
                        structuredDataBodyForButton = "Fico à disposição se precisar de algo mais.";
                    } catch (e) { 
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir compromisso ${appointmentId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir o compromisso.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                else if (buttonId.startsWith('edit_credit_card_')) {
                    const cardId = buttonId.replace('edit_credit_card_', '');
                    state.editingResource = { type: 'credit_card', id: cardId };
                    resourceTypeForEditMessage = "cartão de crédito";
                    aiMessageIntroForButton = `Entendido, ${clientNameToUse}! 💳`;
                    structuredDataBodyForButton = `O que você gostaria de alterar no ${resourceTypeForEditMessage} (ID: ${cardId})? Pode me dizer, por exemplo: "mudar o limite para 3000" ou "atualizar o dia de fechamento para 25".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_credit_card_edit_details';
                } else if (buttonId.startsWith('delete_credit_card_')) {
                    const cardId = buttonId.replace('delete_credit_card_', '');
                    try {
                        await creditCardService.deleteCreditCard(state.activeFinancialAccountId, cardId);
                        aiMessageIntroForButton = `Cartão de crédito removido com sucesso, ${clientNameToUse}! 🗑️`;
                        structuredDataBodyForButton = "";
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir cartão ${cardId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir o cartão.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.includes("transações") ? "Ele ainda tem transações associadas." : `(${e.message.substring(0,70)})` }`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                } else if (buttonId.startsWith('edit_recurring_rule_')) {
                    const ruleId = buttonId.replace('edit_recurring_rule_', '');
                    state.editingResource = { type: 'recurring_rule', id: ruleId };
                    resourceTypeForEditMessage = "regra de recorrência";
                    aiMessageIntroForButton = `Certo, ${clientNameToUse}! 🔄`;
                    structuredDataBodyForButton = `O que vamos ajustar na ${resourceTypeForEditMessage} (ID: ${ruleId})? Por exemplo: "mudar o valor para 60" ou "alterar a frequência para mensal".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_recurring_rule_edit_details';
                } else if (buttonId.startsWith('delete_recurring_rule_')) {
                    const ruleId = buttonId.replace('delete_recurring_rule_', '');
                    try {
                        await recurringTransactionService.deleteRecurringRule(state.activeFinancialAccountId, ruleId);
                        aiMessageIntroForButton = `Regra de recorrência removida, ${clientNameToUse}! 👍`;
                        structuredDataBodyForButton = "";
                    } catch (e) { 
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir regra ${ruleId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar excluir a regra.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
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
                    aiMessageIntroForButton = `Ok, ${clientNameToUse}! Você quer editar a compra parcelada de "${originalDescriptionForEdit}".`;
                    structuredDataBodyForButton = `O que gostaria de alterar? Você pode me dizer os novos detalhes, como por exemplo: "mudar para R$250 em 5x no cartão XP com nova descrição 'Presente Dia das Mães'".\n\nLembre-se que alterar valor, número de parcelas ou o cartão irá refazer essa compra com os novos dados. Se quiser mudar apenas a descrição, diga "mudar descrição para [nova descrição]".`;
                    platformLinkFooterForButton = "";
                    state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                } else if (buttonId.startsWith('delete_parcelled_account_')) {
                    const originalAccountId = buttonId.replace('delete_parcelled_account_', '');
                    try {
                        const success = await financialService.deleteParcelledAccountGroup(state.activeFinancialAccountId, originalAccountId);
                        aiMessageIntroForButton = success ? `Compra parcelada e todas as suas parcelas foram removidas, ${clientNameToUse}! 👍` : `Não consegui remover essa compra parcelada. Pode ter ocorrido um erro.`;
                        structuredDataBodyForButton = "";
                    } catch (e) {
                        logger.error(`[WHATSAPP SERVICE] Erro ao excluir grupo de parcelas ${originalAccountId} por botão: ${e.message}`);
                        aiMessageIntroForButton = `Ops! Tive um problema ao tentar remover essa compra parcelada.`;
                        structuredDataBodyForButton = `Detalhe: ${e.message.substring(0,70)}`;
                    }
                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                }
                else {
                    buttonClickHandledByServiceLogic = false; 
                }
        
                if (buttonClickHandledByServiceLogic) {
                    const finalMsg = `${aiMessageIntroForButton}${structuredDataBodyForButton ? `\n\n${structuredDataBodyForButton}` : ''}${platformLinkFooterForButton ? `\n\n${platformLinkFooterForButton}` : ''}`.trim();
                    state.messageHistory.push({ role: 'assistant', content: finalMsg });
                    await sendWhatsappMessage(senderPhone, finalMsg);
                    conversationState.set(senderPhone, state); 
                    return;
                }
            }
        
            if (state.currentAction && state.data.onboardingStage === 'onboarding_complete') {
                let stateHandledInPreProcessing = false;
                let preProcAiIntro = "";
                let preProcDataStructure = "";
                let preProcPlatformLink = formatPlatformLink();
        
                if (state.currentAction === 'awaiting_confirmation' && state.pendingConfirmation) {
                     const lowerMsgForConfirm = messageText.toLowerCase().trim(); 
                     if (lowerMsgForConfirm === 'sim' || lowerMsgForConfirm === 's' || lowerMsgForConfirm.includes('correto') || lowerMsgForConfirm.includes('ok') || lowerMsgForConfirm.includes('pode')) {
                        if (state.pendingConfirmation.action === 'RECREATE_PARCELLED_ACCOUNT' && state.pendingConfirmation.parameters) {
                            try {
                                const { financialAccountId, originalAccountIdToDelete, newParcelData } = state.pendingConfirmation.parameters;
                                const recreatedResult = await financialService.recreateParcelledAccount(financialAccountId, originalAccountIdToDelete, newParcelData);
                                
                                preProcAiIntro = state.lastAiResponse?.overall_summary_suggestion || `🎉 Sensacional, ${clientNameToUse}! Sua compra parcelada foi atualizada!`;
                                preProcDataStructure = formatParcelledAccountDataStructure(newParcelData, recreatedResult);
                                state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                                stateHandledInPreProcessing = true;
                            } catch(e) {
                                logger.error(`[WHATSAPP SERVICE] Erro ao recriar compra parcelada após confirmação: ${e.message}`);
                                preProcAiIntro = `Puxa, ${clientNameToUse}, algo deu errado ao tentar atualizar sua compra parcelada. 😥`;
                                preProcDataStructure = `Detalhe: ${e.message.substring(0,70)}.\nA compra original não foi alterada. Quer tentar de novo os detalhes ou cancelar?`;
                                preProcPlatformLink = "";
                                state.currentAction = 'awaiting_confirmation'; 
                                stateHandledInPreProcessing = true;
                            }
                        } else {
                            preProcAiIntro = `Entendido, ${clientNameToUse}! Confirmado! 👍`;
                            preProcDataStructure = "Vou prosseguir com base nisso. O que mais posso fazer?";
                            preProcPlatformLink = "";
                            state.currentAction = null; state.pendingConfirmation = null; 
                            stateHandledInPreProcessing = true;
                        }
                    } else if (lowerMsgForConfirm === 'não' || lowerMsgForConfirm === 'n' || lowerMsgForConfirm.includes('incorreto') || lowerMsgForConfirm.includes('cancela')) {
                        preProcAiIntro = `Ok, ${clientNameToUse}, cancelado! Sem problemas.`;
                        preProcDataStructure = "O que gostaria de fazer então? 😊";
                        preProcPlatformLink = "";
                        state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                        stateHandledInPreProcessing = true;
                    }
                }
                else if (state.currentAction === 'awaiting_explicit_account_type_from_ai') {
                    const typeInput = messageText.trim().toUpperCase();
                    if (typeInput === 'PF' || typeInput === 'PJ' || typeInput === 'MEI') {
                        state.data.accountTypeToCreate = typeInput; 
                        const formattedMsg = getOnboardingAskForCompanyNameMessage(clientNameToUse, typeInput);
                        preProcAiIntro = formattedMsg.split('\n\n')[0];
                        preProcDataStructure = formattedMsg.split('\n\n')[1];
                        preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
                        state.currentAction = 'awaiting_explicit_account_name_from_ai';
                    } else {
                        const formattedMsg = getOnboardingAskForPJTypeMessage(clientNameToUse);
                        preProcAiIntro = formattedMsg.split('\n\n')[0];
                        preProcDataStructure = formattedMsg.split('\n\n')[1];
                        preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
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
                                preProcAiIntro = `Opa, ${clientNameToUse}! Você já tem uma conta empresarial (${existingPjMei.accountType}) chamada "${existingPjMei.accountName}".`;
                                preProcDataStructure = "Só podemos ter uma conta PJ ou MEI por vez. 😉";
                                preProcPlatformLink = "";
                            } else if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado')) {
                                preProcAiIntro = `Ah, ${clientNameToUse}! Para criar uma conta empresarial (${typeToCreate}), você precisa de um dos nossos Planos Avançados. 🚀`;
                                preProcDataStructure = `Confira em ${process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos"} e depois me avise! 😉`;
                                preProcPlatformLink = "";
                                state.data.onboardingStage = 'awaiting_plan_confirmation'; 
                            } else {
                                const newFA = await clientService.createFinancialAccount(client.id, { accountName: newAccName, accountType: typeToCreate });
                                const formattedMsg = getOnboardingCompanyCreatedMessage(clientNameToUse, newFA.accountType, newFA.accountName, state.activeFinancialAccountName || "Pessoal");
                                preProcAiIntro = formattedMsg.split('\n\n')[0];
                                preProcDataStructure = formattedMsg.split('\n\n')[1];
                                preProcPlatformLink = formattedMsg.split('\n\n')[2] || "";
                                state.activeFinancialAccountId = newFA.id;
                                state.activeFinancialAccountName = newFA.accountName;
                                state.activeFinancialAccountType = newFA.accountType;
                            }
                        } catch(e) {
                            preProcAiIntro = `Ops, não consegui criar a conta "${newAccName}" (${typeToCreate}).`;
                            preProcDataStructure = `Detalhe: ${e.message.substring(0,70)}.\nTente um nome diferente.`;
                            preProcPlatformLink = "";
                        }
                    } else {
                         preProcAiIntro = `Esse nome parece um pouco curto ou longo demais, ${clientNameToUse}.`;
                         preProcDataStructure = `Para sua conta ${typeToCreate}, que tal um nome entre 3 e 50 letras? ✍️`;
                         preProcPlatformLink = "";
                    }
                    state.currentAction = null; delete state.data.accountTypeToCreate; 
                    stateHandledInPreProcessing = true;
                }
        
        
                if (stateHandledInPreProcessing) {
                    const finalMsg = `${preProcAiIntro}${preProcDataStructure ? `\n\n${preProcDataStructure}` : ''}${preProcPlatformLink ? `\n\n${preProcPlatformLink}` : ''}`.trim();
                    state.messageHistory.push({ role: 'assistant', content: finalMsg });
                    await sendWhatsappMessage(senderPhone, finalMsg);
                    conversationState.set(senderPhone, state); 
                    if (state.currentAction === null && !state.pendingConfirmation && 
                        !(state.currentAction?.startsWith('awaiting_explicit_'))) {
                            return;
                    }
                }
            }
        
            logger.info(`[WHATSAPP HANDLER - PÓS-ONBOARDING] Cliente: ${client.id} (${clientNameToUse}), Plano: ${state.currentAccessLevel}, Conta Ativa: ${state.activeFinancialAccountName || 'N/A'} (ID: ${state.activeFinancialAccountId || 'N/A'}), Msg: "${messageText}"`);
            if(!state.activeFinancialAccountId && state.hasPaidAccess && state.data.onboardingStage === 'onboarding_complete') {
                 logger.error(`[WHATSAPP HANDLER CRITICAL - PÓS-ONBOARDING] Cliente ${client.id} tem acesso pago e onboarding completo, mas NENHUMA conta financeira ativa no estado ANTES DE CHAMAR A IA.`);
                 let noActiveAccountForAIMsg = "";
                 const clientAccountsForAI = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                 if (clientAccountsForAI.length > 0) {
                     noActiveAccountForAIMsg = formatAccountSelectionMessage(clientNameToUse, state.accessLevelTextForUser, clientAccountsForAI.map(a => ({id: a.id, name: a.accountName, type: a.accountType})));
                     state.currentAction = 'selecting_account_flow_active'; 
                     state.data.accountsToList = clientAccountsForAI.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                 } else {
                     const aiIntro = `Olá ${clientNameToUse}! Seu plano ${state.accessLevelTextForUser} está tinindo, mas não encontrei nenhuma conta financeira.`;
                     const dataStructure = `Vamos criar sua conta Pessoal agora?`;
                     const linkText = `Diga "criar conta pessoal"! 😉`;
                     noActiveAccountForAIMsg = `${aiIntro}\n\n${dataStructure}\n\n${linkText}`;
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
                currentStateData: state.data, 
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
            
            let aiMessageIntro = aiResponse.overall_summary_suggestion || (aiResponse.reply_to_user_suggestion && (!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) ? aiResponse.reply_to_user_suggestion : `Ok, ${clientNameToUse}!`);
            let structuredDataBody = "";
            let platformLinkFooter = formatPlatformLink();
            let finalMessageToSend = "";
        
            state.pendingConfirmation = null;
            actionWasAnEdit = false;
            resourceForButtonsContext = null;
        
            if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
                const primaryAction = aiResponse.detected_actions.find(a => a.confidence > 0.7) || aiResponse.detected_actions[0];
                const detectedAction = primaryAction;
                const params = detectedAction.parameters || {};
                let actionBlockedNoAccessLoop = false;

                const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SWITCH_FINANCIAL_ACCOUNT', 'CREATE_FINANCIAL_ACCOUNT'];
                if (!state.hasPaidAccess && !publicActions.includes(detectedAction.action)) {
                    aiMessageIntro = getOnboardingWelcomeNoPlanMessage(clientNameToUse).split('\n\n')[0]; 
                    structuredDataBody = getOnboardingWelcomeNoPlanMessage(clientNameToUse).split('\n\n').slice(1).join('\n\n');
                    platformLinkFooter = "";
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
                    aiMessageIntro = `Opa, ${clientNameToUse}! Para eu poder "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", preciso que você selecione uma conta financeira primeiro.`;
                    structuredDataBody = `Se você já configurou alguma, me diga o nome dela. Se não, diga "criar conta pessoal"! 😊`;
                    platformLinkFooter = "";
                    state.currentAction = 'selecting_account_flow_active'; 
                    actionBlockedNoAccessLoop = true;
                }
                const pjMeiActions = ['CREATE_PRODUCT', 'GET_STOCK_INFO', 'RECORD_STOCK_MOVEMENT', 'UPDATE_PRODUCT'];
                if (pjMeiActions.includes(detectedAction.action) && state.activeFinancialAccountType && !['PJ', 'MEI'].includes(state.activeFinancialAccountType)) {
                    aiMessageIntro = `Desculpe, ${clientNameToUse}, mas "${detectedAction.action.toLowerCase().replace(/_/g, " ")}" é apenas para contas PJ ou MEI.`;
                    structuredDataBody = `Sua conta "${state.activeFinancialAccountName}" é do tipo ${state.activeFinancialAccountType}. Você pode criar uma conta empresarial ou mudar para ela! 😉`;
                    platformLinkFooter = "";
                    actionBlockedNoAccessLoop = true;
                } else if (pjMeiActions.includes(detectedAction.action) && state.activeFinancialAccountType && ['PJ', 'MEI'].includes(state.activeFinancialAccountType) && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado')) {
                    const siteUrlPjMei = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                    aiMessageIntro = `Ah, ${clientNameToUse}! Para usar as funcionalidades de ${state.activeFinancialAccountType === 'PJ' ? 'Empresa (PJ)' : 'MEI'}, como "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", você precisa de um dos nossos Planos Avançados. 🚀`;
                    structuredDataBody = `Eles são perfeitos para quem quer ir além! Confira em ${siteUrlPjMei} e depois me avise para continuarmos! 😉`;
                    platformLinkFooter = "";
                    state.data.onboardingStage = 'awaiting_plan_confirmation'; 
                    actionBlockedNoAccessLoop = true;
                }
        
        
                if (!actionBlockedNoAccessLoop) {
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
                                aiMessageIntro = aiResponse.overall_summary_suggestion || (detectedAction.action_specific_reply_suggestion || `Sua transação foi registrada, ${clientNameToUse}!`);
                                structuredDataBody = formatFinancialTransactionDataStructure(reloadedTx);
                                resourceForButtonsContext = { type: 'transaction', id: newTx.id, description: newTx.description };
                                break;
                            }
                            case 'UPDATE_FINANCIAL_TRANSACTION': {
                                actionWasAnEdit = true;
                                const transactionIdToUpdate = params.transactionIdToUpdate || state.editingResource?.id;
                                if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não foi fornecido pela IA ou não estava no contexto de edição.");
        
                                const updateTxData = { ...params };
                                if (params.financialCategoryName) updateTxData.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || null);
                                if (params.creditCardName) updateTxData.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                delete updateTxData.transactionIdToUpdate; delete updateTxData.financialCategoryName; delete updateTxData.creditCardName;
        
                                const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateTxData);
                                const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);
                                aiMessageIntro = detectedAction.action_specific_reply_suggestion || aiResponse.overall_summary_suggestion || `Transação atualizada com sucesso, ${clientNameToUse}!`;
                                structuredDataBody = formatFinancialTransactionDataStructure(reloadedUpdatedTx);
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
                                aiMessageIntro = aiResponse.overall_summary_suggestion || (detectedAction.action_specific_reply_suggestion || `Seu compromisso foi agendado, ${clientNameToUse}!`);
                                structuredDataBody = formatAppointmentDataStructure(reloadedApp);
                                resourceForButtonsContext = { type: 'appointment', id: newApp.id, description: newApp.title };
                                break;
                            }
                            case 'UPDATE_APPOINTMENT': {
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
                                aiMessageIntro = detectedAction.action_specific_reply_suggestion || aiResponse.overall_summary_suggestion || `Compromisso atualizado com sucesso, ${clientNameToUse}!`;
                                structuredDataBody = formatAppointmentDataStructure(reloadedUpdatedApp);
                                state.editingResource = null;
                                state.currentAction = null;
                                break;
                            }
                            case 'CREATE_PARCELLED_ACCOUNT': {
                                const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                                const cardIdParcel = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
        
                                if (params.creditCardName && !cardIdParcel) {
                                    aiMessageIntro = `Hum, ${clientNameToUse}, não encontrei um cartão chamado "${params.creditCardName}" para registrar essa compra parcelada. 😕`;
                                    structuredDataBody = `Você pode cadastrar o cartão primeiro ou tentar com outro nome.`;
                                    platformLinkFooter = "";
                                    break;
                                }
        
                                const parcelData = {
                                    description: params.description, type: params.type, totalValue: parseFloat(params.totalValue),
                                    numberOfParcels: parseInt(params.numberOfParcels), initialDueDate: params.initialDueDate,
                                    financialCategoryId: catIdParcel, creditCardId: cardIdParcel, notes: params.notes,
                                    transactionDate: params.transactionDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0],
                                };
                                const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData);
                                aiMessageIntro = aiResponse.overall_summary_suggestion || (detectedAction.action_specific_reply_suggestion || `Sua compra parcelada foi registrada, ${clientNameToUse}!`);
                                structuredDataBody = formatParcelledAccountDataStructure(parcelData, parcelResult);
                                if (parcelResult.parcels && parcelResult.parcels.length > 0) {
                                    const originalTxId = parcelResult.parcels[0].originalAccountId || parcelResult.parcels[0].id;
                                    resourceForButtonsContext = { type: 'parcelled_account', id: originalTxId, description: params.description };
                                }
                                break;
                            }
                            case 'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION': {
                                actionWasAnEdit = true;
                                const originalAccountIdToUpdate = params.originalAccountIdToUpdate || state.editingResource?.id;
                                if (!originalAccountIdToUpdate) throw new Error("ID da compra parcelada para atualizar a descrição não foi fornecido.");
                            
                                const newDescription = params.newDescription;
                                if (!newDescription || newDescription.trim() === '') {
                                    aiMessageIntro = `Por favor, me diga a nova descrição para esta compra parcelada, ${clientNameToUse}. 😊`;
                                    structuredDataBody = ""; platformLinkFooter = "";
                                    state.currentAction = 'awaiting_parcelled_account_description_edit'; 
                                    state.editingResource = { type: 'parcelled_account', id: originalAccountIdToUpdate }; 
                                    break; 
                                }
                                await financialService.updateParcelledAccountDescription(state.activeFinancialAccountId, originalAccountIdToUpdate, newDescription);
                                aiMessageIntro = detectedAction.action_specific_reply_suggestion || aiResponse.overall_summary_suggestion || `A descrição da sua compra parcelada foi atualizada para "${newDescription}" em todas as parcelas! ✨`;
                                structuredDataBody = `Lembre-se que isso alterou apenas a descrição. Outros detalhes permanecem os mesmos.`;
                                state.editingResource = null;
                                state.currentAction = null;
                                break;
                            }
                            case 'RECREATE_PARCELLED_ACCOUNT': {
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
                                    aiMessageIntro = `Para refazer essa compra parcelada, preciso de todos os detalhes: nova descrição, valor total, número de parcelas, data da primeira parcela e o cartão (se houver).`;
                                    structuredDataBody = `Parece que algo ficou faltando. Vamos tentar de novo?`;
                                    platformLinkFooter = "";
                                    state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                                    state.editingResource = { type: 'parcelled_account', id: originalAccountIdToRecreate, originalData: state.editingResource?.originalData };
                                    break;
                                }
                                if (params.newCreditCardName && !newParcelData.creditCardId){
                                    aiMessageIntro = `Hum, não encontrei um cartão chamado "${params.newCreditCardName}" para esta nova compra parcelada. 😕`;
                                    structuredDataBody = `Pode verificar o nome ou cadastrar o cartão?`;
                                    platformLinkFooter = "";
                                    state.currentAction = 'awaiting_parcelled_account_full_edit_details';
                                    state.editingResource = { type: 'parcelled_account', id: originalAccountIdToRecreate, originalData: state.editingResource?.originalData };
                                    break;
                                }
                            
                                const confirmationMessage = `🎯 Confirmação de Alteração:\n\n` +
                                                            `Descrição: ${newParcelData.description}\n` +
                                                            `Valor Total: ${formatCurrency(newParcelData.totalValue)} em ${newParcelData.numberOfParcels}x\n` +
                                                            `Primeira Parcela: ${formatDate(newParcelData.initialDueDate)}\n` +
                                                            (newParcelData.creditCardId ? `Cartão: ${params.newCreditCardName}\n` : '') +
                                                            `Isso substituirá a compra original.`;
                                
                                state.pendingConfirmation = {
                                    action: 'RECREATE_PARCELLED_ACCOUNT',
                                    parameters: { 
                                        financialAccountId: state.activeFinancialAccountId,
                                        originalAccountIdToDelete: originalAccountIdToRecreate,
                                        newParcelData: newParcelData
                                    },
                                    messageToConfirm: confirmationMessage
                                };
                                aiMessageIntro = `Ok, ${clientNameToUse}! Você quer alterar a compra para:`;
                                structuredDataBody = `${confirmationMessage}\n\nConfirmar? (Sim/Não)`;
                                platformLinkFooter = "";
                                state.currentAction = 'awaiting_confirmation';
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
                                        aiMessageIntro = `Encontrei várias transações pendentes com essa descrição, ${clientNameToUse}. 🤔`;
                                        structuredDataBody = `Poderia ser mais específico (ex: mencionar o valor ou ID) ou usar a plataforma para marcar?`;
                                        break;
                                    }
                                }
        
                                if (!transactionToMark) {
                                    aiMessageIntro = `Não encontrei uma transação pendente clara para "${params.transactionDescription || 'a transação mencionada'}" para marcar como paga/recebida, ${clientNameToUse}. 😕`;
                                    structuredDataBody = `(ID Pesquisado: ${params.transactionIdToUpdate || 'N/A'})`;
                                    platformLinkFooter = "";
                                } else {
                                    const updatedTx = await financialService.markAsPaidOrReceived(state.activeFinancialAccountId, transactionToMark.id, params.paymentDate);
                                    aiMessageIntro = detectedAction.action_specific_reply_suggestion || aiResponse.overall_summary_suggestion || `✨ Missão cumprida, ${clientNameToUse}!`;
                                    structuredDataBody = formatFinancialTransactionDataStructure(updatedTx);
                                    state.editingResource = null;
                                }
                                break;
                            }
                            case 'CREATE_RECURRING_RULE': {
                                const catRecId = params.financialCategoryName ? await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type) : null;
                                let ruleValue = parseFloat(params.value);
                                if ((isNaN(ruleValue) || ruleValue <= 0) && params.description && params.description.toLowerCase().includes('netflix')) {
                                    ruleValue = 55.90;
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
                                aiMessageIntro = aiResponse.overall_summary_suggestion || (detectedAction.action_specific_reply_suggestion || `Sua recorrência foi criada, ${clientNameToUse}!`);
                                structuredDataBody = formatRecurringRuleDataStructure(reloadedRule);
                                resourceForButtonsContext = { type: 'recurring_rule', id: newRule.id, description: newRule.description };
                                break;
                            }
                             case 'CREATE_PRODUCT': {
                                const productData = {
                                    name: params.name, salePrice: parseFloat(params.salePrice), code: params.code,
                                    costPrice: params.costPrice ? parseFloat(params.costPrice) : null,
                                    quantity: params.initialQuantity !== undefined ? parseInt(params.initialQuantity) : 0,
                                    minimumStock: params.minimumStock !== undefined ? parseInt(params.minimumStock) : 0,
                                    unit: params.unit
                                };
                                const newProd = await productService.createProduct(state.activeFinancialAccountId, productData);
                                aiMessageIntro = aiResponse.overall_summary_suggestion || (detectedAction.action_specific_reply_suggestion || `Produto cadastrado, ${clientNameToUse}!`);
                                structuredDataBody = formatProductSummary(newProd, clientNameToUse, false, false); // Passando forEdit=false explicitamente
                                resourceForButtonsContext = { type: 'product', id: newProd.id, description: newProd.name };
                                break;
                            }
                            case 'GET_STOCK_INFO': {
                                const productId = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                                 if(!productId) {
                                    aiMessageIntro = `Hum... não encontrei nenhum produto parecido com "${params.productNameOrCode}" na sua conta ${state.activeFinancialAccountName}, ${clientNameToUse}. 🧐`;
                                    structuredDataBody = ""; platformLinkFooter = "";
                                    break;
                                }
                                const stockBalance = await stockService.getProductStockBalance(productId);
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `Aqui está o estoque de *${stockBalance.name}* (${state.activeFinancialAccountName}):`;
                                structuredDataBody = `📦 Estoque Atual:\n\n`+
                                                      `🏷️ Produto: ${stockBalance.name}\n`+
                                                      `🔢 Disponível: ${stockBalance.quantity} ${stockBalance.unit || 'UN'}\n` +
                                                      (stockBalance.minimumStock ? `📉 Mínimo: ${stockBalance.minimumStock} ${stockBalance.unit || 'UN'}` : '');
                                if(stockBalance.minimumStock && stockBalance.quantity <= stockBalance.minimumStock) structuredDataBody += "\n\n📉 Atenção, estoque baixo!";
                                break;
                            }
                            case 'RECORD_STOCK_MOVEMENT': {
                                const productIdStock = await findProductIdByNameOrCode(params.productNameOrCode, state.activeFinancialAccountId);
                                 if(!productIdStock) {
                                    aiMessageIntro = `Não encontrei o produto "${params.productNameOrCode}" para movimentar o estoque, ${clientNameToUse}. 😬`;
                                    structuredDataBody = ""; platformLinkFooter = "";
                                    break;
                                }
                                const movementData = {
                                    type: params.movementType,
                                    quantity: parseInt(params.quantity),
                                    reason: params.reason
                                };
                                const movement = await stockService.recordStockMovement(productIdStock, movementData);
                                const updatedProduct = await productService.getProductById(state.activeFinancialAccountId, productIdStock);
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `Movimentação de estoque para *${updatedProduct.name}* registrada!`;
                                structuredDataBody = `📝 Detalhes da Movimentação:\n\n`+
                                                       `📦 Produto: ${updatedProduct.name}\n`+
                                                       `⚖️ Tipo: ${movement.type}\n`+
                                                       `🔢 Quantidade: ${movement.quantity}\n`+
                                                       `🆕 Novo Saldo: ${updatedProduct.quantity} ${updatedProduct.unit || 'UN'}`;
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
                                aiMessageIntro = aiResponse.overall_summary_suggestion || (detectedAction.action_specific_reply_suggestion || `Seu novo cartão foi cadastrado, ${clientNameToUse}!`);
                                structuredDataBody = formatCreditCardSummary(newCard, clientNameToUse, false, false); // Passando forEdit=false explicitamente
                                resourceForButtonsContext = { type: 'credit_card', id: newCard.id, description: newCard.name };
                                break;
                            }
                            case 'UPDATE_CREDIT_CARD':
                            case 'UPDATE_RECURRING_RULE':
                            case 'UPDATE_PRODUCT': {
                                actionWasAnEdit = true;
                                let idToUpdate, typeForUpdate, serviceForUpdate, formatterForUpdate;
                                if (detectedAction.action === 'UPDATE_CREDIT_CARD') {
                                    idToUpdate = params.cardIdToUpdate || state.editingResource?.id;
                                    typeForUpdate = "cartão de crédito"; serviceForUpdate = creditCardService.updateCreditCard; formatterForUpdate = (data) => formatCreditCardSummary(data, clientNameToUse, false, true);
                                } else if (detectedAction.action === 'UPDATE_RECURRING_RULE') {
                                    idToUpdate = params.ruleIdToUpdate || state.editingResource?.id;
                                    typeForUpdate = "regra de recorrência"; serviceForUpdate = recurringTransactionService.updateRecurringRule; formatterForUpdate = (data) => formatRecurringRuleDataStructure(data);
                                } else { // UPDATE_PRODUCT
                                    idToUpdate = params.productIdToUpdate || state.editingResource?.id;
                                    typeForUpdate = "produto"; serviceForUpdate = productService.updateProduct; formatterForUpdate = (data) => formatProductSummary(data, clientNameToUse, false, true);
                                }
                                if (!idToUpdate) throw new Error(`ID do ${typeForUpdate} para atualizar não fornecido.`);
                                const updatePayload = { ...params };
                                delete updatePayload.cardIdToUpdate; delete updatePayload.ruleIdToUpdate; delete updatePayload.productIdToUpdate;

                                const updatedItem = await serviceForUpdate(state.activeFinancialAccountId, idToUpdate, updatePayload);
                                aiMessageIntro = detectedAction.action_specific_reply_suggestion || aiResponse.overall_summary_suggestion || `${typeForUpdate.charAt(0).toUpperCase() + typeForUpdate.slice(1)} atualizado, ${clientNameToUse}!`;
                                structuredDataBody = formatterForUpdate(updatedItem);
                                state.editingResource = null; state.currentAction = null;
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
                                            const firstApp = new Date(new Date(todayLocaleApp).setDate(diffApp));
                                            const lastApp = new Date(new Date(firstApp).setDate(firstApp.getDate() + 6));
                                            filterAppList.dateStart = firstApp.toISOString().split('T')[0]; filterAppList.dateEnd = lastApp.toISOString().split('T')[0]; break;
                                        case 'proximos 7 dias':
                                            filterAppList.dateStart = todayLocaleApp.toISOString().split('T')[0];
                                            const sevenDays = new Date(todayLocaleApp); sevenDays.setDate(todayLocaleApp.getDate() + 6);
                                            filterAppList.dateEnd = sevenDays.toISOString().split('T')[0]; break;
                                    }
                                }
                                const { appointments, totalItems: totalApps } = await appointmentService.getAllAppointments(state.activeFinancialAccountId, filterAppList);
                                if (totalApps === 0) {
                                    aiMessageIntro = `Você não tem compromissos agendados para os filtros informados, ${clientNameToUse}.`;
                                    structuredDataBody = `Que tal agendar algo? 😉`;
                                    platformLinkFooter = "";
                                } else {
                                    aiMessageIntro = `🗓️ Você tem ${totalApps} compromissos. Os próximos são:`;
                                    let appListText = ""; // Sem título aqui, o título já está em aiMessageIntro
                                    appointments.forEach(app => {
                                        const eventDT = new Date(app.eventDateTime);
                                        const dateStr = eventDT.toLocaleDateString('pt-BR', {day:'2-digit', month:'2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo'});
                                        const timeStr = eventDT.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo'});
                                        appListText += `\n- ${app.title} em ${dateStr} às ${timeStr} (ID: ${app.id})`;
                                    });
                                    structuredDataBody = appListText.trim();
                                    if (totalApps > appointments.length) platformLinkFooter = formatPlatformLink(`E mais ${totalApps - appointments.length}. Peça para ver mais ou veja tudo na plataforma!`);
                                }
                                break;
                            }
                            case 'LIST_CREDIT_CARDS': {
                                const cards = await creditCardService.getAllCreditCards(state.activeFinancialAccountId, { isActive: true });
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `💳 Olha só, ${clientNameToUse}! Aqui estão todos os seus cartões cadastrados, prontos para facilitar sua vida financeira! 🏦✨ Dá uma conferida:`;
                                structuredDataBody = formatCreditCardListDataStructure(cards);
                                break;
                            }
                            case 'LIST_RECURRING_RULES': {
                                const rules = await recurringTransactionService.getAllRecurringRules(state.activeFinancialAccountId, { isActive: true });
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `Suas regras de recorrência ativas para "${state.activeFinancialAccountName}", ${clientNameToUse}:`;
                                if(rules.length === 0) {
                                    structuredDataBody = `🧾 Resumo das Recorrências:\n\nNenhuma regra de recorrência ativa encontrada. 🔄 Para criar uma, diga "criar recorrência [descrição] valor [valor] todo [dia/mês/ano]".`;
                                } else {
                                    structuredDataBody = `🧾 Resumo das Recorrências:\n`; // Título para a estrutura
                                    rules.forEach(r => {
                                        const nextDue = formatDate(r.nextDueDate);
                                        structuredDataBody += `\n- ${r.description} (${formatCurrency(r.value)} ${r.type}, Próx: ${nextDue})`;
                                    });
                                }
                                break;
                            }
                            case 'SWITCH_FINANCIAL_ACCOUNT': {
                                const targetAccountName = params.targetAccountNameOrType;
                                const allClientAccountsForSwitch = await clientService.getClientFinancialAccounts(client.id, { isActive: true });
                                if (!targetAccountName) {
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || `Você tem estas contas, ${clientNameToUse}:`;
                                    structuredDataBody = formatListClientAccountsDataStructure(allClientAccountsForSwitch, state.activeFinancialAccountId);
                                    platformLinkFooter = "Para qual delas você gostaria de mudar? Só me dizer o nome ou o número.";
                                    state.currentAction = 'selecting_account_flow_active'; 
                                    state.data.accountsToList = allClientAccountsForSwitch.map(a => ({id: a.id, name: a.accountName, type: a.accountType}));
                                } else {
                                    const foundAcc = allClientAccountsForSwitch.find(acc => acc.accountName.toLowerCase() === targetAccountName.toLowerCase() || acc.accountType.toLowerCase() === targetAccountName.toLowerCase());
                                    if (foundAcc && foundAcc.id !== state.activeFinancialAccountId) {
                                        state.activeFinancialAccountId = foundAcc.id;
                                        state.activeFinancialAccountName = foundAcc.accountName;
                                        state.activeFinancialAccountType = foundAcc.accountType;
                                        aiMessageIntro = aiResponse.overall_summary_suggestion || `Prontinho, ${clientNameToUse}! Mudei para sua conta "${state.activeFinancialAccountName}".`;
                                        structuredDataBody = "O que faremos agora? 😊";
                                        state.currentAction = null;
                                    } else if (foundAcc && foundAcc.id === state.activeFinancialAccountId) {
                                        aiMessageIntro = aiResponse.overall_summary_suggestion || `Você já está usando a conta "${state.activeFinancialAccountName}", ${clientNameToUse}! 😉`;
                                        structuredDataBody = ""; platformLinkFooter = "";
                                    } else {
                                        aiMessageIntro = aiResponse.overall_summary_suggestion || `Não encontrei uma conta chamada ou do tipo "${targetAccountName}", ${clientNameToUse}. 😕`;
                                        structuredDataBody = "Tente de novo com o nome exato ou o tipo (PF, PJ, MEI).";
                                        platformLinkFooter = "";
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
                                    aiMessageIntro = `Opa, ${clientNameToUse}! Você já tem uma conta empresarial (${existingPjMei.accountType}) chamada "${existingPjMei.accountName}".`;
                                    structuredDataBody = `No momento, só é possível ter uma conta PJ ou MEI. 😉`;
                                    platformLinkFooter = "";
                                    break;
                                }
                                const planTierForCreate = state.currentAccessLevel.startsWith('avancado') || state.currentAccessLevel.startsWith('vitalicio_avancado') ? 'avancado' : 'basico';
                                if ((typeToCreate === 'PJ' || typeToCreate === 'MEI') && planTierForCreate !== 'avancado') {
                                    const siteUrlCreateAcc = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                                    aiMessageIntro = `Ah, ${clientNameToUse}! Para criar uma conta empresarial (${typeToCreate}), você precisa de um dos nossos Planos Avançados. 🚀`;
                                    structuredDataBody = `Eles são demais! Confira em ${siteUrlCreateAcc} e depois me avise para continuarmos! 😉`;
                                    platformLinkFooter = "";
                                    state.data.onboardingStage = 'awaiting_plan_confirmation';
                                    break;
                                }
        
                                if (!typeToCreate) {
                                    const msg = getOnboardingAskForPJTypeMessage(clientNameToUse);
                                    aiMessageIntro = msg.split('\n\n')[0];
                                    structuredDataBody = msg.split('\n\n')[1];
                                    platformLinkFooter = msg.split('\n\n')[2] || "";
                                    state.currentAction = 'awaiting_explicit_account_type_from_ai';
                                } else if (!newAccName) {
                                    const msg = getOnboardingAskForCompanyNameMessage(clientNameToUse, typeToCreate);
                                    aiMessageIntro = msg.split('\n\n')[0];
                                    structuredDataBody = msg.split('\n\n')[1];
                                    platformLinkFooter = msg.split('\n\n')[2] || "";
                                    state.currentAction = 'awaiting_explicit_account_name_from_ai';
                                    state.data.accountTypeToCreate = typeToCreate;
                                } else {
                                    try {
                                        const newFA = await clientService.createFinancialAccount(client.id, { accountName: newAccName, accountType: typeToCreate });
                                        const msg = getOnboardingCompanyCreatedMessage(clientNameToUse, newFA.accountType, newFA.accountName, state.activeFinancialAccountName || "Pessoal");
                                        aiMessageIntro = msg.split('\n\n')[0];
                                        structuredDataBody = msg.split('\n\n')[1];
                                        platformLinkFooter = msg.split('\n\n')[2] || "";
                                        state.activeFinancialAccountId = newFA.id;
                                        state.activeFinancialAccountName = newFA.accountName;
                                        state.activeFinancialAccountType = newFA.accountType;
                                        state.currentAction = null; 
                                        if (state.data.onboardingStage !== 'onboarding_complete') {
                                            state.data.onboardingStage = 'onboarding_complete';
                                        }
                                        if (state.data.accountTypeToCreate) delete state.data.accountTypeToCreate;
                                    } catch(e) {
                                        aiMessageIntro = `Ops, não consegui criar a conta "${newAccName}" (${typeToCreate}).`;
                                        structuredDataBody = `Detalhe: ${e.message.substring(0,70)}.\nTente um nome diferente.`;
                                        platformLinkFooter = "";
                                        state.currentAction = 'awaiting_explicit_account_name_from_ai';
                                        state.data.accountTypeToCreate = typeToCreate;
                                    }
                                }
                                break;
                            }
                            case 'GET_CREDIT_CARD_INVOICE': {
                                const cardIdForInvoice = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                if (!cardIdForInvoice) {
                                    aiMessageIntro = `Hum, não consegui identificar o cartão "${params.creditCardName}", ${clientNameToUse}.`;
                                    structuredDataBody = `Pode tentar de novo ou verificar se ele está cadastrado? 🤔`;
                                    platformLinkFooter = "";
                                    break;
                                }
                                const periodOpts = {
                                    type: params.invoicePeriodType || 'aberta',
                                    month: params.invoiceMonth,
                                    year: params.invoiceYear
                                };
                                const invoiceDetails = await creditCardService.getCreditCardInvoiceDetails(state.activeFinancialAccountId, cardIdForInvoice, periodOpts);
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `🛍️ ${clientNameToUse}, chegou a hora de conferir a fatura do seu cartão! Vamos ver tudo que rolou neste mês para você manter o controle na mão! 💳🔥`;
                                structuredDataBody = formatCreditCardInvoiceDataStructure(invoiceDetails, params.listTransactions !== false);
                                break;
                            }
                            case 'GET_CREDIT_CARD_AVAILABLE_LIMIT': {
                                const cardIdForLimit = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                if (!cardIdForLimit) {
                                    aiMessageIntro = `Não encontrei o cartão "${params.creditCardName}" para verificar o limite, ${clientNameToUse}. 😬`;
                                    structuredDataBody = ""; platformLinkFooter = "";
                                    break;
                                }
                                const limitInfo = await creditCardService.getAvailableCreditLimit(state.activeFinancialAccountId, cardIdForLimit);
                                aiMessageIntro = aiResponse.overall_summary_suggestion || `Opa, ${clientNameToUse}! Curioso sobre o limite do seu cartão ${limitInfo.cardName}? Deixa comigo que eu te conto tudo! 💳✨`;
                                structuredDataBody = formatAvailableLimitDataStructure(limitInfo);
                                break;
                            }
                            case 'PAY_CREDIT_CARD_INVOICE': {
                                const cardIdForPayment = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                if (!cardIdForPayment) {
                                    aiMessageIntro = `Não identifiquei o cartão "${params.creditCardName}" para registrar o pagamento da fatura, ${clientNameToUse}. 🧐`;
                                    structuredDataBody = ""; platformLinkFooter = "";
                                    break;
                                }
                                const paymentAmount = parseFloat(params.paymentAmount);
                                const paymentDate = params.paymentDate || new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"})).toISOString().split('T')[0];
        
                                const paymentDescription = `Pagamento Fatura ${params.creditCardName}`;
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
                                    aiMessageIntro = aiResponse.overall_summary_suggestion || `Pagamento da fatura do cartão ${params.creditCardName} registrado! 🎉 Bom demais ter as contas em dia!`;
                                    structuredDataBody = formatFinancialTransactionDataStructure(paymentTx);
                                } catch (e) {
                                    logger.error(`Erro ao registrar pagamento de fatura para cartão ${params.creditCardName} na conta ${state.activeFinancialAccountName}: ${e.message}`);
                                    aiMessageIntro = `Ops! Tive um problema ao tentar registrar o pagamento da fatura do ${params.creditCardName}.`;
                                    structuredDataBody = `Detalhe: ${e.message.substring(0,60)} 😥`;
                                }
                                break;
                            }
                            case 'GENERAL_GREETING_OR_SMALLTALK':
                            case 'GENERAL_QUESTION_OR_HELP':
                            case 'ACTION_CONFIRMATION_YES':
                            case 'ACTION_CONFIRMATION_NO':
                                 aiMessageIntro = aiResponse.reply_to_user_suggestion || `Entendido, ${clientNameToUse}! 😊`;
                                 structuredDataBody = ""; 
                                 platformLinkFooter = (detectedAction.action === 'GENERAL_QUESTION_OR_HELP' && !aiResponse.reply_to_user_suggestion?.includes('app.mapnocontrole.com.br')) ? formatPlatformLink("Se precisar de mais funcionalidades, explore nossa plataforma!") : "";

                                if (detectedAction.action === 'ACTION_CONFIRMATION_YES' || detectedAction.action === 'ACTION_CONFIRMATION_NO') {
                                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                                }
                                break;
                            default:
                                aiMessageIntro = aiResponse.reply_to_user_suggestion || `Entendi sua intenção sobre "${detectedAction.action.toLowerCase().replace(/_/g," ")}", ${clientNameToUse}.`;
                                structuredDataBody = `Ainda estou aprendendo a processar isso completamente. 😅 Minha equipe está trabalhando nisso!`;
                                logger.warn(`[WHATSAPP SERVICE] Ação da IA não implementada no switch de formatação: ${detectedAction.action}`);
                                break;
                        } 
                    } catch (e) {
                         logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack?.substring(0,300), params: params });
                         aiMessageIntro = `Ops! 😬 Tive um problema ao tentar processar "${params.description || detectedAction.action.toLowerCase().replace(/_/g," ")}".`;
                         structuredDataBody = `Detalhe do erro: ${e.message.length < 80 ? e.message : 'Erro interno, desculpe!'}\n\nPode tentar de novo ou com outros termos?`;
                         platformLinkFooter = formatPlatformLink("Se o problema persistir, contate o suporte.");
                    }
                } 
            } 
        
            if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
                aiMessageIntro = aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe:`;
                structuredDataBody = aiResponse.clarifications_needed[0].clarification_question;
                platformLinkFooter = "";
                state.currentAction = 'awaiting_clarification_response'; 
                state.data.clarificationContext = { 
                    action: aiResponse.clarifications_needed[0].original_intent_action_suggestion,
                    original_message: messageText,
                    parameters_so_far: aiResponse.clarifications_needed[0].parameters_so_far || {}
                };
            } else if (!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) {
                if (aiResponse.reply_to_user_suggestion) {
                    aiMessageIntro = aiResponse.reply_to_user_suggestion;
                    structuredDataBody = "";
                    platformLinkFooter = !aiResponse.reply_to_user_suggestion.includes('app.mapnocontrole.com.br') ? formatPlatformLink() : "";
                } else if (!aiMessageIntro && !structuredDataBody) {
                    aiMessageIntro = `Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊`;
                    structuredDataBody = "Estou por aqui!";
                    platformLinkFooter = formatPlatformLink();
                }
            }
        
            finalMessageToSend = aiMessageIntro.trim();
            if (structuredDataBody && structuredDataBody.trim() !== "") {
                finalMessageToSend += `\n\n${structuredDataBody.trim()}`;
            }
            if (platformLinkFooter && platformLinkFooter.trim() !== "" && (!state.currentAction || !state.currentAction.startsWith('awaiting_'))) {
                if(!finalMessageToSend.includes('https://app.mapnocontrole.com.br') && !finalMessageToSend.includes('https://mapnocontrole.com.br/planos')) {
                     finalMessageToSend += `\n\n${platformLinkFooter.trim()}`;
                }
            }
            finalMessageToSend = finalMessageToSend.replace(/\n{3,}/g, '\n\n').trim();
        
            if (finalMessageToSend) { 
                state.messageHistory.push({ role: 'assistant', content: finalMessageToSend });
            }
        
            if (actionWasAnEdit || (state.editingResource && (!aiResponse.detected_actions || aiResponse.detected_actions.every(a => !a.action.startsWith("UPDATE_") && a.action !== 'RECREATE_PARCELLED_ACCOUNT')))) {
                state.editingResource = null;
            }
            if (state.data.clarificationContext && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
                delete state.data.clarificationContext;
            }
        
        
            if (finalMessageToSend) {
                const performedConcreteAction = (aiResponse.detected_actions && aiResponse.detected_actions.length > 0 &&
                                           aiResponse.detected_actions.some(a => !a.action.startsWith("GENERAL_") && !a.action.startsWith("LIST_") && !a.action.startsWith("GET_") && !a.action.startsWith("SWITCH_") && !a.action.startsWith("ACTION_CONFIRMATION_") )
                                          ) &&
                                           (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0);

                if (resourceForButtonsContext && performedConcreteAction && !actionWasAnEdit) {
                    let buttons = [];
                    let buttonItemDesc = "item";
                    if (resourceForButtonsContext.description && typeof resourceForButtonsContext.description === 'string') {
                        buttonItemDesc = resourceForButtonsContext.description.length > 24 ? resourceForButtonsContext.description.substring(0, 21) + "..." : resourceForButtonsContext.description;
                    }
                    const buttonTitle = `Opções para "${buttonItemDesc}":`;
        
                    switch(resourceForButtonsContext.type) {
                        case 'transaction':
                            buttons = [ { id: `edit_transaction_${resourceForButtonsContext.id}`, label: "Editar Transação ✍️" }, { id: `delete_transaction_${resourceForButtonsContext.id}`, label: "Excluir Transação 🗑️" }, ]; break;
                        case 'appointment':
                            buttons = [ { id: `edit_appointment_${resourceForButtonsContext.id}`, label: "Editar Compromisso ✍️" }, { id: `delete_appointment_${resourceForButtonsContext.id}`, label: "Excluir Compromisso 🗑️" }, ]; break;
                        case 'credit_card':
                            buttons = [ { id: `edit_credit_card_${resourceForButtonsContext.id}`, label: "Editar Cartão ✍️" }, { id: `delete_credit_card_${resourceForButtonsContext.id}`, label: "Excluir Cartão 🗑️" }, ]; break;
                        case 'recurring_rule':
                            buttons = [ { id: `edit_recurring_rule_${resourceForButtonsContext.id}`, label: "Editar Recorrência ✍️" }, { id: `delete_recurring_rule_${resourceForButtonsContext.id}`, label: "Excluir Recorrência 🗑️" }, ]; break;
                        case 'product':
                            buttons = [ { id: `edit_product_${resourceForButtonsContext.id}`, label: "Editar Produto ✍️" }, { id: `delete_product_${resourceForButtonsContext.id}`, label: "Excluir Produto 🗑️" }, ]; break;
                        case 'parcelled_account': 
                            buttons = [ { id: `edit_parcelled_account_${resourceForButtonsContext.id}`, label: "Alterar Compra Parcelada ✍️" }, { id: `delete_parcelled_account_${resourceForButtonsContext.id}`, label: "Excluir Compra Parcelada 🗑️" }, ]; break;
                    }
        
                    if (buttons.length > 0) {
                        await sendButtonListMessage(senderPhone, finalMessageToSend, buttons, buttonTitle, "Ver Opções 👇");
                    } else {
                        await sendWhatsappMessage(senderPhone, finalMessageToSend);
                    }
                } else {
                    await sendWhatsappMessage(senderPhone, finalMessageToSend);
                    if(state.editingResource && !resourceForButtonsContext && !actionWasAnEdit) state.editingResource = null;
                }
            }
        } 

    } catch (error) {
        logger.error(`[WHATSAPP HANDLER] Erro CRÍTICO processando msg de ${senderPhone}: ${error.message}`, { stack: error.stack?.substring(0,1000), messageText, rawPayload });
        const clientNameToUseInError = state ? state.clientName : (pushNameFromPayload || "você");
        const errorIntro = `Puxa vida, ${clientNameToUseInError}! 😬 Parece que tive um curto-circuito feio aqui...`;
        const errorData = `🎯 Ocorrência Inesperada:\n\nNão consegui processar sua mensagem.\nMinha equipe de engenheiros já foi notificada! 👩‍💻👨‍💻`;
        const errorLink = formatPlatformLink("Por favor, tente de novo em um momentinho ou acesse a plataforma.");
        try {
            await sendWhatsappMessage(senderPhone, `${errorIntro}\n\n${errorData}\n\n${errorLink}`);
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
                activeFinancialAccountId: state.activeFinancialAccountId,
                accessLevelTextForUser: state.accessLevelTextForUser,
                tempData: JSON.parse(JSON.stringify(state.data)) 
            });
            conversationState.set(senderPhone, state); 
        }
        pushNameFromPayload = null;
    }
}

module.exports = { processIncomingMessage };
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
let pushNameFromPayload = null;


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
        data += `\n${index + 1}️⃣ Cartão: ${card.name || 'N/A'}\n`;
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
    } else if (invoiceDetails.cardTotalLimit !== undefined) { // Fallback para limite total se não tiver o após fatura
        const available = parseFloat(invoiceDetails.cardTotalLimit) - parseFloat(invoiceDetails.totalAmount);
        data += `💳 Limite Total do Cartão: ${formatCurrency(invoiceDetails.cardTotalLimit)}\n`;
        data += `💳 Saldo Estimado Pós-Fatura: ${formatCurrency(available)}\n`;
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
        data += `\n${index + 1}️⃣ ${acc.name} (${acc.type})${currentAccountId === acc.id ? ' (Selecionada ✨)' : ''}`;
    });
    return data.trim();
}

function formatProductDataStructure(product) {
    if (!product) return "📦 Resumo do Produto:\n\nDados do produto não disponíveis.";
    let data = `📦 Resumo do Produto:\n\n`;
    data += `🏷️ Nome: ${product.name}\n`;
    if(product.code) data += `🔢 Código: ${product.code}\n`;
    data += `💰 Preço de Venda: ${formatCurrency(product.salePrice)}\n`;
    if(product.costPrice) data += `💲 Preço de Custo: ${formatCurrency(product.costPrice)}\n`;
    data += `🛍️ Estoque Atual: ${product.quantity} ${product.unit || 'UN'}\n`;
    if(product.minimumStock) data += `📉 Estoque Mínimo: ${product.minimumStock} ${product.unit || 'UN'}\n`;
    if(product.description && product.description.trim() !== "") data += `📄 Descrição Detalhada: ${product.description}\n`;
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
            let multipleActionBodies = []; // Para armazenar estruturas de dados de múltiplas ações

            if (aiResponse.detected_actions && aiResponse.detected_actions.length > 0) {
                for (const detectedAction of aiResponse.detected_actions) {
                    const params = detectedAction.parameters || {};
                    let currentActionBlocked = false;
                    let currentActionFormattedData = ""; // Para a estrutura de dados da ação atual

                    const publicActions = ['GENERAL_GREETING_OR_SMALLTALK', 'GENERAL_QUESTION_OR_HELP', 'ACTION_CONFIRMATION_YES', 'ACTION_CONFIRMATION_NO', 'SWITCH_FINANCIAL_ACCOUNT', 'CREATE_FINANCIAL_ACCOUNT'];
                    if (!state.hasPaidAccess && !publicActions.includes(detectedAction.action)) {
                        const noPlanIntro = getOnboardingWelcomeNoPlanMessage(clientNameToUse).split('\n\n')[0];
                        const noPlanData = getOnboardingWelcomeNoPlanMessage(clientNameToUse).split('\n\n').slice(1).join('\n\n');
                        // Se for a primeira ação bloqueada, define a mensagem principal
                        if (multipleActionBodies.length === 0 && !aiMessageIntro.startsWith("Ah, " + clientNameToUse + ", para eu poder te ajudar")) aiMessageIntro = noPlanIntro;
                        currentActionFormattedData = noPlanData; // Adiciona a estrutura de planos
                        platformLinkFooter = ""; // Removido pois já está na mensagem de onboarding
                        state.data.onboardingStage = 'awaiting_plan_confirmation'; 
                        currentActionBlocked = true;
                    }
                    // ... (outras verificações de acesso e conta, similar ao loop anterior, definindo currentActionBlocked)
                    const accountRequiredActions = [ /* ... lista de ações ... */ ];
                    if (accountRequiredActions.includes(detectedAction.action) && !state.activeFinancialAccountId && !currentActionBlocked) {
                        if (multipleActionBodies.length === 0 && !aiMessageIntro.startsWith("Opa, " + clientNameToUse)) aiMessageIntro = `Opa, ${clientNameToUse}! Para eu poder "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", preciso que você selecione uma conta financeira primeiro.`;
                        currentActionFormattedData = `Se você já configurou alguma, me diga o nome dela. Se não, diga "criar conta pessoal"! 😊`;
                        platformLinkFooter = ""; state.currentAction = 'selecting_account_flow_active'; currentActionBlocked = true;
                    }
                    const pjMeiActions = ['CREATE_PRODUCT', 'GET_STOCK_INFO', 'RECORD_STOCK_MOVEMENT', 'UPDATE_PRODUCT'];
                    if (pjMeiActions.includes(detectedAction.action) && state.activeFinancialAccountType && !['PJ', 'MEI'].includes(state.activeFinancialAccountType)  && !currentActionBlocked) {
                        if (multipleActionBodies.length === 0 && !aiMessageIntro.startsWith("Desculpe, " + clientNameToUse)) aiMessageIntro = `Desculpe, ${clientNameToUse}, mas "${detectedAction.action.toLowerCase().replace(/_/g, " ")}" é apenas para contas PJ ou MEI.`;
                        currentActionFormattedData = `Sua conta "${state.activeFinancialAccountName}" é do tipo ${state.activeFinancialAccountType}. Você pode criar uma conta empresarial ou mudar para ela! 😉`;
                        platformLinkFooter = ""; currentActionBlocked = true;
                    } else if (pjMeiActions.includes(detectedAction.action) && state.activeFinancialAccountType && ['PJ', 'MEI'].includes(state.activeFinancialAccountType) && !state.currentAccessLevel.startsWith('avancado') && !state.currentAccessLevel.startsWith('vitalicio_avancado') && !currentActionBlocked) {
                        const siteUrlPjMei = process.env.PLAN_SITE_URL || "https://mapnocontrole.com.br/planos";
                         if (multipleActionBodies.length === 0 && !aiMessageIntro.startsWith("Ah, " + clientNameToUse)) aiMessageIntro = `Ah, ${clientNameToUse}! Para usar as funcionalidades de ${state.activeFinancialAccountType === 'PJ' ? 'Empresa (PJ)' : 'MEI'}, como "${detectedAction.action.toLowerCase().replace(/_/g, " ")}", você precisa de um dos nossos Planos Avançados. 🚀`;
                        currentActionFormattedData = `Eles são perfeitos para quem quer ir além! Confira em ${siteUrlPjMei} e depois me avise para continuarmos! 😉`;
                        platformLinkFooter = ""; state.data.onboardingStage = 'awaiting_plan_confirmation'; currentActionBlocked = true;
                    }

                    if (currentActionBlocked) {
                        multipleActionBodies.push(currentActionFormattedData);
                        // Se uma ação foi bloqueada, não processa mais ações que dependam de acesso/conta
                        // e foca na mensagem de bloqueio.
                        if (aiResponse.detected_actions.length === 1 || actionBlockedNoAccessLoop) {
                            structuredDataBody = currentActionFormattedData; // Para uma única ação bloqueada
                            // Se a overall_summary_suggestion já for a mensagem de bloqueio, não precisa mexer.
                            // Caso contrário, aiMessageIntro já está setado para o bloqueio.
                        }
                        continue; // Pula para a próxima ação detectada ou finaliza se for a única
                    }

                    try {
                        switch (detectedAction.action) {
                            case 'CREATE_FINANCIAL_TRANSACTION': {
                                const categoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                                const cardId = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                                const txData = { /* ... */ };
                                const newTx = await financialService.createTransaction(state.activeFinancialAccountId, txData);
                                const reloadedTx = await financialService.getTransactionById(state.activeFinancialAccountId, newTx.id);
                                currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedTx);
                                if (aiResponse.detected_actions.length === 1 && detectedAction.action_specific_reply_suggestion) aiMessageIntro = detectedAction.action_specific_reply_suggestion;
                                else if (aiResponse.detected_actions.length === 1 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sua transação foi registrada, ${clientNameToUse}!`;
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'transaction', id: newTx.id, description: newTx.description };
                                break;
                            }
                             case 'UPDATE_FINANCIAL_TRANSACTION': {
                                actionWasAnEdit = true;
                                const transactionIdToUpdate = params.transactionIdToUpdate || state.editingResource?.id;
                                if (!transactionIdToUpdate) throw new Error("ID da transação para atualizar não fornecido.");
                                const updateTxData = { ...params };
                                if (params.financialCategoryName) updateTxData.financialCategoryId = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type || null);
                                if (params.creditCardName) updateTxData.creditCardId = await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId);
                                delete updateTxData.transactionIdToUpdate; delete updateTxData.financialCategoryName; delete updateTxData.creditCardName;
        
                                const updatedTx = await financialService.updateTransaction(state.activeFinancialAccountId, transactionIdToUpdate, updateTxData);
                                const reloadedUpdatedTx = await financialService.getTransactionById(state.activeFinancialAccountId, updatedTx.id);
                                aiMessageIntro = detectedAction.action_specific_reply_suggestion || aiResponse.overall_summary_suggestion || `Transação atualizada com sucesso, ${clientNameToUse}!`;
                                currentActionFormattedData = formatFinancialTransactionDataStructure(reloadedUpdatedTx);
                                state.editingResource = null; state.currentAction = null;   
                                break;
                            }
                            case 'SCHEDULE_APPOINTMENT': {
                                let eventDateTime = params.eventDateTime;
                                if (params.eventDateTime && params.eventDateTime.length === 10) eventDateTime += ' 09:00';
                                else if (params.eventDateTime && params.eventDateTime.includes("T") && params.eventDateTime.endsWith("Z")) {
                                    const d = new Date(params.eventDateTime);
                                    eventDateTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                                }
                                const appData = { /* ... */ };
                                const newApp = await appointmentService.scheduleAppointment(state.activeFinancialAccountId, appData);
                                const reloadedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, newApp.id);
                                if (aiResponse.detected_actions.length === 1 && detectedAction.action_specific_reply_suggestion) aiMessageIntro = detectedAction.action_specific_reply_suggestion;
                                else if (aiResponse.detected_actions.length === 1 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Seu compromisso foi agendado, ${clientNameToUse}!`;
                                currentActionFormattedData = formatAppointmentDataStructure(reloadedApp);
                                if (aiResponse.detected_actions.length === 1) resourceForButtonsContext = { type: 'appointment', id: newApp.id, description: newApp.title };
                                break;
                            }
                            case 'UPDATE_APPOINTMENT': {
                                actionWasAnEdit = true;
                                const appointmentIdToUpdate = params.appointmentIdToUpdate || state.editingResource?.id;
                                if (!appointmentIdToUpdate) throw new Error("ID do compromisso para atualizar não fornecido.");
                                const updateAppData = { ...params };
                                 if (params.eventDateTime && params.eventDateTime.length === 10) updateAppData.eventDateTime += ' 09:00';
                                 else if (params.eventDateTime && params.eventDateTime.includes("T") && params.eventDateTime.endsWith("Z")) {
                                    const d = new Date(params.eventDateTime);
                                    updateAppData.eventDateTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                                 }
                                delete updateAppData.appointmentIdToUpdate;
                                if (params.hasOwnProperty('associatedValue')) updateAppData.associatedValue = params.associatedValue ? parseFloat(params.associatedValue) : null;
        
                                const updatedApp = await appointmentService.updateAppointment(state.activeFinancialAccountId, appointmentIdToUpdate, updateAppData);
                                const reloadedUpdatedApp = await appointmentService.getAppointmentById(state.activeFinancialAccountId, updatedApp.id);
                                aiMessageIntro = detectedAction.action_specific_reply_suggestion || aiResponse.overall_summary_suggestion || `Compromisso atualizado com sucesso, ${clientNameToUse}!`;
                                currentActionFormattedData = formatAppointmentDataStructure(reloadedUpdatedApp);
                                state.editingResource = null; state.currentAction = null;
                                break;
                            }
                            case 'CREATE_PARCELLED_ACCOUNT': {
                                const catIdParcel = await findFinancialCategoryIdByName(params.financialCategoryName, state.activeFinancialAccountId, params.type);
                                const cardIdParcel = params.creditCardName ? await findCreditCardIdByName(params.creditCardName, state.activeFinancialAccountId) : null;
                                if (params.creditCardName && !cardIdParcel) {
                                    aiMessageIntro = `Hum, ${clientNameToUse}, não encontrei um cartão chamado "${params.creditCardName}" para registrar essa compra parcelada. 😕`;
                                    currentActionFormattedData = `Você pode cadastrar o cartão primeiro ou tentar com outro nome.`;
                                    platformLinkFooter = ""; break;
                                }
                                const parcelData = { /* ... */ };
                                const parcelResult = await financialService.createParcelledAccount(state.activeFinancialAccountId, parcelData);
                                if (aiResponse.detected_actions.length === 1 && detectedAction.action_specific_reply_suggestion) aiMessageIntro = detectedAction.action_specific_reply_suggestion;
                                else if (aiResponse.detected_actions.length === 1 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `Sua compra parcelada foi registrada, ${clientNameToUse}!`;
                                currentActionFormattedData = formatParcelledAccountDataStructure(parcelData, parcelResult);
                                if (aiResponse.detected_actions.length === 1 && parcelResult.parcels && parcelResult.parcels.length > 0) {
                                    const originalTxId = parcelResult.parcels[0].originalAccountId || parcelResult.parcels[0].id;
                                    resourceForButtonsContext = { type: 'parcelled_account', id: originalTxId, description: params.description };
                                }
                                break;
                            }
                            // ... (outros cases, seguindo o mesmo padrão de preencher aiMessageIntro e currentActionFormattedData)
                            case 'GET_FINANCIAL_SUMMARY': {
                                const filterParams = { /* ... */ }; // Monta filtros como antes
                                const summaryData = await financialService.getFinancialSummary(state.activeFinancialAccountId, filterParams);
                                let periodText = params.period ? params.period.replace("_", " ") : (filterParams.dateStart && filterParams.dateEnd ? `${formatDate(filterParams.dateStart)} a ${formatDate(filterParams.dateEnd)}` : "geral");
                                if (aiResponse.detected_actions.length === 1 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `📊 Resumo Financeiro (${periodText} para ${state.activeFinancialAccountName}):`;
                                else if (aiResponse.detected_actions.length === 1 && aiResponse.overall_summary_suggestion) aiMessageIntro = aiResponse.overall_summary_suggestion;

                                currentActionFormattedData = `🟢 Entradas: ${formatCurrency(summaryData.totalEntradas)}\n` +
                                              `🔴 Saídas: ${formatCurrency(summaryData.totalSaidas)}\n` +
                                              `💰 *Saldo Efetivado (Caixa): ${formatCurrency(summaryData.saldoEfetivado)}*\n\n` +
                                              `📈 A Receber (Pend.): ${formatCurrency(summaryData.totalAReceberPendente)}\n` +
                                              `📉 A Pagar (Pend.): ${formatCurrency(summaryData.totalAPagarPendente)}`;
                                break;
                            }
                             case 'LIST_FINANCIAL_TRANSACTIONS': {
                                const filterParamsList = { /* ... */ };
                                const { transactions, totalItems } = await financialService.getAllTransactions(state.activeFinancialAccountId, filterParamsList);
                                if (totalItems === 0) {
                                    aiMessageIntro = `Nenhuma transação encontrada para os filtros que você pediu, ${clientNameToUse}. 👍`;
                                    currentActionFormattedData = "Tente outros filtros!";
                                } else {
                                    if (aiResponse.detected_actions.length === 1 && !aiResponse.overall_summary_suggestion) aiMessageIntro = `📜 Encontrei ${totalItems} transações. As ${transactions.length > 1 ? transactions.length + " " : ""}mais recentes são:`;
                                    else if (aiResponse.detected_actions.length === 1 && aiResponse.overall_summary_suggestion) aiMessageIntro = aiResponse.overall_summary_suggestion;
                                    let listText = "";
                                    for (const t of transactions) { /* ... formatação da lista como antes ... */ }
                                    currentActionFormattedData = listText.trim();
                                    if (totalItems > transactions.length) platformLinkFooter = formatPlatformLink(`E mais ${totalItems - transactions.length} transações. Peça para ver mais ou veja tudo na plataforma!`);
                                }
                                break;
                            }
                            // ... (restante dos cases adaptados)
                            case 'GENERAL_GREETING_OR_SMALLTALK':
                            case 'GENERAL_QUESTION_OR_HELP':
                            case 'ACTION_CONFIRMATION_YES':
                            case 'ACTION_CONFIRMATION_NO':
                                 aiMessageIntro = aiResponse.reply_to_user_suggestion || `Entendido, ${clientNameToUse}! 😊`;
                                 currentActionFormattedData = ""; 
                                 platformLinkFooter = (detectedAction.action === 'GENERAL_QUESTION_OR_HELP' && !aiResponse.reply_to_user_suggestion?.includes('app.mapnocontrole.com.br')) ? formatPlatformLink("Se precisar de mais funcionalidades, explore nossa plataforma!") : "";

                                if (detectedAction.action === 'ACTION_CONFIRMATION_YES' || detectedAction.action === 'ACTION_CONFIRMATION_NO') {
                                    state.currentAction = null; state.pendingConfirmation = null; state.editingResource = null;
                                }
                                break;
                            default:
                                if (aiResponse.detected_actions.length === 1 && !aiResponse.overall_summary_suggestion) aiMessageIntro = aiResponse.reply_to_user_suggestion || `Entendi sua intenção sobre "${detectedAction.action.toLowerCase().replace(/_/g," ")}", ${clientNameToUse}.`;
                                else if (aiResponse.detected_actions.length === 1 && aiResponse.overall_summary_suggestion) aiMessageIntro = aiResponse.overall_summary_suggestion;
                                currentActionFormattedData = `Ainda estou aprendendo a processar "${detectedAction.action.toLowerCase().replace(/_/g," ")}" completamente. 😅 Minha equipe está trabalhando nisso!`;
                                logger.warn(`[WHATSAPP SERVICE] Ação da IA não implementada no switch de formatação: ${detectedAction.action}`);
                                break;
                        }
                    } catch (e) {
                         logger.error(`[WHATSAPP HANDLER] Erro executando "${detectedAction.action}" para ${senderPhone}: ${e.message}`, { stack: e.stack?.substring(0,300), params: params });
                         if (aiResponse.detected_actions.length === 1) { // Se for uma única ação, a mensagem de erro é mais direta
                            aiMessageIntro = `Ops! 😬 Tive um problema ao tentar processar "${params.description || detectedAction.action.toLowerCase().replace(/_/g," ")}".`;
                            currentActionFormattedData = `Detalhe do erro: ${e.message.length < 80 ? e.message : 'Erro interno, desculpe!'}\n\nPode tentar de novo ou com outros termos?`;
                         } else { // Se múltiplas ações, adiciona ao corpo de múltiplas ações
                            multipleActionBodies.push(`❌ Erro ao processar "${detectedAction.action}": ${e.message.substring(0,70)}`);
                            currentActionFormattedData = ""; // Não define dados para esta ação específica
                         }
                    }

                    if (currentActionFormattedData && !actionBlockedNoAccessLoop) { // Só adiciona se não foi bloqueado e tem dados
                        multipleActionBodies.push(currentActionFormattedData);
                    }
                } // Fim do loop for detected_actions

                if (multipleActionBodies.length > 0) {
                    structuredDataBody = multipleActionBodies.join("\n\n---\n\n");
                } else if (aiResponse.detected_actions.length === 0) { // Nenhuma ação, mas pode ter reply_to_user_suggestion
                    structuredDataBody = ""; // Garante que não haja dados estruturados
                    if (aiResponse.reply_to_user_suggestion && !aiMessageIntro) {
                        aiMessageIntro = aiResponse.reply_to_user_suggestion;
                    }
                }

            } // Fim do if detected_actions
        
            if (aiResponse.clarifications_needed && aiResponse.clarifications_needed.length > 0) {
                aiMessageIntro = aiResponse.reply_to_user_suggestion || `Opa, ${clientNameToUse}! Para continuarmos, preciso de um detalhe:`;
                structuredDataBody = aiResponse.clarifications_needed[0].clarification_question;
                platformLinkFooter = "";
                state.currentAction = 'awaiting_clarification_response'; 
                state.data.clarificationContext = { /* ... */ };
            } else if (!aiResponse.detected_actions || aiResponse.detected_actions.length === 0) {
                if (aiResponse.reply_to_user_suggestion && !aiMessageIntro.includes(aiResponse.reply_to_user_suggestion.substring(0,30))) { // Evita duplicar se já foi setado
                    aiMessageIntro = aiResponse.reply_to_user_suggestion;
                } else if (!aiMessageIntro && !structuredDataBody) {
                    aiMessageIntro = `Entendido, ${clientNameToUse}! Se precisar de mais alguma coisa, é só chamar. 😊`;
                    structuredDataBody = "Estou por aqui!";
                }
                // Se a IA não detectou ações, não deve haver dados estruturados significativos, a menos que a reply_to_user_suggestion seja para isso.
                if (!structuredDataBody && aiResponse.reply_to_user_suggestion) {
                    // A reply_to_user_suggestion já é a mensagem principal em casos de conversa.
                }
            }
        
            finalMessageToSend = aiMessageIntro.trim();
            if (structuredDataBody && structuredDataBody.trim() !== "") {
                finalMessageToSend += `\n\n${structuredDataBody.trim()}`;
            }
            
            // Não adicionar o link da plataforma se for uma pergunta de clarificação ou se a mensagem já o contiver.
            const noLinkConditions = state.currentAction === 'awaiting_clarification_response' ||
                                     finalMessageToSend.includes('https://app.mapnocontrole.com.br') ||
                                     finalMessageToSend.includes('https://mapnocontrole.com.br/planos') ||
                                     (aiResponse.detected_actions && aiResponse.detected_actions.some(a => a.action.startsWith("GENERAL_") && a.action !== 'GENERAL_QUESTION_OR_HELP' )); // Não adicionar link em saudações simples

            if (platformLinkFooter && platformLinkFooter.trim() !== "" && !noLinkConditions ) {
                 finalMessageToSend += `\n\n${platformLinkFooter.trim()}`;
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
                // Verifica se a *última* ação principal detectada (se houver múltiplas) pode ter botões.
                const lastConcreteAction = aiResponse.detected_actions ? [...aiResponse.detected_actions].reverse().find(a => 
                    !a.action.startsWith("GENERAL_") && 
                    !a.action.startsWith("LIST_") && 
                    !a.action.startsWith("GET_") && 
                    !a.action.startsWith("SWITCH_") && 
                    !a.action.startsWith("ACTION_CONFIRMATION_")
                ) : null;

                const performedSingleConcreteActionForButtons = lastConcreteAction && aiResponse.detected_actions.filter(a => 
                    !a.action.startsWith("GENERAL_") && 
                    !a.action.startsWith("LIST_") && 
                    !a.action.startsWith("GET_") && 
                    !a.action.startsWith("SWITCH_") && 
                    !a.action.startsWith("ACTION_CONFIRMATION_")
                ).length === 1;


                if (resourceForButtonsContext && performedSingleConcreteActionForButtons && !actionWasAnEdit && (!aiResponse.clarifications_needed || aiResponse.clarifications_needed.length === 0)) {
                    let buttons = [];
                    let buttonItemDesc = "item";
                    if (resourceForButtonsContext.description && typeof resourceForButtonsContext.description === 'string') {
                        buttonItemDesc = resourceForButtonsContext.description.length > 24 ? resourceForButtonsContext.description.substring(0, 21) + "..." : resourceForButtonsContext.description;
                    }
                    const buttonTitle = `Opções para "${buttonItemDesc}":`;
        
                    switch(resourceForButtonsContext.type) {
                        case 'transaction': buttons = [ { id: `edit_transaction_${resourceForButtonsContext.id}`, label: "Editar Transação ✍️" }, { id: `delete_transaction_${resourceForButtonsContext.id}`, label: "Excluir Transação 🗑️" }, ]; break;
                        case 'appointment': buttons = [ { id: `edit_appointment_${resourceForButtonsContext.id}`, label: "Editar Compromisso ✍️" }, { id: `delete_appointment_${resourceForButtonsContext.id}`, label: "Excluir Compromisso 🗑️" }, ]; break;
                        case 'credit_card': buttons = [ { id: `edit_credit_card_${resourceForButtonsContext.id}`, label: "Editar Cartão ✍️" }, { id: `delete_credit_card_${resourceForButtonsContext.id}`, label: "Excluir Cartão 🗑️" }, ]; break;
                        case 'recurring_rule': buttons = [ { id: `edit_recurring_rule_${resourceForButtonsContext.id}`, label: "Editar Recorrência ✍️" }, { id: `delete_recurring_rule_${resourceForButtonsContext.id}`, label: "Excluir Recorrência 🗑️" }, ]; break;
                        case 'product': buttons = [ { id: `edit_product_${resourceForButtonsContext.id}`, label: "Editar Produto ✍️" }, { id: `delete_product_${resourceForButtonsContext.id}`, label: "Excluir Produto 🗑️" }, ]; break;
                        case 'parcelled_account': buttons = [ { id: `edit_parcelled_account_${resourceForButtonsContext.id}`, label: "Alterar Compra Parcelada ✍️" }, { id: `delete_parcelled_account_${resourceForButtonsContext.id}`, label: "Excluir Compra Parcelada 🗑️" }, ]; break;
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
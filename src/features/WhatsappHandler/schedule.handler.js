// src/features/WhatsappHandler/schedule.handler.js
const logger = require('../../utils/logger');
const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const availabilityService = require('../Availability/availability.service');
const onboardingAIService = require('./onboarding.ai.service');

// ============================================================================
// FUNÇÕES DE MENSAGEM (Templates de Resposta)
// ============================================================================

function askForWorkDays(clientName) {
    const message = `Entendido, ${clientName}! Vamos redefinir seu horário de trabalho. 🗓️\n\nPrimeiro, me diga em quais dias da semana você trabalha:`;
    const buttons = [
        { id: 'schedule_days_seg_sex', label: 'Segunda a Sexta' },
        { id: 'schedule_days_seg_sab', label: 'Segunda a Sábado' },
        { id: 'schedule_days_todos', label: 'Todos os dias' },
        { id: 'schedule_days_outro', label: 'Outro (descrever)' }
    ];
    return { message, buttons };
}

function askForCustomSchedule(clientName) {
    return { message: `Ok, ${clientName}! Por favor, descreva seus dias e horários de trabalho.\n\n*Exemplo:* "trabalho somente às terças e quintas, das 10h até as 20h"` };
}

function askForWorkTimes(clientName) {
    return { message: `Perfeito! 👍 Agora, qual é o seu horário de trabalho nesses dias?\n\nMe diga a hora que você começa e a hora que termina. Por exemplo:\n\n*"das 9h às 18h"*` };
}

// ============================================================================
// HANDLER PRINCIPAL (Máquina de Estados)
// ============================================================================

/**
 * Lida com o fluxo de conversação para criação/atualização de regras de disponibilidade (horário de trabalho).
 * 
 * @param {object} state - O estado atual da conversa do usuário.
 * @param {string} messageText - O texto da mensagem recebida (ou ID do botão).
 * @param {object} actorClient - O objeto do cliente que está interagindo.
 * @returns {Promise<object>} Um objeto com o estado atualizado.
 */
async function handleScheduleUpdate(state, messageText, actorClient) {
    const lowerMessageText = (messageText || "").toLowerCase().trim();
    const clientNameForMessages = state.clientName;
    const effectiveAccountId = state.activeFinancialAccountId;

    // Mapeamento de texto para RRULE (para flexibilidade no input)
    const daysMap = {
        'schedule_days_seg_sex': 'MO,TU,WE,TH,FR',
        'segunda a sexta': 'MO,TU,WE,TH,FR',
        'schedule_days_seg_sab': 'MO,TU,WE,TH,FR,SA',
        'segunda a sábado': 'MO,TU,WE,TH,FR,SA',
        'schedule_days_todos': 'SU,MO,TU,WE,TH,FR,SA',
        'todos os dias': 'SU,MO,TU,WE,TH,FR,SA',
    };

    switch (state.currentAction) {
        case 'awaiting_schedule_days': {
            
            let daysRule = daysMap[lowerMessageText];
            let shouldProceedToTimes = false;
            let failureMessage = "Não consegui entender sua resposta. 😥"; // Mensagem de falha padrão

            if (daysRule) {
                // Caso 1: Clicou ou digitou o texto exato do botão (já mapeado)
                state.data.tempWorkDays = daysRule;
                shouldProceedToTimes = true;
            } else if (lowerMessageText === 'schedule_days_outro' || lowerMessageText === 'outro (descrever)' || lowerMessageText === 'outro') { 
                // Caso 2: Clicou/digitou 'Outro'
                const { message } = askForCustomSchedule(clientNameForMessages);
                state.currentAction = 'awaiting_schedule_custom';
                await sendWhatsappMessage(actorClient.phone, message);
                return { updatedState: state }; 

            } else {
                // Caso 3: Resposta de texto livre (TENTA INTERPRETAR COM A IA)
                const scheduleInfo = await onboardingAIService.interpretWorkSchedule(messageText);

                if (scheduleInfo && scheduleInfo.rruleDays) {
                    // A IA conseguiu extrair os dias!
                    state.data.tempWorkDays = scheduleInfo.rruleDays;
                    shouldProceedToTimes = true;
                    
                    if (scheduleInfo.startTime && scheduleInfo.endTime) {
                         // Caso ultra-flexível: dias e horários na primeira mensagem
                         const ruleData = {
                            title: 'Horário de Trabalho',
                            type: 'work',
                            startTime: scheduleInfo.startTime,
                            endTime: scheduleInfo.endTime,
                            rrule: `FREQ=WEEKLY;BYDAY=${state.data.tempWorkDays}`
                        };
                        await availabilityService.createDefaultWorkRule(effectiveAccountId, ruleData);
                        await sendWhatsappMessage(actorClient.phone, `✅ *Super Flexível!* Consegui pegar os dias (*${scheduleInfo.rruleDays.replace(/,/g, ', ')}*) e o horário (*${scheduleInfo.startTime} às ${scheduleInfo.endTime}*) na sua primeira mensagem e já atualizei seu horário de trabalho! Mandou bem! 😉`);
                        state.currentAction = null;
                        delete state.data.tempWorkDays;
                        return { updatedState: state }; 
                    }
                } else {
                    // Caso 4: Falha na interpretação (DIGITOU ALGO NÃO ESPERADO)
                    // REGRA DE REPETIÇÃO: REENVIAR PERGUNTA ORIGINAL E MENU
                    const { message, buttons } = askForWorkDays(clientNameForMessages);
                    await sendWhatsappMessage(actorClient.phone, `❌ ${failureMessage} Por favor, escolha uma das opções abaixo:`); 
                    await sendButtonListMessage(actorClient.phone, message, buttons, 'Dias de Trabalho');
                    return { updatedState: state }; // Permanece no estágio atual
                }
            }

            if (shouldProceedToTimes) {
                // Transição para o próximo estágio
                const { message } = askForWorkTimes(clientNameForMessages);
                state.currentAction = 'awaiting_schedule_times';
                await sendWhatsappMessage(actorClient.phone, message);
            }
            break;
        }

        case 'awaiting_schedule_times': {
            const scheduleInfo = await onboardingAIService.interpretWorkSchedule(lowerMessageText);
            if (scheduleInfo && scheduleInfo.startTime && scheduleInfo.endTime) {
                const ruleData = {
                    title: 'Horário de Trabalho',
                    type: 'work',
                    startTime: scheduleInfo.startTime,
                    endTime: scheduleInfo.endTime,
                    rrule: `FREQ=WEEKLY;BYDAY=${state.data.tempWorkDays}`
                };
                await availabilityService.createDefaultWorkRule(effectiveAccountId, ruleData);
                await sendWhatsappMessage(actorClient.phone, `✅ Horário atualizado com sucesso! Sua agenda agora reflete sua nova disponibilidade.`);
                state.currentAction = null;
                delete state.data.tempWorkDays;
            } else {
                 // FALHA: REENVIA A PERGUNTA ORIGINAL
                const { message } = askForWorkTimes(clientNameForMessages);
                await sendWhatsappMessage(actorClient.phone, `❌ Não consegui entender o formato do horário. Por favor, tente algo como *"das 8h às 17h30"* ou *"das 10h às 19h"*.`);
                await sendWhatsappMessage(actorClient.phone, message); // Reenvia a pergunta original
            }
            break;
        }

        case 'awaiting_schedule_custom': {
            const scheduleInfo = await onboardingAIService.interpretWorkSchedule(lowerMessageText);
            if (scheduleInfo && scheduleInfo.startTime && scheduleInfo.endTime && scheduleInfo.rruleDays) {
                const ruleData = {
                    title: 'Horário de Trabalho',
                    type: 'work',
                    startTime: scheduleInfo.startTime,
                    endTime: scheduleInfo.endTime,
                    rrule: `FREQ=WEEKLY;BYDAY=${scheduleInfo.rruleDays}`
                };
                await availabilityService.createDefaultWorkRule(effectiveAccountId, ruleData);
                await sendWhatsappMessage(actorClient.phone, `✅ Horário personalizado atualizado com sucesso!`);
                state.currentAction = null;
            } else {
                 // FALHA: REENVIA A PERGUNTA ORIGINAL
                const { message } = askForCustomSchedule(clientNameForMessages);
                await sendWhatsappMessage(actorClient.phone, `❌ Não consegui entender perfeitamente. 🤔 Por favor, tente ser mais completo, dizendo os *dias e os horários* na mesma frase.`);
                await sendWhatsappMessage(actorClient.phone, message); // Reenvia a pergunta original
            }
            break;
        }

        default:
             // Estágio inicial (caso a ação de entrada do fluxo tenha sido perdida ou seja o início)
             const { message, buttons } = askForWorkDays(clientNameForMessages);
             state.currentAction = 'awaiting_schedule_days';
             await sendButtonListMessage(actorClient.phone, message, buttons, 'Dias de Trabalho');
             break;
    }
    
    return { updatedState: state };
}

module.exports = { handleScheduleUpdate };
// src/features/WhatsappHandler/schedule.handler.js
const logger = require('../../utils/logger');
const { sendWhatsappMessage, sendButtonListMessage } = require('../../services/whatsappService');
const availabilityService = require('../Availability/availability.service');
const onboardingAIService = require('./onboarding.ai.service');

// Funções de Mensagem
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

// Handler Principal
async function handleScheduleUpdate(state, messageText, actorClient) {
    const lowerMessageText = (messageText || "").toLowerCase().trim();
    const clientNameForMessages = state.clientName;
    const effectiveAccountId = state.activeFinancialAccountId;

    switch (state.currentAction) {
        case 'awaiting_schedule_days': {
            const daysMap = {
                'schedule_days_seg_sex': 'MO,TU,WE,TH,FR',
                'schedule_days_seg_sab': 'MO,TU,WE,TH,FR,SA',
                'schedule_days_todos': 'SU,MO,TU,WE,TH,FR,SA',
            };

            if (daysMap[lowerMessageText]) {
                state.data.tempWorkDays = daysMap[lowerMessageText];
                const { message } = askForWorkTimes(clientNameForMessages);
                state.currentAction = 'awaiting_schedule_times';
                await sendWhatsappMessage(actorClient.phone, message);
            } else if (lowerMessageText === 'schedule_days_outro') {
                const { message } = askForCustomSchedule(clientNameForMessages);
                state.currentAction = 'awaiting_schedule_custom';
                await sendWhatsappMessage(actorClient.phone, message);
            } else {
                const { message, buttons } = askForWorkDays(clientNameForMessages);
                await sendButtonListMessage(actorClient.phone, message, buttons, 'Dias de Trabalho');
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
                await availabilityService.createAvailabilityRule(effectiveAccountId, ruleData);
                await sendWhatsappMessage(actorClient.phone, `✅ Horário atualizado com sucesso! Sua agenda agora reflete sua nova disponibilidade.`);
                state.currentAction = null;
                delete state.data.tempWorkDays;
            } else {
                const { message } = askForWorkTimes(clientNameForMessages);
                await sendWhatsappMessage(actorClient.phone, message + "\n\n(Não entendi o formato, tente novamente, por favor)");
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
                await availabilityService.createAvailabilityRule(effectiveAccountId, ruleData);
                await sendWhatsappMessage(actorClient.phone, `✅ Horário personalizado atualizado com sucesso!`);
                state.currentAction = null;
            } else {
                const { message } = askForCustomSchedule(clientNameForMessages);
                await sendWhatsappMessage(actorClient.phone, `Não consegui entender completamente. ${message}`);
            }
            break;
        }

        default:
             const { message, buttons } = askForWorkDays(clientNameForMessages);
             state.currentAction = 'awaiting_schedule_days';
             await sendButtonListMessage(actorClient.phone, message, buttons, 'Dias de Trabalho');
             break;
    }
    
    return { updatedState: state };
}

module.exports = { handleScheduleUpdate };
// src/features/PublicBooking/publicBooking.service.js
const { FinancialAccount, Service, Appointment } = require('../../database'); // <<< Adicionado Appointment
const serviceService = require('../Service/service.service');
const availabilityService = require('../Availability/availability.service');
const businessClientService = require('../BusinessClient/BusinessClient.service');
const appointmentService = require('../Appointment/appointment.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

async function getProviderPublicInfo(financialAccountId) { /* ...código sem alteração... */ }
async function calculateTotalDuration(financialAccountId, serviceIds = []) { /* ...código sem alteração... */ }

/**
 * Gera e verifica os slots de horário disponíveis para uma data e serviços específicos.
 */
async function getAvailableTimeSlots(financialAccountId, date, serviceIds = []) {
  // 1. Obter todas as regras e agendamentos do dia de uma vez
  const [rules, appointmentsOnThisDay] = await Promise.all([
    availabilityService.getAllAvailabilityRules(financialAccountId),
    Appointment.findAll({
      where: {
        financialAccountId,
        status: { [Op.in]: ['Scheduled', 'Confirmed'] },
        eventDateTime: {
          [Op.between]: [`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`],
        },
      },
    })
  ]);

  const workRule = rules.find(r => r.type === 'work');
  if (!workRule || !workRule.startTime || !workRule.endTime) {
    logger.warn(`[PublicBooking] Nenhuma regra de trabalho encontrada para FA ID ${financialAccountId}.`);
    return [];
  }

  const totalDuration = await calculateTotalDuration(financialAccountId, serviceIds);
  if (totalDuration <= 0) {
    throw new Error("A duração dos serviços deve ser maior que zero.");
  }

  // 2. Criar uma lista de intervalos de tempo JÁ OCUPADOS
  const busySlots = appointmentsOnThisDay.map(appt => {
    const start = new Date(appt.eventDateTime);
    const end = new Date(start.getTime() + (appt.durationMinutes || 30) * 60 * 1000);
    return { start, end };
  });

  // Adicionar pausas (breaks) à lista de horários ocupados
  const breakRule = rules.find(r => r.type === 'break');
  if (breakRule && breakRule.startTime && breakRule.endTime) {
    const [breakStartHour, breakStartMinute] = breakRule.startTime.split(':').map(Number);
    const [breakEndHour, breakEndMinute] = breakRule.endTime.split(':').map(Number);
    
    const breakStart = new Date(`${date}T00:00:00.000Z`);
    breakStart.setUTCHours(breakStartHour, breakStartMinute);
    
    const breakEnd = new Date(`${date}T00:00:00.000Z`);
    breakEnd.setUTCHours(breakEndHour, breakEndMinute);

    busySlots.push({ start: breakStart, end: breakEnd });
  }

  // 3. Gerar slots potenciais e verificar contra a lista de ocupados
  const availableSlots = [];
  const slotInterval = workRule.slotIntervalMinutes || 15;

  const [startHour, startMinute] = workRule.startTime.split(':').map(Number);
  const [endHour, endMinute] = workRule.endTime.split(':').map(Number);

  let currentTime = new Date(`${date}T00:00:00.000Z`);
  currentTime.setUTCHours(startHour, startMinute);

  const endTime = new Date(`${date}T00:00:00.000Z`);
  endTime.setUTCHours(endHour, endMinute);

  while (new Date(currentTime.getTime() + totalDuration * 60 * 1000) <= endTime) {
    const slotStart = new Date(currentTime);
    const slotEnd = new Date(slotStart.getTime() + totalDuration * 60 * 1000);

    // Verifica se o slot proposto colide com algum slot ocupado
    const hasConflict = busySlots.some(busy => 
      slotStart.getTime() < busy.end.getTime() && slotEnd.getTime() > busy.start.getTime()
    );

    if (!hasConflict) {
      availableSlots.push(slotStart.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }));
    }

    currentTime = new Date(currentTime.getTime() + slotInterval * 60 * 1000);
  }

  logger.info(`[PublicBooking] Retornando ${availableSlots.length} slots disponíveis para ${date}.`);
  return availableSlots;
}


async function createPublicBooking(financialAccountId, bookingData) {
  const { clientDetails, serviceIds, eventDateTime } = bookingData;

  if (!clientDetails || !clientDetails.name || !clientDetails.email || !serviceIds || serviceIds.length === 0 || !eventDateTime) {
    const error = new Error('Dados insuficientes para o agendamento. Detalhes do cliente, serviços e horário são obrigatórios.');
    error.statusCode = 400;
    throw error;
  }
  
  const totalDuration = await calculateTotalDuration(financialAccountId, serviceIds);
  
  // A revalidação agora é mais simples e direta
  const availableSlots = await getAvailableTimeSlots(financialAccountId, dayjs(eventDateTime).format('YYYY-MM-DD'), serviceIds);
  const selectedSlotTime = dayjs(eventDateTime).utc().format('HH:mm');

  if (!availableSlots.includes(selectedSlotTime)) {
    const error = new Error('Este horário foi agendado por outra pessoa enquanto você preenchia os dados. Por favor, escolha outro horário.');
    error.statusCode = 409;
    throw error;
  }

  let businessClient;
  try {
    const existingClients = await businessClientService.getAllBusinessClients(financialAccountId, { search: clientDetails.email, limit: 1 });
    if (existingClients.businessClients.length > 0) {
        businessClient = existingClients.businessClients[0];
    } else {
        businessClient = await businessClientService.createBusinessClient(financialAccountId, clientDetails);
    }
  } catch (error) {
      if (error.statusCode === 409) {
        const existingClients = await businessClientService.getAllBusinessClients(financialAccountId, { search: clientDetails.name, limit: 1 });
        businessClient = existingClients.businessClients[0];
      } else {
          throw error;
      }
  }

  const services = await Service.findAll({ where: { id: { [Op.in]: serviceIds }, financialAccountId } });
  const appointmentTitle = services.map(s => s.name).join(' + ');

  const appointmentData = {
    title: appointmentTitle,
    eventDateTime,
    durationMinutes: totalDuration,
    status: 'Scheduled',
    businessClientIds: [businessClient.id],
    serviceIds,
    origin: 'public_booking',
  };

  const newAppointment = await appointmentService.scheduleAppointment(financialAccountId, appointmentData);

  return newAppointment;
}

module.exports = {
  getProviderPublicInfo,
  getAvailableTimeSlots,
  createPublicBooking,
};
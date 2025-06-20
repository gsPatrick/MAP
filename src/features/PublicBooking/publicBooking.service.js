// src/features/PublicBooking/publicBooking.service.js
const { FinancialAccount, Service } = require('../../database');
const serviceService = require('../Service/service.service');
const availabilityService = require('../Availability/availability.service');
const businessClientService = require('../BusinessClient/BusinessClient.service');
const appointmentService = require('../Appointment/appointment.service');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

/**
 * Busca informações públicas e seguras de um prestador de serviço para a página de agendamento.
 */
async function getProviderPublicInfo(financialAccountId) {
  const account = await FinancialAccount.findOne({
    where: { id: financialAccountId, isActive: true, accountType: { [Op.in]: ['PJ', 'MEI'] } },
    attributes: ['id', 'accountName'],
  });

  if (!account) {
    const error = new Error('Página de agendamento não encontrada ou indisponível.');
    error.statusCode = 404;
    throw error;
  }

  const { services } = await serviceService.getAllServices(financialAccountId, { isActive: true, limit: 100 });

  return {
    providerName: account.accountName,
    services: services.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      price: s.price,
      durationMinutes: s.durationMinutes,
    })),
  };
}

/**
 * Calcula a duração total em minutos a partir de uma lista de IDs de serviço.
 */
async function calculateTotalDuration(financialAccountId, serviceIds = []) {
    if (serviceIds.length === 0) return 0;
    const services = await Service.findAll({
        where: { id: { [Op.in]: serviceIds }, financialAccountId, isActive: true },
        attributes: ['durationMinutes'],
    });
    if(services.length !== serviceIds.length){
        throw new Error("Um ou mais serviços selecionados são inválidos ou inativos.");
    }
    return services.reduce((total, service) => total + service.durationMinutes, 0);
}


/**
 * Gera e verifica os slots de horário disponíveis para uma data e serviços específicos.
 */
async function getAvailableTimeSlots(financialAccountId, date, serviceIds = []) {
  const rules = await availabilityService.getAllAvailabilityRules(financialAccountId);
  const workRule = rules.find(r => r.type === 'work');
  if (!workRule || !workRule.startTime || !workRule.endTime) {
    logger.warn(`[PublicBooking] Nenhum horário de trabalho (work rule) encontrado para FA ID ${financialAccountId}. Retornando zero slots.`);
    return [];
  }
  
  const totalDuration = await calculateTotalDuration(financialAccountId, serviceIds);
  if (totalDuration === 0) {
      throw new Error("A duração total dos serviços selecionados é zero. Não é possível encontrar horários.");
  }
  
  const potentialSlots = [];
  const slotInterval = workRule.slotIntervalMinutes || 15;

  // <<< MUDANÇA PRINCIPAL AQUI: Trabalhar com datas locais do servidor >>>
  const [startHour, startMinute] = workRule.startTime.split(':').map(Number);
  const [endHour, endMinute] = workRule.endTime.split(':').map(Number);

  let currentTime = new Date(date);
  currentTime.setHours(startHour, startMinute, 0, 0);

  const endTime = new Date(date);
  endTime.setHours(endHour, endMinute, 0, 0);

  logger.info(`[PublicBooking] Gerando slots para ${date} entre ${workRule.startTime} e ${workRule.endTime} com duração de ${totalDuration}min.`);

  while (new Date(currentTime.getTime() + totalDuration * 60 * 1000) <= endTime) {
      potentialSlots.push(new Date(currentTime));
      currentTime = new Date(currentTime.getTime() + slotInterval * 60 * 1000);
  }

  logger.info(`[PublicBooking] ${potentialSlots.length} slots gerados inicialmente. Verificando disponibilidade real...`);

  const availabilityChecks = potentialSlots.map(slot => 
    availabilityService.isTimeSlotAvailable(financialAccountId, slot, totalDuration)
  );

  const results = await Promise.all(availabilityChecks);
  
  const finalSlots = potentialSlots
    .filter((_, index) => results[index])
    .map(slot => slot.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));

  logger.info(`[PublicBooking] ${finalSlots.length} slots verificados como disponíveis.`);
  return finalSlots;
}


/**
 * Orquestra a criação de um agendamento a partir de dados públicos.
 */
async function createPublicBooking(financialAccountId, bookingData) {
  const { clientDetails, serviceIds, eventDateTime } = bookingData;

  if (!clientDetails || !clientDetails.name || !clientDetails.email || !serviceIds || serviceIds.length === 0 || !eventDateTime) {
    const error = new Error('Dados insuficientes para o agendamento. Detalhes do cliente, serviços e horário são obrigatórios.');
    error.statusCode = 400;
    throw error;
  }
  
  // 1. Re-valida a disponibilidade do slot para evitar agendamentos duplos
  const totalDuration = await calculateTotalDuration(financialAccountId, serviceIds);
  const isStillAvailable = await availabilityService.isTimeSlotAvailable(financialAccountId, eventDateTime, totalDuration);
  if (!isStillAvailable) {
    const error = new Error('Este horário foi agendado por outra pessoa enquanto você preenchia os dados. Por favor, escolha outro horário.');
    error.statusCode = 409; // Conflict
    throw error;
  }

  // 2. Cria ou encontra o BusinessClient
  let businessClient;
  try {
    const existingClients = await businessClientService.getAllBusinessClients(financialAccountId, { search: clientDetails.email, limit: 1 });
    if (existingClients.businessClients.length > 0) {
        businessClient = existingClients.businessClients[0];
        logger.info(`BusinessClient existente encontrado (ID: ${businessClient.id}) para o agendamento.`);
    } else {
        businessClient = await businessClientService.createBusinessClient(financialAccountId, clientDetails);
        logger.info(`Novo BusinessClient criado (ID: ${businessClient.id}) para o agendamento.`);
    }
  } catch (error) {
      if (error.statusCode === 409) {
        const existingClients = await businessClientService.getAllBusinessClients(financialAccountId, { search: clientDetails.name, limit: 1 });
        businessClient = existingClients.businessClients[0];
      } else {
          throw error;
      }
  }

  // 3. Prepara e cria o agendamento
  const services = await Service.findAll({ where: { id: { [Op.in]: serviceIds }, financialAccountId } });
  const appointmentTitle = services.map(s => s.name).join(' + ');

  const appointmentData = {
    title: appointmentTitle,
    eventDateTime,
    durationMinutes: totalDuration,
    status: 'Scheduled',
    businessClientIds: [businessClient.id],
    serviceIds,
    origin: 'public_booking', // Define a origem correta
  };

  const newAppointment = await appointmentService.scheduleAppointment(financialAccountId, appointmentData);

  return newAppointment;
}



module.exports = {
  getProviderPublicInfo,
  getAvailableTimeSlots,
  createPublicBooking,
};
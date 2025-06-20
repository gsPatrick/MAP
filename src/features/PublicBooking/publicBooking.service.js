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
    logger.warn(`[PublicBooking] Nenhum horário de trabalho (work rule) encontrado para FA ID ${financialAccountId}.`);
    return [];
  }
  
  const totalDuration = await calculateTotalDuration(financialAccountId, serviceIds);
  if (totalDuration <= 0) {
      throw new Error("A duração dos serviços deve ser maior que zero.");
  }
  
  const potentialSlots = [];
  const slotInterval = workRule.slotIntervalMinutes || 15;

  const [startHour, startMinute] = workRule.startTime.split(':').map(Number);
  const [endHour, endMinute] = workRule.endTime.split(':').map(Number);

  // <<< MUDANÇA: Trabalhar com datas UTC para consistência >>>
  let currentTime = new Date(`${date}T00:00:00.000Z`);
  currentTime.setUTCHours(startHour, startMinute);

  const endTime = new Date(`${date}T00:00:00.000Z`);
  endTime.setUTCHours(endHour, endMinute);

  while (new Date(currentTime.getTime() + totalDuration * 60 * 1000) <= endTime) {
      potentialSlots.push(new Date(currentTime));
      currentTime = new Date(currentTime.getTime() + slotInterval * 60 * 1000);
  }

  logger.info(`[PublicBooking] ${potentialSlots.length} slots potenciais gerados. Verificando disponibilidade...`);

  // <<< MUDANÇA PRINCIPAL AQUI >>>
  // 1. Mapeia cada slot para uma promessa de verificação de disponibilidade.
  const availabilityChecks = potentialSlots.map(slotStart => {
    const slotEnd = new Date(slotStart.getTime() + totalDuration * 60 * 1000);
    // Passa os objetos Date puros para a verificação
    return availabilityService.isTimeSlotAvailable(financialAccountId, slotStart, slotEnd);
  });

  // 2. Espera todas as verificações terminarem.
  const results = await Promise.all(availabilityChecks);
  
  // 3. Filtra os slots originais (objetos Date) com base nos resultados.
  const finalSlots = potentialSlots
    .filter((_, index) => results[index]) // Mantém apenas os que retornaram 'true'
    .map(slot => slot.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })); // Formata para o frontend SÓ NO FINAL

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

  // <<< MUDANÇA PRINCIPAL AQUI >>>
  // Constrói os objetos Date corretos antes de chamar a função
  const desiredStart = new Date(eventDateTime);
  const desiredEnd = new Date(desiredStart.getTime() + totalDuration * 60 * 1000);
  
  // Chama a função com os parâmetros corretos (Date, Date)
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
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
  // <<< MUDANÇA: Lógica de geração de slots aprimorada
  const rules = await availabilityService.getAllAvailabilityRules(financialAccountId);
  const workRule = rules.find(r => r.type === 'work');
  if (!workRule || !workRule.startTime || !workRule.endTime) {
    logger.warn(`[PublicBooking] Nenhum horário de trabalho (work rule) encontrado para FA ID ${financialAccountId}. Retornando zero slots.`);
    return []; // Se não há horário de trabalho, não há slots.
  }
  
  const totalDuration = await calculateTotalDuration(financialAccountId, serviceIds);
  if (totalDuration === 0) {
      throw new Error("A duração total dos serviços selecionados é zero. Não é possível encontrar horários.");
  }
  
  const availableSlots = [];
  const slotInterval = 15; // Gera slots a cada 15 minutos para dar mais opções

  // Converte os horários para objetos Date no fuso horário correto (UTC para consistência)
  let currentTime = new Date(`${date}T${workRule.startTime}Z`);
  const endTime = new Date(`${date}T${workRule.endTime}Z`);

  logger.info(`[PublicBooking] Gerando slots para ${date} entre ${workRule.startTime} e ${workRule.endTime} com duração de ${totalDuration}min.`);

  while (new Date(currentTime.getTime() + totalDuration * 60 * 1000) <= endTime) {
      // Adiciona o slot ao array
      availableSlots.push(currentTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }));
      
      // Incrementa o tempo pelo intervalo definido
      currentTime = new Date(currentTime.getTime() + slotInterval * 60 * 1000);
  }

  logger.info(`[PublicBooking] ${availableSlots.length} slots gerados inicialmente. Verificando disponibilidade...`);

  // Filtra os slots que não são realmente disponíveis usando a função já existente
  const verifiedSlotsPromises = availableSlots.map(async (slot) => {
    const [hour, minute] = slot.split(':');
    const startDateTime = new Date(date);
    startDateTime.setUTCHours(parseInt(hour, 10), parseInt(minute, 10), 0, 0);

    const isAvailable = await availabilityService.isTimeSlotAvailable(financialAccountId, startDateTime, totalDuration);
    return isAvailable ? slot : null;
  });

  const resolvedSlots = await Promise.all(verifiedSlotsPromises);
  const finalSlots = resolvedSlots.filter(Boolean); // Remove os nulos

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
    // Tenta encontrar por email ou telefone para evitar duplicatas
    const existingClients = await businessClientService.getAllBusinessClients(financialAccountId, { search: clientDetails.email, limit: 1 });
    if (existingClients.businessClients.length > 0) {
        businessClient = existingClients.businessClients[0];
        logger.info(`BusinessClient existente encontrado (ID: ${businessClient.id}) para o agendamento.`);
    } else {
        businessClient = await businessClientService.createBusinessClient(financialAccountId, clientDetails);
        logger.info(`Novo BusinessClient criado (ID: ${businessClient.id}) para o agendamento.`);
    }
  } catch (error) {
      if (error.statusCode === 409) { // Se já existe por nome/telefone
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
    status: 'Scheduled', // Sempre começa como agendado, para o PJ confirmar
    businessClientIds: [businessClient.id],
    serviceIds,
  };

  const newAppointment = await appointmentService.scheduleAppointment(financialAccountId, appointmentData);

  return newAppointment;
}

module.exports = {
  getProviderPublicInfo,
  getAvailableTimeSlots,
  createPublicBooking,
};
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
/**
 * Verifica se um determinado slot de tempo está disponível para agendamento.
 * @param {number} financialAccountId - O ID da conta a ser verificada.
 * @param {Date|string} startDateTime - O início do horário desejado.
 * @param {number} durationMinutes - A duração do agendamento em minutos.
 * @returns {Promise<boolean>} True se o horário estiver livre, false caso contrário.
 */
async function isTimeSlotAvailable(financialAccountId, startDateTime, durationMinutes) {
  // <<< MUDANÇA PRINCIPAL AQUI >>>
  const desiredStart = new Date(startDateTime);
  const desiredEnd = new Date(desiredStart.getTime() + durationMinutes * 60 * 1000);
  
  // 1. Verificar colisão com agendamentos existentes (sem alteração)
  const existingAppointment = await Appointment.findOne({
    where: {
      financialAccountId,
      status: { [Op.in]: ['Scheduled', 'Confirmed'] },
      eventDateTime: { [Op.lt]: desiredEnd, [Op.gt]: new Date(desiredStart.getTime() - (24 * 60 * 60 * 1000)) },
    },
  });

  if (existingAppointment) {
    const existingStart = new Date(existingAppointment.eventDateTime);
    const existingEnd = new Date(existingStart.getTime() + (existingAppointment.durationMinutes || 60) * 60 * 1000);
    if (desiredStart < existingEnd && desiredEnd > existingStart) {
      logger.warn(`[Availability] Conflito de horário para FA ${financialAccountId}: Slot desejado ${desiredStart.toISOString()} colide com agendamento existente ID ${existingAppointment.id}.`);
      return false;
    }
  }

  // 2. Obter todas as regras de disponibilidade
  const rules = await AvailabilityRule.findAll({ where: { financialAccountId } });
  const workRule = rules.find(r => r.type === 'work');
  const breakRules = rules.filter(r => r.type === 'break');
  const dayOffRules = rules.filter(r => r.type === 'day_off');

  // 3. Verificar se é um dia de folga específico
  const desiredDateString = desiredStart.toISOString().split('T')[0];
  if (dayOffRules.some(rule => rule.specificDate === desiredDateString)) {
    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredDateString} é um dia de folga.`);
    return false;
  }

  // 4. Verificar se o dia da semana e o horário estão dentro da jornada de trabalho
  if (!workRule || !workRule.rrule || !workRule.startTime || !workRule.endTime) {
    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: Nenhuma regra de trabalho (work rule) válida encontrada.`);
    return false; // Se não há regra de trabalho, nada está disponível
  }

  try {
    const rule = rrulestr(workRule.rrule);
    const startOfDay = new Date(desiredStart.toISOString().split('T')[0] + 'T00:00:00.000Z');
    const endOfDay = new Date(desiredStart.toISOString().split('T')[0] + 'T23:59:59.999Z');
    
    // Verifica se o dia desejado é uma ocorrência da regra de trabalho
    const occurrences = rule.between(startOfDay, endOfDay);
    if (occurrences.length === 0) {
      logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: O dia ${desiredDateString} não é um dia de trabalho segundo a RRULE.`);
      return false; // Não é um dia de trabalho
    }

    // Compara apenas as horas e minutos, ignorando a data
    const workStart = new Date(`1970-01-01T${workRule.startTime}Z`);
    const workEnd = new Date(`1970-01-01T${workRule.endTime}Z`);
    const desiredStartTime = new Date(`1970-01-01T${desiredStart.toISOString().split('T')[1]}`);
    const desiredEndTime = new Date(`1970-01-01T${desiredEnd.toISOString().split('T')[1]}`);

    if (desiredStartTime < workStart || desiredEndTime > workEnd) {
      logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredStart.toISOString()} está fora do expediente (${workRule.startTime}-${workRule.endTime}).`);
      return false; // Fora do horário de expediente
    }

    // 5. Verificar se colide com um intervalo (break)
    for (const breakRule of breakRules) {
        if (breakRule.rrule) {
            const breakOccurrences = rrulestr(breakRule.rrule).between(startOfDay, endOfDay);
            if (breakOccurrences.length > 0) {
                const breakStart = new Date(`1970-01-01T${breakRule.startTime}Z`);
                const breakEnd = new Date(`1970-01-01T${breakRule.endTime}Z`);
                // Verifica sobreposição de horários
                if (desiredStartTime < breakEnd && desiredEndTime > breakStart) {
                    logger.warn(`[Availability] Slot recusado para FA ${financialAccountId}: ${desiredStart.toISOString()} colide com um intervalo.`);
                    return false;
                }
            }
        }
    }

  } catch (e) {
    logger.error(`[Availability] Erro ao processar RRULE para FA ${financialAccountId}: ${e.message}`);
    return false; // Se a regra for inválida, considera indisponível por segurança
  }

  logger.info(`[Availability] Slot disponível para FA ${financialAccountId} em ${desiredStart.toISOString()}.`);
  return true;
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
  
  const totalDuration = await calculateTotalDuration(financialAccountId, serviceIds);
  const isStillAvailable = await availabilityService.isTimeSlotAvailable(financialAccountId, eventDateTime, totalDuration);
  if (!isStillAvailable) {
    const error = new Error('Este horário foi agendado por outra pessoa enquanto você preenchia os dados. Por favor, escolha outro horário.');
    error.statusCode = 409; // Conflict
    throw error;
  }

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

  const services = await Service.findAll({ where: { id: { [Op.in]: serviceIds }, financialAccountId } });
  const appointmentTitle = services.map(s => s.name).join(' + ');

  const appointmentData = {
    title: appointmentTitle,
    eventDateTime,
    durationMinutes: totalDuration,
    status: 'Scheduled',
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
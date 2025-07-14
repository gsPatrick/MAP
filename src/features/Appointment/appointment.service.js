// src/features/Appointment/appointment.service.js
const { Appointment, FinancialAccount, Client, UserPreference, BusinessClient, AppointmentBusinessClient, Service, AppointmentService, AvailabilityRule, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const googleCalendarService = require('../../features/GoogleCalendar/googleCalendarService'); 
const businessClientService = require('../BusinessClient/BusinessClient.service');
const financialService = require('../Financial/financial.service'); // Adicionado
const { sendWhatsappMessage } = require('../../services/whatsappService'); // Adicionado
const formatter = require('../WhatsappHandler/response.formatter'); // Adicionado
const aiModelService = require('../../services/aiModelService');
const { RRule } = require('rrule'); 


const BUSINESS_CLIENT_INCLUDE_ATTRIBUTES = ['id', 'name', 'phone', 'email', 'photoUrl', 'notes'];
const SERVICE_INCLUDE_ATTRIBUTES = ['id', 'name', 'price', 'durationMinutes', 'description'];

async function validateOwningFinancialAccount(financialAccountId, transaction = null, includeClient = true) {
  const includeOptions = [];
  if (includeClient) includeOptions.push({ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone', 'isGoogleCalendarSynced'] });

  const account = await FinancialAccount.findByPk(financialAccountId, {
    include: includeOptions,
    transaction
  });
  if (!account) {
    const error = new Error(`Conta Financeira com ID ${financialAccountId} não encontrada.`);
    error.statusCode = 404; error.status = 'fail'; throw error;
  }
  if (!account.isActive) {
    const error = new Error(`A Conta Financeira ID ${financialAccountId} ("${account.accountName}") está inativa.`);
    error.statusCode = 403; error.status = 'fail'; throw error;
  }
  return account;
}

async function scheduleAppointment(financialAccountId, appointmentData) {
  const t = await sequelize.transaction();
  let newAppointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true);

    if (!appointmentData.title || !appointmentData.eventDateTime) {
      const error = new Error('Título e Data/Hora do Evento são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    // --- Lógica de Bifurcação PF vs PJ/MEI ---
    if (account.accountType === 'PF') {
        // Lógica para contas PF
        if (appointmentData.reminderEnabled !== false && appointmentData.reminderLeadTimeMinutes === undefined) {
            const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
            appointmentData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
        } else if (appointmentData.reminderEnabled === false) {
            appointmentData.reminderLeadTimeMinutes = null;
            appointmentData.reminderSentTimestamp = null;
        }
        appointmentData.origin = appointmentData.origin || 'system_pf';
    } else { // Lógica para PJ ou MEI
        appointmentData.origin = appointmentData.origin || 'system_pj_mei';
        
        // Zera campos de lembrete do sistema antigo
        appointmentData.reminderEnabled = false;
        appointmentData.reminderLeadTimeMinutes = null;
        appointmentData.reminderSentTimestamp = null;
        
        // Validação de Clientes de Negócio (BusinessClient)
        // Agendamentos PJ/MEI devem ter ao menos um BusinessClient
        const businessClientIds = appointmentData.businessClientIds;
        if (!businessClientIds || !Array.isArray(businessClientIds) || businessClientIds.length === 0) {
            const error = new Error('Para agendamentos de contas PJ/MEI, pelo menos um cliente deve ser associado.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        const validClients = await BusinessClient.findAll({
            where: { id: { [Op.in]: businessClientIds }, financialAccountId, isActive: true },
            transaction: t
        });
        if (validClients.length !== businessClientIds.length) {
            const missingIds = businessClientIds.filter(id => !validClients.some(client => client.id === id));
            const error = new Error(`Um ou mais Clientes de Negócio (IDs: ${missingIds.join(', ')}) não foram encontrados ou não pertencem a esta conta.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        // Validação de Serviços
        const serviceIds = appointmentData.serviceIds;
        let validServices = [];

        // Correção aqui: serviceIds só são obrigatórios se fornecidos OU se a origem for 'public_booking'
        // 'system_pj_mei' (modais) pode ou não ter servicesIds.
        if (serviceIds && Array.isArray(serviceIds) && serviceIds.length > 0) {
            validServices = await Service.findAll({
                where: { id: { [Op.in]: serviceIds }, financialAccountId, isActive: true },
                transaction: t
            });
            if (validServices.length !== serviceIds.length) {
                const missingIds = serviceIds.filter(id => !validServices.some(service => service.id === id));
                const error = new Error(`Um ou mais Serviços (IDs: ${missingIds.join(', ')}) não foram encontrados, estão inativos ou não pertencem a esta conta.`);
                error.statusCode = 404; error.status = 'fail'; throw error;
            }
        } else if (appointmentData.origin === 'public_booking') {
            // Para agendamentos de origem pública, serviços são sempre obrigatórios
            const error = new Error('Para agendamentos via página pública, pelo menos um serviço deve ser associado.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        // Se serviceIds não for fornecido e a origem não for 'public_booking', não há erro aqui.
        // Isso permite agendamentos PJ/MEI genéricos (sem serviço específico).

        // Garante que a duração seja calculada e salva
        // Se a duração não foi passada no payload, tenta calcular a partir dos serviços.
        // Se ainda for 0 (nenhum serviço ou serviços sem duração), define um padrão.
        if (!appointmentData.durationMinutes) {
          const totalDuration = validServices.reduce((sum, service) => sum + service.durationMinutes, 0);
          appointmentData.durationMinutes = totalDuration > 0 ? totalDuration : 30; // Fallback de 30 min se a soma for 0
        }
    }

    newAppointment = await Appointment.create(
      { ...appointmentData, financialAccountId },
      { transaction: t }
    );

    // Criação de associações para PJ/MEI
    if (account.accountType !== 'PF') {
        if (appointmentData.businessClientIds && appointmentData.businessClientIds.length > 0) {
            const clientAssociations = appointmentData.businessClientIds.map(bcId => ({
                appointmentId: newAppointment.id, businessClientId: bcId
            }));
            await AppointmentBusinessClient.bulkCreate(clientAssociations, { transaction: t });
        }
        
        // Só cria associação com serviços se houver serviceIds no payload
        if (appointmentData.serviceIds && appointmentData.serviceIds.length > 0) {
            const servicesToAssociate = await Service.findAll({
                where: { id: { [Op.in]: appointmentData.serviceIds }, financialAccountId },
                attributes: ['id', 'price'],
                transaction: t
            });

            const serviceAssociations = servicesToAssociate.map(service => ({
                appointmentId: newAppointment.id,
                serviceId: service.id,
                priceAtTimeOfBooking: service.price,
                quantity: 1
            }));

            await AppointmentService.bulkCreate(serviceAssociations, { transaction: t });
        }
    }

    await t.commit(); 
    logger.info(`Compromisso "${newAppointment.title}" (ID: ${newAppointment.id}) agendado para FA ID ${financialAccountId}.`);

    // --- Notificação e Sincronização (pós-commit) ---
    const reloadedApptForSync = await Appointment.findByPk(newAppointment.id, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
            { model: Service, as: 'services', through: { attributes: [] }, attributes: SERVICE_INCLUDE_ATTRIBUTES }
        ]
    });

    if (!reloadedApptForSync) {
        logger.error(`Falha ao recarregar o compromisso ID ${newAppointment.id} após a criação.`);
        throw new Error('Falha ao recarregar compromisso para notificações.');
    }

    // Notificação para o dono da conta PJ/MEI
    // Só envia se for uma conta PJ/MEI e o ownerClient tiver telefone
    if (account.accountType !== 'PF' && account.ownerClient?.phone) {
        const ownerClient = account.ownerClient;
        const ownerName = ownerClient.name ? ownerClient.name.split(' ')[0] : 'Você';
        
        // Passo 1: Gerar a introdução criativa com a IA
        const creativeIntro = await aiModelService.generateNewBookingNotification(ownerName, reloadedApptForSync.toJSON());

        // Passo 2: Formatar os detalhes do agendamento
        const formattedDetails = formatter.formatAppointmentDataStructure(reloadedApptForSync.toJSON(), false, null, true);

        // Passo 3: Montar a mensagem final
        const notificationMessage = `${creativeIntro}\n\n` +
                                    `${formattedDetails}\n\n` +
                                    `Para aceitar e confirmar com o cliente, responda: *"confirmar agendamento ${reloadedApptForSync.id}"*.`;
        
        await sendWhatsappMessage(ownerClient.phone, notificationMessage);
    }

    // Sincronização com Google Calendar
    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced) {
        const googleEvent = await googleCalendarService.createGoogleEvent(account.ownerClient.id, reloadedApptForSync.toJSON());
        if (googleEvent && googleEvent.id) {
            // Atualiza o agendamento local com os IDs do Google Event para referência futura
            await newAppointment.update({ googleEventId: googleEvent.id, googleEventLastUpdated: new Date(googleEvent.updated || googleEvent.created) });
            logger.info(`Compromisso ID ${newAppointment.id} sincronizado com Google Calendar Event ID ${googleEvent.id}.`);
        }
    }

    return reloadedApptForSync.toJSON(); // Retorna o agendamento completo e recarregado

  } catch (error) {
    // Em caso de erro, desfaz a transação para garantir a atomicidade
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbError) { logger.error("Erro no rollback após falha em scheduleAppointment:", rbError); }
    }
    logger.error(`Erro ao agendar compromisso para FA ID ${financialAccountId}: ${error.message}`, { error, appointmentData });
    // Se o erro não tiver um statusCode definido, define 500 como padrão
    if (!error.statusCode) error.statusCode = 500;
    throw error; // Propaga o erro
  }
}

async function getAllAppointments(financialAccountId, queryParams = {}) {
  try {
    // Valida se a conta financeira existe e pertence ao usuário
    await validateOwningFinancialAccount(financialAccountId, null, false);
    const {
      page = 1, limit = 10, dateStart, dateEnd, specificDate,
      status, search,
      sortBy = 'eventDateTime', sortOrder = 'ASC'
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };
    const includeOptions = [
        { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES, required: false },
        { model: Service, as: 'services', through: { attributes: [] }, attributes: SERVICE_INCLUDE_ATTRIBUTES, required: false }
    ];

    if (status) whereConditions.status = status;
    if (specificDate) {
        // Busca agendamentos em um dia específico (ignora hora)
        whereConditions.eventDateTime = {
            [Op.gte]: `${specificDate}T00:00:00.000Z`,
            [Op.lt]: new Date(new Date(specificDate).setDate(new Date(specificDate).getDate() + 1)).toISOString().split('T')[0] + 'T00:00:00.000Z'
        };
    } else {
        // Busca agendamentos em um intervalo de datas
        if (dateStart) whereConditions.eventDateTime = { ...whereConditions.eventDateTime, [Op.gte]: new Date(dateStart) };
        if (dateEnd) {
            const endDateObj = new Date(dateEnd);
            endDateObj.setUTCHours(23, 59, 59, 999); // Garante que inclui o dia inteiro
            whereConditions.eventDateTime = { ...whereConditions.eventDateTime, [Op.lte]: endDateObj };
        }
    }
    if (search) {
      // Busca por termos no título, descrição ou localização
      whereConditions[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
        { location: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];

    const { count, rows } = await Appointment.findAndCountAll({
      where: whereConditions,
      include: includeOptions,
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
      distinct: true, // Garante que não haja duplicatas em caso de joins complexos
    });

    logger.info(`Listados ${rows.length} compromissos para FA ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      appointments: rows.map(a => a.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar compromissos para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAppointmentById(financialAccountId, appointmentId) {
  try {
    await validateOwningFinancialAccount(financialAccountId, null, true);
    const appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [
         { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
         { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
         { model: Service, as: 'services', through: { attributes: [] }, attributes: SERVICE_INCLUDE_ATTRIBUTES }
      ]
    });

    if (!appointment) {
      logger.warn(`Compromisso ID ${appointmentId} não encontrado ou não pertence à FA ID ${financialAccountId}.`);
      return null;
    }
    return appointment.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar compromisso ID ${appointmentId} para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateAppointment(financialAccountId, appointmentId, updateData) {
  const t = await sequelize.transaction();
  let appointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true);
    appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      // Inclui associações para poder manipular (ex: remover/adicionar businessClients)
      include: [
          { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
          { model: BusinessClient, as: 'businessClients', through: { attributes: [] } },
          { model: Service, as: 'services', through: { attributes: [] } }
      ],
      transaction: t
    });
    if (!appointment) {
      await t.rollback();
      const err404 = new Error(`Compromisso ID ${appointmentId} não encontrado.`);
      err404.statusCode = 404; err404.status = 'fail'; throw err404; // Correção no nome da variável de erro
    }
    
    // Lógica de atualização para PJ/MEI (se o tipo da conta não for PF)
    if (account.accountType !== 'PF') {
        // Se businessClientIds foi fornecido no updateData, atualiza as associações
        if (updateData.hasOwnProperty('businessClientIds') && Array.isArray(updateData.businessClientIds)) {
            const businessClientIds = updateData.businessClientIds;
            if (businessClientIds.length > 0) {
                 const validClients = await BusinessClient.findAll({
                     where: { id: { [Op.in]: businessClientIds }, financialAccountId, isActive: true }, transaction: t
                 });
                 if (validClients.length !== businessClientIds.length) {
                     const missingIds = businessClientIds.filter(id => !validClients.some(client => client.id === id));
                     const error = new Error(`Um ou mais Clientes de Negócio (IDs: ${missingIds.join(', ')}) não pertencem a esta conta.`);
                     error.statusCode = 404; error.status = 'fail'; throw error;
                 }
            }
            // Remove todas as associações existentes e cria as novas
            await AppointmentBusinessClient.destroy({ where: { appointmentId: appointment.id }, transaction: t });
            if (businessClientIds.length > 0) {
                 const associations = businessClientIds.map(bcId => ({ appointmentId: appointment.id, businessClientId: bcId }));
                 await AppointmentBusinessClient.bulkCreate(associations, { transaction: t });
            }
            delete updateData.businessClientIds; // Remove do updateData para não tentar atualizar campo inexistente na tabela Appointment
        }
        // Se serviceIds foi fornecido no updateData, atualiza as associações de serviço
        if (updateData.hasOwnProperty('serviceIds') && Array.isArray(updateData.serviceIds)) {
             const serviceIds = updateData.serviceIds;
             // Agendamentos PJ/MEI devem ter pelo menos um serviço se servicesIds for fornecido e for um agendamento baseado em serviço.
             if (serviceIds.length === 0) throw new Error("Agendamentos PJ/MEI devem ter pelo menos um serviço se a lista de serviços for fornecida explicitamente.");
             const validServices = await Service.findAll({
                where: { id: { [Op.in]: serviceIds }, financialAccountId, isActive: true }, transaction: t
             });
             if (validServices.length !== serviceIds.length) {
                const missingIds = serviceIds.filter(id => !validServices.some(s => s.id === id));
                const error = new Error(`Um ou mais Serviços (IDs: ${missingIds.join(', ')}) não pertencem a esta conta.`);
                error.statusCode = 404; error.status = 'fail'; throw error;
             }
             // Remove todas as associações existentes e cria as novas
             await AppointmentService.destroy({ where: { appointmentId: appointment.id }, transaction: t });
             const associations = serviceIds.map(sId => ({ appointmentId: appointment.id, serviceId: sId }));
             await AppointmentService.bulkCreate(associations, { transaction: t });
             delete updateData.serviceIds; // Remove do updateData
        }
    } else { // Lógica de atualização para PF (se o tipo da conta for PF)
        // Lógica para lidar com a ativação/desativação de lembretes
        if (updateData.reminderEnabled === false) {
            updateData.reminderLeadTimeMinutes = null;
            updateData.reminderSentTimestamp = null;
        } else if (updateData.reminderEnabled === true && updateData.reminderLeadTimeMinutes === undefined && appointment.reminderLeadTimeMinutes === null) {
            // Se ativou lembrete mas não definiu minutos e não tinha antes, usa o padrão das preferências
            const preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
            updateData.reminderLeadTimeMinutes = (preferences?.defaultAppointmentReminderLeadTimeMinutes) || 60;
        } else if (updateData.hasOwnProperty('reminderLeadTimeMinutes') && updateData.reminderLeadTimeMinutes !== null) {
            updateData.reminderEnabled = true; // Se definiu minutos, ativa o lembrete
        }
    }

    delete updateData.financialAccountId; // Impede que o financialAccountId seja alterado por esta rota

    const hasOtherUpdates = Object.keys(updateData).length > 0;
    if(hasOtherUpdates){
        await appointment.update(updateData, { transaction: t });
    }
    
    await t.commit(); // Confirma a transação
    logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") atualizado para FA ID ${financialAccountId}.`);

    // Recarrega o agendamento completo para sincronização e retorno
    const updatedAppointmentFull = await appointment.reload({
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
            { model: Service, as: 'services', through: { attributes: [] }, attributes: SERVICE_INCLUDE_ATTRIBUTES }
        ]
    });

    // Sincronização com Google Calendar (se o cliente tiver sincronização ativa)
    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced) {
        const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, appointment.googleEventId, updatedAppointmentFull.toJSON());
        if (googleEvent && googleEvent.id) {
            // Atualiza o timestamp da última sincronização no registro local
            const apptInstanceToUpdateGoogleFields = await Appointment.findByPk(appointment.id);
            if (apptInstanceToUpdateGoogleFields) {
                await apptInstanceToUpdateGoogleFields.update({ googleEventId: googleEvent.id, googleEventLastUpdated: new Date(googleEvent.updated) });
            }
            logger.info(`Compromisso ID ${appointmentId} atualizado e sincronizado com Google Calendar Event ID ${googleEvent.id}.`);
        }
    }
    return updatedAppointmentFull.toJSON(); // Retorna o objeto atualizado
  } catch (error) {
    // Desfaz a transação em caso de erro
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbError) { logger.error("Erro no rollback após falha em updateAppointment:", rbError); }
    }
    logger.error(`Erro ao atualizar compromisso ID ${appointmentId}: ${error.message}`, { errorJson: JSON.stringify(error, Object.getOwnPropertyNames(error)), updateDataSent: updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteOrCancelAppointment(financialAccountId, appointmentId, actuallyDelete = false) {
  const t = await sequelize.transaction();
  let appointment = null;
  try {
    const account = await validateOwningFinancialAccount(financialAccountId, t, true);
    appointment = await Appointment.findOne({
      where: { id: appointmentId, financialAccountId },
      include: [ { model: BusinessClient, as: 'businessClients' } ], // Inclui para notificação
      transaction: t
    });
    if (!appointment) {
      await t.rollback();
      logger.warn(`Compromisso ID ${appointmentId} não encontrado para ${actuallyDelete ? 'exclusão' : 'cancelamento'} na FA ID ${financialAccountId}.`);
      return false;
    }

    const googleEventIdToDelete = appointment.googleEventId; // Guarda o ID do Google antes de deletar/cancelar

    if (actuallyDelete) {
      await appointment.destroy({ transaction: t }); // Deleta o registro do banco de dados
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") EXCLUÍDO da FA ID ${financialAccountId}.`);
    } else {
      await appointment.update({ status: 'Cancelled' }, { transaction: t }); // Apenas muda o status para 'Cancelled'
      logger.info(`Compromisso ID ${appointmentId} ("${appointment.title}") CANCELADO na FA ID ${financialAccountId}.`);
    }
    await t.commit(); // Confirma a transação
    
    // Recarrega o agendamento após a operação para ter os dados mais recentes para notificação
    const reloadedApptForNotify = await Appointment.findByPk(appointmentId, {
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient' }] },
            { model: BusinessClient, as: 'businessClients', attributes: ['name', 'phone'] }
        ]
    });

    // Notificação para o BusinessClient em caso de cancelamento (apenas para contas PJ/MEI)
    if (!actuallyDelete && reloadedApptForNotify && account.accountType !== 'PF' && reloadedApptForNotify.businessClients.length > 0) {
        for (const bClient of reloadedApptForNotify.businessClients) {
            if (bClient.phone) {
                const providerName = reloadedApptForNotify.financialAccount.accountName || reloadedApptForNotify.financialAccount.ownerClient.name;

                // Gerar a mensagem de cancelamento com a IA
                const cancellationMessage = await aiModelService.generateClientCancellationMessage(providerName, bClient.name, reloadedApptForNotify.toJSON());

                const finalMessage = `${cancellationMessage}\n\n` +
                                     `---\n` +
                                     `Mensagem de *${providerName}* via MAP no Controle.`;

                await sendWhatsappMessage(bClient.phone, finalMessage);
            }
        }
    }

    // Sincronização com Google Calendar
    if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced && googleEventIdToDelete) {
        if (actuallyDelete) {
            await googleCalendarService.deleteGoogleEvent(account.ownerClient.id, googleEventIdToDelete);
        } else {
            // Se apenas cancelou, atualiza o evento no Google para refletir o status
            if(reloadedApptForNotify) {
                const googleEvent = await googleCalendarService.updateGoogleEvent(account.ownerClient.id, googleEventIdToDelete, reloadedApptForNotify.toJSON());
                 if (googleEvent && googleEvent.id) {
                    await Appointment.update({ googleEventLastUpdated: new Date(googleEvent.updated) }, { where: { id: appointmentId } });
                }
            }
        }
    }
    return true;
  } catch (error) {
    // Desfaz a transação em caso de erro
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbError) { logger.error("Erro no rollback após falha em deleteOrCancelAppointment:", rbError); }
    }
    logger.error(`Erro ao ${actuallyDelete ? 'excluir' : 'cancelar'} compromisso ID ${appointmentId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

// --- Funções do Ciclo de Vida do Agendamento PJ/MEI ---

async function confirmAppointment(financialAccountId, appointmentId) {
    const t = await sequelize.transaction();
    try {
        const account = await validateOwningFinancialAccount(financialAccountId, t, true);
        if (account.accountType === 'PF') {
            throw { statusCode: 400, message: 'A confirmação de agendamentos é uma funcionalidade para contas PJ/MEI.' };
        }
        const appointment = await Appointment.findOne({ where: { id: appointmentId, financialAccountId }, transaction: t });
        if (!appointment) {
            throw { statusCode: 404, message: `Agendamento ID ${appointmentId} não encontrado.` };
        }
        if (appointment.status !== 'Scheduled') {
            throw { statusCode: 409, message: `Este agendamento não está no estado 'Agendado' e não pode ser confirmado. Status atual: ${appointment.status}` };
        }

        await appointment.update({ status: 'Confirmed' }, { transaction: t });
        await t.commit(); // Confirma a transação

        // Recarrega o agendamento completo após a confirmação para notificação e sincronização
        const confirmedAppointment = await getAppointmentById(financialAccountId, appointmentId);
        if (!confirmedAppointment) {
            logger.error(`Falha ao recarregar o agendamento ${appointmentId} após confirmação.`);
            return null; // Não retorna se não conseguir recarregar
        }

        // Notificar BusinessClient
        if (confirmedAppointment.businessClients && confirmedAppointment.businessClients.length > 0) {
            for (const bClient of confirmedAppointment.businessClients) {
                if (bClient.phone) {
                    const providerName = account.accountName || account.ownerClient.name;
                    
                    // Passo 1: Gerar a mensagem criativa com a IA
                    const creativeMessage = await aiModelService.generateClientConfirmationMessage(providerName, bClient.name, confirmedAppointment);

                    // Passo 2: Formatar os detalhes
                    const formattedDetails = formatter.formatAppointmentDataStructure(confirmedAppointment);
                    
                    // Passo 3: Montar a mensagem final com a "assinatura"
                    const finalMessage = `${creativeMessage}\n\n${formattedDetails}\n\n` +
                                         `---\n` +
                                         `Esta é uma mensagem automática do sistema MAP no Controle em nome de *${providerName}*.`;

                    await sendWhatsappMessage(bClient.phone, finalMessage);
                }
            }
        }
        
        // Sincronizar com Google
        if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced && confirmedAppointment.googleEventId) {
             await googleCalendarService.updateGoogleEvent(account.ownerClient.id, confirmedAppointment.googleEventId, confirmedAppointment);
        }

        return confirmedAppointment; // Retorna o agendamento confirmado
    } catch(error) {
        if (t && !t.finished) await t.rollback(); // Desfaz a transação em caso de erro
        logger.error(`Erro ao confirmar agendamento ${appointmentId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function completeAppointment(financialAccountId, appointmentId) {
    const t = await sequelize.transaction();
    try {
        const account = await validateOwningFinancialAccount(financialAccountId, t, true);
        if (account.accountType === 'PF') {
            throw { statusCode: 400, message: 'A conclusão de agendamentos é uma funcionalidade para contas PJ/MEI.' };
        }
        const appointment = await Appointment.findOne({ 
            where: { id: appointmentId, financialAccountId },
            include: [ { model: Service, as: 'services' }, { model: BusinessClient, as: 'businessClients' } ], // Inclui serviços e clientes
            transaction: t 
        });

        if (!appointment) {
            throw { statusCode: 404, message: `Agendamento ID ${appointmentId} não encontrado.` };
        }
        // Agendamento só pode ser concluído se estiver Confirmado ou Agendado (Scheduled)
        if (appointment.status !== 'Confirmed' && appointment.status !== 'Scheduled') {
            throw { statusCode: 409, message: `Este agendamento não pode ser concluído. Status atual: ${appointment.status}` };
        }
        // Para concluir um agendamento com serviços, deve haver serviços associados para gerar a transação
        if (!appointment.services || appointment.services.length === 0) {
            throw { statusCode: 400, message: 'Não é possível concluir o agendamento pois não há serviços associados para gerar a transação financeira.' };
        }
        
        // Criação da Transação Financeira (Entrada) baseada nos serviços do agendamento
        const totalValue = appointment.services.reduce((sum, service) => sum + parseFloat(service.price), 0);
        const serviceNames = appointment.services.map(s => s.name).join(', ');
        const clientName = appointment.businessClients.length > 0 ? appointment.businessClients[0].name : 'Cliente';
        const transactionDescription = `Serviço: ${serviceNames} para ${clientName}`;

        await financialService.createTransaction(financialAccountId, {
            description: transactionDescription,
            type: 'Entrada',
            value: totalValue,
            transactionDate: new Date().toISOString().split('T')[0], // Data da conclusão
            isPayableOrReceivable: false, // Não é uma conta a receber
            isPaidOrReceived: true, // Já foi recebida/concluída
        }, { transaction: t });

        await appointment.update({ status: 'Completed' }, { transaction: t }); // Atualiza status do agendamento
        await t.commit(); // Confirma a transação

        // Recarrega o agendamento completo após a conclusão
        const completedAppointment = await getAppointmentById(financialAccountId, appointmentId);
        
        // Sincronizar com Google
        if (account.ownerClient && account.ownerClient.isGoogleCalendarSynced && completedAppointment.googleEventId) {
             await googleCalendarService.updateGoogleEvent(account.ownerClient.id, completedAppointment.googleEventId, completedAppointment);
        }

        return completedAppointment; // Retorna o agendamento concluído
    } catch (error) {
        if (t && !t.finished) await t.rollback(); // Desfaz a transação em caso de erro
        logger.error(`Erro ao completar agendamento ${appointmentId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

// --- Funções de Lembrete para Contas PF (Sistema Antigo/Simples) ---

async function getPFAppointmentsNeedingReminder(forFinancialAccountId = null) {
  try {
    const now = new Date();
    const whereConditions = {
      status: { [Op.in]: ['Scheduled', 'Confirmed'] },
      reminderEnabled: true, // Lembrete ativado
      reminderSentTimestamp: null, // Ainda não enviado
      eventDateTime: { [Op.gt]: now }, // Data do evento no futuro
      origin: 'system_pf', // Apenas compromissos originados do sistema PF
    };

    if (forFinancialAccountId !== null) {
        whereConditions.financialAccountId = forFinancialAccountId;
    }

    const appointments = await Appointment.findAll({
      where: whereConditions,
      include: [
        { model: FinancialAccount, as: 'financialAccount', attributes: ['id', 'accountName', 'accountType'], include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }] },
        // BusinessClient incluído como 'false' para evitar erro se não existir na query PJ, embora aqui seja PF
        { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES, required: false }
      ],
      order: [['eventDateTime', 'ASC']],
    });

    // Filtra os que realmente precisam de lembrete agora com base no leadTimeMinutes
    const needingReminder = appointments.filter(app => {
      const leadTime = app.reminderLeadTimeMinutes || 0;
      const reminderTime = new Date(new Date(app.eventDateTime).getTime() - (leadTime * 60000));
      return reminderTime <= now;
    });

    if (needingReminder.length > 0) {
      logger.info(`${needingReminder.length} compromissos de PF encontrados precisando de lembrete.`);
    }
    return needingReminder.map(app => app.toJSON());

  } catch (error) {
    logger.error('Erro ao buscar compromissos de PF para lembrete:', { error });
    return []; // Retorna array vazio em caso de erro
  }
}

async function markReminderAsSent(appointmentId) {
    try {
        const [updatedCount] = await Appointment.update( { reminderSentTimestamp: new Date() }, { where: { id: appointmentId } });
        if (updatedCount > 0) logger.info(`Lembrete (PF) para compromisso ID ${appointmentId} marcado como enviado.`);
        return updatedCount > 0;
    } catch (error) {
        logger.error(`Erro ao marcar lembrete (PF) como enviado para compromisso ID ${appointmentId}:`, { error });
        return false;
    }
}

// --- Funções de Lembrete para Contas PJ/MEI (Sistema Novo) ---

async function getPJAppointmentsNeeding24hReminder() {
    const now = new Date();
    // Limite de 24 horas a partir de agora
    const threshold = new Date(now.getTime() + 24 * 60 * 60 * 1000); 
    return Appointment.findAll({
        where: {
            status: 'Confirmed', // Apenas agendamentos confirmados
            origin: 'system_pj_mei', // Apenas compromissos PJ/MEI do sistema
            reminder24hSentAt: null, // Lembrete de 24h ainda não enviado
            eventDateTime: { [Op.lte]: threshold, [Op.gt]: now } // Evento entre agora e as próximas 24h
        },
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient' }] },
            { model: BusinessClient, as: 'businessClients', attributes: ['name', 'phone'], required: true } // Deve ter BusinessClient associado
        ]
    });
}

async function getPJAppointmentsNeeding30minReminder() {
    const now = new Date();
    // Limite de 30 minutos a partir de agora
    const threshold = new Date(now.getTime() + 30 * 60 * 1000); 
     return Appointment.findAll({
        where: {
            status: 'Confirmed', // Apenas agendamentos confirmados
            origin: 'system_pj_mei', // Apenas compromissos PJ/MEI do sistema
            reminder30minSentAt: null, // Lembrete de 30min ainda não enviado
            eventDateTime: { [Op.lte]: threshold, [Op.gt]: now } // Evento entre agora e os próximos 30min
        },
        include: [
            { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient' }] },
            { model: BusinessClient, as: 'businessClients', attributes: ['name', 'phone'], required: true }
        ]
    });
}

async function mark24hReminderAsSent(appointmentId) {
    return Appointment.update({ reminder24hSentAt: new Date() }, { where: { id: appointmentId } });
}

async function mark30minReminderAsSent(appointmentId) {
    return Appointment.update({ reminder30minSentAt: new Date() }, { where: { id: appointmentId } });
}

// Funções de Sincronização com Google Calendar

/**
 * Cria ou atualiza um agendamento no sistema com base em um evento do Google Calendar.
 * Lida com a complexidade de mapear IDs, tipos de conta e associações.
 * @param {object} googleEvent - O objeto do evento do Google Calendar.
 * @param {number} systemClientId - O ID do cliente proprietário no sistema.
 * @param {number} defaultFinancialAccountIdPF - O ID da conta PF padrão do cliente (para eventos sem tipo explícito).
 * @param {Array<object>} clientPjAccounts - Lista de contas PJ/MEI do cliente.
 * @returns {Promise<object|null>} O agendamento local (JSON) ou null se não for possível criar/atualizar.
 */
async function createOrUpdateAppointmentFromGoogle(googleEvent, systemClientId, defaultFinancialAccountIdPF, clientPjAccounts = []) {
  const t = await sequelize.transaction();
  try {
    if (!googleEvent || !googleEvent.id) {
      await t.rollback();
      logger.warn('[ApptServiceFromGoogle] Evento Google inválido ou sem ID fornecido.');
      return null;
    }

    const systemAppointmentIdFromGoogle = googleEvent.extendedProperties?.private?.systemAppointmentId;
    let appointmentLocal = null;
    let operation = 'updated'; // Assume atualização por padrão

    // Tenta encontrar o agendamento local pelo ID armazenado nas propriedades estendidas do Google Event
    if (systemAppointmentIdFromGoogle) {
      appointmentLocal = await Appointment.findOne({
        where: { id: parseInt(systemAppointmentIdFromGoogle, 10), '$financialAccount.clientId$': systemClientId },
        include: [
            { model: FinancialAccount, as: 'financialAccount', required: true },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] } }
        ],
        transaction: t,
      });
      if (!appointmentLocal) {
          logger.warn(`[ApptServiceFromGoogle] Appointment local ID ${systemAppointmentIdFromGoogle} (do evento Google ${googleEvent.id}) não encontrado para Cliente ${systemClientId}, apesar da prop. Será tratado como novo.`);
      }
    } else { // Se não tem systemAppointmentId, tenta encontrar pelo googleEventId (pode ser o caso de eventos criados no Google antes da sincronização ou quando a prop privada falha)
      appointmentLocal = await Appointment.findOne({
        where: { googleEventId: googleEvent.id, '$financialAccount.clientId$': systemClientId },
        include: [
            { model: FinancialAccount, as: 'financialAccount', required: true },
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] } }
        ],
        transaction: t,
      });
    }

    // Extrai e valida datas e duração do evento do Google
    const startDateTimeString = googleEvent.start?.dateTime || googleEvent.start?.date;
    const endDateTimeString = googleEvent.end?.dateTime || googleEvent.end?.date;

    if (!startDateTimeString) {
      await t.rollback();
      logger.warn(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} sem data/hora de início. Ignorando.`);
      return null;
    }
    const eventStartDateTime = new Date(startDateTimeString);
    let durationMinutes = null;

    if (endDateTimeString) {
        const eventEndDateTime = new Date(endDateTimeString);
        if (eventEndDateTime > eventStartDateTime) { // Garante que end é depois de start
            durationMinutes = Math.round((eventEndDateTime.getTime() - eventStartDateTime.getTime()) / 60000);
        }
    }

    // Mapeamento de status do Google para status interno
    let systemStatus = 'Scheduled'; // Default
    if (googleEvent.status === 'cancelled') {
        systemStatus = 'Cancelled';
    } else if (googleEvent.status === 'confirmed') {
        systemStatus = 'Confirmed';
    }
    // Verifica se o status "Completed" foi marcado via propriedade privada (se o sistema Google atualizou)
    if (googleEvent.extendedProperties?.private?.systemStatus === 'Completed') {
        systemStatus = 'Completed';
    }

    // Lógica para identificar o título e a conta financeira (PF/PJ/MEI) do agendamento
    let systemTitle = googleEvent.summary || 'Compromisso do Google';
    const pfPrefix = "[Pessoal] ";
    const pjMeiPrefixRegex = /^\[(PJ|MEI|[^\]]+)\]\s*/i; // Regex para "[Nome da Conta PJ/MEI]"

    let identifiedFinancialAccountId = appointmentLocal ? appointmentLocal.financialAccountId : null;
    let identifiedAccountType = appointmentLocal
        ? appointmentLocal.financialAccount.accountType
        : (googleEvent.extendedProperties?.private?.systemAccountType); // Tenta pegar o tipo da conta das propriedades privadas

    let googleEventNeedsCosmeticUpdate = false; // Flag para indicar se o evento Google precisa ser atualizado com as propriedades do sistema

    // 1. Tenta identificar FinancialAccount e Tipo pelas propriedades estendidas do Google Event se já sincronizado antes
    if (identifiedAccountType && !identifiedFinancialAccountId) {
        if (identifiedAccountType === 'PF') identifiedFinancialAccountId = defaultFinancialAccountIdPF;
        else if ((identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') && clientPjAccounts.length > 0) {
            const specificTypeAccounts = clientPjAccounts.filter(acc => acc.accountType === identifiedAccountType);
            if (specificTypeAccounts.length === 1) {
                identifiedFinancialAccountId = specificTypeAccounts[0].id;
            } else if (clientPjAccounts.length === 1 && (clientPjAccounts[0].accountType === 'PJ' || clientPjAccounts[0].accountType === 'MEI')) {
                identifiedFinancialAccountId = clientPjAccounts[0].id;
                identifiedAccountType = clientPjAccounts[0].accountType;
            }
        }
    }
    
    // 2. Tenta identificar/refinar a conta pelo prefixo no título do evento Google (ex: "[Pessoal] Aniversário")
    const currentGoogleSummary = googleEvent.summary || '';
    const pfPrefixLower = pfPrefix.toLowerCase();

    if (currentGoogleSummary.toLowerCase().startsWith(pfPrefixLower)) {
        systemTitle = currentGoogleSummary.substring(pfPrefix.length); // Remove o prefixo do título
        if (!identifiedAccountType) identifiedAccountType = 'PF';
        if (identifiedAccountType === 'PF' && !identifiedFinancialAccountId) identifiedFinancialAccountId = defaultFinancialAccountIdPF;
        // Se o título não tem o prefixo exatamente como esperado (case-sensitive), marca para atualização cosmética
        if (identifiedAccountType === 'PF' && !currentGoogleSummary.startsWith(pfPrefix)) googleEventNeedsCosmeticUpdate = true;
    } else {
      const pjMeiMatch = currentGoogleSummary.match(pjMeiPrefixRegex); // Tenta encontrar prefixo PJ/MEI
      if (pjMeiMatch) {
        const extractedNameOrType = pjMeiMatch[1]; // Ex: "Nome da Empresa", "PJ", "MEI"
        systemTitle = currentGoogleSummary.substring(pjMeiMatch[0].length); // Remove o prefixo

        if (!identifiedAccountType) { // Se o tipo ainda não foi identificado, tenta a partir do prefixo
            if (extractedNameOrType.toUpperCase() === 'PJ') identifiedAccountType = 'PJ';
            else if (extractedNameOrType.toUpperCase() === 'MEI') identifiedAccountType = 'MEI';
            else identifiedAccountType = 'PJ'; // Fallback para PJ se for um nome genérico no prefixo
        }

        if (identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') {
            if (!identifiedFinancialAccountId) { // Se a FA ainda não foi identificada, tenta encontrar
                const matchedPjAccountByName = clientPjAccounts.find(acc => acc.accountName.toLowerCase() === extractedNameOrType.toLowerCase());
                if (matchedPjAccountByName) { // Tenta por nome exato
                    identifiedFinancialAccountId = matchedPjAccountByName.id;
                    identifiedAccountType = matchedPjAccountByName.accountType;
                } else { // Se não encontrou por nome, tenta se houver apenas uma conta do tipo
                    const specificTypeAccounts = clientPjAccounts.filter(acc => acc.accountType === identifiedAccountType);
                    if (specificTypeAccounts.length === 1) {
                        identifiedFinancialAccountId = specificTypeAccounts[0].id;
                    } else if (clientPjAccounts.length === 1 && (clientPjAccounts[0].accountType === 'PJ' || clientPjAccounts[0].accountType === 'MEI')) {
                        identifiedFinancialAccountId = clientPjAccounts[0].id;
                        identifiedAccountType = clientPjAccounts[0].accountType;
                    }
                }
            }
            // Verifica se o prefixo no Google Event precisa ser atualizado para o nome real da conta
            if (identifiedFinancialAccountId) {
                const correctPjAccount = await FinancialAccount.findByPk(identifiedFinancialAccountId, {attributes: ['accountName'], transaction:t});
                if (correctPjAccount && !currentGoogleSummary.startsWith(`[${correctPjAccount.accountName}]`)) googleEventNeedsCosmeticUpdate = true;
            }
        }
      }
    }

    // 3. Tenta identificar pela cor do evento Google (se for um evento novo para o sistema)
    if (!appointmentLocal && !identifiedFinancialAccountId && googleEvent.colorId) {
        const clientFull = await Client.findByPk(systemClientId, { transaction: t });
        if (clientFull) {
            if (googleEvent.colorId === clientFull.googleCalendarColorIdPF) {
                identifiedFinancialAccountId = defaultFinancialAccountIdPF;
                if (!identifiedAccountType && defaultFinancialAccountIdPF) identifiedAccountType = 'PF';
                if (!currentGoogleSummary.startsWith(pfPrefix)) googleEventNeedsCosmeticUpdate = true;
            } else if (googleEvent.colorId === clientFull.googleCalendarColorIdPJ) {
                const pjOrMeiAccounts = clientPjAccounts.filter(acc => acc.accountType === 'PJ' || acc.accountType === 'MEI');
                if (pjOrMeiAccounts.length === 1) {
                     identifiedFinancialAccountId = pjOrMeiAccounts[0].id;
                     identifiedAccountType = pjOrMeiAccounts[0].accountType;
                     if (!currentGoogleSummary.startsWith(`[${pjOrMeiAccounts[0].accountName}]`)) googleEventNeedsCosmeticUpdate = true;
                } else if (pjOrMeiAccounts.length > 1) {
                    logger.warn(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} com cor PJ, mas cliente ${systemClientId} tem múltiplas contas PJ/MEI. Título é necessário para desambiguar.`);
                }
            }
        }
    }
    
    // 4. Se temos o ID da FA, mas não o tipo, buscamos o tipo da conta para garantir
    if (identifiedFinancialAccountId && !identifiedAccountType) {
        const faForType = await FinancialAccount.findByPk(identifiedFinancialAccountId, { attributes: ['accountType'], transaction: t });
        if (faForType) {
            identifiedAccountType = faForType.accountType;
        } else {
             await t.rollback();
             logger.error(`[ApptServiceFromGoogle] FinancialAccount ID ${identifiedFinancialAccountId} (deduzida) não encontrada no banco para evento ${googleEvent.id}. Abortando.`);
             return null;
        }
    }

    // Se, após toda a lógica, a FinancialAccount ainda não foi identificada, ignora o evento
    if (!identifiedFinancialAccountId) {
      await t.rollback();
      logger.warn(`[ApptServiceFromGoogle] Não foi possível determinar FinancialAccount para Google Event ID ${googleEvent.id} (Cliente ${systemClientId}). Título: "${currentGoogleSummary}", Cor: ${googleEvent.colorId}. Ignorando.`);
      return null;
    }

    // Limpa a descrição do Google Event de informações internas do sistema
    let systemDescription = googleEvent.description || '';
    systemDescription = systemDescription.replace(/\n\n--- Participantes do Negócio ---\n(- .+\n?)+/, '').trim();
    systemDescription = systemDescription.replace(/\n\n--- Observações Internas ---\n.*/, '').trim();
    systemDescription = systemDescription.replace(/\n\n--- Serviços Prestados ---.*/s, '').trim(); // Remove a seção de serviços também

    // Dados base para criação/atualização do agendamento local
    const appointmentData = {
      title: systemTitle.substring(0, 255), // Limita o tamanho do título
      description: systemDescription,
      eventDateTime: eventStartDateTime,
      durationMinutes: durationMinutes,
      location: googleEvent.location ? googleEvent.location.substring(0, 255) : null,
      status: systemStatus,
      financialAccountId: identifiedFinancialAccountId,
      googleEventId: googleEvent.id,
      googleEventLastUpdated: googleEvent.updated ? new Date(googleEvent.updated) : new Date(),
      origin: identifiedAccountType === 'PF' ? 'system_pf' : 'system_pj_mei', // Define a origem no sistema
    };

    let currentAssociatedBusinessClientIds = [];
    if (appointmentLocal && appointmentLocal.businessClients) {
        currentAssociatedBusinessClientIds = appointmentLocal.businessClients.map(bc => bc.id);
    }
    let newBusinessClientIdsToAssociate = [];

    // Lógica para associar BusinessClients com base nos "attendees" do Google Event (apenas para contas PJ/MEI)
    if ((identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI') && googleEvent.attendees && googleEvent.attendees.length > 0) {
        const ownerClientEmailDb = await Client.findByPk(systemClientId, {attributes:['email'], transaction:t});
        const ownerClientEmail = ownerClientEmailDb?.email?.toLowerCase();

        for (const attendee of googleEvent.attendees) {
            const attendeeEmailLower = attendee.email?.toLowerCase();
            // Ignora o organizador e participantes que recusaram, ou que são o próprio dono
            if (attendeeEmailLower && !attendee.organizer && attendee.responseStatus !== 'declined' && attendeeEmailLower !== ownerClientEmail) {
                let businessClient = await BusinessClient.findOne({
                    where: { email: attendeeEmailLower, financialAccountId: identifiedFinancialAccountId },
                    transaction: t
                });
                if (!businessClient) {
                    // Se o BusinessClient não existe, cria um novo
                    let nameForNewBC = attendee.displayName || attendeeEmailLower.split('@')[0];
                    nameForNewBC = nameForNewBC.trim().substring(0, 255); // Limita o tamanho
                    logger.info(`[ApptServiceFromGoogle] Attendee "${nameForNewBC}" não encontrado. Criando BusinessClient para FA ${identifiedFinancialAccountId}.`);
                    try {
                        businessClient = await businessClientService.createBusinessClient(
                            identifiedFinancialAccountId, { name: nameForNewBC, email: attendeeEmailLower }, { transaction: t }
                        );
                    } catch (createBcError) {
                        // Trata caso de concorrência onde o cliente pode ter sido criado por outra thread/requisição
                        if (createBcError.message.includes('Já existe um cliente com o email') || createBcError.message.includes('unique_business_client_email_per_account')) {
                             businessClient = await BusinessClient.findOne({ where: { email: attendeeEmailLower, financialAccountId: identifiedFinancialAccountId }, transaction: t });
                        } else {
                            logger.warn(`[ApptServiceFromGoogle] Impossível criar/encontrar BC para ${attendeeEmailLower}. Erro: ${createBcError.message}`);
                            continue; // Pula para o próximo attendee
                        }
                    }
                }
                if (businessClient) newBusinessClientIdsToAssociate.push(businessClient.id);
            }
        }
    }

    // Se o agendamento local já existe, atualiza-o; caso contrário, cria um novo
    if (appointmentLocal) {
        operation = 'updated';
        // Verifica se houve mudanças nos dados ou nos participantes para evitar atualizações desnecessárias
        const localLastSyncTime = appointmentLocal.googleEventLastUpdated ? new Date(appointmentLocal.googleEventLastUpdated).getTime() : 0;
        const googleUpdateTime = googleEvent.updated ? new Date(googleEvent.updated).getTime() : new Date().getTime();
        let dataFieldsChanged = googleUpdateTime > localLastSyncTime;

        const attendeesActuallyChanged = JSON.stringify(currentAssociatedBusinessClientIds.sort()) !== JSON.stringify(newBusinessClientIdsToAssociate.sort());
        if (!dataFieldsChanged && !attendeesActuallyChanged && !googleEventNeedsCosmeticUpdate) {
            await t.commit();
            logger.info(`[ApptServiceFromGoogle] Appointment local ID ${appointmentLocal.id} (Google ${googleEvent.id}) e participantes já atualizados.`);
            return appointmentLocal.toJSON();
        }
        if(dataFieldsChanged){
            await appointmentLocal.update(appointmentData, { transaction: t });
        }
    } else {
        operation = 'created';
        appointmentLocal = await Appointment.create(appointmentData, { transaction: t });
        googleEventNeedsCosmeticUpdate = true; // Novo evento sempre precisa de atualização cosmética no Google
    }

    // Atualiza as associações de BusinessClient (remove todas e recria)
    if (appointmentLocal && (identifiedAccountType === 'PJ' || identifiedAccountType === 'MEI')) {
        await AppointmentBusinessClient.destroy({ where: { appointmentId: appointmentLocal.id }, transaction: t });
        if (newBusinessClientIdsToAssociate.length > 0) {
            await AppointmentBusinessClient.bulkCreate(newBusinessClientIdsToAssociate.map(bcId => ({ appointmentId: appointmentLocal.id, businessClientId: bcId })), { transaction: t });
        }
    }

    // Atualiza o Google Event com propriedades estendidas (systemId, systemType, etc.) e cor
    if (googleEventNeedsCosmeticUpdate && appointmentLocal) {
        // Recarrega o agendamento para ter os dados mais recentes para mapear para o Google Event
        const reloadedApptForGoogleMap = await Appointment.findByPk(appointmentLocal.id, {
            include: [
                { model: FinancialAccount, as: 'financialAccount', include: [{ model: Client, as: 'ownerClient' }] },
                { model: BusinessClient, as: 'businessClients' },
                { model: Service, as: 'services' } // Inclui serviços para o mapeamento (se houver)
            ],
            transaction: t
        });
        if (reloadedApptForGoogleMap) {
            logger.info(`[ApptServiceFromGoogle] Appt ${appointmentLocal.id}. Evento Google ${googleEvent.id} precisa de atualização de props/cosmética.`);
            // Dispara a atualização do Google Event em segundo plano (não espera o resultado para não travar a transação)
            googleCalendarService.updateGoogleEvent(systemClientId, googleEvent.id, reloadedApptForGoogleMap.toJSON())
                .then(updatedGE => { if(updatedGE) logger.info(`[ApptServiceFromGoogle] Evento Google ${googleEvent.id} atualizado (cosmética/props) async.`);})
                .catch(err => logger.error(`[ApptServiceFromGoogle] Erro na atualização cosmética async do evento Google ${googleEvent.id}: ${err.message}`));
        }
    }

    await t.commit(); // Confirma a transação
    logger.info(`[ApptServiceFromGoogle] Appointment ${operation} (ID: ${appointmentLocal.id}) para Cliente ${systemClientId} a partir do Google Event ID ${googleEvent.id}.`);
    // Retorna o agendamento final recarregado para garantir todos os dados associados
    const finalReloadedAppt = await Appointment.findByPk(appointmentLocal.id, {
        include: [ 
            { model: FinancialAccount, as: 'financialAccount', include: [{model: Client, as: 'ownerClient'}] }, 
            { model: BusinessClient, as: 'businessClients', through: { attributes: [] }, attributes: BUSINESS_CLIENT_INCLUDE_ATTRIBUTES },
            { model: Service, as: 'services', through: { attributes: [] }, attributes: SERVICE_INCLUDE_ATTRIBUTES }
        ]
    });
    return finalReloadedAppt.toJSON();

  } catch (error) {
    // Em caso de erro, desfaz a transação
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') {
        try { await t.rollback(); } catch (rbErr) { logger.error(`[ApptServiceFromGoogle] Erro no rollback: ${rbErr.message}`); }
    }
    logger.error(`[ApptServiceFromGoogle] Erro ao criar/atualizar Appointment do Google Event ID ${googleEvent?.id} (Cliente ${systemClientId}): ${error.message}`, { stack: error.stack?.substring(0,700), googleEventSummary: googleEvent?.summary });
    return null;
  }
}

async function deleteOrCancelAppointmentByGoogleId(googleEventId, systemClientId) {
  const t = await sequelize.transaction();
  try {
    const appointmentLocal = await Appointment.findOne({
      where: { googleEventId: googleEventId, '$financialAccount.clientId$': systemClientId },
      include: [{ model: FinancialAccount, as: 'financialAccount', required: true }],
      transaction: t
    });
    if (!appointmentLocal) {
      await t.commit(); // Nada para deletar, sucesso.
      return true;
    }
    // Marca como cancelado e remove o vínculo com o Google Event
    await appointmentLocal.update({
        status: 'Cancelled',
        googleEventId: null, // Desvincula do Google Calendar
        googleEventLastUpdated: new Date() // Atualiza timestamp
    }, { transaction: t });
    await t.commit();
    return true;
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`[ApptServiceFromGoogleDelete] Erro ao cancelar/desvincular Appointment (Google ID ${googleEventId}): ${error.message}`);
    return false;
  }
}

/**
 * Agrega agendamentos e regras de disponibilidade para uma visualização de calendário.
 * @param {number} financialAccountId - O ID da conta financeira.
 * @param {string} startDate - Data de início do período (YYYY-MM-DD).
 * @param {string} endDate - Data de fim do período (YYYY-MM-DD).
 * @returns {Promise<Array>} Uma lista de eventos formatados para um calendário de frontend.
 */
async function getAgendaView(financialAccountId, startDate, endDate) {
  // Ajusta as datas para o início e fim do dia em UTC
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  const agendaEvents = [];

  // 1. Buscar Agendamentos no Período
  const appointments = await Appointment.findAll({
    where: {
      financialAccountId,
      status: { [Op.in]: ['Scheduled', 'Confirmed', 'Completed'] }, // Considera apenas esses status
      eventDateTime: {
        [Op.between]: [start, end], // Dentro do período
      },
    },
    include: [{
      model: BusinessClient,
      as: 'businessClients',
      attributes: ['name'], // Apenas o nome do cliente de negócio
      through: { attributes: [] } // Não retorna dados da tabela de junção
    }, { 
      model: Service,
      as: 'services',
      attributes: ['name'], // Apenas o nome do serviço
      through: { attributes: [] }
    }]
  });

  for (const appt of appointments) {
    // Calcula o horário de término do agendamento
    const apptEnd = new Date(new Date(appt.eventDateTime).getTime() + (appt.durationMinutes || 60) * 60000);
    let backgroundColor = '#3788d8'; // Azul padrão para 'Scheduled'/'Confirmed'
    let title = appt.title;

    // Constrói o título para exibição, priorizando o nome do cliente, depois do serviço, senão o título original
    if (appt.businessClients && appt.businessClients.length > 0) {
      title = `${appt.businessClients[0].name} - ${appt.title}`;
    } else if (appt.services && appt.services.length > 0) {
      // Caso não tenha cliente mas tenha serviço, usa o nome do serviço
      title = appt.services.map(s => s.name).join(' + ');
    }

    // Altera cor e adiciona emoji se o agendamento estiver 'Completed'
    if (appt.status === 'Completed') {
      backgroundColor = '#6c757d'; // Cinza para 'Completed'
      title = `✅ ${title}`;
    }

    agendaEvents.push({
      id: `appt_${appt.id}`, // ID único para o evento no calendário (ex: 'appt_123')
      type: 'appointment',
      appointmentId: appt.id, // ID original do agendamento no DB
      title,
      start: appt.eventDateTime, // Data e hora de início
      end: apptEnd.toISOString(), // Data e hora de fim
      status: appt.status,
      backgroundColor,
      borderColor: backgroundColor,
      description: appt.description, // Descrição completa para popover/detalhes
      businessClients: appt.businessClients, // Lista de clientes para popover/detalhes
      services: appt.services, // Lista de serviços para popover/detalhes
    });
  }

  // 2. Buscar Regras de Disponibilidade e gerar eventos de bloqueio (breaks, day_offs)
  const availabilityRules = await AvailabilityRule.findAll({ where: { financialAccountId } });

  // Itera por cada dia no período solicitado para aplicar as regras de recorrência
  for (let day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    const currentDayStr = day.toISOString().split('T')[0];
    
    for (const rule of availabilityRules) {
      let ruleApplies = false;
      // Verifica se a regra é um 'day_off' para a data específica
      if (rule.type === 'day_off' && rule.specificDate === currentDayStr) {
        ruleApplies = true;
      } else if (rule.rrule) {
        // Se a regra tem uma string RRULE, usa a biblioteca rrule para verificar ocorrências
        try {
            const rrule = RRule.fromString(rule.rrule);
            // Verifica se a regra ocorre no dia atual
            const occurrences = rrule.between(new Date(currentDayStr + "T00:00:00.000Z"), new Date(currentDayStr + "T23:59:59.999Z"), true);
            if(occurrences.length > 0) {
                ruleApplies = true;
            }
        } catch(e) {
            logger.error(`Erro ao processar RRULE ID ${rule.id}: ${e.message}`);
        }
      }

      if (ruleApplies) {
        let eventStart, eventEnd;
        if (rule.type === 'day_off') {
          // Para um dia inteiro de folga, o evento cobre o dia todo
          eventStart = new Date(`${currentDayStr}T00:00:00`);
          eventEnd = new Date(`${currentDayStr}T23:59:59`);
        }
        else if (rule.type === 'break' && rule.startTime && rule.endTime) {
          // Para pausas, usa os horários definidos na regra
          eventStart = new Date(`${currentDayStr}T${rule.startTime}`);
          eventEnd = new Date(`${currentDayStr}T${rule.endTime}`);
        } else {
            continue; // Se não for um tipo tratável aqui, pula
        }

        agendaEvents.push({
          id: `break_${rule.id}_${currentDayStr}`, // ID único para evento de bloqueio
          type: 'break',
          title: rule.title,
          start: eventStart.toISOString(),
          end: eventEnd.toISOString(),
          backgroundColor: '#6c757d', // Cor cinza para bloqueios
          borderColor: '#6c757d',
          display: 'background', // Exibe como um evento de background no calendário
        });
      }
    }
  }
  
  logger.info(`[AgendaView] Retornando ${agendaEvents.length} eventos para FA ID ${financialAccountId}.`);
  return agendaEvents;
}

module.exports = {
  // Funções CRUD principais para Agendamentos
  scheduleAppointment,
  getAllAppointments,
  getAppointmentById,
  updateAppointment,
  deleteOrCancelAppointment,
  // Funções de Ciclo de Vida do Agendamento PJ/MEI
  confirmAppointment,
  completeAppointment,
  // Funções de Lembrete (usadas pelos jobs)
  getPFAppointmentsNeedingReminder,
  markReminderAsSent,
  getPJAppointmentsNeeding24hReminder,
  getPJAppointmentsNeeding30minReminder,
  mark24hReminderAsSent,
  mark30minReminderAsSent,
  // Funções para Sincronização Google Calendar
  createOrUpdateAppointmentFromGoogle, 
  deleteOrCancelAppointmentByGoogleId, 
  // Função para visualização de Agenda
  getAgendaView
};
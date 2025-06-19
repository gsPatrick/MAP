// src/features/Service/service.service.js
const { Service, FinancialAccount, AppointmentService, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Valida se a conta financeira existe, está ativa e é do tipo PJ ou MEI.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} [transaction=null] - A transação do Sequelize, se houver.
 * @returns {Promise<object>} O objeto da conta financeira validada.
 * @throws {Error} Se a conta não for encontrada, estiver inativa ou não for PJ/MEI.
 */
async function validateAndGetServiceAccount(financialAccountId, transaction = null) {
  const account = await FinancialAccount.findByPk(financialAccountId, { transaction });
  if (!account) {
    const error = new Error(`Conta Financeira com ID ${financialAccountId} não encontrada.`);
    error.statusCode = 404;
    error.status = 'fail';
    throw error;
  }
  if (!account.isActive) {
    const error = new Error(`A Conta Financeira ID ${financialAccountId} ("${account.accountName}") está inativa.`);
    error.statusCode = 403;
    error.status = 'fail';
    throw error;
  }
  if (!['PJ', 'MEI'].includes(account.accountType)) {
    const error = new Error(`Serviços só podem ser gerenciados em contas do tipo PJ ou MEI. Sua conta é do tipo ${account.accountType}.`);
    error.statusCode = 403;
    error.status = 'fail';
    throw error;
  }
  return account;
}

/**
 * Cria um novo serviço para uma conta financeira PJ/MEI.
 * @param {number} financialAccountId - ID da conta financeira proprietária.
 * @param {object} serviceData - Dados do serviço a ser criado.
 * @returns {Promise<object>} O objeto do serviço criado.
 */
async function createService(financialAccountId, serviceData) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetServiceAccount(financialAccountId, t);

    const { name, price, durationMinutes } = serviceData;
    if (!name || price === undefined || durationMinutes === undefined) {
      const error = new Error('Nome, preço e duração em minutos são obrigatórios para criar um serviço.');
      error.statusCode = 400;
      error.status = 'fail';
      throw error;
    }

    const existingService = await Service.findOne({
      where: { name, financialAccountId },
      transaction: t,
    });
    if (existingService) {
      const error = new Error(`Já existe um serviço com o nome "${name}" nesta conta.`);
      error.statusCode = 409; // Conflict
      error.status = 'fail';
      throw error;
    }

    const newService = await Service.create(
      { ...serviceData, financialAccountId },
      { transaction: t }
    );

    await t.commit();
    logger.info(`Serviço ID ${newService.id} ("${newService.name}") criado para FinancialAccount ID ${financialAccountId}.`);
    return newService.toJSON();
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro ao criar serviço para FA ID ${financialAccountId}: ${error.message}`, { error, serviceData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todos os serviços de uma conta financeira com filtros e paginação.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} queryParams - Parâmetros de filtro e paginação.
 * @returns {Promise<object>} Objeto com a lista de serviços e metadados de paginação.
 */
async function getAllServices(financialAccountId, queryParams = {}) {
  try {
    await validateAndGetServiceAccount(financialAccountId);

    const { page = 1, limit = 10, search, isActive } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const whereConditions = { financialAccountId };

    if (isActive !== undefined && (isActive === true || isActive === 'true' || isActive === false || isActive === 'false')) {
      whereConditions.isActive = (isActive === true || isActive === 'true');
    }

    if (search) {
      whereConditions[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await Service.findAndCountAll({
      where: whereConditions,
      limit: parseInt(limit, 10),
      offset,
      order: [['name', 'ASC']],
    });

    logger.info(`Listados ${rows.length} serviços para FA ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      services: rows.map(s => s.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar serviços para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca um serviço específico pelo seu ID.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {number} serviceId - ID do serviço a ser buscado.
 * @returns {Promise<object|null>} O objeto do serviço ou null se não encontrado.
 */
async function getServiceById(financialAccountId, serviceId) {
  try {
    await validateAndGetServiceAccount(financialAccountId);
    const service = await Service.findOne({
      where: { id: serviceId, financialAccountId },
    });

    if (!service) {
      logger.warn(`Serviço ID ${serviceId} não encontrado ou não pertence à FA ID ${financialAccountId}.`);
      return null;
    }
    return service.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar serviço ID ${serviceId} para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Atualiza os dados de um serviço existente.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {number} serviceId - ID do serviço a ser atualizado.
 * @param {object} updateData - Dados a serem atualizados.
 * @returns {Promise<object>} O objeto do serviço atualizado.
 */
async function updateService(financialAccountId, serviceId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetServiceAccount(financialAccountId, t);

    const service = await Service.findOne({
      where: { id: serviceId, financialAccountId },
      transaction: t,
    });

    if (!service) {
      const error = new Error(`Serviço com ID ${serviceId} não encontrado.`);
      error.statusCode = 404;
      error.status = 'fail';
      throw error;
    }

    // Se o nome está sendo alterado, verifica se o novo nome já existe
    if (updateData.name && updateData.name !== service.name) {
      const existingService = await Service.findOne({
        where: {
          name: updateData.name,
          financialAccountId,
          id: { [Op.ne]: serviceId },
        },
        transaction: t,
      });
      if (existingService) {
        const error = new Error(`Já existe um serviço com o nome "${updateData.name}".`);
        error.statusCode = 409;
        error.status = 'fail';
        throw error;
      }
    }

    await service.update(updateData, { transaction: t });

    await t.commit();
    logger.info(`Serviço ID ${serviceId} ("${service.name}") atualizado para FA ID ${financialAccountId}.`);
    return service.toJSON();
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro ao atualizar serviço ID ${serviceId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui um serviço, somente se ele não estiver vinculado a nenhum agendamento.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {number} serviceId - ID do serviço a ser excluído.
 * @returns {Promise<boolean>} True se a exclusão foi bem-sucedida.
 */
async function deleteService(financialAccountId, serviceId) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetServiceAccount(financialAccountId, t);

    const service = await Service.findByPk(serviceId, { transaction: t });
    if (!service || service.financialAccountId !== financialAccountId) {
      const error = new Error(`Serviço com ID ${serviceId} não encontrado ou não pertence a esta conta.`);
      error.statusCode = 404;
      error.status = 'fail';
      throw error;
    }

    // Verifica se o serviço está em uso em algum agendamento
    const usage = await AppointmentService.findOne({
      where: { serviceId },
      transaction: t,
    });

    if (usage) {
      const error = new Error('Este serviço não pode ser excluído pois está vinculado a um ou mais agendamentos. Considere desativá-lo.');
      error.statusCode = 409; // Conflict
      error.status = 'fail';
      throw error;
    }

    await service.destroy({ transaction: t });

    await t.commit();
    logger.info(`Serviço ID ${serviceId} excluído da FA ID ${financialAccountId}.`);
    return true;
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro ao excluir serviço ID ${serviceId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  createService,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
};
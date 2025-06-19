// src/features/Service/service.controller.js
const serviceService = require('./service.service');
const logger = require('../../utils/logger');

/**
 * Cria um novo serviço associado a uma conta financeira.
 */
async function createService(req, res, next) {
  try {
    const { financialAccountId } = req.params;
    const serviceData = req.body;

    const newService = await serviceService.createService(parseInt(financialAccountId, 10), serviceData);

    res.status(201).json({
      status: 'success',
      message: 'Serviço criado com sucesso.',
      data: newService,
    });
  } catch (error) {
    logger.error(`[ServiceController] Erro ao criar serviço: ${error.message}`);
    next(error);
  }
}

/**
 * Lista todos os serviços de uma conta financeira, com filtros e paginação.
 */
async function getAllServices(req, res, next) {
  try {
    const { financialAccountId } = req.params;
    const queryParams = req.query; // page, limit, search, isActive

    const result = await serviceService.getAllServices(parseInt(financialAccountId, 10), queryParams);

    res.status(200).json({
      status: 'success',
      message: 'Serviços listados com sucesso.',
      data: result,
    });
  } catch (error) {
    logger.error(`[ServiceController] Erro ao listar serviços: ${error.message}`);
    next(error);
  }
}

/**
 * Obtém os detalhes de um serviço específico.
 */
async function getServiceById(req, res, next) {
  try {
    const { financialAccountId, serviceId } = req.params;

    const service = await serviceService.getServiceById(parseInt(financialAccountId, 10), parseInt(serviceId, 10));

    if (!service) {
      return res.status(404).json({
        status: 'fail',
        message: 'Serviço não encontrado.',
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Serviço encontrado com sucesso.',
      data: service,
    });
  } catch (error) {
    logger.error(`[ServiceController] Erro ao obter serviço por ID: ${error.message}`);
    next(error);
  }
}

/**
 * Atualiza um serviço existente.
 */
async function updateService(req, res, next) {
  try {
    const { financialAccountId, serviceId } = req.params;
    const updateData = req.body;

    const updatedService = await serviceService.updateService(parseInt(financialAccountId, 10), parseInt(serviceId, 10), updateData);

    res.status(200).json({
      status: 'success',
      message: 'Serviço atualizado com sucesso.',
      data: updatedService,
    });
  } catch (error) {
    logger.error(`[ServiceController] Erro ao atualizar serviço: ${error.message}`);
    next(error);
  }
}

/**
 * Exclui um serviço.
 */
async function deleteService(req, res, next) {
  try {
    const { financialAccountId, serviceId } = req.params;

    await serviceService.deleteService(parseInt(financialAccountId, 10), parseInt(serviceId, 10));

    res.status(200).json({
      status: 'success',
      message: 'Serviço excluído com sucesso.',
      data: null,
    });
  } catch (error) {
    logger.error(`[ServiceController] Erro ao excluir serviço: ${error.message}`);
    next(error);
  }
}

module.exports = {
  createService,
  getAllServices,
  getServiceById,
  updateService,
  deleteService,
};
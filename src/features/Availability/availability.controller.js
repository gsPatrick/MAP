// src/features/Availability/availability.controller.js
const availabilityService = require('./availability.service');
const logger = require('../../utils/logger');

/**
 * Cria uma nova regra de disponibilidade (trabalho, folga, etc.).
 */
async function createAvailabilityRule(req, res, next) {
  try {
    const { financialAccountId } = req.params;
    const ruleData = req.body;

    const newRule = await availabilityService.createAvailabilityRule(parseInt(financialAccountId, 10), ruleData);

    res.status(201).json({
      status: 'success',
      message: 'Regra de disponibilidade criada com sucesso.',
      data: newRule,
    });
  } catch (error) {
    logger.error(`[AvailabilityController] Erro ao criar regra de disponibilidade: ${error.message}`);
    next(error);
  }
}

/**
 * Lista todas as regras de disponibilidade para uma conta financeira.
 */
async function getAllAvailabilityRules(req, res, next) {
  try {
    const { financialAccountId } = req.params;

    const rules = await availabilityService.getAllAvailabilityRules(parseInt(financialAccountId, 10));

    res.status(200).json({
      status: 'success',
      message: 'Regras de disponibilidade listadas com sucesso.',
      data: rules,
    });
  } catch (error) {
    logger.error(`[AvailabilityController] Erro ao listar regras de disponibilidade: ${error.message}`);
    next(error);
  }
}

/**
 * Obtém os detalhes de uma regra de disponibilidade específica.
 */
async function getAvailabilityRuleById(req, res, next) {
  try {
    const { financialAccountId, ruleId } = req.params;

    const rule = await availabilityService.getAvailabilityRuleById(parseInt(financialAccountId, 10), parseInt(ruleId, 10));

    if (!rule) {
      return res.status(404).json({
        status: 'fail',
        message: 'Regra de disponibilidade não encontrada.',
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Regra de disponibilidade encontrada com sucesso.',
      data: rule,
    });
  } catch (error) {
    logger.error(`[AvailabilityController] Erro ao obter regra por ID: ${error.message}`);
    next(error);
  }
}

/**
 * Atualiza uma regra de disponibilidade existente.
 */
async function updateAvailabilityRule(req, res, next) {
  try {
    const { financialAccountId, ruleId } = req.params;
    const updateData = req.body;

    const updatedRule = await availabilityService.updateAvailabilityRule(parseInt(financialAccountId, 10), parseInt(ruleId, 10), updateData);

    res.status(200).json({
      status: 'success',
      message: 'Regra de disponibilidade atualizada com sucesso.',
      data: updatedRule,
    });
  } catch (error) {
    logger.error(`[AvailabilityController] Erro ao atualizar regra: ${error.message}`);
    next(error);
  }
}

/**
 * Exclui uma regra de disponibilidade.
 */
async function deleteAvailabilityRule(req, res, next) {
  try {
    const { financialAccountId, ruleId } = req.params;

    await availabilityService.deleteAvailabilityRule(parseInt(financialAccountId, 10), parseInt(ruleId, 10));

    res.status(200).json({
      status: 'success',
      message: 'Regra de disponibilidade excluída com sucesso.',
      data: null,
    });
  } catch (error) {
    logger.error(`[AvailabilityController] Erro ao excluir regra: ${error.message}`);
    next(error);
  }
}

module.exports = {
  createAvailabilityRule,
  getAllAvailabilityRules,
  getAvailabilityRuleById,
  updateAvailabilityRule,
  deleteAvailabilityRule,
};
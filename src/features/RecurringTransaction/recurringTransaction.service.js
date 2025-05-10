// src/features/RecurringTransaction/recurringTransaction.service.js
const { RecurringTransactionRule, FinancialAccount, FinancialCategory, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { calculateNextDueDate } = require('../../utils/dateUtils'); // Utilitário a ser criado

/**
 * Valida se a FinancialAccount existe e está ativa.
 * @param {number} financialAccountId
 * @param {object} transaction - Transação Sequelize opcional.
 */
async function validateOwningFinancialAccount(financialAccountId, transaction = null) {
  const account = await FinancialAccount.findByPk(financialAccountId, { transaction });
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

/**
 * Cria uma nova regra de transação recorrente para uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} ruleData - Dados da regra de recorrência.
 * @returns {Promise<object>} A regra criada.
 */
async function createRecurringRule(financialAccountId, ruleData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);

    const requiredFields = ['description', 'type', 'value', 'frequency', 'startDate'];
    for (const field of requiredFields) {
      if (ruleData[field] === undefined || ruleData[field] === null || ruleData[field] === '') {
        const error = new Error(`Campo obrigatório "${field}" não fornecido para a regra de recorrência.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
    }

    if (ruleData.financialCategoryId && !(await FinancialCategory.findByPk(ruleData.financialCategoryId, { transaction: t }))) {
      const error = new Error(`Categoria financeira com ID ${ruleData.financialCategoryId} não encontrada.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    // Calcular o primeiro nextDueDate
    const nextDueDate = calculateNextDueDate(ruleData.startDate, ruleData.frequency, ruleData.interval || 1, ruleData.dayOfMonth, ruleData.dayOfWeek);
    if (!nextDueDate) {
        const error = new Error('Não foi possível calcular a próxima data de vencimento para a recorrência.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    // Validar se endDate é após startDate, se fornecido
    if (ruleData.endDate && new Date(ruleData.endDate) < new Date(ruleData.startDate)) {
        const error = new Error('A data final da recorrência não pode ser anterior à data inicial.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    // Validar se nextDueDate não é após endDate, se endDate existir
    if (ruleData.endDate && new Date(nextDueDate) > new Date(ruleData.endDate)) {
        const error = new Error('A primeira ocorrência calculada está após a data final da recorrência.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }


    const newRule = await RecurringTransactionRule.create(
      { ...ruleData, financialAccountId, nextDueDate },
      { transaction: t }
    );
    await t.commit();
    logger.info(`Regra de recorrência "${newRule.description}" (ID: ${newRule.id}) criada para FinancialAccount ID ${financialAccountId}. Próximo vencimento: ${newRule.nextDueDate}`);
    return newRule.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar regra de recorrência para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, ruleData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todas as regras de recorrência de uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} queryParams - { isActive, frequency, type }
 * @returns {Promise<Array<object>>}
 */
async function getAllRecurringRules(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const { isActive, frequency, type, sortBy = 'nextDueDate', sortOrder = 'ASC' } = queryParams;
    const whereConditions = { financialAccountId };

    if (isActive !== undefined) {
      whereConditions.isActive = (isActive === 'true' || isActive === true);
    }
    if (frequency) whereConditions.frequency = frequency;
    if (type) whereConditions.type = type;

    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];


    const rules = await RecurringTransactionRule.findAll({
      where: whereConditions,
      include: [
        { model: FinancialCategory, as: 'category', attributes: ['id', 'name'] }
      ],
      order: order,
    });

    logger.info(`Listadas ${rules.length} regras de recorrência para FinancialAccount ID ${financialAccountId}.`);
    return rules.map(r => r.toJSON());
  } catch (error) {
    logger.error(`Erro ao listar regras de recorrência para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca uma regra de recorrência pelo ID, verificando se pertence à FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} ruleId
 * @returns {Promise<object|null>}
 */
async function getRecurringRuleById(financialAccountId, ruleId) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const rule = await RecurringTransactionRule.findOne({
      where: { id: ruleId, financialAccountId },
      include: [
        { model: FinancialCategory, as: 'category' },
        { model: FinancialAccount, as: 'financialAccount', attributes: ['id', 'accountName']}
      ]
    });

    if (!rule) {
      logger.warn(`Regra de recorrência ID ${ruleId} não encontrada ou não pertence à FinancialAccount ID ${financialAccountId}.`);
      return null;
    }
    return rule.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar regra de recorrência ID ${ruleId} para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Atualiza uma regra de recorrência.
 * @param {number} financialAccountId
 * @param {number} ruleId
 * @param {object} updateData
 * @returns {Promise<object|null>}
 */
async function updateRecurringRule(financialAccountId, ruleId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);
    const rule = await RecurringTransactionRule.findOne({
      where: { id: ruleId, financialAccountId },
      transaction: t
    });
    if (!rule) {
      await t.rollback();
      logger.warn(`Regra de recorrência ID ${ruleId} não encontrada para atualização na FinancialAccount ID ${financialAccountId}.`);
      return null;
    }

    // Se campos que afetam nextDueDate forem alterados (startDate, frequency, interval, dayOfMonth, dayOfWeek), recalcular.
    // É mais simples recalcular sempre que houver uma alteração nesses campos.
    const dateFieldsChanged = ['startDate', 'frequency', 'interval', 'dayOfMonth', 'dayOfWeek'].some(field => updateData.hasOwnProperty(field));
    
    // Construir os dados para o cálculo do nextDueDate, usando valores atualizados ou os existentes na regra
    const nextDueDateCalcData = {
        startDate: updateData.startDate || rule.startDate,
        frequency: updateData.frequency || rule.frequency,
        interval: updateData.interval !== undefined ? updateData.interval : rule.interval,
        dayOfMonth: updateData.dayOfMonth !== undefined ? updateData.dayOfMonth : rule.dayOfMonth,
        dayOfWeek: updateData.dayOfWeek !== undefined ? updateData.dayOfWeek : rule.dayOfWeek,
    };
    const endDateForCalc = updateData.endDate !== undefined ? updateData.endDate : rule.endDate;


    if (dateFieldsChanged) {
      const newNextDueDate = calculateNextDueDate(
        nextDueDateCalcData.startDate,
        nextDueDateCalcData.frequency,
        nextDueDateCalcData.interval,
        nextDueDateCalcData.dayOfMonth,
        nextDueDateCalcData.dayOfWeek,
        rule.lastGeneratedDate || rule.startDate // Use lastGeneratedDate se disponível, senão startDate para recalcular "do zero"
      );
      if (!newNextDueDate) {
        const error = new Error('Não foi possível recalcular a próxima data de vencimento com os novos dados.');
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
      // Validar se newNextDueDate não é após endDate, se endDate existir
      if (endDateForCalc && new Date(newNextDueDate) > new Date(endDateForCalc)) {
          if (rule.isActive || (updateData.hasOwnProperty('isActive') && updateData.isActive === true) ) {
            const error = new Error('A próxima ocorrência calculada com os novos dados está após a data final da recorrência. Considere desativar a regra ou ajustar as datas.');
            error.statusCode = 400; error.status = 'fail'; throw error;
          } else {
            // Se a regra está sendo desativada, podemos permitir que nextDueDate ultrapasse endDate
            logger.warn(`Próxima data de vencimento ${newNextDueDate} ultrapassa data final ${endDateForCalc}, mas a regra está inativa ou sendo desativada.`);
          }
      }
      updateData.nextDueDate = newNextDueDate;
    }
    
    // Validar endDate vs startDate
    const finalStartDate = updateData.startDate || rule.startDate;
    const finalEndDate = updateData.endDate !== undefined ? updateData.endDate : rule.endDate;
    if(finalEndDate && new Date(finalEndDate) < new Date(finalStartDate)){
        const error = new Error('A data final da recorrência não pode ser anterior à data inicial.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }


    // Remover financialAccountId de updateData para não permitir mover entre contas
    delete updateData.financialAccountId;

    await rule.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Regra de recorrência ID ${ruleId} ("${rule.description}") atualizada para FinancialAccount ID ${financialAccountId}.`);
    return rule.reload({
        include: [
            { model: FinancialCategory, as: 'category' },
            { model: FinancialAccount, as: 'financialAccount', attributes: ['id', 'accountName']}
        ]
    }).then(r => r.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar regra de recorrência ID ${ruleId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui uma regra de recorrência.
 * @param {number} financialAccountId
 * @param {number} ruleId
 * @returns {Promise<boolean>}
 */
async function deleteRecurringRule(financialAccountId, ruleId) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);
    const rule = await RecurringTransactionRule.findOne({
      where: { id: ruleId, financialAccountId },
      transaction: t
    });
    if (!rule) {
      await t.rollback();
      logger.warn(`Regra de recorrência ID ${ruleId} não encontrada para exclusão na FinancialAccount ID ${financialAccountId}.`);
      return false;
    }

    await rule.destroy({ transaction: t });
    await t.commit();
    logger.info(`Regra de recorrência ID ${ruleId} ("${rule.description}") excluída da FinancialAccount ID ${financialAccountId}.`);
    return true;
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao excluir regra de recorrência ID ${ruleId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  createRecurringRule,
  getAllRecurringRules,
  getRecurringRuleById,
  updateRecurringRule,
  deleteRecurringRule,
};
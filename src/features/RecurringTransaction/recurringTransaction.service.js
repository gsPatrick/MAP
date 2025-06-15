// src/features/RecurringTransaction/recurringTransaction.service.js
const { RecurringTransactionRule, FinancialAccount, FinancialCategory, FinancialTransaction, sequelize } = require('../../database'); // Adicionado FinancialTransaction
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
    
    const { 
        isActive, frequency, type, descriptionSearch, 
        dateStart, dateEnd, period,
        sortBy = 'nextDueDate', sortOrder = 'ASC' 
    } = queryParams;

    const whereConditions = { financialAccountId };

    if (isActive !== undefined && isActive !== null) {
      whereConditions.isActive = (String(isActive).toLowerCase() === 'true' || isActive === true);
    }

    if (frequency) whereConditions.frequency = frequency;
    if (type) whereConditions.type = type;
    
    // Filtro por descrição (case-insensitive e parcial)
    if (descriptionSearch) {
        whereConditions.description = { [Op.iLike]: `%${descriptionSearch}%` };
    }

    if (period || dateStart || dateEnd) {
        let finalDateStart = dateStart;
        let finalDateEnd = dateEnd;

        if (period) {
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth();

            if (period === "este_mes") {
                finalDateStart = new Date(year, month, 1).toISOString().split('T')[0];
                finalDateEnd = new Date(year, month + 1, 0).toISOString().split('T')[0];
            }
        }

        if (finalDateStart && finalDateEnd) {
            whereConditions.nextDueDate = { [Op.between]: [finalDateStart, finalDateEnd] };
        } else if (finalDateStart) {
            whereConditions.nextDueDate = { [Op.gte]: finalDateStart };
        } else if (finalDateEnd) {
            whereConditions.nextDueDate = { [Op.lte]: finalDateEnd };
        }
    }

    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];

    const { count, rows } = await RecurringTransactionRule.findAndCountAll({
      where: whereConditions,
      include: [{ model: FinancialCategory, as: 'category', attributes: ['id', 'name'] }],
      order: order,
    });

    logger.info(`Listadas ${rows.length} de um total de ${count} regras de recorrência para FA ID ${financialAccountId}. Filtros: ${JSON.stringify(whereConditions)}`);
    
    return {
        rules: rows.map(r => r.toJSON()),
        totalItems: count
    };

  } catch (error) {
    logger.error(`Erro ao listar regras de recorrência para FA ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca uma regra de recorrência pelo ID, verificando se pertence à FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} ruleId
 * @param {boolean} includeGeneratedTransactions - Se true, inclui as transações geradas.
 * @returns {Promise<object|null>}
 */
async function getRecurringRuleById(financialAccountId, ruleId, includeGeneratedTransactions = false) { // Adicionado includeGeneratedTransactions
  try {
    await validateOwningFinancialAccount(financialAccountId);
    
    const includeOptions = [
        { model: FinancialCategory, as: 'category' },
        { model: FinancialAccount, as: 'financialAccount', attributes: ['id', 'accountName']}
    ];

    if (includeGeneratedTransactions) {
        includeOptions.push({
            model: FinancialTransaction,
            as: 'generatedTransactions',
            attributes: ['id', 'description', 'value', 'type', 'transactionDate', 'dueDate', 'isPaidOrReceived', 'paymentDate'], // Campos relevantes
            order: [['dueDate', 'DESC']], // Mais recentes primeiro
            limit: 50, // Limitar para não sobrecarregar, se necessário
            separate: true // Opcional: para queries mais eficientes com hasMany e limit
        });
    }
    
    const rule = await RecurringTransactionRule.findOne({
      where: { id: ruleId, financialAccountId },
      include: includeOptions
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
    // IMPORTANTE: Decidir o que fazer com as FinancialTransactions geradas por esta regra.
    // A FK em FinancialTransaction tem onDelete: 'SET NULL'.
    // Se quisesse deletar as transações junto, teria que ser 'CASCADE' ou deletá-las manualmente aqui.
    // Por ora, elas apenas perderão a referência à regra.

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


/**
 * Busca o histórico de transações geradas por uma regra de recorrência.
 * @param {number} financialAccountId
 * @param {number} ruleId
 * @param {object} queryParams - { page, limit, sortBy, sortOrder }
 * @returns {Promise<object>} Objeto com lista de transações e paginação.
 */
async function getRecurringRuleHistory(financialAccountId, ruleId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const rule = await RecurringTransactionRule.findOne({ where: { id: ruleId, financialAccountId } });
    if (!rule) {
        const error = new Error('Regra de recorrência não encontrada ou não pertence à conta financeira.');
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const { page = 1, limit = 10, sortBy = 'dueDate', sortOrder = 'DESC' } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const whereConditions = {
        financialAccountId,
        recurringTransactionRuleId: ruleId
    };
    
    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC']];

    const { count, rows } = await FinancialTransaction.findAndCountAll({
        where: whereConditions,
        include: [
            { model: FinancialCategory, as: 'category', attributes: ['id', 'name'] },
            // Não precisa incluir a regra de novo, pois já temos o ruleId
        ],
        limit: parseInt(limit, 10),
        offset: offset,
        order: order,
        distinct: true,
    });

    logger.info(`Listado histórico de ${rows.length} transações para Regra de Recorrência ID ${ruleId} (Total: ${count}).`);
    return {
        ruleDescription: rule.description, // Adiciona a descrição da regra para contexto
        totalItems: count,
        totalPages: Math.ceil(count / parseInt(limit, 10)),
        currentPage: parseInt(page, 10),
        transactions: rows.map(t => t.toJSON()),
    };

  } catch (error) {
    logger.error(`Erro ao buscar histórico da regra de recorrência ID ${ruleId}: ${error.message}`, { error });
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
  getRecurringRuleHistory, // <<< EXPORTADO
};
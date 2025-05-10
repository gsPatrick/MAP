// src/features/Financial/financial.service.js
const {
    FinancialTransaction,
    FinancialCategory,
    FinancialAccount,
    CreditCard,
    RecurringTransactionRule, // Importado para uso futuro, CRUD será aqui
    Client, // Importado para includes
    sequelize
} = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { calculateNextDueDate } = require('../../utils/dateUtils'); // Para recorrências

// --- Funções Auxiliares ---
/**
 * Valida se a FinancialAccount existe e está ativa.
 * @param {number} financialAccountId
 * @param {object} transaction - Transação Sequelize opcional.
 * @param {Array<string|object>} include - Opções de include para FinancialAccount.
 * @returns {Promise<object>} A FinancialAccount validada.
 */
async function validateAndGetFinancialAccount(financialAccountId, transaction = null, include = []) {
  const account = await FinancialAccount.findByPk(financialAccountId, { transaction, include });
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


// === Gerenciamento de Transações Financeiras (FinancialTransaction) ===

/**
 * Registra uma nova transação financeira para uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} transactionData - Dados da transação.
 * @param {object} options - Opções adicionais, como { transaction: sequelizeTransaction }
 * @returns {Promise<object>} A transação criada.
 */
async function createTransaction(financialAccountId, transactionData, options = {}) {
  const t = options.transaction || await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);

    const requiredFields = ['description', 'type', 'value', 'transactionDate'];
    for (const field of requiredFields) {
        if (transactionData[field] === undefined || transactionData[field] === null || transactionData[field] === '') {
            const error = new Error(`Campo obrigatório "${field}" não fornecido para a transação.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }

    if (transactionData.financialCategoryId && !(await FinancialCategory.findByPk(transactionData.financialCategoryId, { transaction: t }))) {
      const error = new Error(`Categoria financeira com ID ${transactionData.financialCategoryId} não encontrada.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    if (transactionData.creditCardId) {
        const card = await CreditCard.findOne({ where: { id: transactionData.creditCardId, financialAccountId }, transaction: t });
        if (!card) {
            const error = new Error(`Cartão de Crédito ID ${transactionData.creditCardId} não encontrado ou não pertence à conta financeira ID ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        if(!card.isActive){
            const error = new Error(`Cartão de Crédito ID ${transactionData.creditCardId} ("${card.name}") está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }
    if (transactionData.isPayableOrReceivable && !transactionData.dueDate) {
      logger.warn(`Registrando conta a pagar/receber para financialAccountId ${financialAccountId} sem data de vencimento.`);
    }

    const newTransaction = await FinancialTransaction.create(
      { ...transactionData, financialAccountId },
      { transaction: t }
    );
    
    if (!options.transaction) await t.commit(); // Só faz commit se a transação foi criada aqui
    logger.info(`Transação ID ${newTransaction.id} ("${newTransaction.description}") criada para FinancialAccount ID ${financialAccountId}.`);
    return newTransaction.toJSON();
  } catch (error) {
    if (!options.transaction) await t.rollback(); // Só faz rollback se a transação foi criada aqui
    logger.error(`Erro ao criar transação para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, transactionData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Registra uma conta parcelada para uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} accountData - { description, type, totalValue, initialDueDate, numberOfParcels, ...commonData }
 * @returns {Promise<object>} Objeto com as parcelas criadas.
 */
async function createParcelledAccount(financialAccountId, accountData) {
  const { description, type, totalValue, initialDueDate, numberOfParcels = 1, ...commonData } = accountData;

  if (!description || !type || totalValue === undefined || !initialDueDate || numberOfParcels < 1) {
    const error = new Error('Descrição, tipo, valor total, data de vencimento inicial e número de parcelas (mínimo 1) são obrigatórios.');
    error.statusCode = 400; error.status = 'fail'; throw error;
  }

  const t = await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);

    if (commonData.financialCategoryId && !(await FinancialCategory.findByPk(commonData.financialCategoryId, { transaction: t }))) {
        const error = new Error(`Categoria financeira ID ${commonData.financialCategoryId} não encontrada.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
    }
    if (commonData.creditCardId) {
        const card = await CreditCard.findOne({ where: { id: commonData.creditCardId, financialAccountId }, transaction: t });
        if (!card) {
            const error = new Error(`Cartão de Crédito ID ${commonData.creditCardId} não pertence à conta financeira ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
         if(!card.isActive){
            const error = new Error(`Cartão de Crédito ID ${commonData.creditCardId} ("${card.name}") está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }

    const parcelValue = parseFloat((totalValue / numberOfParcels).toFixed(2));
    let accumulatedValue = 0;
    const createdParcelsModels = []; // Para armazenar os modelos Sequelize criados
    let firstParcelId = null;

    for (let i = 1; i <= numberOfParcels; i++) {
      const currentParcelValue = (i === numberOfParcels) ? parseFloat((totalValue - accumulatedValue).toFixed(2)) : parcelValue;
      accumulatedValue += currentParcelValue;

      const dueDateObj = new Date(new Date(initialDueDate).toISOString().slice(0,10) + 'T12:00:00Z'); // Normalize to UTC noon
      dueDateObj.setUTCMonth(dueDateObj.getUTCMonth() + (i - 1));
      const dueDateString = `${dueDateObj.getUTCFullYear()}-${String(dueDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dueDateObj.getUTCDate()).padStart(2, '0')}`;


      const parcelData = {
        ...commonData,
        financialAccountId,
        description: numberOfParcels > 1 ? `${description} - Parcela ${i}/${numberOfParcels}` : description,
        type,
        value: currentParcelValue,
        transactionDate: commonData.transactionDate || new Date().toISOString().split('T')[0],
        isPayableOrReceivable: commonData.isPayableOrReceivable !== undefined ? commonData.isPayableOrReceivable : true,
        dueDate: dueDateString,
        isParcel: numberOfParcels > 1,
        parcelNumber: numberOfParcels > 1 ? i : null,
        totalParcels: numberOfParcels > 1 ? numberOfParcels : null,
        originalAccountId: null, // Será definido abaixo se for uma parcela
      };

      const createdParcel = await FinancialTransaction.create(parcelData, { transaction: t });
      createdParcelsModels.push(createdParcel);

      if (i === 1 && numberOfParcels > 1) {
        firstParcelId = createdParcel.id;
      }
    }
    
    // Agora, atualiza originalAccountId para todas as parcelas se houver mais de uma
    if (numberOfParcels > 1 && firstParcelId) {
        for (let i = 0; i < createdParcelsModels.length; i++) {
            await createdParcelsModels[i].update({ originalAccountId: firstParcelId }, { transaction: t });
        }
    }
    
    await t.commit();
    logger.info(`Conta parcelada "${description}" criada com ${numberOfParcels} parcelas para FinancialAccount ID ${financialAccountId}.`);
    
    // Recarregar para obter os dados atualizados, especialmente originalAccountId
    const finalParcels = [];
    for(const pModel of createdParcelsModels){
        finalParcels.push(await pModel.reload({transaction: null, include: [{model: FinancialTransaction, as: 'originalAccount'}]}).then(p => p.toJSON()));
    }

    return {
        message: numberOfParcels > 1 ? `Conta parcelada criada com ${numberOfParcels} parcelas.` : "Transação criada.",
        parcels: finalParcels
    };

  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar conta parcelada para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, accountData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}


async function getAllTransactions(financialAccountId, queryParams = {}) {
  try {
    await validateAndGetFinancialAccount(financialAccountId);
    const {
      page = 1, limit = 10, type, financialCategoryId, creditCardId,
      dateStart, dateEnd, transactionDate,
      isPayableOrReceivable, isPaidOrReceived, dueBefore, dueAfter,
      search, sortBy = 'transactionDate', sortOrder = 'DESC'
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };

    if (type) whereConditions.type = type;
    if (financialCategoryId) whereConditions.financialCategoryId = financialCategoryId;
    if (creditCardId) whereConditions.creditCardId = creditCardId;

    if (transactionDate) {
        whereConditions.transactionDate = transactionDate;
    } else {
        if (dateStart) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.gte]: dateStart };
        if (dateEnd) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.lte]: dateEnd };
    }

    if (isPayableOrReceivable !== undefined) {
        whereConditions.isPayableOrReceivable = (isPayableOrReceivable === 'true' || isPayableOrReceivable === true);
        if (isPaidOrReceived !== undefined && whereConditions.isPayableOrReceivable) {
            whereConditions.isPaidOrReceived = (isPaidOrReceived === 'true' || isPaidOrReceived === true);
        }
        if (dueBefore) whereConditions.dueDate = { ...whereConditions.dueDate, [Op.lte]: dueBefore };
        if (dueAfter) whereConditions.dueDate = { ...whereConditions.dueDate, [Op.gte]: dueAfter };
    }

    if (search) {
      whereConditions[Op.or] = [
          { description: { [Op.iLike]: `%${search}%` } },
          { notes: { [Op.iLike]: `%${search}%` } }
      ];
    }
    
    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC']];

    const { count, rows } = await FinancialTransaction.findAndCountAll({
      where: whereConditions,
      include: [
        { model: FinancialCategory, as: 'category', attributes: ['id', 'name'] },
        { model: CreditCard, as: 'creditCard', attributes: ['id', 'name', 'lastFourDigits'] },
        { model: FinancialTransaction, as: 'originalAccount', attributes: ['id', 'description'] }
      ],
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
      distinct: true,
    });

    logger.info(`Listadas ${rows.length} transações para FinancialAccount ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      transactions: rows.map(t => t.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar transações para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getTransactionById(financialAccountId, transactionId) {
  try {
    await validateAndGetFinancialAccount(financialAccountId);
    const transaction = await FinancialTransaction.findOne({
      where: { id: transactionId, financialAccountId },
      include: [
        { model: FinancialCategory, as: 'category' },
        { model: CreditCard, as: 'creditCard' },
        { 
          model: FinancialTransaction, 
          as: 'parcels', // Se esta for uma conta original (primeira parcela), lista suas "filhas"
          include: [{model: FinancialCategory, as: 'category'}, {model: CreditCard, as: 'creditCard'}] // Detalhes das parcelas
        }, 
        { model: FinancialTransaction, as: 'originalAccount' } // Se esta for uma parcela, mostra a conta original
      ]
    });

    if (!transaction) {
      logger.warn(`Transação ID ${transactionId} não encontrada ou não pertence à FinancialAccount ID ${financialAccountId}.`);
      return null;
    }
    return transaction.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar transação ID ${transactionId} para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateTransaction(financialAccountId, transactionId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);
    const transaction = await FinancialTransaction.findOne({
      where: { id: transactionId, financialAccountId },
      transaction: t
    });
    if (!transaction) { /* ... erro 404, rollback ... */ }

    if (updateData.financialCategoryId && updateData.financialCategoryId !== transaction.financialCategoryId && !(await FinancialCategory.findByPk(updateData.financialCategoryId, { transaction: t }))) { /* ... erro 404 ... */ }
    if (updateData.creditCardId && updateData.creditCardId !== transaction.creditCardId) {
        const card = await CreditCard.findOne({ where: { id: updateData.creditCardId, financialAccountId }, transaction: t });
        if (!card) { /* ... erro 404 ... */ }
         if(!card.isActive && updateData.creditCardId !== null){ // Permite desassociar (null) mas não associar a inativo
            const error = new Error(`Cartão de Crédito ID ${updateData.creditCardId} ("${card.name}") está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }
    
    delete updateData.financialAccountId; // Não permitir mover entre contas aqui

    await transaction.update(updateData, { transaction: t });
    const updatedTransaction = await transaction.reload({
        transaction: t,
        include: [
            { model: FinancialCategory, as: 'category' },
            { model: CreditCard, as: 'creditCard' }
        ]
    });

    await t.commit();
    logger.info(`Transação ID ${transactionId} atualizada para FinancialAccount ID ${financialAccountId}.`);
    return updatedTransaction.toJSON();
  } catch (error) { /* ... rollback, log, throw ... */ }
}

async function markAsPaidOrReceived(financialAccountId, transactionId, paymentDate = null) {
    const t = await sequelize.transaction();
    try {
        await validateAndGetFinancialAccount(financialAccountId, t);
        const transaction = await FinancialTransaction.findOne({where: {id: transactionId, financialAccountId}, transaction: t});
        if(!transaction){
            const e = new Error('Transação não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }
        if (!transaction.isPayableOrReceivable) {
            const error = new Error('Esta transação não é uma conta a pagar/receber.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        const updateData = {
            isPaidOrReceived: true,
            paymentDate: paymentDate || new Date().toISOString().split('T')[0]
        };
        await transaction.update(updateData, {transaction: t});
        await t.commit();
        return transaction.reload({include: [{model: FinancialCategory, as: 'category'}, {model: CreditCard, as: 'creditCard'}]}).then(tr => tr.toJSON());
    } catch(error) {
        await t.rollback();
        logger.error(`Erro ao marcar transação ${transactionId} como paga/recebida: ${error.message}`, {error});
        if(!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function deleteTransaction(financialAccountId, transactionId) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);
    const transaction = await FinancialTransaction.findOne({
      where: { id: transactionId, financialAccountId },
      transaction: t
    });
    if (!transaction) { /* ... erro 404, rollback ... */ }

    // Se esta transação for a "originalAccount" de outras parcelas, o que fazer?
    // A FK nas outras parcelas (originalAccountId) tem onDelete: 'SET NULL' ou 'CASCADE'.
    // Se SET NULL, as parcelas perdem a referência. Se CASCADE, são deletadas.
    // Se esta for a PRIMEIRA parcela de um conjunto (originalAccountId === id), e outras a referenciam:
    if (transaction.isParcel && transaction.originalAccountId === transaction.id) {
        const childParcelsCount = await FinancialTransaction.count({
            where: { originalAccountId: transaction.id, id: { [Op.ne]: transaction.id } },
            transaction: t
        });
        if (childParcelsCount > 0) {
            const error = new Error(`Esta é a transação principal de um parcelamento com ${childParcelsCount} outras parcelas. Para excluí-la, primeiro exclua ou desvincule as parcelas dependentes, ou exclua todas as parcelas do grupo.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    await transaction.destroy({ transaction: t });
    await t.commit();
    logger.info(`Transação ID ${transactionId} excluída da FinancialAccount ID ${financialAccountId}.`);
    return true;
  } catch (error) { /* ... rollback, log, throw ... */ }
}

async function getFinancialSummary(financialAccountId, filters = {}) {
  try {
    const account = await validateAndGetFinancialAccount(financialAccountId, null, [{model:Client, as: 'ownerClient'}]);
    const { dateStart, dateEnd, financialCategoryId, type } = filters;
    const whereBase = { financialAccountId };

    if (financialCategoryId) whereBase.financialCategoryId = financialCategoryId;
    if (type) whereBase.type = type;
    
    let whereTransactionDate = {};
    if (dateStart) whereTransactionDate[Op.gte] = dateStart;
    if (dateEnd) whereTransactionDate[Op.lte] = dateEnd;
    if(Object.keys(whereTransactionDate).length > 0) whereBase.transactionDate = whereTransactionDate;

    // Transações que efetivamente movimentaram caixa no período
    const whereEffective = {
        ...whereBase,
        [Op.or]: [
            { isPayableOrReceivable: false }, // Transações à vista
            { isPaidOrReceived: true }        // Contas que foram pagas/recebidas
        ]
    };

    const totalEntradas = await FinancialTransaction.sum('value', { where: { ...whereEffective, type: 'Entrada' } }) || 0;
    const totalSaidas = await FinancialTransaction.sum('value', { where: { ...whereEffective, type: 'Saída' } }) || 0;
    const saldoEfetivado = parseFloat((totalEntradas - totalSaidas).toFixed(2));

    // Contas a Receber Pendentes (com vencimento no período ou antes, se não especificado 'dateStart' para dueDate)
    const whereReceivables = { financialAccountId, type: 'Entrada', isPayableOrReceivable: true, isPaidOrReceived: false };
    if (dateEnd) whereReceivables.dueDate = { [Op.lte]: dateEnd }; // Vencendo até o final do período
    const totalAReceberPendente = await FinancialTransaction.sum('value', { where: whereReceivables }) || 0;

    // Contas a Pagar Pendentes
    const wherePayables = { financialAccountId, type: 'Saída', isPayableOrReceivable: true, isPaidOrReceived: false };
    if (dateEnd) wherePayables.dueDate = { [Op.lte]: dateEnd }; // Vencendo até o final do período
    const totalAPagarPendente = await FinancialTransaction.sum('value', { where: wherePayables }) || 0;

    const summary = {
      financialAccountId,
      accountName: account.accountName,
      accountType: account.accountType,
      ownerClientName: account.ownerClient?.name,
      totalEntradas: parseFloat(totalEntradas.toFixed(2)),
      totalSaidas: parseFloat(totalSaidas.toFixed(2)),
      saldoEfetivado,
      totalAReceberPendente: parseFloat(totalAReceberPendente.toFixed(2)),
      totalAPagarPendente: parseFloat(totalAPagarPendente.toFixed(2)),
      filtersApplied: filters
    };
    logger.info(`Resumo financeiro gerado para FinancialAccount ID ${financialAccountId}.`);
    return summary;
  } catch (error) { /* ... log, throw ... */ }
}

// Os CRUDs para RecurringTransactionRule e CreditCard foram movidos para seus respectivos serviços
// nas features RecurringTransaction e CreditCardManagement.

module.exports = {
  createTransaction,
  createParcelledAccount,
  getAllTransactions,
  getTransactionById,
  updateTransaction,
  markAsPaidOrReceived,
  deleteTransaction,
  getFinancialSummary,
};
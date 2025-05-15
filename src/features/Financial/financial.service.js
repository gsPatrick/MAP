// src/features/Financial/financial.service.js
const {
  FinancialTransaction,
  FinancialCategory,
  FinancialAccount,
  CreditCard, 
  RecurringTransactionRule,
  Client,
  sequelize
} = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { calculateNextDueDate } = require('../../utils/dateUtils');
const creditCardService = require('../CreditCardManagement/creditCard.service'); 

// ... (validateAndGetFinancialAccount permanece a mesma) ...
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

  if (transactionData.creditCardId && transactionData.type === 'Saída') {
      const card = await CreditCard.findOne({ where: { id: transactionData.creditCardId, financialAccountId }, transaction: t });
      if (!card) {
          const error = new Error(`Cartão de Crédito ID ${transactionData.creditCardId} não encontrado ou não pertence à conta financeira ID ${financialAccountId}.`);
          error.statusCode = 404; error.status = 'fail'; throw error;
      }
      if(!card.isActive){
          const error = new Error(`Cartão de Crédito ID ${transactionData.creditCardId} ("${card.name}") está inativo.`);
          error.statusCode = 400; error.status = 'fail'; throw error;
      }

      const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, transactionData.creditCardId); 
      if (parseFloat(transactionData.value) > limitInfo.availableLimit) {
          const error = new Error(`Limite insuficiente no cartão "${card.name}". Disponível: R$ ${limitInfo.availableLimit.toFixed(2)}, Tentativa: R$ ${parseFloat(transactionData.value).toFixed(2)}.`);
          error.statusCode = 409; 
          error.status = 'fail'; throw error;
      }
  }

  if (transactionData.isPayableOrReceivable && !transactionData.dueDate) {
    logger.warn(`Registrando conta a pagar/receber para financialAccountId ${financialAccountId} sem data de vencimento.`);
  }

  const newTransaction = await FinancialTransaction.create(
    { ...transactionData, financialAccountId },
    { transaction: t }
  );

  if (!options.transaction) await t.commit(); 
  logger.info(`Transação ID ${newTransaction.id} ("${newTransaction.description}") criada para FinancialAccount ID ${financialAccountId}.`);
  return newTransaction.toJSON();
} catch (error) {
  if (!options.transaction) await t.rollback(); 
  logger.error(`Erro ao criar transação para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, transactionData });
  if (!error.statusCode) error.statusCode = 500;
  throw error;
}
}

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

  if (commonData.creditCardId && type === 'Saída') {
      const card = await CreditCard.findOne({ where: { id: commonData.creditCardId, financialAccountId }, transaction: t });
      if (!card) {
          const error = new Error(`Cartão de Crédito ID ${commonData.creditCardId} não pertence à conta financeira ${financialAccountId}.`);
          error.statusCode = 404; error.status = 'fail'; throw error;
      }
       if(!card.isActive){
          const error = new Error(`Cartão de Crédito ID ${commonData.creditCardId} ("${card.name}") está inativo.`);
          error.statusCode = 400; error.status = 'fail'; throw error;
      }
      const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, commonData.creditCardId); 
      if (parseFloat(totalValue) > limitInfo.availableLimit) {
          const error = new Error(`Limite insuficiente no cartão "${card.name}" para a compra parcelada. Disponível: R$ ${limitInfo.availableLimit.toFixed(2)}, Valor total da compra: R$ ${parseFloat(totalValue).toFixed(2)}.`);
          error.statusCode = 409;
          error.status = 'fail'; throw error;
      }
  }


  const parcelValue = parseFloat((totalValue / numberOfParcels).toFixed(2));
  let accumulatedValue = 0;
  const createdParcelsModels = []; 
  let firstParcelId = null;

  for (let i = 1; i <= numberOfParcels; i++) {
    const currentParcelValue = (i === numberOfParcels) ? parseFloat((totalValue - accumulatedValue).toFixed(2)) : parcelValue;
    accumulatedValue += currentParcelValue;

    const dueDateObj = new Date(new Date(initialDueDate).toISOString().slice(0,10) + 'T12:00:00Z'); 
    dueDateObj.setUTCMonth(dueDateObj.getUTCMonth() + (i - 1));
    const dueDateString = `${dueDateObj.getUTCFullYear()}-${String(dueDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dueDateObj.getUTCDate()).padStart(2, '0')}`;


    const parcelData = {
      ...commonData,
      financialAccountId,
      description: numberOfParcels > 1 ? `${description} - Parcela ${i}/${numberOfParcels}` : description,
      type,
      value: currentParcelValue,
      transactionDate: commonData.transactionDate || new Date().toISOString().split('T')[0],
      isPayableOrReceivable: commonData.isPayableOrReceivable !== undefined ? commonData.isPayableOrReceivable : (commonData.creditCardId ? false : true), 
      isPaidOrReceived: commonData.isPaidOrReceived !== undefined ? commonData.isPaidOrReceived : (commonData.creditCardId ? true : false), 
      dueDate: commonData.creditCardId ? null : dueDateString, 
      isParcel: numberOfParcels > 1,
      parcelNumber: numberOfParcels > 1 ? i : null,
      totalParcels: numberOfParcels > 1 ? numberOfParcels : null,
      originalAccountId: null, 
      originalPurchaseTotalValue: numberOfParcels > 1 ? parseFloat(totalValue) : null, // <<< ADICIONADO AQUI
    };

    const createdParcel = await FinancialTransaction.create(parcelData, { transaction: t });
    createdParcelsModels.push(createdParcel);

    if (i === 1 && numberOfParcels > 1) {
      firstParcelId = createdParcel.id;
    }
  }

  if (numberOfParcels > 1 && firstParcelId) {
      for (let k = 0; k < createdParcelsModels.length; k++) { // <<< CORRIGIDO ÍNDICE DO LOOP AQUI de i para k
          await createdParcelsModels[k].update({ originalAccountId: firstParcelId }, { transaction: t });
      }
  }

  await t.commit();
  logger.info(`Conta parcelada "${description}" criada com ${numberOfParcels} parcelas para FinancialAccount ID ${financialAccountId}.`);

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
      { 
        model: FinancialTransaction, 
        as: 'originalAccount', 
        attributes: ['id', 'description', 'originalPurchaseTotalValue'] // Incluir valor total da compra original
      }
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
        as: 'parcels', 
        include: [
            {model: FinancialCategory, as: 'category'}, 
            {model: CreditCard, as: 'creditCard'},
            // Para evitar loop infinito, não incluir 'originalAccount' dentro de 'parcels' recursivamente aqui
            // Se precisar do originalAccount das parcelas, buscar separadamente ou ajustar a query com cuidado.
        ] 
      },
      { 
        model: FinancialTransaction, 
        as: 'originalAccount',
        attributes: ['id', 'description', 'value', 'originalPurchaseTotalValue'] // Incluir o valor da transação original e o total da compra
      } 
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
  if (!transaction) {
      await t.rollback();
      const e = new Error('Transação não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
  }

  if (updateData.financialCategoryId && updateData.financialCategoryId !== transaction.financialCategoryId && !(await FinancialCategory.findByPk(updateData.financialCategoryId, { transaction: t }))) {
      await t.rollback();
      const e = new Error('Categoria não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
  }

  const changingCardOrValue = (updateData.creditCardId && updateData.creditCardId !== transaction.creditCardId) ||
                            (updateData.value && parseFloat(updateData.value) !== parseFloat(transaction.value));
  const targetCreditCardId = updateData.hasOwnProperty('creditCardId') ? updateData.creditCardId : transaction.creditCardId;
  const targetValue = updateData.hasOwnProperty('value') ? parseFloat(updateData.value) : parseFloat(transaction.value);
  const targetType = updateData.hasOwnProperty('type') ? updateData.type : transaction.type;


  if (targetCreditCardId && targetType === 'Saída' && changingCardOrValue) {
      const card = await CreditCard.findOne({ where: { id: targetCreditCardId, financialAccountId }, transaction: t });
      if (!card) {
          await t.rollback();
          const e = new Error('Cartão de crédito não encontrado.'); e.statusCode = 404; e.status = 'fail'; throw e;
      }
      if (!card.isActive && targetCreditCardId !== null){
           await t.rollback();
          const error = new Error(`Cartão de Crédito ID ${targetCreditCardId} ("${card.name}") está inativo.`);
          error.statusCode = 400; error.status = 'fail'; throw error;
      }

      const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, targetCreditCardId);
      let availableAfterOldTx = limitInfo.availableLimit;
      if (transaction.creditCardId === targetCreditCardId) { 
          availableAfterOldTx += parseFloat(transaction.value);
      }

      if (targetValue > availableAfterOldTx) {
          await t.rollback();
          const error = new Error(`Atualização resultaria em limite insuficiente no cartão "${card.name}". Disponível (considerando outras transações e desfazendo esta): R$ ${availableAfterOldTx.toFixed(2)}, Novo valor: R$ ${targetValue.toFixed(2)}.`);
          error.statusCode = 409; error.status = 'fail'; throw error;
      }
  }
  
  delete updateData.financialAccountId; 

  // Se a transação é uma parcela e o valor está sendo atualizado,
  // idealmente, outras parcelas do mesmo grupo e o originalPurchaseTotalValue deveriam ser ajustados.
  // Isso adiciona complexidade e pode ser um "TODO" para uma lógica mais avançada de edição de parcelamentos.
  // Por ora, a atualização de valor em uma parcela só afeta ELA MESMA.

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
} catch (error) {
      await t.rollback();
      logger.error(`Erro ao atualizar transação ID ${transactionId}: ${error.message}`, {error, updateData});
      if(!error.statusCode) error.statusCode = 500;
      throw error;
 }
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
  if (!transaction) {
      await t.rollback();
      const e = new Error('Transação não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
  }

  if (transaction.isParcel && transaction.originalAccountId === transaction.id) {
      const childParcelsCount = await FinancialTransaction.count({
          where: { originalAccountId: transaction.id, id: { [Op.ne]: transaction.id } },
          transaction: t
      });
      if (childParcelsCount > 0) {
          await t.rollback();
          const error = new Error(`Esta é a transação principal de um parcelamento com ${childParcelsCount} outras parcelas. Para excluí-la, primeiro exclua ou desvincule as parcelas dependentes, ou exclua todas as parcelas do grupo.`);
          error.statusCode = 409; error.status = 'fail'; throw error;
      }
  }

  await transaction.destroy({ transaction: t });
  await t.commit();
  logger.info(`Transação ID ${transactionId} excluída da FinancialAccount ID ${financialAccountId}.`);
  return true;
} catch (error) {
      await t.rollback();
      logger.error(`Erro ao excluir transação ID ${transactionId}: ${error.message}`, {error});
      if(!error.statusCode) error.statusCode = 500;
      throw error;
  }
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

  const whereEffective = {
      ...whereBase,
      [Op.or]: [
          { isPayableOrReceivable: false }, 
          { isPaidOrReceived: true }        
      ],
      creditCardId: null 
  };
  const whereCardPayments = {
      ...whereBase,
      isPayableOrReceivable: false, 
      description: { [Op.iLike]: '%Pagamento de Fatura%' } 
  };


  const totalEntradasCaixa = await FinancialTransaction.sum('value', { where: { ...whereEffective, type: 'Entrada' } }) || 0;
  let totalSaidasCaixa = await FinancialTransaction.sum('value', { where: { ...whereEffective, type: 'Saída' } }) || 0;
  const totalPagamentoFaturas = await FinancialTransaction.sum('value', { where: { ...whereCardPayments, type: 'Saída' }}) || 0;
  totalSaidasCaixa += totalPagamentoFaturas; 


  const saldoEfetivado = parseFloat((totalEntradasCaixa - totalSaidasCaixa).toFixed(2));

  const whereReceivables = { financialAccountId, type: 'Entrada', isPayableOrReceivable: true, isPaidOrReceived: false };
  if (dateEnd) whereReceivables.dueDate = { [Op.lte]: dateEnd }; 
  const totalAReceberPendente = await FinancialTransaction.sum('value', { where: whereReceivables }) || 0;

  const wherePayables = { financialAccountId, type: 'Saída', isPayableOrReceivable: true, isPaidOrReceived: false };
  if (dateEnd) wherePayables.dueDate = { [Op.lte]: dateEnd }; 
  const totalAPagarPendente = await FinancialTransaction.sum('value', { where: wherePayables }) || 0;

  const summary = {
    financialAccountId,
    accountName: account.accountName,
    accountType: account.accountType,
    ownerClientName: account.ownerClient?.name,
    totalEntradas: parseFloat(totalEntradasCaixa.toFixed(2)),
    totalSaidas: parseFloat(totalSaidasCaixa.toFixed(2)),
    saldoEfetivado,
    totalAReceberPendente: parseFloat(totalAReceberPendente.toFixed(2)),
    totalAPagarPendente: parseFloat(totalAPagarPendente.toFixed(2)),
    filtersApplied: filters
  };
  logger.info(`Resumo financeiro gerado para FinancialAccount ID ${financialAccountId}.`);
  return summary;
} catch (error) {
      logger.error(`Erro ao gerar resumo financeiro: ${error.message}`, { error });
      if(!error.statusCode) error.statusCode = 500;
      throw error;
  }
}


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
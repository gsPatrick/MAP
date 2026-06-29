// src/features/Financial/financial.service.js
const {
  FinancialTransaction,
  FinancialCategory,
  FinancialAccount,
  CreditCard,
  RecurringTransactionRule,
  StockMovement,
  Client,
  sequelize
} = require('../../database');
const { Op, fn, col, literal } = require('sequelize');
const dayjs = require('dayjs');
const logger = require('../../utils/logger');
const { calculateNextDueDate } = require('../../utils/dateUtils');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const { formatDate, formatCurrency } = require('../../utils/formatters'); // <<< ADICIONE ESTA LINHA
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');


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

    const requiredFields = ['description', 'type', 'value', 'transactionDate', 'paymentMethod'];
    for (const field of requiredFields) {
      if (transactionData[field] === undefined || transactionData[field] === null || String(transactionData[field]).trim() === '') {
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
      if (!card.isActive) {
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
    if (!options.transaction && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao criar transação para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, transactionData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function createParcelledAccount(financialAccountId, accountData, options = {}) {
  const { description, type, totalValue, initialDueDate, numberOfParcels = 1, transactionDate, ...commonData } = accountData;

  if (!description || !type || totalValue === undefined || !initialDueDate || numberOfParcels < 1) {
    const error = new Error('Descrição, tipo, valor total, data de vencimento inicial da primeira parcela e número de parcelas (mínimo 1) são obrigatórios.');
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  const parsedTotalValue = parseFloat(totalValue);
  if (parsedTotalValue <= 0) {
    const error = new Error('O valor total da conta parcelada deve ser maior que zero.');
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  const numParcelsInt = parseInt(numberOfParcels, 10);
  if (numParcelsInt < 1) {
    const error = new Error('O número de parcelas deve ser pelo menos 1.');
    error.statusCode = 400; error.status = 'fail'; throw error;
  }

  const t = options.transaction || await sequelize.transaction();
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
      if (!card.isActive) {
        const error = new Error(`Cartão de Crédito ID ${commonData.creditCardId} ("${card.name}") está inativo.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
      // Chamada para getAvailableCreditLimit não deve passar a transação 't' se ela gerencia a sua própria
      const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, commonData.creditCardId);
      if (parsedTotalValue > limitInfo.availableLimit) {
        const error = new Error(`Limite insuficiente no cartão "${card.name}" para a compra parcelada. Disponível: R$ ${limitInfo.availableLimit.toFixed(2)}, Valor total da compra: R$ ${parsedTotalValue.toFixed(2)}.`);
        error.statusCode = 409;
        error.status = 'fail'; throw error;
      }
    }

    const parcelValue = parseFloat((parsedTotalValue / numParcelsInt).toFixed(2));
    let accumulatedValue = 0;
    const createdParcelsModels = [];
    let firstParcelModel = null;

    const originalPurchaseDate = transactionDate || initialDueDate || new Date().toISOString().split('T')[0];

    for (let i = 1; i <= numParcelsInt; i++) {
      const currentParcelValue = (i === numParcelsInt) ? parseFloat((parsedTotalValue - accumulatedValue).toFixed(2)) : parcelValue;
      accumulatedValue += currentParcelValue;

      const parcelEffectiveDateObj = new Date(new Date(initialDueDate).toISOString().slice(0, 10) + 'T00:00:00.000Z');
      parcelEffectiveDateObj.setUTCMonth(parcelEffectiveDateObj.getUTCMonth() + (i - 1));
      const parcelEffectiveDateString = `${parcelEffectiveDateObj.getUTCFullYear()}-${String(parcelEffectiveDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(parcelEffectiveDateObj.getUTCDate()).padStart(2, '0')}`;

      const parcelDescription = numParcelsInt > 1 ? `${description} - Parcela ${i}/${numParcelsInt}` : description;

      const parcelData = {
        ...commonData,
        financialAccountId,
        description: parcelDescription,
        type,
        value: currentParcelValue,
        transactionDate: commonData.creditCardId ? parcelEffectiveDateString : originalPurchaseDate,
        isPayableOrReceivable: commonData.creditCardId ? false : true,
        isPaidOrReceived: commonData.creditCardId ? true : false, // No cartão, a "compra" da parcela é efetivada na data da parcela
        dueDate: commonData.creditCardId ? null : parcelEffectiveDateString,
        isParcel: numParcelsInt > 1,
        parcelNumber: numParcelsInt > 1 ? i : null,
        totalParcels: numParcelsInt > 1 ? numParcelsInt : null,
        originalAccountId: null, // Será preenchido depois
        // >>> CORREÇÃO IMPORTANTE AQUI <<<
        // Salvar o valor total da compra na transação "mãe" (primeira parcela)
        // E opcionalmente em todas as parcelas para referência, mas crucial na mãe.
        originalPurchaseTotalValue: (i === 1 || numParcelsInt === 1) ? parsedTotalValue : null // Salva na primeira parcela ou se for parcela única
      };

      const createdParcel = await FinancialTransaction.create(parcelData, { transaction: t });
      createdParcelsModels.push(createdParcel);

      if (i === 1) {
        firstParcelModel = createdParcel;
        // Se for parcela única e não for de cartão, ou se for a mãe de um parcelamento,
        // e o originalPurchaseTotalValue não foi setado acima (caso de numParcelsInt === 1), setar aqui.
        if (numParcelsInt === 1 && !firstParcelModel.originalPurchaseTotalValue) {
          await firstParcelModel.update({ originalPurchaseTotalValue: parsedTotalValue }, { transaction: t });
        }
      }
    }

    if (firstParcelModel) {
      // Atualiza todas as parcelas para apontar para o ID da primeira como originalAccountId
      // E garante que todas as parcelas (incluindo a primeira) tenham o originalPurchaseTotalValue
      for (let parcelModel of createdParcelsModels) {
        await parcelModel.update({
          originalAccountId: firstParcelModel.id,
          originalPurchaseTotalValue: parsedTotalValue // Garante que todas as parcelas tenham o valor total
        }, { transaction: t });
      }
    }

    if (!options.transaction) await t.commit();
    logger.info(`Conta parcelada "${description}" criada com ${numParcelsInt} parcelas para FinancialAccount ID ${financialAccountId}.`);

    const finalParcels = [];
    for (const pModel of createdParcelsModels) {
      finalParcels.push(await pModel.reload({
        transaction: null,
        include: [
          { model: FinancialTransaction, as: 'originalAccount', attributes: ['id', 'description', 'originalPurchaseTotalValue'] },
          { model: FinancialCategory, as: 'category' },
          { model: CreditCard, as: 'creditCard' }
        ]
      }).then(p => p.toJSON())
      );
    }

    return {
      message: numParcelsInt > 1 ? `Conta parcelada criada com ${numParcelsInt} parcelas.` : "Transação criada.",
      parcels: finalParcels
    };

  } catch (error) {
    if (!options.transaction && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao criar conta parcelada para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, accountData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}


async function getAllTransactions(financialAccountId, queryParams = {}, period = null) {
  try {
    await validateAndGetFinancialAccount(financialAccountId);
    const {
      page = 1, limit = 10, type, financialCategoryId, creditCardId,
      dateStart: queryDateStart, dateEnd: queryDateEnd,
      isPayableOrReceivable, isPaidOrReceived, dueBefore, dueAfter,
      search, sortBy = 'transactionDate', sortOrder = 'DESC'
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };

    if (type) whereConditions.type = type;
    if (financialCategoryId) whereConditions.financialCategoryId = financialCategoryId;
    if (creditCardId) whereConditions.creditCardId = creditCardId;

    let finalDateStart = queryDateStart;
    let finalDateEnd = queryDateEnd;

    if (period) {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" }));
      const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

      if (period === "hoje") {
        finalDateStart = today.toISOString().split('T')[0];
        finalDateEnd = today.toISOString().split('T')[0];
      } else if (period === "ontem") {
        const yesterday = new Date(today);
        yesterday.setUTCDate(today.getUTCDate() - 1);
        finalDateStart = yesterday.toISOString().split('T')[0];
        finalDateEnd = yesterday.toISOString().split('T')[0];
      } else if (period === "este_mes") {
        finalDateStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().split('T')[0];
        const lastDayOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
        finalDateEnd = lastDayOfMonth.toISOString().split('T')[0];
      } else if (period === "mes_passado") {
        const firstDayLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
        finalDateStart = firstDayLastMonth.toISOString().split('T')[0];
        const lastDayLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
        finalDateEnd = lastDayLastMonth.toISOString().split('T')[0];
      }
    }

    if (finalDateStart) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.gte]: finalDateStart };
    if (finalDateEnd) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.lte]: finalDateEnd };


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
        { model: FinancialTransaction, as: 'originalAccount', attributes: ['id', 'description', 'originalPurchaseTotalValue'] }
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
          required: false,
          include: [{ model: FinancialCategory, as: 'category' }, { model: CreditCard, as: 'creditCard' }]
        },
        {
          model: FinancialTransaction,
          as: 'originalAccount',
          required: false,
          attributes: ['id', 'description', 'originalPurchaseTotalValue', 'totalParcels']
        }
      ]
    });

    if (!transaction) {
      logger.warn(`Transação ID ${transactionId} não encontrada ou não pertence à FinancialAccount ID ${financialAccountId}.`);
      const error = new Error(`Transação ID ${transactionId} não encontrada.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
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

    if (transaction.isParcel && transaction.originalAccountId && transaction.originalAccountId !== transaction.id) {
      await t.rollback();
      const e = new Error('Parcelas individuais de uma compra parcelada não podem ser editadas diretamente desta forma. Edite a compra original ou exclua e recrie o grupo.');
      e.statusCode = 400; e.status = 'fail'; throw e;
    }
    if (transaction.isParcel && transaction.originalAccountId === transaction.id && (updateData.value || updateData.totalParcels || updateData.initialDueDate || updateData.originalPurchaseTotalValue)) {
      await t.rollback();
      const e = new Error('Para alterar valor, número de parcelas ou datas de uma compra parcelada, utilize a função de "refazer compra parcelada".');
      e.statusCode = 400; e.status = 'fail'; throw e;
    }


    if (updateData.financialCategoryId && updateData.financialCategoryId !== transaction.financialCategoryId && !(await FinancialCategory.findByPk(updateData.financialCategoryId, { transaction: t }))) {
      await t.rollback();
      const e = new Error('Categoria não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
    }

    const changingCardOrValue = (updateData.hasOwnProperty('creditCardId') && updateData.creditCardId !== transaction.creditCardId) ||
      (updateData.hasOwnProperty('value') && parseFloat(updateData.value) !== parseFloat(transaction.value));
    const targetCreditCardId = updateData.hasOwnProperty('creditCardId') ? updateData.creditCardId : transaction.creditCardId;
    const targetValue = updateData.hasOwnProperty('value') ? parseFloat(updateData.value) : parseFloat(transaction.value);
    const targetType = updateData.hasOwnProperty('type') ? updateData.type : transaction.type;


    if (targetCreditCardId && targetType === 'Saída' && changingCardOrValue) {
      const card = await CreditCard.findOne({ where: { id: targetCreditCardId, financialAccountId }, transaction: t });
      if (!card) {
        await t.rollback();
        const e = new Error('Cartão de crédito não encontrado.'); e.statusCode = 404; e.status = 'fail'; throw e;
      }
      if (!card.isActive && targetCreditCardId !== null) {
        await t.rollback();
        const error = new Error(`Cartão de Crédito ID ${targetCreditCardId} ("${card.name}") está inativo.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
      }

      const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, targetCreditCardId);
      let availableAfterOldTx = limitInfo.availableLimit;
      if (transaction.creditCardId === targetCreditCardId && transaction.type === 'Saída') {
        // Se a transação for parcelada "mãe", usar o originalPurchaseTotalValue para devolver ao limite
        if (transaction.isParcel && transaction.originalAccountId === transaction.id && transaction.originalPurchaseTotalValue) {
          availableAfterOldTx += parseFloat(transaction.originalPurchaseTotalValue);
        } else { // Compra à vista ou parcela filha (embora não deva chegar aqui para filha)
          availableAfterOldTx += parseFloat(transaction.value);
        }
      }

      // O 'targetValue' aqui, se for uma transação mãe de parcelamento,
      // deveria ser o 'originalPurchaseTotalValue' para a validação de limite.
      // Mas a edição direta de valor de mãe parcelada foi bloqueada acima.
      // Esta lógica é para transações não parceladas ou à vista.
      if (targetCreditCardId !== null && targetValue > availableAfterOldTx) {
        await t.rollback();
        const error = new Error(`Atualização resultaria em limite insuficiente no cartão "${card.name}". Disponível (considerando ajuste): R$ ${availableAfterOldTx.toFixed(2)}, Novo valor: R$ ${targetValue.toFixed(2)}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
    }

    delete updateData.financialAccountId;

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
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao atualizar transação ID ${transactionId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function markAsPaidOrReceived(financialAccountId, transactionId, paymentDate = null) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);
    const transaction = await FinancialTransaction.findOne({ where: { id: transactionId, financialAccountId }, transaction: t });
    if (!transaction) {
      await t.rollback();
      const e = new Error('Transação não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
    }
    if (!transaction.isPayableOrReceivable) {
      await t.rollback();
      const error = new Error('Esta transação não é uma conta a pagar/receber.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const updateData = {
      isPaidOrReceived: true,
      paymentDate: paymentDate || new Date().toISOString().split('T')[0]
    };
    await transaction.update(updateData, { transaction: t });
    await t.commit();
    return transaction.reload({ include: [{ model: FinancialCategory, as: 'category' }, { model: CreditCard, as: 'creditCard' }] }).then(tr => tr.toJSON());
  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao marcar transação ${transactionId} como paga/recebida: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function markTransactionAsPaidOrReceived(financialAccountId, description, value = null, paymentDate = null, financialCategoryName = null) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);
    const whereConditions = {
      financialAccountId,
      description: { [Op.iLike]: `%${description}%` },
      isPayableOrReceivable: true,
      isPaidOrReceived: false
    };
    if (value) {
      whereConditions.value = parseFloat(value);
    }
    if (financialCategoryName) {
      const category = await FinancialCategory.findOne({ where: { name: { [Op.iLike]: financialCategoryName } }, transaction: t });
      if (category) {
        whereConditions.financialCategoryId = category.id;
      } else {
        logger.warn(`Categoria "${financialCategoryName}" não encontrada ao tentar marcar transação como paga.`);
      }
    }

    const transactions = await FinancialTransaction.findAll({ where: whereConditions, order: [['dueDate', 'ASC']], transaction: t });

    if (transactions.length === 0) {
      await t.rollback();
      const e = new Error(`Nenhuma transação pendente encontrada com descrição similar a "${description}" e valor ${value ? formatCurrency(value) : 'qualquer'}.`);
      e.statusCode = 404; e.status = 'fail'; throw e;
    }
    if (transactions.length > 1) {
      logger.warn(`Múltiplas transações pendentes encontradas para "${description}". Marcando a mais próxima do vencimento.`);
    }
    const transactionToMark = transactions[0];

    const updateData = {
      isPaidOrReceived: true,
      paymentDate: paymentDate || new Date().toISOString().split('T')[0]
    };
    await transactionToMark.update(updateData, { transaction: t });
    await t.commit();
    return transactionToMark.reload({ include: [{ model: FinancialCategory, as: 'category' }, { model: CreditCard, as: 'creditCard' }] }).then(tr => tr.toJSON());
  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao marcar transação por descrição "${description}" como paga/recebida: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
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
        const error = new Error(`Esta é a transação principal de um parcelamento com ${childParcelsCount} outras parcelas. Para excluí-la, use a opção de excluir o grupo de parcelas (via compra parcelada) ou remova as parcelas dependentes primeiro.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
    }

    // Limpeza defensiva de referências antes de excluir. O modelo define onDelete: 'SET NULL'
    // para estes vínculos, mas em produção o schema foi criado via sync e a regra real da FK
    // pode estar como NO ACTION/RESTRICT — o que faria a exclusão falhar com erro de FK.
    // Zeramos as referências aqui para que a exclusão funcione independente da constraint do banco.
    await StockMovement.update(
      { relatedTransactionId: null },
      { where: { relatedTransactionId: transactionId }, transaction: t }
    );
    await FinancialTransaction.update(
      { originalAccountId: null },
      { where: { originalAccountId: transactionId, id: { [Op.ne]: transactionId } }, transaction: t }
    );

    await transaction.destroy({ transaction: t });
    await t.commit();
    logger.info(`Transação ID ${transactionId} excluída da FinancialAccount ID ${financialAccountId}.`);
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao excluir transação ID ${transactionId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}


async function getFinancialSummary(financialAccountId, filters = {}) {
  try {
    const account = await validateAndGetFinancialAccount(financialAccountId, null, [{ model: Client, as: 'ownerClient' }]);
    const { period, financialCategoryId, type } = filters; // <<< Pega o 'type' do filtro
    let { dateStart, dateEnd } = filters;

    let periodDescription = "Período Personalizado";
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ || "America/Sao_Paulo" }));
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

    if (period) {
      if (period === "hoje" || period === 'daily') {
        const dateToUse = today;
        dateStart = dateToUse.toISOString().split('T')[0];
        dateEnd = dateStart;
        periodDescription = `Hoje (${new Date(dateStart + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' })})`;
      } else if (period === "este_mes" || period === 'monthly') {
        dateStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().split('T')[0];
        dateEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().split('T')[0];
        periodDescription = `Este Mês (${new Date(dateStart + 'T00:00:00Z').toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })})`;
      } else if (period === 'esta_semana' || period === 'weekly') {
        const endDateWeekly = new Date(today);
        const startDateWeekly = new Date(endDateWeekly);
        startDateWeekly.setUTCDate(endDateWeekly.getUTCDate() - 6);
        dateStart = startDateWeekly.toISOString().split('T')[0];
        dateEnd = endDateWeekly.toISOString().split('T')[0];
        periodDescription = `Últimos 7 dias (${formatDate(dateStart)} a ${formatDate(dateEnd)})`;
      }
    } else if (dateStart && dateEnd) {
      periodDescription = `De ${formatDate(dateStart)} a ${formatDate(dateEnd)}`;
    }

    const baseWhere = { financialAccountId };
    if (financialCategoryId) baseWhere.financialCategoryId = financialCategoryId;

    const wherePeriod = {};
    if (dateStart) wherePeriod.transactionDate = { [Op.gte]: dateStart };
    if (dateEnd) wherePeriod.transactionDate = { ...wherePeriod.transactionDate, [Op.lte]: dateEnd };

    // <<< INÍCIO DA MUDANÇA >>>
    // Aplica o filtro de tipo se ele for fornecido
    if (type) {
      wherePeriod.type = type;
    }

    let totalIncome = 0;
    let totalExpenses = 0;
    let expenseBreakdown = [];

    // Calcula os totais e detalhamentos condicionalmente
    if (type !== 'Saída') {
      totalIncome = await FinancialTransaction.sum('value', { where: { ...baseWhere, ...wherePeriod, type: 'Entrada' } }) || 0;
    }
    if (type !== 'Entrada') {
      totalExpenses = await FinancialTransaction.sum('value', { where: { ...baseWhere, ...wherePeriod, type: 'Saída' } }) || 0;

      expenseBreakdown = await FinancialTransaction.findAll({
        where: { ...baseWhere, ...wherePeriod, type: 'Saída' },
        attributes: [
          'financialCategoryId',
          [sequelize.fn('SUM', sequelize.col('value')), 'totalValue']
        ],
        include: [{ model: FinancialCategory, as: 'category', attributes: ['name'] }],
        group: ['financialCategoryId', 'category.id'],
        order: [[sequelize.fn('SUM', sequelize.col('value')), 'DESC']],
        raw: true,
        nest: true
      }).then(results => results.map(r => ({
        categoryName: r.category.name || 'Sem Categoria',
        totalValue: parseFloat(r.totalValue)
      })));
    }

    // --- NOVA LÓGICA: Totais por Forma de Pagamento ---
    const totalPix = await FinancialTransaction.sum('value', { where: { ...baseWhere, ...wherePeriod, paymentMethod: 'Pix' } }) || 0;
    const totalCash = await FinancialTransaction.sum('value', { where: { ...baseWhere, ...wherePeriod, paymentMethod: 'Dinheiro' } }) || 0;
    const totalCreditCard = await FinancialTransaction.sum('value', { where: { ...baseWhere, ...wherePeriod, paymentMethod: 'Cartão de Crédito' } }) || 0;

    // --- NOVA LÓGICA: Média Mensal de Gastos (para Alertas no Front) ---
    const threeMonthsAgo = dayjs().subtract(3, 'month').startOf('month').format('YYYY-MM-DD');

    // Dialect-aware month grouping
    const dialect = sequelize.getDialect();
    let monthExpression;
    if (dialect === 'postgres') {
      monthExpression = sequelize.fn('TO_CHAR', sequelize.col('transactionDate'), 'YYYY-MM');
    } else if (dialect === 'mysql') {
      monthExpression = sequelize.fn('DATE_FORMAT', sequelize.col('transactionDate'), '%Y-%m');
    } else {
      // SQLite
      monthExpression = sequelize.fn('strftime', '%Y-%m', sequelize.col('transactionDate'));
    }

    const avgExpensesRes = await FinancialTransaction.findAll({
      where: { ...baseWhere, type: 'Saída', transactionDate: { [Op.gte]: threeMonthsAgo } },
      attributes: [
        [sequelize.fn('SUM', sequelize.col('value')), 'total'],
        [monthExpression, 'month']
      ],
      group: [sequelize.literal(dialect === 'postgres' ? "TO_CHAR(\"transactionDate\", 'YYYY-MM')" : dialect === 'mysql' ? "DATE_FORMAT(transactionDate, '%Y-%m')" : "strftime('%Y-%m', transactionDate)")],
      raw: true
    });

    // Fallback para outros bancos se não for SQLite (mas este projeto usa SQLite em dev/prod conforme context)
    // Se precisar de compatibilidade total, pode-se usar uma lógica JS após buscar gastos dos últimos 90 dias.
    const totalExpenseSum = avgExpensesRes.reduce((sum, row) => sum + parseFloat(row.total || 0), 0);
    const averageMonthlyExpenses = avgExpensesRes.length > 0 ? totalExpenseSum / avgExpensesRes.length : totalExpenses;

    // Pendências são sempre gerais, então não aplicamos o filtro de tipo aqui
    const totalToReceivePending = await FinancialTransaction.sum('value', { where: { ...baseWhere, type: 'Entrada', isPayableOrReceivable: true, isPaidOrReceived: false } });
    const totalToPayPending = await FinancialTransaction.sum('value', { where: { ...baseWhere, type: 'Saída', isPayableOrReceivable: true, isPaidOrReceived: false } });

    // A lista de transações recentes respeitará o filtro de tipo
    const recentTransactions = await FinancialTransaction.findAll({
      where: { ...baseWhere, ...wherePeriod },
      include: [{ model: FinancialCategory, as: 'category', attributes: ['name'] }],
      order: [['transactionDate', 'ASC']],
      limit: 15
    });

    // --- NOVA LÓGICA: Previsão de Parcelas Futuras ---
    const futureSummary = await getFutureInstallmentsSummary(financialAccountId);

    const summary = {
      financialAccountId,
      accountName: account.accountName,
      periodDescription,
      totalIncome,
      totalExpenses,
      netBalance: totalIncome - totalExpenses,
      totalToReceivePending: totalToReceivePending || 0,
      totalToPayPending: totalToPayPending || 0,
      expenseBreakdown,
      totalPix,
      totalCash,
      totalCreditCard,
      averageMonthlyExpenses,
      futureForecast: futureSummary,
      recentTransactions,
      type
    };

    logger.info(`Resumo financeiro completo gerado para FinancialAccount ID ${financialAccountId}.`);
    return summary;
  } catch (error) {
    logger.error(`Erro ao gerar resumo financeiro completo: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Calcula o total que falta pagar em faturas futuras e agrupa por mês.
 */
async function getFutureInstallmentsSummary(financialAccountId) {
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const futureTxs = await FinancialTransaction.findAll({
      where: {
        financialAccountId,
        creditCardId: { [Op.ne]: null },
        transactionDate: { [Op.gt]: todayStr },
        type: 'Saída'
      },
      attributes: ['value', 'transactionDate']
    });

    const totalFutureDebt = futureTxs.reduce((sum, tx) => sum + parseFloat(tx.value), 0);

    // Agrupa por mês (YYYY-MM)
    const forecastMap = {};
    futureTxs.forEach(tx => {
      const monthKey = tx.transactionDate.substring(0, 7);
      if (!forecastMap[monthKey]) forecastMap[monthKey] = 0;
      forecastMap[monthKey] += parseFloat(tx.value);
    });

    const forecast = Object.entries(forecastMap)
      .map(([month, total]) => ({ month, total }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return {
      totalFutureDebt: parseFloat(totalFutureDebt.toFixed(2)),
      forecast
    };
  } catch (error) {
    logger.error(`Erro ao buscar resumo de parcelas futuras para conta ${financialAccountId}: ${error.message}`);
    return { totalFutureDebt: 0, forecast: [] };
  }
}


async function deleteParcelledAccountGroup(financialAccountId, originalAccountId) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);

    const originalTx = await FinancialTransaction.findOne({
      where: { id: originalAccountId, financialAccountId, originalAccountId: originalAccountId, isParcel: true },
      transaction: t
    });

    if (!originalTx) {
      await t.rollback();
      logger.warn(`Grupo de parcelamento com ID original ${originalAccountId} não encontrado ou não é uma transação principal de parcelamento para FinancialAccount ID ${financialAccountId}.`);
      const e = new Error('Grupo de parcelamento não encontrado ou inválido.'); e.statusCode = 404; e.status = 'fail'; throw e;
    }

    const numDeleted = await FinancialTransaction.destroy({
      where: {
        originalAccountId: originalAccountId,
        financialAccountId: financialAccountId
      },
      transaction: t
    });

    await t.commit();
    logger.info(`${numDeleted} transações do grupo de parcelamento (originalAccountId: ${originalAccountId}) foram excluídas da FinancialAccount ID ${financialAccountId}.`);
    return numDeleted > 0;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao excluir grupo de parcelas ID ${originalAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateParcelledAccountDescription(financialAccountId, originalAccountId, newBaseDescription) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);

    const parcelsToUpdate = await FinancialTransaction.findAll({
      where: { originalAccountId, financialAccountId, isParcel: true },
      transaction: t
    });

    if (!parcelsToUpdate || parcelsToUpdate.length === 0) {
      await t.rollback();
      const e = new Error('Nenhuma parcela encontrada para este grupo para atualizar a descrição.');
      e.statusCode = 404; e.status = 'fail'; throw e;
    }

    let updatedCount = 0;
    for (const parcel of parcelsToUpdate) {
      let updatedParcelDescription = newBaseDescription;
      if (parcel.parcelNumber && parcel.totalParcels) {
        updatedParcelDescription = `${newBaseDescription} - Parcela ${parcel.parcelNumber}/${parcel.totalParcels}`;
      }
      await parcel.update({ description: updatedParcelDescription }, { transaction: t });
      updatedCount++;
    }

    await t.commit();
    logger.info(`${updatedCount} parcelas do grupo ID ${originalAccountId} tiveram a descrição atualizada para base "${newBaseDescription}".`);
    return updatedCount;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao atualizar descrição do grupo de parcelas ID ${originalAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function recreateParcelledAccount(financialAccountId, originalAccountIdToDelete, newParcelFullData) {
  const t = await sequelize.transaction();
  try {
    await validateAndGetFinancialAccount(financialAccountId, t);
    logger.info(`Iniciando recriação da compra parcelada. Grupo antigo ID: ${originalAccountIdToDelete}`);

    const originalTxToDelete = await FinancialTransaction.findOne({
      where: { id: originalAccountIdToDelete, financialAccountId, originalAccountId: originalAccountIdToDelete, isParcel: true },
      transaction: t
    });
    if (!originalTxToDelete) {
      await t.rollback();
      const err = new Error(`Compra parcelada original com ID ${originalAccountIdToDelete} não encontrada ou inválida para recriação.`);
      err.statusCode = 404; err.status = 'fail'; throw err;
    }

    const numDeleted = await FinancialTransaction.destroy({
      where: {
        originalAccountId: originalAccountIdToDelete,
        financialAccountId: financialAccountId
      },
      transaction: t
    });
    logger.info(`${numDeleted} parcelas antigas do grupo ID ${originalAccountIdToDelete} foram excluídas.`);

    if (newParcelFullData.creditCardId && newParcelFullData.type === 'Saída') {
      const card = await CreditCard.findOne({ where: { id: newParcelFullData.creditCardId, financialAccountId }, transaction: t });
      if (!card) {
        const error = new Error(`Novo Cartão de Crédito ID ${newParcelFullData.creditCardId} não pertence à conta financeira ${financialAccountId}.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
      }
      if (!card.isActive) {
        const error = new Error(`Novo Cartão de Crédito ID ${newParcelFullData.creditCardId} ("${card.name}") está inativo.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
      const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, newParcelFullData.creditCardId);
      if (parseFloat(newParcelFullData.totalValue) > limitInfo.availableLimit) {
        const error = new Error(`Limite insuficiente no novo cartão "${card.name}" para a compra parcelada. Disponível: R$ ${limitInfo.availableLimit.toFixed(2)}, Valor total da compra: R$ ${parseFloat(newParcelFullData.totalValue).toFixed(2)}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
    }

    const recreatedResult = await createParcelledAccount(financialAccountId, newParcelFullData, { transaction: t });

    await t.commit();
    logger.info(`Compra parcelada (original ID: ${originalAccountIdToDelete}) recriada com sucesso com novos dados.`);
    return recreatedResult;

  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao recriar compra parcelada (original ID: ${originalAccountIdToDelete}): ${error.message}`, { error, newParcelFullData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getMonthlyTrend(financialAccountId, numberOfMonths = 6) {
  try {
    await validateAndGetFinancialAccount(financialAccountId);
    const results = [];
    const endDate = new Date(); // Mês atual

    for (let i = 0; i < numberOfMonths; i++) {
      const targetMonth = new Date(endDate.getFullYear(), endDate.getMonth() - i, 1);
      const monthStart = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1);
      const monthEnd = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0); // Último dia do mês

      const monthLabel = targetMonth.toLocaleString('pt-BR', { month: 'short', year: '2-digit' });

      // Receitas do mês
      const income = await FinancialTransaction.sum('value', {
        where: {
          financialAccountId,
          type: 'Entrada',
          transactionDate: {
            [Op.gte]: monthStart.toISOString().split('T')[0],
            [Op.lte]: monthEnd.toISOString().split('T')[0],
          },
          // Considerar apenas transações efetivadas (não pendentes de recebimento)
          // e não incluir pagamentos de fatura de cartão como "entrada" direta na conta (a menos que seja o fluxo desejado)
          [Op.or]: [
            { isPayableOrReceivable: false }, // Transações diretas
            { isPayableOrReceivable: true, isPaidOrReceived: true } // Contas a receber que foram recebidas
          ],
          creditCardId: null, // Receitas geralmente não estão em cartão de crédito (a menos que seja um estorno)
        },
      }) || 0;
      results.push({ month: monthLabel, type: 'Receitas', value: parseFloat(income.toFixed(2)) });

      // Despesas do mês
      const expenses = await FinancialTransaction.sum('value', {
        where: {
          financialAccountId,
          type: 'Saída',
          transactionDate: {
            [Op.gte]: monthStart.toISOString().split('T')[0],
            [Op.lte]: monthEnd.toISOString().split('T')[0],
          },
          // Considerar apenas transações efetivadas ou gastos no cartão
          [Op.or]: [
            { isPayableOrReceivable: false }, // Transações diretas (dinheiro, pix, débito)
            { isPayableOrReceivable: true, isPaidOrReceived: true }, // Contas a pagar que foram pagas
            { creditCardId: { [Op.ne]: null } } // Compras no cartão de crédito (já são "efetivadas" no cartão)
          ]
        },
      }) || 0;
      results.push({ month: monthLabel, type: 'Despesas', value: parseFloat(expenses.toFixed(2)) });
    }

    logger.info(`Tendência mensal gerada para FinancialAccount ID ${financialAccountId} para os últimos ${numberOfMonths} meses.`);
    return results.reverse(); // Reverte para ter o mês mais antigo primeiro
  } catch (error) {
    logger.error(`Erro ao gerar tendência mensal para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getExpenseCategorySummary(financialAccountId, dateStart, dateEnd) {
  try {
    await validateAndGetFinancialAccount(financialAccountId);

    const whereConditions = {
      financialAccountId,
      type: 'Saída',
    };

    if (dateStart) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.gte]: dateStart };
    if (dateEnd) whereConditions.transactionDate = { ...whereConditions.dateEnd, [Op.lte]: dateEnd };

    const expensesByCategory = await FinancialTransaction.findAll({
      attributes: [
        'financialCategoryId',
        [sequelize.fn('SUM', sequelize.col('value')), 'totalValue']
      ],
      where: whereConditions,
      group: ['financialCategoryId'],
      raw: true,
    });

    // Mapeia os IDs para nomes de categorias
    const categoryIds = expensesByCategory.map(e => e.financialCategoryId).filter(id => id !== null);
    const categories = await FinancialCategory.findAll({
      where: { id: { [Op.in]: categoryIds } },
      attributes: ['id', 'name'],
      raw: true,
    });
    const categoryMap = categories.reduce((map, cat) => {
      map[cat.id] = cat.name;
      return map;
    }, {});

    const result = expensesByCategory.map(item => ({
      type: item.financialCategoryId ? categoryMap[item.financialCategoryId] : 'Sem Categoria',
      value: parseFloat(parseFloat(item.totalValue).toFixed(2))
    }));

    result.sort((a, b) => b.value - a.value);

    logger.info(`Resumo de categorias de despesa gerado para FinancialAccount ID ${financialAccountId}.`);
    return result;
  } catch (error) {
    logger.error(`Erro ao gerar resumo de categorias de despesa para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getIncomeCategorySummary(financialAccountId, dateStart, dateEnd) {
  try {
    await validateAndGetFinancialAccount(financialAccountId);

    const whereConditions = {
      financialAccountId,
      type: 'Entrada', // Apenas Receitas
    };

    if (dateStart) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.gte]: dateStart };
    if (dateEnd) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.lte]: dateEnd };

    const incomeByCategory = await FinancialTransaction.findAll({
      attributes: [
        'financialCategoryId',
        [sequelize.fn('SUM', sequelize.col('value')), 'totalValue']
      ],
      where: whereConditions,
      group: ['financialCategoryId'],
      raw: true,
    });

    const categoryIds = incomeByCategory.map(e => e.financialCategoryId).filter(id => id !== null);
    const categories = await FinancialCategory.findAll({
      where: { id: { [Op.in]: categoryIds } },
      attributes: ['id', 'name'],
      raw: true,
    });
    const categoryMap = categories.reduce((map, cat) => {
      map[cat.id] = cat.name;
      return map;
    }, {});

    const result = incomeByCategory.map(item => ({
      type: item.financialCategoryId ? categoryMap[item.financialCategoryId] : 'Sem Categoria',
      value: parseFloat(parseFloat(item.totalValue).toFixed(2))
    }));

    result.sort((a, b) => b.value - a.value);

    logger.info(`Resumo de categorias de receita gerado para FinancialAccount ID ${financialAccountId}.`);
    return result;
  } catch (error) {
    logger.error(`Erro ao gerar resumo de categorias de receita para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}
async function getFilteredTransactions(financialAccountId, filters = {}) {
  try {
    const account = await validateAndGetFinancialAccount(financialAccountId); // Valida a conta

    const whereConditions = { financialAccountId };

    if (filters.type) whereConditions.type = filters.type;
    if (filters.financialCategoryId) whereConditions.financialCategoryId = filters.financialCategoryId;
    if (filters.creditCardId) whereConditions.creditCardId = filters.creditCardId;

    // Filtros de data
    if (filters.dateStart) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.gte]: filters.dateStart };
    if (filters.dateEnd) whereConditions.transactionDate = { ...whereConditions.transactionDate, [Op.lte]: filters.dateEnd };

    // Filtros booleanos
    if (filters.isPayableOrReceivable !== undefined) {
      whereConditions.isPayableOrReceivable = filters.isPayableOrReceivable;
      if (filters.isPaidOrReceived !== undefined) {
        whereConditions.isPaidOrReceived = filters.isPaidOrReceived;
      }
      if (filters.dueBefore) whereConditions.dueDate = { ...whereConditions.dueDate, [Op.lte]: filters.dueBefore };
      if (filters.dueAfter) whereConditions.dueDate = { ...whereConditions.dueDate, [Op.gte]: filters.dueAfter };
    }

    // Campo de busca
    if (filters.search) {
      whereConditions[Op.or] = [
        { description: { [Op.iLike]: `%${filters.search}%` } },
        { notes: { [Op.iLike]: `%${filters.search}%` } }
      ];
    }

    // Ordenação
    const validSortOrders = ['ASC', 'DESC'];
    let sortField = filters.sortBy || 'transactionDate';
    let sortDirection = validSortOrders.includes(filters.sortOrder?.toUpperCase()) ? filters.sortOrder.toUpperCase() : 'DESC';

    const order = [[sortField, sortDirection]];
    // Adicionar um desempate por data de criação ou ID para garantir consistência
    if (sortField !== 'createdAt') order.push(['createdAt', 'DESC']);

    // Paginação
    const page = parseInt(filters.page, 10) || 1;
    const limit = parseInt(filters.limit, 10) || 10;
    const offset = (page - 1) * limit;

    const { count, rows } = await FinancialTransaction.findAndCountAll({
      where: whereConditions,
      include: [
        { model: FinancialCategory, as: 'category', attributes: ['id', 'name'] },
        { model: CreditCard, as: 'creditCard', attributes: ['id', 'name', 'lastFourDigits'] },
      ],
      limit: limit,
      offset: offset,
      order: order,
      distinct: true, // Conta corretamente o total de itens
    });

    logger.info(`Filtradas ${rows.length} transações para FinancialAccount ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      transactions: rows.map(t => t.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao filtrar transações para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, filters });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function generateMonthlyReportPdf(financialAccountId, month, year) {
  try {
    const { Client } = require('../../database');
    const account = await validateAndGetFinancialAccount(financialAccountId, null, [{ model: Client, as: 'ownerClient' }]);
    const dateStart = new Date(Date.UTC(year, month - 1, 1)).toISOString().split('T')[0];
    const dateEnd = new Date(Date.UTC(year, month, 0)).toISOString().split('T')[0];

    const summary = await getFinancialSummary(financialAccountId, { dateStart, dateEnd });

    // Lista todas as transações para o PDF
    const { transactions } = await getAllTransactions(financialAccountId, { dateStart, dateEnd, limit: 1000 });

    const doc = new PDFDocument({ margin: 50 });
    const fileName = `Relatorio_${account.accountName.replace(/\s+/g, '_')}_${month}_${year}.pdf`;
    const reportsDir = path.join(process.cwd(), 'temp_reports');

    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const filePath = path.join(reportsDir, fileName);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Layout do PDF
    doc.fontSize(20).text(`Relatório Financeiro Mensal`, { align: 'center' });
    doc.fontSize(14).text(`${account.accountName}`, { align: 'center' });
    doc.fontSize(12).text(`Período: ${month}/${year}`, { align: 'center' });
    doc.moveDown();

    doc.lineCap('butt').moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();

    doc.fontSize(14).text('Resumo Financeiro');
    doc.fontSize(12).text(`Receitas: ${formatCurrency(summary.totalIncome)}`);
    doc.fontSize(12).text(`Despesas: ${formatCurrency(summary.totalExpenses)}`);
    doc.fontSize(12).text(`Saldo Líquido: ${formatCurrency(summary.netBalance)}`);
    doc.moveDown();

    doc.fontSize(14).text('Totais por Forma de Pagamento');
    doc.fontSize(12).text(`Pix: ${formatCurrency(summary.totalPix || 0)}`);
    doc.fontSize(12).text(`Dinheiro: ${formatCurrency(summary.totalCash || 0)}`);
    doc.fontSize(12).text(`Cartão de Crédito: ${formatCurrency(summary.totalCreditCard || 0)}`);
    doc.moveDown();

    doc.lineCap('butt').moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();

    doc.fontSize(14).text('Detalhamento de Transações');
    doc.moveDown(0.5);

    transactions.forEach((tx) => {
      doc.fontSize(10).text(`${formatDate(tx.transactionDate)} - ${tx.description} - ${formatCurrency(tx.value)} (${tx.paymentMethod})`);
    });

    doc.end();

    await new Promise((resolve) => stream.on('finish', resolve));

    // URL para acesso externo ao relatório
    const baseUrl = process.env.BASE_URL || 'https://geral-agentewhatsappapi.r954jc.easypanel.host';
    const publicUrl = `${baseUrl}/reports/${fileName}`;
    return { fileName, filePath, publicUrl };

  } catch (error) {
    logger.error(`Erro ao gerar PDF mensal para conta ${financialAccountId}: ${error.message}`);
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
  markTransactionAsPaidOrReceived,
  deleteTransaction,
  getFinancialSummary,
  getMonthlyTrend,
  getExpenseCategorySummary,
  getIncomeCategorySummary,
  getFilteredTransactions,
  validateAndGetFinancialAccount,
  generateMonthlyReportPdf,
  getFutureInstallmentsSummary
};
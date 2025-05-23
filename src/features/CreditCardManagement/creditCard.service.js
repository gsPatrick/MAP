// src/features/Financial/financial.service.js
const {
  FinancialTransaction,
  FinancialCategory,
  FinancialAccount,
  CreditCard,
  // RecurringTransactionRule, // Não usado diretamente aqui, mas pode ser relevante em outros contextos
  Client, // Adicionado para validação de conta
  sequelize
} = require('../../database');
const { Op, fn, col, literal } = require('sequelize');
const logger = require('../../utils/logger');
const { calculateNextDueDate } = require('../../utils/dateUtils');
const creditCardService = require('../CreditCardManagement/creditCard.service');
const systemService = require('../System/system.service'); // <<< IMPORTAR systemService

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
        if (transactionData[field] === undefined || transactionData[field] === null || String(transactionData[field]).trim() === '') {
            const error = new Error(`Campo obrigatório "${field}" não fornecido para a transação.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }
    
    // <<< MODIFICAÇÃO PARA CATEGORIA POR NOME >>>
    let categoryIdToUse = null;
    if (transactionData.financialCategoryName) { // Espera financialCategoryName
        const category = await systemService.findFinancialCategoryByNameAndType(transactionData.financialCategoryName, transactionData.type, financialAccountId);
        if (category) {
            categoryIdToUse = category.id;
        } else {
            logger.warn(`[FIN SERVICE - createTransaction] Categoria "${transactionData.financialCategoryName}" não encontrada. Tentando "Outras" ou sem categoria.`);
            const otherCategory = await systemService.findFinancialCategoryByNameAndType("Outras", transactionData.type, financialAccountId) || await systemService.findFinancialCategoryByNameAndType("Outros", transactionData.type, financialAccountId);
            if(otherCategory) categoryIdToUse = otherCategory.id;
        }
    } else if (transactionData.financialCategoryId) { // Mantém compatibilidade se ID for enviado
        if (!(await FinancialCategory.findByPk(transactionData.financialCategoryId, { transaction: t }))) {
            const error = new Error(`Categoria financeira com ID ${transactionData.financialCategoryId} não encontrada.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        categoryIdToUse = transactionData.financialCategoryId;
    }
    // <<< FIM DA MODIFICAÇÃO DE CATEGORIA >>>


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
        // Validação de limite para compra à vista no cartão
        const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, transactionData.creditCardId); // Não passar 't' aqui
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
      { ...transactionData, financialAccountId, financialCategoryId: categoryIdToUse }, // Usa categoryIdToUse
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
    // accountData aqui deve ter financialCategoryName em vez de financialCategoryId (ou ambos para flexibilidade)
    const { description, type, totalValue, initialDueDate, numberOfParcels = 1, transactionDate, financialCategoryName, ...commonData } = accountData;


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

      // <<< MODIFICAÇÃO PARA CATEGORIA POR NOME >>>
      let categoryIdToUseParcel = null;
      if (financialCategoryName) {
          const category = await systemService.findFinancialCategoryByNameAndType(financialCategoryName, type, financialAccountId);
          if (category) {
              categoryIdToUseParcel = category.id;
          } else {
              logger.warn(`[FIN SERVICE - createParcelledAccount] Categoria "${financialCategoryName}" não encontrada. Tentando "Outras" ou sem categoria.`);
              const otherCategory = await systemService.findFinancialCategoryByNameAndType("Outras", type, financialAccountId) || await systemService.findFinancialCategoryByNameAndType("Outros", type, financialAccountId);
              if(otherCategory) categoryIdToUseParcel = otherCategory.id;
          }
      } else if (commonData.financialCategoryId) { // Mantém compatibilidade se ID for enviado em commonData
          if (!(await FinancialCategory.findByPk(commonData.financialCategoryId, { transaction: t }))) {
              const error = new Error(`Categoria financeira com ID ${commonData.financialCategoryId} não encontrada.`);
              error.statusCode = 404; error.status = 'fail'; throw error;
          }
          categoryIdToUseParcel = commonData.financialCategoryId;
      }
      // <<< FIM DA MODIFICAÇÃO DE CATEGORIA >>>


      if (commonData.creditCardId && type === 'Saída') {
          const card = await CreditCard.findOne({ where: { id: commonData.creditCardId, financialAccountId }, transaction: t });
          if (!card) {
              const error = new Error(`Cartão de Crédito ID ${commonData.creditCardId} não encontrado ou não pertence à conta financeira ${financialAccountId}.`);
              error.statusCode = 404; error.status = 'fail'; throw error;
          }
           if(!card.isActive){
              const error = new Error(`Cartão de Crédito ID ${commonData.creditCardId} ("${card.name}") está inativo.`);
              error.statusCode = 400; error.status = 'fail'; throw error;
          }
          const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, commonData.creditCardId); // Não passar 't'
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

        const parcelEffectiveDateObj = new Date(new Date(initialDueDate).toISOString().slice(0,10) + 'T00:00:00.000Z');
        parcelEffectiveDateObj.setUTCMonth(parcelEffectiveDateObj.getUTCMonth() + (i - 1));
        const parcelEffectiveDateString = `${parcelEffectiveDateObj.getUTCFullYear()}-${String(parcelEffectiveDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(parcelEffectiveDateObj.getUTCDate()).padStart(2, '0')}`;

        const parcelDescription = numParcelsInt > 1 ? `${description} - Parcela ${i}/${numParcelsInt}` : description;

        const parcelDataForDb = {
          ...commonData,
          financialAccountId,
          description: parcelDescription,
          type,
          value: currentParcelValue,
          transactionDate: commonData.creditCardId ? parcelEffectiveDateString : originalPurchaseDate,
          isPayableOrReceivable: commonData.creditCardId ? false : true,
          isPaidOrReceived: commonData.creditCardId ? true : false,
          dueDate: commonData.creditCardId ? null : parcelEffectiveDateString,
          isParcel: numParcelsInt > 1,
          parcelNumber: numParcelsInt > 1 ? i : null,
          totalParcels: numParcelsInt > 1 ? numParcelsInt : null,
          originalAccountId: null,
          originalPurchaseTotalValue: (i === 1 || numParcelsInt === 1) ? parsedTotalValue : null,
          financialCategoryId: categoryIdToUseParcel // Usa o ID da categoria encontrado
        };

        const createdParcel = await FinancialTransaction.create(parcelDataForDb, { transaction: t });
        createdParcelsModels.push(createdParcel);

        if (i === 1) {
          firstParcelModel = createdParcel;
          if (numParcelsInt === 1 && !firstParcelModel.originalPurchaseTotalValue) {
              await firstParcelModel.update({ originalPurchaseTotalValue: parsedTotalValue }, { transaction: t });
          }
        }
      }

      if (firstParcelModel) {
          for (let parcelModel of createdParcelsModels) {
              await parcelModel.update({ 
                  originalAccountId: firstParcelModel.id,
                  originalPurchaseTotalValue: parsedTotalValue 
                }, { transaction: t });
          }
      }
      
      if (!options.transaction) await t.commit();
      logger.info(`Conta parcelada "${description}" criada com ${numParcelsInt} parcelas para FA ID ${financialAccountId}.`);

      const finalParcels = [];
      for(const pModel of createdParcelsModels){
          finalParcels.push(await pModel.reload({
              transaction: null, // Fora da transação 't' se ela já foi commitada
              include: [
                  {model: FinancialTransaction, as: 'originalAccount', attributes:['id', 'description', 'originalPurchaseTotalValue']},
                  {model: FinancialCategory, as: 'category'},
                  {model: CreditCard, as: 'creditCard'}
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
      logger.error(`Erro ao criar conta parcelada para FA ID ${financialAccountId}: ${error.message}`, { error, accountData });
      if (!error.statusCode) error.statusCode = 500;
      throw error;
    }
}


async function getAllTransactions(financialAccountId, queryParams = {}, period = null) {
  try {
    await validateAndGetFinancialAccount(financialAccountId);
    const {
      page = 1, limit = 10, type, /* financialCategoryId, */ financialCategoryName, creditCardId, // Alterado para financialCategoryName
      dateStart: queryDateStart, dateEnd: queryDateEnd,
      isPayableOrReceivable, isPaidOrReceived, dueBefore, dueAfter,
      search, sortBy = 'transactionDate', sortOrder = 'DESC'
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };

    if (type) whereConditions.type = type;
    
    // <<< MODIFICAÇÃO PARA CATEGORIA POR NOME >>>
    if (financialCategoryName) {
        const category = await systemService.findFinancialCategoryByNameAndType(financialCategoryName, type, financialAccountId);
        if (category) {
            whereConditions.financialCategoryId = category.id;
        } else {
            // Se a categoria não for encontrada pelo nome, retorna lista vazia ou não aplica filtro de categoria.
            // Para retornar vazio se categoria não existe:
            // whereConditions.financialCategoryId = -1; // ID заведомо inexistente
            logger.warn(`[FIN SERVICE - getAllTransactions] Categoria "${financialCategoryName}" não encontrada, não será usada no filtro.`);
        }
    }
    // <<< FIM DA MODIFICAÇÃO DE CATEGORIA >>>

    if (creditCardId) whereConditions.creditCardId = creditCardId;

    let finalDateStart = queryDateStart;
    let finalDateEnd = queryDateEnd;

    if (period) {
        const now = new Date(new Date().toLocaleString("en-US", {timeZone: process.env.TZ || "America/Sao_Paulo"}));
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
        whereConditions.isPayableOrReceivable = (String(isPayableOrReceivable).toLowerCase() === 'true' || isPayableOrReceivable === true);
        if (isPaidOrReceived !== undefined && whereConditions.isPayableOrReceivable) {
            whereConditions.isPaidOrReceived = (String(isPaidOrReceived).toLowerCase() === 'true' || isPaidOrReceived === true);
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

    logger.info(`Listadas ${rows.length} transações para FA ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      transactions: rows.map(t => t.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar transações para FA ID ${financialAccountId}: ${error.message}`, { error });
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
          as: 'parcels', // Parcelas filhas desta transação (se ela for a "mãe")
          required: false,
          include: [{model: FinancialCategory, as: 'category'}, {model: CreditCard, as: 'creditCard'}]
        },
        {
            model: FinancialTransaction,
            as: 'originalAccount', // Transação "mãe" desta parcela (se esta for uma "filha")
            required: false,
            attributes: ['id', 'description', 'originalPurchaseTotalValue', 'totalParcels']
        }
      ]
    });

    if (!transaction) {
      const error = new Error(`Transação ID ${transactionId} não encontrada ou não pertence à conta financeira ID ${financialAccountId}.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    return transaction.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar transação ID ${transactionId} para FA ID ${financialAccountId}: ${error.message}`, { error });
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
      const e = new Error('Parcelas individuais de uma compra parcelada não podem ser editadas diretamente. Edite a compra original ou exclua e recrie o grupo de parcelas.');
      e.statusCode = 400; e.status = 'fail'; throw e;
    }
    if (transaction.isParcel && transaction.originalAccountId === transaction.id && (updateData.value || updateData.totalParcels || updateData.initialDueDate || updateData.originalPurchaseTotalValue) ) {
      await t.rollback();
      const e = new Error('Para alterar valor, número de parcelas ou datas de uma compra parcelada, utilize a função de "refazer compra parcelada" (API específica) ou edite cada parcela individualmente se permitido.');
      e.statusCode = 400; e.status = 'fail'; throw e;
    }

    // <<< MODIFICAÇÃO PARA CATEGORIA POR NOME >>>
    let categoryIdToUpdate = transaction.financialCategoryId; // Mantém a original se não houver alteração
    if (updateData.financialCategoryName) {
        const category = await systemService.findFinancialCategoryByNameAndType(updateData.financialCategoryName, updateData.type || transaction.type, financialAccountId);
        if (category) {
            categoryIdToUpdate = category.id;
        } else {
            logger.warn(`[FIN SERVICE - updateTransaction] Categoria "${updateData.financialCategoryName}" não encontrada. Mantendo categoria original ou removendo se não houver.`);
            // Se desejar remover a categoria se o nome novo não for encontrado: categoryIdToUpdate = null;
        }
    } else if (updateData.hasOwnProperty('financialCategoryId')) { // Se o ID foi passado diretamente
        if (updateData.financialCategoryId === null) { // Permitir remover categoria
            categoryIdToUpdate = null;
        } else if (!(await FinancialCategory.findByPk(updateData.financialCategoryId, { transaction: t }))) {
            await t.rollback();
            const e = new Error(`Categoria financeira ID ${updateData.financialCategoryId} para atualização não encontrada.`); e.statusCode = 404; e.status = 'fail'; throw e;
        } else {
            categoryIdToUpdate = updateData.financialCategoryId;
        }
    }
    updateData.financialCategoryId = categoryIdToUpdate; // Atualiza o updateData com o ID
    delete updateData.financialCategoryName; // Remove o nome do objeto de atualização
    // <<< FIM DA MODIFICAÇÃO DE CATEGORIA >>>


    const changingCardOrValue = (updateData.hasOwnProperty('creditCardId') && updateData.creditCardId !== transaction.creditCardId) ||
                              (updateData.hasOwnProperty('value') && parseFloat(updateData.value) !== parseFloat(transaction.value));
    const targetCreditCardId = updateData.hasOwnProperty('creditCardId') ? updateData.creditCardId : transaction.creditCardId;
    const targetValue = updateData.hasOwnProperty('value') ? parseFloat(updateData.value) : parseFloat(transaction.value);
    const targetType = updateData.hasOwnProperty('type') ? updateData.type : transaction.type;


    if (targetCreditCardId && targetType === 'Saída' && changingCardOrValue) {
        const card = await CreditCard.findOne({ where: { id: targetCreditCardId, financialAccountId }, transaction: t });
        if (!card) {
            await t.rollback();
            const e = new Error(`Cartão de crédito ID ${targetCreditCardId} não encontrado ou não pertence à conta.`); e.statusCode = 404; e.status = 'fail'; throw e;
        }
        if (!card.isActive && targetCreditCardId !== null){ // Permite remover cartão (creditCardId = null)
             await t.rollback();
            const error = new Error(`Cartão de Crédito ID ${targetCreditCardId} ("${card.name}") está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, targetCreditCardId); // Não passar 't'
        let availableAfterOldTx = limitInfo.availableLimit;
        if (transaction.creditCardId === targetCreditCardId && transaction.type === 'Saída') {
            if (transaction.isParcel && transaction.originalAccountId === transaction.id && transaction.originalPurchaseTotalValue) {
                availableAfterOldTx += parseFloat(transaction.originalPurchaseTotalValue);
            } else { 
                availableAfterOldTx += parseFloat(transaction.value);
            }
        }
        
        if (targetCreditCardId !== null && targetValue > availableAfterOldTx) {
            await t.rollback();
            const error = new Error(`Atualização resultaria em limite insuficiente no cartão "${card.name}". Disponível (considerando ajuste): R$ ${availableAfterOldTx.toFixed(2)}, Novo valor: R$ ${targetValue.toFixed(2)}.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    delete updateData.financialAccountId; // Não permitir mover entre contas

    await transaction.update(updateData, { transaction: t });
    const updatedTransaction = await transaction.reload({
        transaction: t,
        include: [
            { model: FinancialCategory, as: 'category' },
            { model: CreditCard, as: 'creditCard' }
        ]
    });

    await t.commit();
    logger.info(`Transação ID ${transactionId} atualizada para FA ID ${financialAccountId}.`);
    return updatedTransaction.toJSON();
  } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
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
            await t.rollback();
            const e = new Error('Transação não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }
        if (!transaction.isPayableOrReceivable) {
            await t.rollback();
            const error = new Error('Esta transação não é uma conta a pagar/receber e não pode ser marcada como liquidada desta forma.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        const updateData = {
            isPaidOrReceived: true,
            paymentDate: paymentDate || new Date().toISOString().split('T')[0]
        };
        await transaction.update(updateData, {transaction: t});
        await t.commit();
        const reloadedTx = await transaction.reload({include: [{model: FinancialCategory, as: 'category'}, {model: CreditCard, as: 'creditCard'}]});
        return reloadedTx.toJSON();
    } catch(error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao marcar transação ${transactionId} como paga/recebida: ${error.message}`, {error});
        if(!error.statusCode) error.statusCode = 500;
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
        // <<< MODIFICAÇÃO PARA CATEGORIA POR NOME >>>
        if (financialCategoryName) {
            const category = await systemService.findFinancialCategoryByNameAndType(financialCategoryName, null, financialAccountId); // Tipo pode ser inferido ou null
            if (category) {
                whereConditions.financialCategoryId = category.id;
            } else {
                logger.warn(`[FIN SERVICE - markTxAsPaid] Categoria "${financialCategoryName}" não encontrada. Filtro de categoria não será aplicado.`);
            }
        }
        // <<< FIM DA MODIFICAÇÃO DE CATEGORIA >>>

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
        const reloadedMarkedTx = await transactionToMark.reload({ include: [{model: FinancialCategory, as: 'category'}, {model: CreditCard, as: 'creditCard'}] });
        return reloadedMarkedTx.toJSON();
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
            const error = new Error(`Esta é a transação principal de um parcelamento com ${childParcelsCount} outras parcelas. Para excluí-la, use a opção de excluir o grupo de parcelas (se disponível) ou remova as parcelas dependentes primeiro.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    await transaction.destroy({ transaction: t });
    await t.commit();
    logger.info(`Transação ID ${transactionId} excluída da FA ID ${financialAccountId}.`);
    return true;
  } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao excluir transação ID ${transactionId}: ${error.message}`, {error});
        if(!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function getFinancialSummary(financialAccountId, filters = {}) {
  try {
    const account = await validateAndGetFinancialAccount(financialAccountId, null, [{model:Client, as: 'ownerClient'}]);
    const { dateStart, dateEnd, financialCategoryName, type } = filters; // Alterado para financialCategoryName
    const whereBase = { financialAccountId };

    // <<< MODIFICAÇÃO PARA CATEGORIA POR NOME >>>
    if (financialCategoryName) {
        const category = await systemService.findFinancialCategoryByNameAndType(financialCategoryName, type, financialAccountId);
        if (category) {
            whereBase.financialCategoryId = category.id;
        } else {
            logger.warn(`[FIN SERVICE - getSummary] Categoria "${financialCategoryName}" não encontrada para o resumo. Filtro de categoria não será aplicado.`);
        }
    }
    // <<< FIM DA MODIFICAÇÃO DE CATEGORIA >>>
    if (type) whereBase.type = type;

    let whereTransactionDate = {};
    if (dateStart) whereTransactionDate[Op.gte] = dateStart;
    if (dateEnd) whereTransactionDate[Op.lte] = dateEnd;
    if(Object.keys(whereTransactionDate).length > 0) whereBase.transactionDate = whereTransactionDate;

    const whereEffective = {
        ...whereBase,
        [Op.or]: [
            { isPayableOrReceivable: false, creditCardId: null },
            { isPayableOrReceivable: true, isPaidOrReceived: true, creditCardId: null }
        ]
    };
    const whereCardPayments = { // Pagamentos de fatura de cartão de crédito
        ...whereBase, // Respeita filtros de data e categoria se aplicados ao resumo geral
        type: 'Saída',
        description: { [Op.iLike]: '%Pagamento Fatura%' }, // Heurística para identificar pagamento de fatura
        creditCardId: null // Pagamento de fatura não tem creditCardId
    };


    const totalEntradasCaixa = await FinancialTransaction.sum('value', { where: { ...whereEffective, type: 'Entrada' } }) || 0;
    // Saídas de caixa incluem saídas diretas E pagamentos de fatura
    const totalSaidasDiretasCaixa = await FinancialTransaction.sum('value', { where: { ...whereEffective, type: 'Saída' } }) || 0;
    const totalPagamentosFatura = await FinancialTransaction.sum('value', { where: whereCardPayments }) || 0;
    const totalSaidasCaixa = totalSaidasDiretasCaixa + totalPagamentosFatura;


    const saldoEfetivado = parseFloat((totalEntradasCaixa - totalSaidasCaixa).toFixed(2));

    const whereReceivables = { financialAccountId, type: 'Entrada', isPayableOrReceivable: true, isPaidOrReceived: false, creditCardId: null };
    if (whereBase.financialCategoryId) whereReceivables.financialCategoryId = whereBase.financialCategoryId; // Adiciona filtro de categoria se presente
    if (dateEnd) whereReceivables.dueDate = { ...whereReceivables.dueDate, [Op.lte]: dateEnd }; // Considera dueDate para pendentes
    const totalAReceberPendente = await FinancialTransaction.sum('value', { where: whereReceivables }) || 0;

    const wherePayables = { financialAccountId, type: 'Saída', isPayableOrReceivable: true, isPaidOrReceived: false, creditCardId: null };
    if (whereBase.financialCategoryId) wherePayables.financialCategoryId = whereBase.financialCategoryId; // Adiciona filtro de categoria
    if (dateEnd) wherePayables.dueDate = { ...wherePayables.dueDate, [Op.lte]: dateEnd }; // Considera dueDate
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
      filtersApplied: { dateStart, dateEnd, financialCategoryName, type }
    };
    logger.info(`Resumo financeiro gerado para FA ID ${financialAccountId}.`);
    return summary;
  } catch (error) {
        logger.error(`Erro ao gerar resumo financeiro para FA ID ${financialAccountId}: ${error.message}`, { error });
        if(!error.statusCode) error.statusCode = 500;
        throw error;
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
            const e = new Error(`Grupo de parcelamento com ID original ${originalAccountId} não encontrado ou não é uma transação principal de parcelamento para a conta financeira ID ${financialAccountId}.`);
            e.statusCode = 404; e.status = 'fail'; throw e;
        }

        const numDeleted = await FinancialTransaction.destroy({
            where: {
                originalAccountId: originalAccountId,
                financialAccountId: financialAccountId
            },
            transaction: t
        });

        await t.commit();
        logger.info(`${numDeleted} transações do grupo de parcelamento (originalAccountId: ${originalAccountId}) foram excluídas da FA ID ${financialAccountId}.`);
        return numDeleted > 0;
    } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao excluir grupo de parcelas ID ${originalAccountId} (FA ID: ${financialAccountId}): ${error.message}`, { error });
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
            const e = new Error('Nenhuma parcela encontrada para este grupo (ID original: ${originalAccountId}) para atualizar a descrição.');
            e.statusCode = 404; e.status = 'fail'; throw e;
        }

        let updatedCount = 0;
        for (const parcel of parcelsToUpdate) {
            let updatedParcelDescription = newBaseDescription;
            if (parcel.parcelNumber && parcel.totalParcels && parcel.totalParcels > 1) { // Só adiciona sufixo se for realmente parcelado
                updatedParcelDescription = `${newBaseDescription} - Parcela ${parcel.parcelNumber}/${parcel.totalParcels}`;
            }
            await parcel.update({ description: updatedParcelDescription }, { transaction: t });
            updatedCount++;
        }

        await t.commit();
        logger.info(`${updatedCount} parcelas do grupo ID ${originalAccountId} (FA ID: ${financialAccountId}) tiveram a descrição atualizada para base "${newBaseDescription}".`);
        return updatedCount;
    } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao atualizar descrição do grupo de parcelas ID ${originalAccountId} (FA ID: ${financialAccountId}): ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function recreateParcelledAccount(financialAccountId, originalAccountIdToDelete, newParcelFullData) {
    const t = await sequelize.transaction();
    try {
        await validateAndGetFinancialAccount(financialAccountId, t);
        logger.info(`Iniciando recriação da compra parcelada para FA ID ${financialAccountId}. Grupo antigo ID: ${originalAccountIdToDelete}`);

        const originalTxToDelete = await FinancialTransaction.findOne({
            where: { id: originalAccountIdToDelete, financialAccountId, originalAccountId: originalAccountIdToDelete, isParcel: true },
            transaction: t
        });
        if (!originalTxToDelete) {
            await t.rollback();
            const err = new Error(`Compra parcelada original com ID ${originalAccountIdToDelete} não encontrada ou inválida para recriação na FA ID ${financialAccountId}.`);
            err.statusCode = 404; err.status = 'fail'; throw err;
        }

        // Deleção das parcelas antigas
        const numDeleted = await FinancialTransaction.destroy({
            where: { originalAccountId: originalAccountIdToDelete, financialAccountId: financialAccountId },
            transaction: t
        });
        logger.info(`${numDeleted} parcelas antigas do grupo ID ${originalAccountIdToDelete} foram excluídas da FA ID ${financialAccountId}.`);

        // Validação de limite do novo cartão, se aplicável
        if (newParcelFullData.creditCardId && newParcelFullData.type === 'Saída') {
            const card = await CreditCard.findOne({ where: { id: newParcelFullData.creditCardId, financialAccountId }, transaction: t });
            if (!card) {
                await t.rollback();
                const error = new Error(`Novo Cartão de Crédito ID ${newParcelFullData.creditCardId} não pertence à conta financeira ${financialAccountId}.`);
                error.statusCode = 404; error.status = 'fail'; throw error;
            }
            if (!card.isActive) {
                await t.rollback();
                const error = new Error(`Novo Cartão de Crédito ID ${newParcelFullData.creditCardId} ("${card.name}") está inativo.`);
                error.statusCode = 400; error.status = 'fail'; throw error;
            }
            const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, newParcelFullData.creditCardId); // Não passar 't'
            if (parseFloat(newParcelFullData.totalValue) > limitInfo.availableLimit) {
                 await t.rollback();
                const error = new Error(`Limite insuficiente no novo cartão "${card.name}" para a compra parcelada. Disponível: R$ ${limitInfo.availableLimit.toFixed(2)}, Valor total da compra: R$ ${parseFloat(newParcelFullData.totalValue).toFixed(2)}.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }
        
        // Criação do novo grupo de parcelas
        // Garante que newParcelFullData tenha financialCategoryName se for o caso, ou financialCategoryId
        let categoryIdForNewParcelGroup = null;
        if (newParcelFullData.financialCategoryName) {
            const category = await systemService.findFinancialCategoryByNameAndType(newParcelFullData.financialCategoryName, newParcelFullData.type, financialAccountId);
            if (category) categoryIdForNewParcelGroup = category.id;
            // Se não encontrar, pode deixar nulo ou usar "Outras"
        } else if (newParcelFullData.financialCategoryId) {
            categoryIdForNewParcelGroup = newParcelFullData.financialCategoryId;
        }
        
        const dataForCreation = {
            ...newParcelFullData,
            financialCategoryId: categoryIdForNewParcelGroup // Usa o ID encontrado/passado
        };
        delete dataForCreation.financialCategoryName; // Remove o nome se existia

        const recreatedResult = await createParcelledAccount(financialAccountId, dataForCreation, { transaction: t });

        await t.commit();
        logger.info(`Compra parcelada (original ID: ${originalAccountIdToDelete}) recriada com sucesso com novos dados para FA ID ${financialAccountId}.`);
        return recreatedResult;

    } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao recriar compra parcelada (original ID: ${originalAccountIdToDelete}, FA ID: ${financialAccountId}): ${error.message}`, { error, newParcelFullData });
        if (!error.statusCode) error.statusCode = 500;
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
  deleteParcelledAccountGroup,
  updateParcelledAccountDescription,
  recreateParcelledAccount,
};
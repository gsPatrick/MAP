// src/features/Financial/financial.service.js
const {
  FinancialTransaction,
  FinancialCategory,
  FinancialAccount,
  CreditCard,
  RecurringTransactionRule, // Certifique-se de que este modelo existe e está correto
  Client, // Certifique-se de que este modelo existe e está correto
  sequelize
} = require('../../database');
const { Op, fn, col, literal } = require('sequelize'); // fn, col, literal podem ser necessários
const logger = require('../../utils/logger');
const { calculateNextDueDate } = require('../../utils/dateUtils'); // Verifique o caminho
const creditCardService = require('../CreditCardManagement/creditCard.service');

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
        if (transactionData[field] === undefined || transactionData[field] === null || String(transactionData[field]).trim() === '') {
            const error = new Error(`Campo obrigatório "${field}" não fornecido para a transação.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }

    if (transactionData.financialCategoryId && !(await FinancialCategory.findByPk(transactionData.financialCategoryId, { transaction: t }))) {
      const error = new Error(`Categoria financeira com ID ${transactionData.financialCategoryId} não encontrada.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    // Validação de limite do cartão ANTES de criar a transação de saída
    if (transactionData.creditCardId && transactionData.type === 'Saída') {
        const card = await CreditCard.findOne({ where: { id: transactionData.creditCardId, financialAccountId }, transaction: t });
        if (!card) {
            const error = new Error(`Cartão de Crédito ID ${transactionData.creditCardId} não encontrado ou não pertence à conta financeira ID ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        if(!card.isActive){ // Verifica se o cartão está ativo
            const error = new Error(`Cartão de Crédito ID ${transactionData.creditCardId} ("${card.name}") está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        // Usa a função refatorada que não depende da query problemática
        const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, transactionData.creditCardId); // Não passa 't' pois getAvailableCreditLimit gerencia sua própria transação
        if (parseFloat(transactionData.value) > limitInfo.availableLimit) {
            const error = new Error(`Limite insuficiente no cartão "${card.name}". Disponível: R$ ${limitInfo.availableLimit.toFixed(2)}, Tentativa: R$ ${parseFloat(transactionData.value).toFixed(2)}.`);
            error.statusCode = 409; // Conflito
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

    if (!options.transaction) await t.commit(); // Só commita se esta função iniciou a transação
    logger.info(`Transação ID ${newTransaction.id} ("${newTransaction.description}") criada para FinancialAccount ID ${financialAccountId}.`);
    return newTransaction.toJSON();
  } catch (error) {
    if (!options.transaction) await t.rollback(); // Só faz rollback se esta função iniciou a transação
    logger.error(`Erro ao criar transação para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, transactionData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
* Registra uma conta parcelada para uma FinancialAccount.
* Cria a transação "mãe" e as transações "filhas" (parcelas).
* @param {number} financialAccountId - ID da conta financeira.
* @param {object} accountData - { description, type, totalValue, initialDueDate (primeira parcela), numberOfParcels, transactionDate (data da compra original), ...commonData }
* @returns {Promise<object>} Objeto com as parcelas criadas.
*/
async function createParcelledAccount(financialAccountId, accountData) {
    const { description, type, totalValue, initialDueDate, numberOfParcels = 1, transactionDate, ...commonData } = accountData;

    // Validações básicas
    if (!description || !type || totalValue === undefined || !initialDueDate || numberOfParcels < 1) {
      const error = new Error('Descrição, tipo, valor total, data de vencimento inicial da primeira parcela e número de parcelas (mínimo 1) são obrigatórios.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (parseFloat(totalValue) <= 0) {
        const error = new Error('O valor total da conta parcelada deve ser maior que zero.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const numParcelsInt = parseInt(numberOfParcels, 10);
    if (numParcelsInt < 1) {
        const error = new Error('O número de parcelas deve ser pelo menos 1.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const t = await sequelize.transaction();
    try {
      await validateAndGetFinancialAccount(financialAccountId, t);

      if (commonData.financialCategoryId && !(await FinancialCategory.findByPk(commonData.financialCategoryId, { transaction: t }))) {
          const error = new Error(`Categoria financeira ID ${commonData.financialCategoryId} não encontrada.`);
          error.statusCode = 404; error.status = 'fail'; throw error;
      }

      // Validação de limite do cartão para o VALOR TOTAL da compra
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
          // A função getAvailableCreditLimit já foi ajustada para não causar o erro de coluna.
          const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, commonData.creditCardId); // Não passa 't'
          if (parseFloat(totalValue) > limitInfo.availableLimit) {
              const error = new Error(`Limite insuficiente no cartão "${card.name}" para a compra parcelada. Disponível: R$ ${limitInfo.availableLimit.toFixed(2)}, Valor total da compra: R$ ${parseFloat(totalValue).toFixed(2)}.`);
              error.statusCode = 409; // Conflito
              error.status = 'fail'; throw error;
          }
      }

      // Calcula valor da parcela, com ajuste na última para bater o totalValue
      const parcelValue = parseFloat((parseFloat(totalValue) / numParcelsInt).toFixed(2));
      let accumulatedValue = 0;
      const createdParcelsModels = [];
      let firstParcelModel = null; // Guarda o modelo da primeira parcela para ser o originalAccountId

      const originalPurchaseDate = transactionDate || initialDueDate || new Date().toISOString().split('T')[0];

      for (let i = 1; i <= numParcelsInt; i++) {
        const currentParcelValue = (i === numParcelsInt) ? parseFloat((parseFloat(totalValue) - accumulatedValue).toFixed(2)) : parcelValue;
        accumulatedValue += currentParcelValue;

        // Calcula data de vencimento/transação da parcela
        const parcelEffectiveDateObj = new Date(new Date(initialDueDate).toISOString().slice(0,10) + 'T00:00:00.000Z'); // Garante UTC na base
        parcelEffectiveDateObj.setUTCMonth(parcelEffectiveDateObj.getUTCMonth() + (i - 1)); // Adiciona meses para parcelas futuras
        const parcelEffectiveDateString = `${parcelEffectiveDateObj.getUTCFullYear()}-${String(parcelEffectiveDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(parcelEffectiveDateObj.getUTCDate()).padStart(2, '0')}`;

        const parcelDescription = numParcelsInt > 1 ? `${description} - Parcela ${i}/${numParcelsInt}` : description;

        const parcelData = {
          ...commonData, // financialCategoryId, notes, creditCardId (se houver)
          financialAccountId,
          description: parcelDescription,
          type,
          value: currentParcelValue,
          // Para cartão, transactionDate é a data que a parcela entra na fatura.
          // Para outras contas a pagar, transactionDate é a data da compra original.
          transactionDate: commonData.creditCardId ? parcelEffectiveDateString : originalPurchaseDate,
          isPayableOrReceivable: commonData.creditCardId ? false : true, // No cartão, não é "a pagar" individualmente, entra na fatura
          isPaidOrReceived: commonData.creditCardId ? true : false,       // No cartão, a "compra" é feita, o pagamento é da fatura
          dueDate: commonData.creditCardId ? null : parcelEffectiveDateString, // dueDate para contas a pagar, não para lançamentos de cartão
          isParcel: numParcelsInt > 1,
          parcelNumber: numParcelsInt > 1 ? i : null,
          totalParcels: numParcelsInt > 1 ? numParcelsInt : null,
          originalAccountId: null, // Será preenchido após criar a primeira parcela
        };

        const createdParcel = await FinancialTransaction.create(parcelData, { transaction: t });
        createdParcelsModels.push(createdParcel);

        if (i === 1) {
          firstParcelModel = createdParcel; // Guarda o modelo da primeira parcela
        }
      }

      // Se for parcelado, atualiza todas as parcelas para apontar para o ID da primeira como originalAccountId
      if (numParcelsInt > 1 && firstParcelModel) {
          for (let parcelModel of createdParcelsModels) {
              await parcelModel.update({ originalAccountId: firstParcelModel.id }, { transaction: t });
          }
      } else if (numParcelsInt === 1 && createdParcelsModels.length === 1) {
          // Se for "parcela única", ela é a sua própria originalAccount
          await createdParcelsModels[0].update({ originalAccountId: createdParcelsModels[0].id }, { transaction: t });
      }

      await t.commit();
      logger.info(`Conta parcelada "${description}" criada com ${numParcelsInt} parcelas para FinancialAccount ID ${financialAccountId}.`);

      // Recarrega os modelos para incluir associações e garantir dados atualizados
      const finalParcels = [];
      for(const pModel of createdParcelsModels){
          // Inclui originalAccount para ter a descrição da compra "mãe" se necessário
          finalParcels.push(await pModel.reload({
              transaction: null, // Fora da transação 't' que já foi comitada
              include: [
                  {model: FinancialTransaction, as: 'originalAccount', attributes: ['id', 'description']},
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
      await t.rollback();
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
      dateStart: queryDateStart, dateEnd: queryDateEnd, // Renomeado para evitar conflito com variáveis
      isPayableOrReceivable, isPaidOrReceived, dueBefore, dueAfter,
      search, sortBy = 'transactionDate', sortOrder = 'DESC'
    } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };

    if (type) whereConditions.type = type;
    if (financialCategoryId) whereConditions.financialCategoryId = financialCategoryId;
    if (creditCardId) whereConditions.creditCardId = creditCardId;

    // Lógica de período (ex: "este_mes", "hoje")
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
            const lastDayOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)); // Dia 0 do próximo mês é o último do atual
            finalDateEnd = lastDayOfMonth.toISOString().split('T')[0];
        } else if (period === "mes_passado") {
            const firstDayLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
            finalDateStart = firstDayLastMonth.toISOString().split('T')[0];
            const lastDayLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
            finalDateEnd = lastDayLastMonth.toISOString().split('T')[0];
        }
        // Adicionar outras lógicas de período (esta_semana, semana_passada, etc.)
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
        { model: FinancialTransaction, as: 'originalAccount', attributes: ['id', 'description'] } // Para parcelas
      ],
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
      distinct: true, // Necessário se include causa duplicação
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
        { // Para buscar as parcelas filhas, se esta for uma transação mãe
          model: FinancialTransaction,
          as: 'parcels', // Assume que há um alias 'parcels' definido no modelo FinancialTransaction para originalAccountId -> id
          required: false, // Não falha se não houver parcelas filhas
          include: [{model: FinancialCategory, as: 'category'}, {model: CreditCard, as: 'creditCard'}]
        },
        { // Para buscar a transação mãe, se esta for uma parcela filha
            model: FinancialTransaction,
            as: 'originalAccount', // Alias para originalAccountId -> id
            required: false
        }
      ]
    });

    if (!transaction) {
      logger.warn(`Transação ID ${transactionId} não encontrada ou não pertence à FinancialAccount ID ${financialAccountId}.`);
      // Lança erro para ser tratado pelo controller
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

    // Restrições de edição para parcelas
    if (transaction.isParcel && transaction.originalAccountId && transaction.originalAccountId !== transaction.id) {
      // É uma parcela filha
      await t.rollback();
      const e = new Error('Parcelas individuais de uma compra parcelada não podem ser editadas diretamente desta forma. Edite a compra original ou exclua e recrie o grupo.');
      e.statusCode = 400; e.status = 'fail'; throw e;
    }
    // Se for a transação "mãe" de um parcelamento (originalAccountId === id), a edição de valor/parcelas etc. deve ser tratada por recreateParcelledAccount
    if (transaction.isParcel && transaction.originalAccountId === transaction.id && (updateData.value || updateData.totalParcels || updateData.initialDueDate) ) {
      await t.rollback();
      const e = new Error('Para alterar valor, número de parcelas ou datas de uma compra parcelada, utilize a função de "refazer compra" ou edite pela plataforma (se disponível).');
      e.statusCode = 400; e.status = 'fail'; throw e;
    }


    if (updateData.financialCategoryId && updateData.financialCategoryId !== transaction.financialCategoryId && !(await FinancialCategory.findByPk(updateData.financialCategoryId, { transaction: t }))) {
        await t.rollback();
        const e = new Error('Categoria não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
    }

    // Validação de limite do cartão se o valor ou o cartão estão mudando
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
        if (!card.isActive && targetCreditCardId !== null){ // Permite desassociar (creditCardId = null)
             await t.rollback();
            const error = new Error(`Cartão de Crédito ID ${targetCreditCardId} ("${card.name}") está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, targetCreditCardId); // Não passa 't'
        let availableAfterOldTx = limitInfo.availableLimit;
        // Se o cartão é o mesmo, o valor antigo da transação "volta" para o limite disponível para o cálculo do novo valor.
        if (transaction.creditCardId === targetCreditCardId && transaction.type === 'Saída') {
            availableAfterOldTx += parseFloat(transaction.value);
        }
        // Se o cartão está mudando para um novo cartão, availableAfterOldTx já é o limite correto do novo cartão.
        // Se está removendo o cartão (targetCreditCardId = null), não há validação de limite.

        if (targetCreditCardId !== null && targetValue > availableAfterOldTx) {
            await t.rollback();
            const error = new Error(`Atualização resultaria em limite insuficiente no cartão "${card.name}". Disponível (considerando ajuste): R$ ${availableAfterOldTx.toFixed(2)}, Novo valor: R$ ${targetValue.toFixed(2)}.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    delete updateData.financialAccountId; // Não permitir mover entre contas aqui

    await transaction.update(updateData, { transaction: t });
    // Recarrega a transação para obter dados atualizados, incluindo associações
    const updatedTransaction = await transaction.reload({
        transaction: t, // Continua na mesma transação para leitura consistente
        include: [
            { model: FinancialCategory, as: 'category' },
            { model: CreditCard, as: 'creditCard' }
        ]
    });

    await t.commit();
    logger.info(`Transação ID ${transactionId} atualizada para FinancialAccount ID ${financialAccountId}.`);
    return updatedTransaction.toJSON();
  } catch (error) {
        if (t && !t.finished) await t.rollback(); // Garante rollback se não comitado
        logger.error(`Erro ao atualizar transação ID ${transactionId}: ${error.message}`, {error, updateData});
        if(!error.statusCode) error.statusCode = 500;
        throw error;
   }
}

async function markAsPaidOrReceived(financialAccountId, transactionId, paymentDate = null) { // Renomeado para não conflitar com markTransactionAsPaidReceived
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

// Função para uso pela IA, pode ser mais flexível na busca
async function markTransactionAsPaidOrReceived(financialAccountId, description, value = null, paymentDate = null, financialCategoryName = null) {
    const t = await sequelize.transaction();
    try {
        await validateAndGetFinancialAccount(financialAccountId, t);
        const whereConditions = {
            financialAccountId,
            description: { [Op.iLike]: `%${description}%` },
            isPayableOrReceivable: true,
            isPaidOrReceived: false // Apenas pendentes
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
            // TODO: Idealmente, retornar uma lista para o usuário escolher ou pedir mais detalhes.
            // Por ora, pega a mais próxima do vencimento.
            logger.warn(`Múltiplas transações pendentes encontradas para "${description}". Marcando a mais próxima do vencimento.`);
        }
        const transactionToMark = transactions[0];

        const updateData = {
            isPaidOrReceived: true,
            paymentDate: paymentDate || new Date().toISOString().split('T')[0]
        };
        await transactionToMark.update(updateData, { transaction: t });
        await t.commit();
        return transactionToMark.reload({ include: [{model: FinancialCategory, as: 'category'}, {model: CreditCard, as: 'creditCard'}] }).then(tr => tr.toJSON());
    } catch (error) {
        await t.rollback();
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

    // Se for a transação "mãe" de um parcelamento, não permite deletar isoladamente.
    if (transaction.isParcel && transaction.originalAccountId === transaction.id) {
        const childParcelsCount = await FinancialTransaction.count({
            where: { originalAccountId: transaction.id, id: { [Op.ne]: transaction.id } }, // Exclui a própria "mãe" da contagem
            transaction: t
        });
        if (childParcelsCount > 0) {
            await t.rollback();
            const error = new Error(`Esta é a transação principal de um parcelamento com ${childParcelsCount} outras parcelas. Para excluí-la, utilize a opção de excluir o grupo de parcelas (pela compra parcelada) ou remova as parcelas dependentes primeiro.`);
            error.statusCode = 409; // Conflito
            error.status = 'fail'; throw error;
        }
    }
    // Se for uma parcela filha, permite deletar individualmente (pode causar inconsistência no total da compra original, mas é uma opção)
    // A UI/Bot pode querer alertar sobre isso.

    await transaction.destroy({ transaction: t });
    await t.commit();
    logger.info(`Transação ID ${transactionId} excluída da FinancialAccount ID ${financialAccountId}.`);
    return true;
  } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao excluir transação ID ${transactionId}: ${error.message}`, {error});
        if(!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function getFinancialSummary(financialAccountId, filters = {}) {
  try {
    const account = await validateAndGetFinancialAccount(financialAccountId, null, [{model:Client, as: 'ownerClient'}]); // Inclui ownerClient
    const { dateStart, dateEnd, financialCategoryId, type } = filters;
    const whereBase = { financialAccountId };

    if (financialCategoryId) whereBase.financialCategoryId = financialCategoryId;
    if (type) whereBase.type = type;

    let whereTransactionDate = {};
    if (dateStart) whereTransactionDate[Op.gte] = dateStart;
    if (dateEnd) whereTransactionDate[Op.lte] = dateEnd;
    if(Object.keys(whereTransactionDate).length > 0) whereBase.transactionDate = whereTransactionDate;

    // Transações que afetam o caixa (não são contas a pagar/receber pendentes e não são de cartão)
    // OU que são contas a pagar/receber que já foram pagas/recebidas.
    const whereEffective = {
        ...whereBase,
        [Op.or]: [
            { isPayableOrReceivable: false, creditCardId: null }, // À vista, não cartão
            { isPayableOrReceivable: true, isPaidOrReceived: true, creditCardId: null } // Contas liquidadas, não cartão
        ]
    };
    // Pagamentos de fatura de cartão (saídas da conta principal para pagar cartão)
    const whereCardPayments = {
        ...whereBase, // Filtros de data/categoria podem se aplicar ao pagamento da fatura
        type: 'Saída',
        // Idealmente, ter um financialCategoryId específico para "Pagamento de Fatura" ou identificar pela descrição
        description: { [Op.iLike]: '%Pagamento Fatura%' }, // Heurística
        creditCardId: null // Pagamento de fatura não tem creditCardId (sai da conta, não é gasto no cartão)
    };


    const totalEntradasCaixa = await FinancialTransaction.sum('value', { where: { ...whereEffective, type: 'Entrada' } }) || 0;
    let totalSaidasCaixa = await FinancialTransaction.sum('value', { where: { ...whereEffective, type: 'Saída' } }) || 0;
    // Adiciona pagamentos de fatura às saídas do caixa
    const totalPagamentoFaturas = await FinancialTransaction.sum('value', { where: whereCardPayments }) || 0;
    totalSaidasCaixa += totalPagamentoFaturas;


    const saldoEfetivado = parseFloat((totalEntradasCaixa - totalSaidasCaixa).toFixed(2));

    // Contas a Receber Pendentes (dueDate futura ou passada, mas não paga)
    const whereReceivables = { financialAccountId, type: 'Entrada', isPayableOrReceivable: true, isPaidOrReceived: false, creditCardId: null };
    if (dateEnd) whereReceivables.dueDate = { [Op.lte]: dateEnd }; // Considera pendentes até o fim do período
    const totalAReceberPendente = await FinancialTransaction.sum('value', { where: whereReceivables }) || 0;

    // Contas a Pagar Pendentes
    const wherePayables = { financialAccountId, type: 'Saída', isPayableOrReceivable: true, isPaidOrReceived: false, creditCardId: null };
    if (dateEnd) wherePayables.dueDate = { [Op.lte]: dateEnd };
    const totalAPagarPendente = await FinancialTransaction.sum('value', { where: wherePayables }) || 0;

    const summary = {
      financialAccountId,
      accountName: account.accountName,
      accountType: account.accountType,
      ownerClientName: account.ownerClient?.name, // Usa optional chaining
      totalEntradas: parseFloat(totalEntradasCaixa.toFixed(2)),
      totalSaidas: parseFloat(totalSaidasCaixa.toFixed(2)),
      saldoEfetivado, // Saldo das transações efetivamente movimentadas no caixa
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

/**
 * Exclui todas as transações de um grupo de parcelamento.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {number} originalAccountId - ID da transação original que agrupa as parcelas (a primeira parcela do grupo).
 * @returns {Promise<boolean>} True se o grupo foi excluído.
 */
async function deleteParcelledAccountGroup(financialAccountId, originalAccountId) {
    const t = await sequelize.transaction();
    try {
        await validateAndGetFinancialAccount(financialAccountId, t);

        // Verifica se o originalAccountId fornecido é de fato uma transação "mãe" de um parcelamento
        const originalTx = await FinancialTransaction.findOne({
            where: { id: originalAccountId, financialAccountId, originalAccountId: originalAccountId, isParcel: true },
            transaction: t
        });

        if (!originalTx) {
            await t.rollback();
            logger.warn(`Grupo de parcelamento com ID original ${originalAccountId} não encontrado ou não é uma transação principal de parcelamento para FinancialAccount ID ${financialAccountId}.`);
            const e = new Error('Grupo de parcelamento não encontrado ou inválido.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }

        // Deleta todas as transações que pertencem a este grupo de parcelamento (incluindo a "mãe")
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
        await t.rollback();
        logger.error(`Erro ao excluir grupo de parcelas ID ${originalAccountId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

/**
 * Atualiza a descrição de todas as transações de um grupo de parcelamento.
 * A nova descrição base será concatenada com " - Parcela X/Y".
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {number} originalAccountId - ID da transação original que agrupa as parcelas.
 * @param {string} newBaseDescription - Nova descrição base para as parcelas.
 * @returns {Promise<number>} Número de parcelas atualizadas.
 */
async function updateParcelledAccountDescription(financialAccountId, originalAccountId, newBaseDescription) {
    const t = await sequelize.transaction();
    try {
        await validateAndGetFinancialAccount(financialAccountId, t);

        const parcelsToUpdate = await FinancialTransaction.findAll({
            where: { originalAccountId, financialAccountId, isParcel: true }, // Apenas parcelas
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
            // Mantém a numeração da parcela na descrição, se houver
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
        await t.rollback();
        logger.error(`Erro ao atualizar descrição do grupo de parcelas ID ${originalAccountId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

/**
 * Recria um grupo de parcelas. Isso envolve deletar o grupo antigo e criar um novo.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {number} originalAccountIdToDelete - ID da transação original do grupo a ser deletado.
 * @param {object} newParcelFullData - Dados completos para a nova compra parcelada (mesmo formato de createParcelledAccount).
 * @returns {Promise<object>} O resultado da criação do novo grupo de parcelas.
 */
async function recreateParcelledAccount(financialAccountId, originalAccountIdToDelete, newParcelFullData) {
    const t = await sequelize.transaction();
    try {
        await validateAndGetFinancialAccount(financialAccountId, t);
        logger.info(`Iniciando recriação da compra parcelada. Grupo antigo ID: ${originalAccountIdToDelete}`);

        // 1. Validar se o grupo a ser deletado existe e é uma "mãe"
        const originalTxToDelete = await FinancialTransaction.findOne({
            where: { id: originalAccountIdToDelete, financialAccountId, originalAccountId: originalAccountIdToDelete, isParcel: true },
            transaction: t
        });
        if (!originalTxToDelete) {
            await t.rollback();
            const err = new Error(`Compra parcelada original com ID ${originalAccountIdToDelete} não encontrada ou inválida para recriação.`);
            err.statusCode = 404; err.status = 'fail'; throw err;
        }

        // 2. Deletar o grupo de parcelas antigo
        const numDeleted = await FinancialTransaction.destroy({
            where: {
                originalAccountId: originalAccountIdToDelete,
                financialAccountId: financialAccountId
            },
            transaction: t
        });
        logger.info(`${numDeleted} parcelas antigas do grupo ID ${originalAccountIdToDelete} foram excluídas.`);

        // 3. Criar o novo grupo de parcelas com os novos dados
        // Validação de limite para o NOVO cartão, se aplicável, ANTES de chamar createParcelledAccount
        if (newParcelFullData.creditCardId && newParcelFullData.type === 'Saída') {
            const card = await CreditCard.findOne({ where: { id: newParcelFullData.creditCardId, financialAccountId }, transaction: t }); // Usa a transação 't'
            if (!card) {
                const error = new Error(`Novo Cartão de Crédito ID ${newParcelFullData.creditCardId} não pertence à conta financeira ${financialAccountId}.`);
                error.statusCode = 404; error.status = 'fail'; throw error; // Será capturado e fará rollback de 't'
            }
            if (!card.isActive) {
                const error = new Error(`Novo Cartão de Crédito ID ${newParcelFullData.creditCardId} ("${card.name}") está inativo.`);
                error.statusCode = 400; error.status = 'fail'; throw error;
            }
            // Chama getAvailableCreditLimit sem transação, pois ele gerencia a sua.
            const limitInfo = await creditCardService.getAvailableCreditLimit(financialAccountId, newParcelFullData.creditCardId);
            if (parseFloat(newParcelFullData.totalValue) > limitInfo.availableLimit) {
                const error = new Error(`Limite insuficiente no novo cartão "${card.name}" para a compra parcelada. Disponível: R$ ${limitInfo.availableLimit.toFixed(2)}, Valor total da compra: R$ ${parseFloat(newParcelFullData.totalValue).toFixed(2)}.`);
                error.statusCode = 409; error.status = 'fail'; throw error;
            }
        }

        // Para garantir atomicidade, createParcelledAccount deveria aceitar a transação 't'.
        // Se createParcelledAccount não for ajustada para aceitar 't' e fizer seu próprio commit/rollback,
        // esta operação não será totalmente atômica. O delete pode ter sucesso e a criação falhar.
        // Assumindo que createParcelledAccount foi ajustada para usar options.transaction:
        const recreatedResult = await createParcelledAccount(financialAccountId, newParcelFullData, { transaction: t });


        await t.commit(); // Commit da transação principal
        logger.info(`Compra parcelada (original ID: ${originalAccountIdToDelete}) recriada com sucesso com novos dados.`);
        return recreatedResult;

    } catch (error) {
        if (t && !t.finished) await t.rollback(); // Rollback da transação principal se qualquer passo falhar
        logger.error(`Erro ao recriar compra parcelada (original ID: ${originalAccountIdToDelete}): ${error.message}`, { error, newParcelFullData });
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
  markAsPaidOrReceived, // A função específica que recebe ID
  markTransactionAsPaidOrReceived, // A função mais flexível para IA
  deleteTransaction,
  getFinancialSummary,
  deleteParcelledAccountGroup,
  updateParcelledAccountDescription,
  recreateParcelledAccount,
};
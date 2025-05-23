// src/features/CreditCardManagement/creditCard.service.js
const { CreditCard, FinancialAccount, FinancialTransaction, FinancialCategory, sequelize } = require('../../database');
const { Op, fn, col, literal } = require('sequelize');
const logger = require('../../utils/logger');
const { formatDate, formatCurrency, formatTime } = require('../../utils/formatters');

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

async function findCreditCardByName(financialAccountId, cardName, transaction = null) {
    if (!cardName || typeof cardName !== 'string' || cardName.trim() === '') {
        // Não lança erro, apenas retorna null se o nome não for válido para busca
        logger.warn(`[SERVICE] Tentativa de buscar cartão com nome inválido/vazio para conta ${financialAccountId}.`);
        return null;
    }
    let card = await CreditCard.findOne({
        where: {
            name: { [Op.iLike]: cardName },
            financialAccountId,
            isActive: true
        },
        transaction
    });

    if (!card) {
        card = await CreditCard.findOne({
            where: {
                name: { [Op.iLike]: `${cardName}%` },
                financialAccountId,
                isActive: true
            },
            transaction
        });
    }
   
    if (!card) {
        const cards = await CreditCard.findAll({ where: { financialAccountId, isActive: true }, transaction });
        card = cards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
    }

    if (card) {
        logger.info(`[SERVICE] Cartão encontrado para "${cardName}" na conta ${financialAccountId}: "${card.name}" (ID: ${card.id})`);
    } else {
        logger.warn(`[SERVICE] Cartão de crédito ativo com nome parecido com "${cardName}" não encontrado na conta ${financialAccountId}.`);
    }
    return card;
}


async function createCreditCard(financialAccountId, cardData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);

    const requiredFields = ['name', 'limit', 'closingDay', 'paymentDay'];
    for (const field of requiredFields) {
      if (cardData[field] === undefined || cardData[field] === null || String(cardData[field]).trim() === '') {
        const error = new Error(`Campo obrigatório "${field}" não fornecido ou inválido para o cartão de crédito.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
    }
    const existingCardName = await CreditCard.findOne({
        where: { name: cardData.name, financialAccountId }, transaction: t
    });
    if(existingCardName){
        const error = new Error(`Já existe um cartão com o nome "${cardData.name}" nesta conta financeira.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    if (cardData.isDefault === true || String(cardData.isDefault).toLowerCase() === 'true') {
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true }, transaction: t }
      );
    } else {
      const defaultCount = await CreditCard.count({ where: { financialAccountId, isDefault: true }, transaction: t });
      if (defaultCount === 0) {
        cardData.isDefault = true;
      } else {
        cardData.isDefault = false;
      }
    }
    cardData.isActive = cardData.isActive === undefined ? true : (String(cardData.isActive).toLowerCase() === 'true' || cardData.isActive === true);

    const newCard = await CreditCard.create(
      { ...cardData, financialAccountId },
      { transaction: t }
    );
    await t.commit();
    logger.info(`Cartão de Crédito "${newCard.name}" (ID: ${newCard.id}) criado para FinancialAccount ID ${financialAccountId}. Default: ${newCard.isDefault}`);
    return newCard.toJSON();

  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro ao criar cartão de crédito para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, cardData });
    if (error.name === 'SequelizeValidationError' && error.errors) {
        const validationErrors = error.errors.map(e => `${e.path}: ${e.message}`).join(', ');
        const valError = new Error(`Erro de validação: ${validationErrors}`);
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAllCreditCards(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const { isActive, sortBy = 'name', sortOrder = 'ASC', includeSummary = false } = queryParams;
    const whereConditions = { financialAccountId };

    if (isActive !== undefined) {
      whereConditions.isActive = (String(isActive).toLowerCase() === 'true' || isActive === true);
    }

    const validSortBy = ['name', 'limit', 'closingDay', 'paymentDay', 'createdAt', 'updatedAt', 'isDefault'];
    const validSortOrders = ['ASC', 'DESC'];
    const sortField = validSortBy.includes(sortBy) ? sortBy : 'name';
    const sortDirection = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC';

    const order = [['isDefault', 'DESC']]; // Sempre prioriza o default
    if (sortField !== 'isDefault') { // Adiciona segunda ordenação se não for por 'isDefault'
        order.push([sortField, sortDirection]);
    } else if (sortDirection === 'ASC') {
        // Se sortBy for 'isDefault' e sortOrder for 'ASC', a ordenação 'isDefault DESC' já coloca false (0) antes de true (1) se invertermos a lógica de Booleano para número.
        // No entanto, a ordenação padrão de booleano no SQL pode variar. Para garantir 'false' antes de 'true':
        order.push(['isDefault', 'ASC']); // Adiciona 'isDefault ASC' para colocar false antes de true
    }
    // Se sortField é 'isDefault' e sortOrder é 'DESC', a ordenação primária já cuida disso.
    order.push(['name', 'ASC']); // Como desempate final

    const cards = await CreditCard.findAll({
      where: whereConditions,
      order: order,
    });

    let resultCards = cards.map(c => c.toJSON());

    if (String(includeSummary).toLowerCase() === 'true' || includeSummary === true) {
        resultCards = await Promise.all(resultCards.map(async (cardJson) => {
            try {
                // Não passar transação para getAvailableCreditLimit pois ele gerencia a sua
                const limitDetails = await getAvailableCreditLimit(financialAccountId, cardJson.id);
                return { ...cardJson, availableLimit: limitDetails.availableLimit };
            } catch (summaryError) {
                logger.warn(`[SERVICE] Falha ao obter resumo de limite para cartão ID ${cardJson.id} durante listagem: ${summaryError.message}`);
                return { ...cardJson, availableLimit: null };
            }
        }));
    }

    logger.info(`Listados ${resultCards.length} cartões de crédito para FinancialAccount ID ${financialAccountId}.`);
    return { cards: resultCards, totalItems: resultCards.length };
  } catch (error) {
    logger.error(`Erro ao listar cartões de crédito para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getCreditCardById(financialAccountId, cardId) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const card = await CreditCard.findOne({
      where: { id: cardId, financialAccountId },
    });

    if (!card) {
      const error = new Error(`Cartão de crédito ID ${cardId} não encontrado ou não pertence à conta financeira ID ${financialAccountId}.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    return card.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar cartão de crédito ID ${cardId} para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateCreditCard(financialAccountId, cardId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);
    const card = await CreditCard.findOne({
      where: { id: cardId, financialAccountId },
      transaction: t
    });
    if (!card) {
      await t.rollback();
      const error = new Error(`Cartão de crédito ID ${cardId} não encontrado para atualização.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    if (updateData.name && updateData.name !== card.name) {
        const existingCardName = await CreditCard.findOne({
            where: { name: updateData.name, financialAccountId, id: {[Op.ne]: cardId} }, transaction: t
        });
        if(existingCardName){
            await t.rollback();
            const error = new Error(`Já existe outro cartão com o nome "${updateData.name}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    if (updateData.hasOwnProperty('isDefault')) {
        const isDefaultUpdate = String(updateData.isDefault).toLowerCase() === 'true' || updateData.isDefault === true;
        if (isDefaultUpdate && !card.isDefault) { // Se está tornando este cartão o default
            await CreditCard.update(
                { isDefault: false },
                { where: { financialAccountId, isDefault: true, id: { [Op.ne]: cardId } }, transaction: t }
            );
        } else if (!isDefaultUpdate && card.isDefault) { // Se está desmarcando este como default
            const otherActiveCard = await CreditCard.findOne({
                where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
                order: [['createdAt', 'ASC']],
                transaction: t,
            });
            if (otherActiveCard) {
                await otherActiveCard.update({ isDefault: true }, { transaction: t });
            } else if (updateData.hasOwnProperty('isActive') ? (String(updateData.isActive).toLowerCase() === 'true' || updateData.isActive === true) : card.isActive) {
                // Se não há outros cartões ativos E este cartão não está sendo inativado, ele deve permanecer default.
                updateData.isDefault = true;
                logger.warn(`Cartão ID ${cardId} é o único ativo, não pode ser desmarcado como default a menos que seja inativado.`);
            }
        }
    }
    if (updateData.hasOwnProperty('isActive')) {
        updateData.isActive = String(updateData.isActive).toLowerCase() === 'true' || updateData.isActive === true;
    }

    delete updateData.financialAccountId;

    await card.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Cartão de Crédito ID ${cardId} ("${card.name}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    return card.reload().then(c => c.toJSON());
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro ao atualizar cartão de crédito ID ${cardId}: ${error.message}`, { error, updateData });
    if (error.name === 'SequelizeValidationError' && error.errors) {
        const validationErrors = error.errors.map(e => `${e.path}: ${e.message}`).join(', ');
        const valError = new Error(`Erro de validação: ${validationErrors}`);
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteCreditCard(financialAccountId, cardId) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);
    const card = await CreditCard.findOne({
      where: { id: cardId, financialAccountId },
      transaction: t
    });
    if (!card) {
      await t.rollback();
      const error = new Error(`Cartão de crédito ID ${cardId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const transactionsCount = await FinancialTransaction.count({ where: { creditCardId: cardId }, transaction: t });
    if (transactionsCount > 0) {
      await t.rollback();
      const error = new Error(`Não é possível excluir o cartão "${card.name}" pois está associado a ${transactionsCount} transações. Considere marcá-lo como inativo.`);
      error.statusCode = 409; error.status = 'fail'; throw error;
    }

    if (card.isDefault) {
      const otherCard = await CreditCard.findOne({
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
        order: [['createdAt', 'ASC']],
        transaction: t,
      });
      if (otherCard) {
        await otherCard.update({ isDefault: true }, { transaction: t });
        logger.info(`Cartão ID ${otherCard.id} promovido a default para Conta ID ${financialAccountId}.`);
      }
    }

    await card.destroy({ transaction: t });
    await t.commit();
    logger.info(`Cartão de Crédito ID ${cardId} ("${card.name}") excluído da FinancialAccount ID ${financialAccountId}.`);
    return true;
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error(`Erro ao excluir cartão de crédito ID ${cardId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAvailableCreditLimit(financialAccountId, creditCardId) {
    const t = await sequelize.transaction();
    try {
        await validateOwningFinancialAccount(financialAccountId, t);
        const card = await CreditCard.findByPk(creditCardId, { transaction: t });

        if (!card || card.financialAccountId !== financialAccountId) {
            await t.rollback();
            const error = new Error(`Cartão de crédito ID ${creditCardId} não encontrado ou não pertence à conta ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        if (!card.isActive) {
            await t.rollback();
            const error = new Error(`Cartão de crédito "${card.name}" (ID: ${creditCardId}) está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        const totalLimit = parseFloat(card.limit);
        let totalSpendsImpactingLimit = 0;

        const parcelledPurchasesMothers = await FinancialTransaction.findAll({
            where: { creditCardId: card.id, financialAccountId, type: 'Saída', isParcel: true, originalAccountId: { [Op.eq]: col('id') } },
            transaction: t
        });
        parcelledPurchasesMothers.forEach(motherTx => {
            totalSpendsImpactingLimit += parseFloat(motherTx.originalPurchaseTotalValue || motherTx.value);
        });

        const singlePurchases = await FinancialTransaction.findAll({
            where: { creditCardId: card.id, financialAccountId, type: 'Saída', isParcel: false },
            transaction: t
        });
        singlePurchases.forEach(tx => { totalSpendsImpactingLimit += parseFloat(tx.value); });

        const directCreditsOnCard = await FinancialTransaction.sum('value', {
            where: { creditCardId: card.id, financialAccountId, type: 'Entrada'},
            transaction: t
        }) || 0;
        totalSpendsImpactingLimit -= parseFloat(directCreditsOnCard);
        
        const invoicePayments = await FinancialTransaction.sum('value', {
            where: { financialAccountId, type: 'Saída', creditCardId: null, description: { [Op.iLike]: `Pagamento Fatura ${card.name}%` } },
            transaction: t
        }) || 0;
        
        const currentDebtOnCard = Math.max(0, totalSpendsImpactingLimit - parseFloat(invoicePayments));
        const availableLimitFinal = totalLimit - currentDebtOnCard;

        const today = new Date();
        let currentBillingYear = today.getUTCFullYear();
        let currentBillingMonth = today.getUTCMonth();
        let faturaAbertaStartDate, faturaAbertaEndDate;

        if (today.getUTCDate() <= card.closingDay) {
            faturaAbertaStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1));
            faturaAbertaEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay));
        } else {
            faturaAbertaStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay + 1));
            faturaAbertaEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth + 1, card.closingDay));
        }
        
        const transacoesFaturaAberta = await FinancialTransaction.sum('value', {
            where: {
                creditCardId: card.id, financialAccountId, type: 'Saída', 
                transactionDate: { 
                    [Op.gte]: faturaAbertaStartDate.toISOString().split('T')[0],
                    [Op.lte]: faturaAbertaEndDate.toISOString().split('T')[0],
                },
            },
            transaction: t
        }) || 0;
        
        await t.commit();

        return {
            cardId: card.id, // Adicionado para referência
            cardName: card.name,
            totalLimit: totalLimit,
            netUsedInOpenInvoice: parseFloat(parseFloat(transacoesFaturaAberta).toFixed(2)),
            totalDebtOnCard: parseFloat(currentDebtOnCard.toFixed(2)),
            availableLimit: parseFloat(availableLimitFinal.toFixed(2)),
            closingDay: card.closingDay,
            paymentDay: card.paymentDay,
            currentInvoiceCycle: {
                start: faturaAbertaStartDate.toISOString().split('T')[0],
                end: faturaAbertaEndDate.toISOString().split('T')[0]
            }
        };

    } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao calcular limite disponível para cartão ID ${creditCardId} (Conta: ${financialAccountId}): ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function getCreditCardInvoiceDetails(financialAccountId, creditCardId, periodOptions = { type: 'aberta' }) {
  const t = await sequelize.transaction();
  try {
      const financialAccount = await validateOwningFinancialAccount(financialAccountId, t);
      const card = await CreditCard.findByPk(creditCardId, { transaction: t });

      if (!card || card.financialAccountId !== financialAccountId) {
          await t.rollback();
          const error = new Error(`Cartão ID ${creditCardId} não encontrado ou não pertence à conta ${financialAccountId}.`);
          error.statusCode = 404; error.status = 'fail'; throw error;
      }
      if (!card.isActive && periodOptions.type === 'aberta') {
          await t.rollback();
          const error = new Error(`Cartão "${card.name}" está inativo. Fatura aberta não aplicável.`);
          error.statusCode = 400; error.status = 'fail'; throw error;
      }

      const today = new Date();
      let invoiceStartDate, invoiceEndDate, invoiceDescriptionPeriod;
      let referenceYear, referenceMonthZeroBased;

      if (periodOptions.type === 'especifico') {
          if (!periodOptions.month || !periodOptions.year || isNaN(parseInt(periodOptions.month)) || isNaN(parseInt(periodOptions.year))) {
              await t.rollback();
              const error = new Error("Mês (1-12) e ano são obrigatórios para fatura de período específico.");
              error.statusCode = 400; error.status = 'fail'; throw error;
          }
          referenceMonthZeroBased = parseInt(periodOptions.month, 10) - 1;
          referenceYear = parseInt(periodOptions.year, 10);

          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `${new Date(Date.UTC(referenceYear, referenceMonthZeroBased)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone:'UTC' })}`;
      } else if (periodOptions.type === 'ultima_fechada') {
          let targetMonth = today.getUTCMonth();
          let targetYear = today.getUTCFullYear();
          if (today.getUTCDate() <= card.closingDay) {
              targetMonth -= 1;
              if (targetMonth < 0) { targetMonth = 11; targetYear -=1; }
          }
          referenceMonthZeroBased = targetMonth;
          referenceYear = targetYear;

          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `Última Fatura Fechada (${formatDate(invoiceStartDate.toISOString().split('T')[0])} - ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;
      } else { // 'aberta'
          let targetMonth = today.getUTCMonth();
          let targetYear = today.getUTCFullYear();
          if (today.getUTCDate() > card.closingDay) {
              targetMonth += 1;
              if (targetMonth > 11) { targetMonth = 0; targetYear +=1; }
          }
          referenceMonthZeroBased = targetMonth;
          referenceYear = targetYear;

          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `Fatura Atual/Aberta (Prev. Fechamento: ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;
      }

      const transactions = await FinancialTransaction.findAll({
          where: {
              financialAccountId, creditCardId, type: 'Saída',
              transactionDate: { 
                  [Op.gte]: invoiceStartDate.toISOString().split('T')[0],
                  [Op.lte]: invoiceEndDate.toISOString().split('T')[0]
              }
          },
          order: [['transactionDate', 'ASC'], ['createdAt', 'ASC']],
          include: [
              {model: FinancialCategory, as: 'category', attributes: ['id','name']},
              {model: FinancialTransaction, as: 'originalAccount', attributes:['id','description', 'originalPurchaseTotalValue', 'totalParcels']}
          ],
          transaction: t
      });

      const totalAmount = transactions.reduce((sum, tx) => sum + parseFloat(tx.value), 0);

      let paymentDueDate = new Date(invoiceEndDate);
      if (card.paymentDay <= card.closingDay) {
          paymentDueDate.setUTCMonth(invoiceEndDate.getUTCMonth() + 1);
      }
      paymentDueDate.setUTCDate(card.paymentDay);

      await t.commit(); 

      // Não passar transação para getAvailableCreditLimit pois ele gerencia a sua
      const limitDetails = await getAvailableCreditLimit(financialAccountId, creditCardId);
      
      return {
          cardId: card.id, // Adicionado para referência
          cardName: card.name,
          financialAccountId: financialAccountId,
          financialAccountName: financialAccount.accountName,
          financialAccountType: financialAccount.accountType,
          invoicePeriodDescription: invoiceDescriptionPeriod,
          invoiceReferenceMonthYear: new Date(Date.UTC(invoiceEndDate.getUTCFullYear(), invoiceEndDate.getUTCMonth())).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
          invoiceCycleStartDate: invoiceStartDate.toISOString().split('T')[0],
          invoiceCycleEndDate: invoiceEndDate.toISOString().split('T')[0],
          paymentDueDate: paymentDueDate.toISOString().split('T')[0],
          totalAmount: parseFloat(totalAmount.toFixed(2)),
          transactions: transactions.map(tx => {
              const jsonTx = tx.toJSON();
              if (jsonTx.isParcel && jsonTx.originalAccount && jsonTx.originalAccount.totalParcels) {
                  jsonTx.totalParcels = jsonTx.originalAccount.totalParcels;
              }
              return jsonTx;
          }),
          cardTotalLimit: parseFloat(card.limit),
          availableLimitAfterInvoice: limitDetails.availableLimit 
      };

  } catch (error) {
      if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
      logger.error(`Erro ao obter detalhes da fatura para cartão ID ${creditCardId} (Conta: ${financialAccountId}): ${error.message}`, { error, periodOptions });
      if (!error.statusCode) error.statusCode = 500;
      throw error;
  }
}

async function getAvailableInvoicePeriods(financialAccountId, creditCardId) {
    try {
        await validateOwningFinancialAccount(financialAccountId);
        const card = await CreditCard.findByPk(creditCardId);
        if (!card || card.financialAccountId !== financialAccountId) {
            const error = new Error(`Cartão de crédito ID ${creditCardId} inválido ou não pertence à conta ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        let dateExtractFunction;
        let groupLiteral, orderLiteral;
        const dialect = sequelize.getDialect();

        if (dialect === 'sqlite') {
            dateExtractFunction = fn('strftime', '%Y-%m', col('transactionDate'));
            groupLiteral = literal("strftime('%Y-%m', \"transactionDate\")");
            orderLiteral = literal("strftime('%Y-%m', \"transactionDate\")");
        } else if (dialect === 'postgres') {
            dateExtractFunction = fn('TO_CHAR', col('transactionDate'), 'YYYY-MM');
            groupLiteral = literal("TO_CHAR(\"transactionDate\", 'YYYY-MM')"); // Aspas duplas para nomes de coluna no Postgres
            orderLiteral = literal("TO_CHAR(\"transactionDate\", 'YYYY-MM')");
        } else if (dialect === 'mysql') {
            dateExtractFunction = fn('DATE_FORMAT', col('transactionDate'), '%Y-%m');
            groupLiteral = literal("DATE_FORMAT(`transactionDate`, '%Y-%m')"); // Backticks para MySQL
            orderLiteral = literal("DATE_FORMAT(`transactionDate`, '%Y-%m')");
        } else {
            logger.error(`[SERVICE] Dialeto SQL não suportado para getAvailableInvoicePeriods: ${dialect}`);
            throw new Error('Dialeto SQL não suportado para esta operação.');
        }

        const distinctTransactionYearMonths = await FinancialTransaction.findAll({
            attributes: [[dateExtractFunction, 'yearMonth']],
            where: { creditCardId, financialAccountId, type: 'Saída' },
            group: [groupLiteral],
            order: [[orderLiteral, 'DESC']],
            raw: true,
        });
       
        const periods = new Map(); // Usar Map para garantir unicidade pela label

        for (const { yearMonth } of distinctTransactionYearMonths) {
            if (yearMonth && typeof yearMonth === 'string') {
                const [yearStr, monthStr] = yearMonth.split('-');
                const year = parseInt(yearStr, 10);
                const monthOneBased = parseInt(monthStr, 10); // Mês como no calendário (1-12)
                const monthZeroBased = monthOneBased - 1;   // Mês para construtor Date (0-11)
                
                // Lógica para determinar o mês/ano de fechamento da fatura que CONTERIA transações de 'yearMonth'
                // Uma transação feita em 'yearMonth' pode cair na fatura que fecha em 'yearMonth' ou 'yearMonth + 1'
                // dependendo do closingDay do cartão.

                // Opção 1: Fatura que fecha no mesmo mês (ou no início do mês seguinte se closingDay for no início do mês)
                // Se a transação foi ANTES do dia de fechamento do cartão NO MÊS da transação:
                // Ex: Transação em 10/Maio, Cartão fecha dia 15. Fatura de Maio.
                // Ex: Transação em 20/Maio, Cartão fecha dia 15. Fatura de Junho.
                let invoiceClosingMonth = monthZeroBased;
                let invoiceClosingYear = year;
                // Se a transação (no mês 'monthZeroBased') ocorreu APÓS o dia de fechamento do cartão NESSE MÊS,
                // então ela cai na fatura que fecha no MÊS SEGUINTE.
                // Não temos o dia da transação aqui, apenas o mês/ano. Para simplificar, consideramos duas faturas possíveis.

                // Fatura A: Fecha no mês de 'monthOneBased'
                const closingDateA = new Date(Date.UTC(year, monthZeroBased, card.closingDay));
                const labelA = closingDateA.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                if (!periods.has(labelA)) {
                    periods.set(labelA, { month: closingDateA.getUTCMonth() + 1, year: closingDateA.getUTCFullYear(), label: labelA });
                }

                // Fatura B: Fecha no mês SEGUINTE a 'monthOneBased'
                const closingDateB = new Date(Date.UTC(year, monthZeroBased + 1, card.closingDay));
                const labelB = closingDateB.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                 if (!periods.has(labelB)) {
                    periods.set(labelB, { month: closingDateB.getUTCMonth() + 1, year: closingDateB.getUTCFullYear(), label: labelB });
                }
            }
        }
       
        const uniquePeriodsArray = Array.from(periods.values())
                               .sort((a, b) => {
                                   if (b.year !== a.year) return b.year - a.year;
                                   return b.month - a.month;
                               });
                               
        const today = new Date();
        let openInvoiceRefMonth = today.getUTCMonth() + 1; // Mês atual 1-12
        let openInvoiceRefYear = today.getUTCFullYear();
        if (today.getUTCDate() > card.closingDay) { // Se já passou o dia de fechamento deste mês
            openInvoiceRefMonth += 1;
            if (openInvoiceRefMonth > 12) {
                openInvoiceRefMonth = 1;
                openInvoiceRefYear += 1;
            }
        }
        const openInvoiceLabel = new Date(Date.UTC(openInvoiceRefYear, openInvoiceRefMonth - 1)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        
        // Adiciona "Fatura Aberta" se não estiver já na lista (pode acontecer se houver transações recentes)
        if (!periods.has(openInvoiceLabel)) {
             uniquePeriodsArray.unshift({ month: openInvoiceRefMonth, year: openInvoiceRefYear, label: `${openInvoiceLabel} (Aberta)`});
        } else {
            // Se já existe, apenas atualiza o label para indicar que é a aberta
            const existingOpen = uniquePeriodsArray.find(p => p.label === openInvoiceLabel);
            if (existingOpen && !existingOpen.label.includes("(Aberta)")) {
                existingOpen.label = `${existingOpen.label} (Aberta)`;
            }
        }

        logger.info(`Encontrados ${uniquePeriodsArray.length} períodos de fatura distintos para cartão ID ${creditCardId}.`);
        return uniquePeriodsArray.slice(0, 12);

    } catch (error) {
        logger.error(`Erro ao obter períodos de fatura para cartão ID ${creditCardId} (Conta: ${financialAccountId}): ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function payCreditCardInvoice(financialAccountId, creditCardId, paymentAmount, paymentDate, originatingAccountDescription = null, financialCategoryId = null) {
    const t = await sequelize.transaction();
    try {
        await validateOwningFinancialAccount(financialAccountId, t);
        const card = await CreditCard.findOne({ where: {id: creditCardId, financialAccountId}, transaction: t });

        if (!card) {
            await t.rollback();
            const error = new Error(`Cartão de crédito ID ${creditCardId} não encontrado ou não pertence à conta financeira ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        let categoryId = financialCategoryId;
        if (!categoryId) {
            const defaultCategory = await FinancialCategory.findOne({
                where: { name: { [Op.iLike]: 'Pagamento de Fatura' }, type: 'Saída', isActive: true },
                transaction: t
            });
            if (defaultCategory) {
                categoryId = defaultCategory.id;
            } else {
                const fallbackCategory = await FinancialCategory.findOne({
                    where: { name: { [Op.iLike]: 'Pagamento de Cartão' }, type: 'Saída', isActive: true },
                    transaction: t
                });
                if (fallbackCategory) {
                    categoryId = fallbackCategory.id;
                } else {
                    logger.warn(`[SERVICE] Categoria "Pagamento de Fatura" ou "Pagamento de Cartão" não encontrada para o pagamento do cartão ${card.name}.`);
                }
            }
        }

        const paymentTransaction = await FinancialTransaction.create({
            financialAccountId,
            description: `Pagamento Fatura ${card.name}${originatingAccountDescription ? ` (Origem: ${originatingAccountDescription})` : ''}`,
            value: Math.abs(paymentAmount),
            type: 'Saída',
            transactionDate: paymentDate,
            financialCategoryId: categoryId,
            creditCardId: null, 
            isPayableOrReceivable: false,
            isPaidOrReceived: true,
            paymentDate: paymentDate,
            notes: `Pagamento da fatura do cartão de crédito ${card.name} (ID do Cartão: ${card.id}).`
        }, { transaction: t });

        await t.commit();
        logger.info(`Pagamento de ${formatCurrency(paymentAmount)} para fatura do cartão ID ${creditCardId} (${card.name}) registrado com sucesso. Transação ID: ${paymentTransaction.id}`);
        const reloadedPaymentTx = await FinancialTransaction.findByPk(paymentTransaction.id, {
            include: [{model: FinancialCategory, as: 'category', attributes: ['id', 'name']}]
        });
        return reloadedPaymentTx.toJSON();

    } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao registrar pagamento de fatura para cartão ID ${creditCardId} (Conta: ${financialAccountId}): ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}


module.exports = {
  createCreditCard,
  getAllCreditCards,
  getCreditCardById,
  updateCreditCard,
  deleteCreditCard,
  findCreditCardByName,
  getAvailableCreditLimit,
  getCreditCardInvoiceDetails,
  getAvailableInvoicePeriods,
  payCreditCardInvoice,
};
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
        const error = new Error('Nome do cartão de crédito não fornecido para busca.');
        error.statusCode = 400; error.status = 'fail'; throw error;
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
        logger.info(`Cartão encontrado para "${cardName}": "${card.name}" (ID: ${card.id})`);
    } else {
        const error = new Error(`Cartão de crédito ativo com nome parecido com "${cardName}" não encontrado nesta conta financeira.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
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

    if (cardData.isDefault === true || cardData.isDefault === 'true') {
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
    cardData.isActive = cardData.isActive === undefined ? true : (cardData.isActive === 'true' || cardData.isActive === true);

    const newCard = await CreditCard.create(
      { ...cardData, financialAccountId },
      { transaction: t }
    );
    await t.commit();
    logger.info(`Cartão de Crédito "${newCard.name}" (ID: ${newCard.id}) criado para FinancialAccount ID ${financialAccountId}. Default: ${newCard.isDefault}`);
    return newCard.toJSON();

  } catch (error) {
    await t.rollback();
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
      whereConditions.isActive = (isActive === 'true' || isActive === true);
    }

    const validSortBy = ['name', 'limit', 'closingDay', 'paymentDay', 'createdAt', 'updatedAt'];
    const validSortOrders = ['ASC', 'DESC'];
    const sortField = validSortBy.includes(sortBy) ? sortBy : 'name';
    const sortDirection = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC';

    const order = [[sortField, sortDirection]];
    const finalOrder = [['isDefault', 'DESC'], ...order];

    const cards = await CreditCard.findAll({
      where: whereConditions,
      order: finalOrder,
    });

    let resultCards = cards.map(c => c.toJSON());

    if (includeSummary) {
        resultCards = await Promise.all(resultCards.map(async (cardJson) => {
            const limitDetails = await getAvailableCreditLimit(financialAccountId, cardJson.id);
            return { ...cardJson, availableLimit: limitDetails.availableLimit };
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
      logger.warn(`Cartão de Crédito ID ${cardId} não encontrado ou não pertence à FinancialAccount ID ${financialAccountId}.`);
      const error = new Error(`Cartão de crédito ID ${cardId} não encontrado.`);
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
      logger.warn(`Cartão de Crédito ID ${cardId} não encontrado para atualização na FinancialAccount ID ${financialAccountId}.`);
      const error = new Error(`Cartão de crédito ID ${cardId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    if (updateData.name && updateData.name !== card.name) {
        const existingCardName = await CreditCard.findOne({
            where: { name: updateData.name, financialAccountId, id: {[Op.ne]: cardId} }, transaction: t
        });
        if(existingCardName){
            const error = new Error(`Já existe outro cartão com o nome "${updateData.name}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    if ((updateData.isDefault === false || updateData.isDefault === 'false') && card.isDefault) {
      const otherActiveCard = await CreditCard.findOne({
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
        order: [['createdAt', 'ASC']],
        transaction: t,
      });
      if (otherActiveCard) {
        await otherActiveCard.update({ isDefault: true }, { transaction: t });
      } else if (updateData.isActive === undefined || updateData.isActive === true || updateData.isActive === 'true') {
        updateData.isDefault = true;
        logger.warn(`Tentativa de desmarcar cartão ID ${cardId} como default, mas não há outros ativos. Ele permanecerá default.`);
      }
    } else if ((updateData.isDefault === true || updateData.isDefault === 'true') && !card.isDefault) {
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true, id: { [Op.ne]: cardId } }, transaction: t }
      );
    }

    delete updateData.financialAccountId;

    await card.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Cartão de Crédito ID ${cardId} ("${card.name}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    return card.reload().then(c => c.toJSON());
  } catch (error) {
    await t.rollback();
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
      logger.warn(`Cartão de Crédito ID ${cardId} não encontrado para exclusão na FinancialAccount ID ${financialAccountId}.`);
      const error = new Error(`Cartão de crédito ID ${cardId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    const transactionsCount = await FinancialTransaction.count({ where: { creditCardId: cardId }, transaction: t });
    if (transactionsCount > 0) {
      await t.rollback();
      const error = new Error(`Não é possível excluir o cartão de crédito "${card.name}" (ID ${cardId}) pois está associado a ${transactionsCount} transações. Remova a associação das transações ou marque o cartão como inativo.`);
      error.statusCode = 409;
      error.status = 'fail';
      throw error;
    }

    if (card.isDefault) {
      const otherCard = await CreditCard.findOne({
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
        order: [['createdAt', 'ASC']],
        transaction: t,
      });
      if (otherCard) {
        await otherCard.update({ isDefault: true }, { transaction: t });
        logger.info(`Cartão de Crédito ID ${otherCard.id} ("${otherCard.name}") promovido a default para FinancialAccount ID ${financialAccountId}.`);
      }
    }

    await card.destroy({ transaction: t });
    await t.commit();
    logger.info(`Cartão de Crédito ID ${cardId} ("${card.name}") excluído da FinancialAccount ID ${financialAccountId}.`);
    return true;
  } catch (error) {
    await t.rollback();
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
            const error = new Error(`Cartão de crédito ID ${creditCardId} não encontrado ou não pertence à conta.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        if (!card.isActive) {
            await t.rollback();
            const error = new Error(`Cartão de crédito "${card.name}" está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        const totalLimit = parseFloat(card.limit);
        let totalDebtOnCard = 0;

        // 1. Soma de todas as transações de 'Saída' (compras à vista e valor TOTAL de compras parceladas)
        //    que ainda não foram quitadas por um pagamento de fatura.
        //    Para compras parceladas, o VALOR TOTAL compromete o limite no momento da compra.
        
        // Soma das compras à vista (não parceladas) e valor TOTAL das compras parceladas "mãe"
        const spendings = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id,
                financialAccountId,
                type: 'Saída',
                // Para parceladas, pegamos a transação "mãe" que deve ter o originalPurchaseTotalValue
                // Para não parceladas, pegamos o valor direto
                [Op.or]: [
                    { isParcel: false }, // Compras à vista
                    { 
                        isParcel: true, 
                        originalAccountId: { [Op.eq]: col('id') } // Transação "mãe" de um parcelamento
                    } 
                ]
            },
            transaction: t
        });

        spendings.forEach(tx => {
            if (tx.isParcel) {
                // Usa originalPurchaseTotalValue se disponível, senão o valor da transação "mãe" (que deveria ser o total)
                totalDebtOnCard += parseFloat(tx.originalPurchaseTotalValue || tx.value);
            } else {
                totalDebtOnCard += parseFloat(tx.value);
            }
        });

        // 2. Soma de todas as transações de 'Entrada' NO CARTÃO (ex: estornos, créditos manuais)
        const totalCreditsOnCard = await FinancialTransaction.sum('value', {
            where: {
                creditCardId: card.id,
                financialAccountId,
                type: 'Entrada'
            },
            transaction: t
        }) || 0;

        totalDebtOnCard -= parseFloat(totalCreditsOnCard);

        // 3. Cálculo do valor da fatura aberta atual (apenas para informação, não afeta o limite total disponível se já consideramos toda a dívida)
        const today = new Date();
        let currentBillingYear = today.getUTCFullYear();
        let currentBillingMonth = today.getUTCMonth();
        let faturaAbertaStartDate, faturaAbertaEndDate;
        if (today.getUTCDate() <= card.closingDay) {
            faturaAbertaStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1, 0, 0, 0, 0));
            faturaAbertaEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay, 23, 59, 59, 999));
        } else {
            faturaAbertaStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay + 1, 0, 0, 0, 0));
            faturaAbertaEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth + 1, card.closingDay, 23, 59, 59, 999));
        }
        
        const transacoesFaturaAberta = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id,
                financialAccountId,
                transactionDate: { // Data da transação individual (parcela ou compra à vista)
                    [Op.gte]: faturaAbertaStartDate.toISOString().split('T')[0],
                    [Op.lte]: faturaAbertaEndDate.toISOString().split('T')[0],
                },
                // [Op.or]: [ // Inclui saídas e entradas na fatura aberta
                //     { type: 'Saída' },
                //     { type: 'Entrada' } 
                // ]
                // Apenas saídas para o "valor usado na fatura aberta"
                 type: 'Saída'
            },
            attributes: ['value', 'type'],
            transaction: t
        });

        let netUsedInOpenInvoice = 0;
        transacoesFaturaAberta.forEach(tx => {
            // if (tx.type === 'Saída') netUsedInOpenInvoice += parseFloat(tx.value);
            // else if (tx.type === 'Entrada') netUsedInOpenInvoice -= parseFloat(tx.value);
            netUsedInOpenInvoice += parseFloat(tx.value); // Somamos apenas as saídas que compõem a fatura
        });

        // O availableLimit é o limite total menos a dívida total pendente no cartão.
        const availableLimitFinal = totalLimit - totalDebtOnCard;

        await t.commit();

        return {
            cardName: card.name,
            totalLimit: totalLimit,
            netUsedAmount: parseFloat(netUsedInOpenInvoice.toFixed(2)), // O que virá na fatura aberta
            totalDebtOnCard: parseFloat(totalDebtOnCard.toFixed(2)), // Dívida total no cartão (impacta o limite)
            availableLimit: parseFloat(availableLimitFinal.toFixed(2)), // Limite realmente disponível
            closingDay: card.closingDay,
            paymentDay: card.paymentDay,
            currentInvoiceCycle: {
                start: faturaAbertaStartDate.toISOString().split('T')[0],
                end: faturaAbertaEndDate.toISOString().split('T')[0]
            }
        };

    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao calcular limite disponível para cartão ID ${creditCardId}: ${error.message}`, { error });
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
          const error = new Error(`Cartão de crédito ID ${creditCardId} não encontrado ou não pertence à conta ${financialAccountId}.`);
          error.statusCode = 404; error.status = 'fail'; throw error;
      }
      if (!card.isActive) {
          await t.rollback();
          const error = new Error(`Cartão de crédito "${card.name}" está inativo.`);
          error.statusCode = 400; error.status = 'fail'; throw error;
      }

      const today = new Date();
      let currentBillingYear = today.getUTCFullYear();
      let currentBillingMonth = today.getUTCMonth();

      let invoiceStartDate, invoiceEndDate, invoiceDescriptionPeriod;
      let referenceYear, referenceMonthZeroBased;

      if (periodOptions.type === 'especifico') {
          if (!periodOptions.month || !periodOptions.year || isNaN(parseInt(periodOptions.month)) || isNaN(parseInt(periodOptions.year))) {
              await t.rollback();
              const error = new Error("Mês e ano são obrigatórios e devem ser números para fatura de período específico.");
              error.statusCode = 400; error.status = 'fail'; throw error;
          }
          referenceMonthZeroBased = parseInt(periodOptions.month, 10) - 1;
          referenceYear = parseInt(periodOptions.year, 10);

          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `${new Date(Date.UTC(referenceYear, referenceMonthZeroBased)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone:'UTC' })}`;

      } else if (periodOptions.type === 'ultima_fechada') {
          if (today.getUTCDate() <= card.closingDay) {
              referenceMonthZeroBased = currentBillingMonth - 1;
              referenceYear = currentBillingYear;
              if (referenceMonthZeroBased < 0) {
                  referenceMonthZeroBased = 11;
                  referenceYear -= 1;
              }
          } else {
              referenceMonthZeroBased = currentBillingMonth;
              referenceYear = currentBillingYear;
          }
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `Última Fatura Fechada (${formatDate(invoiceStartDate.toISOString().split('T')[0])} - ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;
      } else { // 'aberta' (default)
          if (today.getUTCDate() <= card.closingDay) {
              referenceMonthZeroBased = currentBillingMonth;
              referenceYear = currentBillingYear;
          } else {
              referenceMonthZeroBased = currentBillingMonth + 1;
              referenceYear = currentBillingYear;
              if (referenceMonthZeroBased > 11) {
                  referenceMonthZeroBased = 0;
                  referenceYear += 1;
              }
          }
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `Fatura Atual/Aberta (Prev. Fechamento: ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;
      }

      const transactions = await FinancialTransaction.findAll({
          where: {
              financialAccountId,
              creditCardId,
              type: 'Saída',
              transactionDate: {
                  [Op.gte]: invoiceStartDate.toISOString().split('T')[0],
                  [Op.lte]: invoiceEndDate.toISOString().split('T')[0]
              }
          },
          order: [['transactionDate', 'ASC'], ['createdAt', 'ASC']],
          include: [
              {model: FinancialCategory, as: 'category', attributes: ['name']},
              {
                model: FinancialTransaction, 
                as: 'originalAccount', 
                attributes:['id','description', 'originalPurchaseTotalValue', 'totalParcels'] // Inclui totalParcels da transação mãe
              }
          ],
          transaction: t
      });

      let totalAmount = 0;
      transactions.forEach(tx => {
          totalAmount += parseFloat(tx.value);
      });

      let paymentDueDate = new Date(invoiceEndDate);
      if (card.paymentDay <= card.closingDay) {
          paymentDueDate.setUTCMonth(invoiceEndDate.getUTCMonth() + 1);
      }
      paymentDueDate.setUTCDate(card.paymentDay);

      await t.commit(); // Commita a transação 't' antes de chamar getAvailableCreditLimit

      // Pega o limite disponível já calculado pela função refatorada
      const limitDetails = await getAvailableCreditLimit(financialAccountId, creditCardId);
      
      return {
          cardName: card.name,
          financialAccountName: financialAccount.accountName,
          financialAccountType: financialAccount.accountType,
          invoicePeriodDescription: invoiceDescriptionPeriod,
          invoiceReferenceMonthYear: new Date(Date.UTC(invoiceEndDate.getUTCFullYear(), invoiceEndDate.getUTCMonth())).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
          invoiceCycleStartDate: invoiceStartDate.toISOString().split('T')[0],
          invoiceCycleEndDate: invoiceEndDate.toISOString().split('T')[0],
          paymentDueDate: paymentDueDate.toISOString().split('T')[0],
          totalAmount: parseFloat(totalAmount.toFixed(2)),
          transactions: transactions.map(tx => tx.toJSON()),
          cardTotalLimit: parseFloat(card.limit),
          // O 'availableLimitAfterInvoice' agora é o limite que SOBRA após considerar TODA a dívida no cartão,
          // não apenas o valor desta fatura específica.
          availableLimitAfterInvoice: limitDetails.availableLimit 
      };

  } catch (error) {
      if (t && !t.finished) await t.rollback();
      logger.error(`Erro ao obter detalhes da fatura para cartão ID ${creditCardId}: ${error.message}`, { error });
      if (!error.statusCode) error.statusCode = 500;
      throw error;
  }
}


async function getAvailableInvoicePeriods(financialAccountId, creditCardId) {
    try {
        await validateOwningFinancialAccount(financialAccountId);
        const card = await CreditCard.findByPk(creditCardId);
        if (!card || card.financialAccountId !== financialAccountId || !card.isActive) {
            const error = new Error(`Cartão de crédito ID ${creditCardId} inválido, inativo ou não pertence à conta.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        const distinctTransactionMonths = await FinancialTransaction.findAll({
            attributes: [
                [fn('strftime', '%Y-%m', col('transactionDate')), 'yearMonth']
            ],
            where: {
                creditCardId: creditCardId,
                financialAccountId: financialAccountId,
                type: 'Saída'
            },
            group: [literal("strftime('%Y-%m', transactionDate)")],
            order: [[literal("strftime('%Y-%m', transactionDate)"), 'DESC']],
            raw: true,
        });
       
        const periods = [];
        const addedLabels = new Set();

        for (const { yearMonth } of distinctTransactionMonths) {
            if (yearMonth) {
                const [yearStr, monthStr] = yearMonth.split('-');
                const year = parseInt(yearStr, 10);
                const monthOneBased = parseInt(monthStr, 10);
                const monthZeroBased = monthOneBased - 1;
                
                let closingDateOpt1 = new Date(Date.UTC(year, monthZeroBased, card.closingDay));
                let label1 = closingDateOpt1.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                if (!addedLabels.has(label1)) {
                    periods.push({
                        month: closingDateOpt1.getUTCMonth() + 1,
                        year: closingDateOpt1.getUTCFullYear(),
                        label: label1
                    });
                    addedLabels.add(label1);
                }

                let closingDateOpt2 = new Date(Date.UTC(year, monthZeroBased + 1, card.closingDay));
                let label2 = closingDateOpt2.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                 if (!addedLabels.has(label2)) {
                    periods.push({
                        month: closingDateOpt2.getUTCMonth() + 1,
                        year: closingDateOpt2.getUTCFullYear(),
                        label: label2
                    });
                    addedLabels.add(label2);
                }
            }
        }
       
        const uniquePeriods = Array.from(new Set(periods.map(p => JSON.stringify({month: p.month, year: p.year, label: p.label}))))
                               .map(s => JSON.parse(s))
                               .sort((a, b) => {
                                   if (b.year !== a.year) return b.year - a.year;
                                   return b.month - a.month;
                               });

        logger.info(`Encontrados ${uniquePeriods.length} períodos de fatura distintos para cartão ID ${creditCardId}.`);
        return uniquePeriods.slice(0, 12);

    } catch (error) {
        logger.error(`Erro ao obter períodos de fatura para cartão ID ${creditCardId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function payCreditCardInvoice(financialAccountId, creditCardId, paymentAmount, paymentDate, originatingAccountDescription = null, financialCategoryId = null) {
    const t = await sequelize.transaction();
    try {
        await validateOwningFinancialAccount(financialAccountId, t);
        const card = await CreditCard.findByPk(creditCardId, { where: { financialAccountId }, transaction: t });

        if (!card) {
            await t.rollback();
            const error = new Error(`Cartão de crédito ID ${creditCardId} não encontrado.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        let categoryId = financialCategoryId;
        if (!categoryId) {
            const defaultCategory = await FinancialCategory.findOne({
                where: { name: 'Pagamento de Fatura', type: 'Saída', isActive: true },
                transaction: t
            });
            if (defaultCategory) {
                categoryId = defaultCategory.id;
            } else {
                logger.warn(`Categoria "Pagamento de Fatura" não encontrada para o pagamento do cartão ${card.name}.`);
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
            notes: `Pagamento da fatura do cartão ${card.name} (ID: ${card.id}).`
        }, { transaction: t });

        await t.commit();
        logger.info(`Pagamento de ${formatCurrency(paymentAmount)} para fatura do cartão ID ${creditCardId} (${card.name}) registrado com sucesso. Transação ID: ${paymentTransaction.id}`);
        const reloadedPaymentTx = await FinancialTransaction.findByPk(paymentTransaction.id, {
            include: [{model: FinancialCategory, as: 'category', attributes: ['name']}]
        });
        return reloadedPaymentTx.toJSON();

    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao registrar pagamento de fatura para cartão ID ${creditCardId}: ${error.message}`, { error });
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
// src/features/CreditCardManagement/creditCard.service.js
const { CreditCard, FinancialAccount, FinancialTransaction, FinancialCategory, sequelize } = require('../../database');
const { Op, fn, col, literal } = require('sequelize');
const logger = require('../../utils/logger');

// ... (demais funções do serviço inalteradas) ...
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
            [Op.or]: [
                { name: { [Op.iLike]: cardName } },
                { name: { [Op.iLike]: `${cardName}%` } } 
            ],
            financialAccountId,
            isActive: true 
        },
        transaction
    });

    if (!card) {
        const cards = await CreditCard.findAll({ where: { financialAccountId, isActive: true }, transaction });
        const exactMatchAmongPartials = cards.find(c => c.name.toLowerCase() === cardName.toLowerCase());
        if (exactMatchAmongPartials) {
            card = exactMatchAmongPartials;
        } else {
            card = cards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
        }

        if (card) {
            logger.info(`Cartão "${cardName}" não encontrado por correspondência inicial, usando correspondência parcial/exata encontrada: "${card.name}" (ID: ${card.id})`);
        } else {
            const error = new Error(`Cartão de crédito ativo com nome parecido com "${cardName}" não encontrado nesta conta financeira.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
    }
    return card;
}


async function createCreditCard(financialAccountId, cardData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);

    const requiredFields = ['name', 'limit', 'closingDay', 'paymentDay'];
    for (const field of requiredFields) {
      if (cardData[field] === undefined || cardData[field] === null || cardData[field] === '') {
        const error = new Error(`Campo obrigatório "${field}" não fornecido para o cartão de crédito.`);
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
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAllCreditCards(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const { isActive, sortBy = 'name', sortOrder = 'ASC' } = queryParams;
    const whereConditions = { financialAccountId };

    if (isActive !== undefined) {
      whereConditions.isActive = (isActive === 'true' || isActive === true);
    }

    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];


    const cards = await CreditCard.findAll({
      where: whereConditions,
      order: [['isDefault', 'DESC'], order], 
    });

    logger.info(`Listados ${cards.length} cartões de crédito para FinancialAccount ID ${financialAccountId}.`);
    return cards.map(c => c.toJSON());
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
      return null;
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
      return null;
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

    if ((updateData.isDefault === true || updateData.isDefault === 'true') && !card.isDefault) {
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true, id: { [Op.ne]: cardId } }, transaction: t }
      );
    } else if ((updateData.isDefault === false || updateData.isDefault === 'false') && card.isDefault) {
      const otherActiveCardsCount = await CreditCard.count({
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } }, transaction: t
      });
      if (otherActiveCardsCount > 0) {
        logger.warn(`Tentativa de desmarcar cartão default ID ${cardId} sem definir outro. A UI deve garantir a seleção de um novo padrão.`);
      } else if (otherActiveCardsCount === 0 && (updateData.isActive === undefined || updateData.isActive === true || updateData.isActive === 'true')) {
          updateData.isDefault = true; 
      }
    }

    delete updateData.financialAccountId;

    await card.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Cartão de Crédito ID ${cardId} ("${card.name}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    return card.reload().then(c => c.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar cartão de crédito ID ${cardId}: ${error.message}`, { error, updateData });
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
      return false;
    }

    const transactionsCount = await FinancialTransaction.count({ where: { creditCardId: cardId }, transaction: t });
    if (transactionsCount > 0) {
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
        logger.info(`Cartão de Crédito ID ${otherCard.id} ("${otherCard.name}") promovido a default para FinancialAccount ID ${account.clientId}.`);
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
    try {
        await validateOwningFinancialAccount(financialAccountId);
        const card = await CreditCard.findByPk(creditCardId);
        if (!card || card.financialAccountId !== financialAccountId) {
            const error = new Error(`Cartão de crédito ID ${creditCardId} não encontrado ou não pertence à conta.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        if (!card.isActive) {
            const error = new Error(`Cartão de crédito "${card.name}" está inativo.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        const today = new Date(); 
        const currentBillingYear = today.getUTCFullYear();
        const currentBillingMonth = today.getUTCMonth(); 

        let invoiceStartDate, invoiceEndDate;

        if (today.getUTCDate() <= card.closingDay) { 
            invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1));
            invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay)); 
        } else { 
            invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay + 1));
            invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth + 1, card.closingDay)); 
        }

        const openInvoiceTransactions = await FinancialTransaction.findAll({
            where: {
                financialAccountId,
                creditCardId,
                type: 'Saída',
                transactionDate: { 
                    [Op.gte]: invoiceStartDate.toISOString().split('T')[0],
                    [Op.lte]: invoiceEndDate.toISOString().split('T')[0]
                },
            }
        });
        let usedAmount = 0;
        openInvoiceTransactions.forEach(t => { usedAmount += parseFloat(t.value); });

        const paymentsForOpenInvoice = await FinancialTransaction.findAll({
            where: {
                financialAccountId, 
                type: 'Saída',
                description: { [Op.iLike]: `%Pagamento Fatura ${card.name}%` }, 
                transactionDate: { 
                    [Op.gte]: invoiceStartDate.toISOString().split('T')[0], 
                    [Op.lte]: invoiceEndDate.toISOString().split('T')[0]   
                }
            }
        });
        let paymentsMadeAmount = 0;
        paymentsForOpenInvoice.forEach(p => { paymentsMadeAmount += parseFloat(p.value); });

        const netUsedAmount = usedAmount - paymentsMadeAmount;
        const availableLimit = parseFloat(card.limit) - netUsedAmount;

        return {
            cardName: card.name,
            totalLimit: parseFloat(card.limit),
            usedAmount: parseFloat(usedAmount.toFixed(2)), 
            paymentsMadeForOpenInvoice: parseFloat(paymentsMadeAmount.toFixed(2)), 
            netUsedAmount: parseFloat(netUsedAmount.toFixed(2)), 
            availableLimit: parseFloat(availableLimit.toFixed(2)),
            closingDay: card.closingDay,
            paymentDay: card.paymentDay,
            currentInvoiceCycle: {
                start: invoiceStartDate.toISOString().split('T')[0],
                end: invoiceEndDate.toISOString().split('T')[0]
            }
        };

    } catch (error) {
        logger.error(`Erro ao calcular limite disponível para cartão ID ${creditCardId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function getCreditCardInvoiceDetails(financialAccountId, creditCardId, periodOptions = { type: 'aberta' }) {
  try {
      // Valida e obtém a conta financeira para pegar accountName e accountType
      const financialAccount = await validateOwningFinancialAccount(financialAccountId);
      const card = await CreditCard.findByPk(creditCardId);

      if (!card || card.financialAccountId !== financialAccountId) {
          const error = new Error(`Cartão de crédito ID ${creditCardId} não encontrado ou não pertence à conta ${financialAccountId}.`);
          error.statusCode = 404; error.status = 'fail'; throw error;
      }
      if (!card.isActive) {
          const error = new Error(`Cartão de crédito "${card.name}" está inativo.`);
          error.statusCode = 400; error.status = 'fail'; throw error;
      }

      const today = new Date();
      let currentBillingYear = today.getUTCFullYear();
      let currentBillingMonth = today.getUTCMonth(); // 0-11

      let invoiceStartDate, invoiceEndDate, invoiceDescriptionPeriod;

      if (periodOptions.type === 'especifico') {
          if (!periodOptions.month || !periodOptions.year) {
              throw new Error("Mês e ano são obrigatórios para fatura de período específico.");
          }
          const requestedMonth = parseInt(periodOptions.month, 10) - 1;
          const requestedYear = parseInt(periodOptions.year, 10);

          invoiceEndDate = new Date(Date.UTC(requestedYear, requestedMonth, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(requestedYear, requestedMonth - 1, card.closingDay + 1));
          invoiceDescriptionPeriod = `${new Date(Date.UTC(requestedYear, requestedMonth)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone:'UTC' })}`;

      } else if (periodOptions.type === 'ultima_fechada') {
          if (today.getUTCDate() <= card.closingDay) {
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay));
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 2, card.closingDay + 1));
          } else {
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay));
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1));
          }
          invoiceDescriptionPeriod = `Última Fatura Fechada (${invoiceStartDate.toLocaleDateString('pt-BR', {timeZone:'UTC'})} - ${invoiceEndDate.toLocaleDateString('pt-BR', {timeZone:'UTC'})})`;
      } else { // 'aberta' (default)
          if (today.getUTCDate() <= card.closingDay) {
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1));
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay));
          } else {
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay + 1));
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth + 1, card.closingDay));
          }
          invoiceDescriptionPeriod = `Fatura Atual/Aberta (Prev. Fechamento: ${invoiceEndDate.toLocaleDateString('pt-BR', {timeZone:'UTC'})})`;
      }

      const transactions = await FinancialTransaction.findAll({
          where: {
              financialAccountId, // Garante que estamos pegando transações da conta correta (embora o cartão já filtre)
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
              {model: FinancialTransaction, as: 'originalAccount', attributes:['description']} // Para pegar descrição original da parcela
          ]
      });

      let totalAmount = 0;
      transactions.forEach(t => {
          totalAmount += parseFloat(t.value);
      });

      let paymentDueDate = new Date(invoiceEndDate);
      if (card.paymentDay <= card.closingDay) {
          paymentDueDate.setUTCMonth(invoiceEndDate.getUTCMonth() + 1);
      }
      paymentDueDate.setUTCDate(card.paymentDay);


      return {
          cardName: card.name,
          financialAccountName: financialAccount.accountName, // <<< NOVO
          financialAccountType: financialAccount.accountType, // <<< NOVO
          invoicePeriodDescription: invoiceDescriptionPeriod, // Descrição do período como "Fatura de Maio de 2025" ou "Fatura Aberta"
          invoiceReferenceMonthYear: new Date(invoiceEndDate + 'T00:00:00Z').toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }), // <<< NOVO (Mês/Ano de referência da fatura)
          invoiceCycleStartDate: invoiceStartDate.toISOString().split('T')[0], // <<< NOVO (Início do ciclo de gastos)
          invoiceCycleEndDate: invoiceEndDate.toISOString().split('T')[0],     // <<< NOVO (Fim do ciclo de gastos / Fechamento)
          paymentDueDate: paymentDueDate.toISOString().split('T')[0],
          totalAmount: parseFloat(totalAmount.toFixed(2)),
          transactions: transactions.map(t => t.toJSON()),
      };

  } catch (error) {
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

        const transactionsDates = await FinancialTransaction.findAll({
            attributes: [
                // Usando fn.TRUNC para agrupar por mês. Adapte para seu DB.
                // Para PostgreSQL: fn('date_trunc', 'month', col('transactionDate'))
                // Para SQLite: fn('strftime', '%Y-%m-01', col('transactionDate'))
                // Para MySQL: fn('DATE_FORMAT', col('transactionDate'), '%Y-%m-01')
                // Vamos usar uma forma mais genérica que agrupa pelo texto YYYY-MM e depois processa
                [fn('DISTINCT', fn('strftime', '%Y-%m', col('transactionDate'))), 'yearMonth']
            ],
            where: {
                creditCardId: creditCardId,
                financialAccountId: financialAccountId,
                type: 'Saída' 
            },
            order: [[literal('"yearMonth"'), 'DESC']], 
            raw: true, 
            group: ['yearMonth'] // Adiciona group by para o distinct funcionar corretamente com fn
        });
        
        const periods = [];
        const addedLabels = new Set();

        for (const { yearMonth } of transactionsDates) {
            if (yearMonth) { 
                const [year, monthNum] = yearMonth.split('-').map(Number);
                
                // A fatura de um gasto feito no dia D do mês M com fechamento no dia C:
                // - Se D <= C, a fatura fecha no mês M.
                // - Se D > C, a fatura fecha no mês M+1.
                // Precisamos do mês de FECHAMENTO da fatura.
                
                // Data da transação (representativa do mês de gastos)
                const transactionSampleDate = new Date(Date.UTC(year, monthNum - 1, 15)); // Dia 15 para evitar problemas com fim de mês
                
                let closingMonth = transactionSampleDate.getUTCMonth(); // Mês base 0
                let closingYear = transactionSampleDate.getUTCFullYear();

                // Simula o dia da transação em relação ao dia de fechamento para determinar o mês de fechamento
                // Se uma transação foi feita no dia 25 e o cartão fecha dia 20, ela entra na fatura do mês seguinte.
                // (Esta é uma simplificação, a lógica exata de qual fatura uma transação entra está em getCreditCardInvoiceDetails)
                // Para listar opções, podemos usar o mês da transação como referência para o "mês da fatura".
                
                const labelDate = new Date(Date.UTC(year, monthNum - 1, 1));
                const label = labelDate.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

                if (!addedLabels.has(label)) {
                    periods.push({
                        month: monthNum, 
                        year: year,
                        label: label 
                    });
                    addedLabels.add(label);
                }
            }
        }
        
        logger.info(`Encontrados ${periods.length} períodos de fatura distintos para cartão ID ${creditCardId}.`);
        return periods;

    } catch (error) {
        logger.error(`Erro ao obter períodos de fatura para cartão ID ${creditCardId}: ${error.message}`, { error });
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
};

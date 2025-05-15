// src/features/CreditCardManagement/creditCard.service.js
const { CreditCard, FinancialAccount, FinancialTransaction, FinancialCategory, sequelize } = require('../../database');
const { Op, fn, col, literal } = require('sequelize'); // Adicionado fn, col, literal
const logger = require('../../utils/logger');

// ... (validateOwningFinancialAccount, findCreditCardByName, createCreditCard, etc. permanecem os mesmos) ...
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
    // Primeiro, tenta uma correspondência mais exata com o início do nome ou nome completo
    let card = await CreditCard.findOne({
        where: {
            [Op.or]: [
                { name: { [Op.iLike]: cardName } }, // Exato (case-insensitive)
                { name: { [Op.iLike]: `${cardName}%` } } // Começa com (case-insensitive)
            ],
            financialAccountId,
            isActive: true // Considera apenas cartões ativos
        },
        transaction
    });

    if (!card) {
        // Se não encontrou exato ou começando com, tenta busca parcial (contém)
        const cards = await CreditCard.findAll({ where: { financialAccountId, isActive: true }, transaction });
        // Prioriza correspondência exata se houver múltiplas parciais
        const exactMatchAmongPartials = cards.find(c => c.name.toLowerCase() === cardName.toLowerCase());
        if (exactMatchAmongPartials) {
            card = exactMatchAmongPartials;
        } else {
            // Se não há correspondência exata entre as parciais, pega a primeira parcial que encontrar
            card = cards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
        }

        if (card) {
            logger.info(`Cartão "${cardName}" não encontrado por correspondência inicial, usando correspondência parcial/exata encontrada: "${card.name}" (ID: ${card.id})`);
        } else {
            const error = new Error(`Cartão de crédito ativo com nome parecido com "${cardName}" não encontrado nesta conta financeira.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
    }
    // A verificação de isActive já foi feita na query ou no processo de busca parcial
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
        let currentBillingYear = today.getUTCFullYear();
        let currentBillingMonth = today.getUTCMonth(); 

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
        } else { 
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
                financialAccountId,
                creditCardId,
                type: 'Saída',
                transactionDate: {
                    [Op.gte]: invoiceStartDate.toISOString().split('T')[0],
                    [Op.lte]: invoiceEndDate.toISOString().split('T')[0]
                }
            },
            order: [['transactionDate', 'ASC'], ['createdAt', 'ASC']],
            include: [{model: FinancialCategory, as: 'category', attributes: ['name']}] 
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
            invoicePeriodDescription: invoiceDescriptionPeriod,
            invoiceStartDate: invoiceStartDate.toISOString().split('T')[0],
            invoiceEndDate: invoiceEndDate.toISOString().split('T')[0],
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

/**
 * Obtém os períodos de fatura disponíveis (meses com transações) para um cartão.
 * @param {number} financialAccountId
 * @param {number} creditCardId
 * @returns {Promise<Array<object>>} Lista de objetos { month, year, label }
 */
async function getAvailableInvoicePeriods(financialAccountId, creditCardId) {
    try {
        await validateOwningFinancialAccount(financialAccountId);
        const card = await CreditCard.findByPk(creditCardId);
        if (!card || card.financialAccountId !== financialAccountId || !card.isActive) {
            const error = new Error(`Cartão de crédito ID ${creditCardId} inválido, inativo ou não pertence à conta.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        // Buscar todas as datas de transação para este cartão
        const transactionsDates = await FinancialTransaction.findAll({
            attributes: [
                [fn('DISTINCT', fn('to_char', col('transactionDate'), 'YYYY-MM')), 'yearMonth']
                // Adapte 'to_char' e 'YYYY-MM' para a sintaxe do seu banco de dados se não for PostgreSQL
                // Para SQLite, seria: [fn('strftime', '%Y-%m', col('transactionDate')), 'yearMonth']
                // Para MySQL, seria: [fn('DATE_FORMAT', col('transactionDate'), '%Y-%m'), 'yearMonth']
            ],
            where: {
                creditCardId: creditCardId,
                financialAccountId: financialAccountId,
                type: 'Saída' // Apenas gastos contam para faturas
            },
            order: [[literal('"yearMonth"'), 'DESC']], // Mais recentes primeiro
            raw: true, // Para obter o resultado puro
        });
        
        const periods = [];
        const addedPeriods = new Set(); // Para evitar duplicatas de rótulos

        for (const { yearMonth } of transactionsDates) {
            if (yearMonth) { // yearMonth será algo como "2024-05"
                const [year, monthNum] = yearMonth.split('-').map(Number);
                
                // Determinar o período de fechamento da fatura para transações deste mês/ano
                // Se uma transação ocorreu em Mês X / Ano Y:
                // - Se transactionDate.day <= closingDay, ela pertence à fatura que fecha em Mês X / Ano Y (no closingDay).
                // - Se transactionDate.day > closingDay, ela pertence à fatura que fecha em Mês X+1 / Ano Y (no closingDay).

                // Precisamos agrupar por MÊS DE FECHAMENTO DA FATURA.
                // Uma transação de 05/Maio com fechamento dia 20, pertence à fatura que fecha em 20/Maio.
                // Uma transação de 25/Maio com fechamento dia 20, pertence à fatura que fecha em 20/Junho.
                
                // Para simplificar, vamos listar os meses em que HOUVE GASTOS.
                // A lógica de `getCreditCardInvoiceDetails` determinará o período exato da fatura.
                // Aqui, queremos dar ao usuário opções de "Mês/Ano" que ele reconheça.

                const dateForLabel = new Date(Date.UTC(year, monthNum -1, 15)); // Dia 15 para pegar o nome do mês corretamente
                const label = dateForLabel.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

                if (!addedPeriods.has(label)) {
                    periods.push({
                        month: monthNum, // 1-12
                        year: year,
                        label: label // Ex: "Maio/2024"
                    });
                    addedPeriods.add(label);
                }
            }
        }
        // Adicionar "Última Fechada" e "Fatura Aberta" como opções fixas
        // Estas serão tratadas pela lógica do `getCreditCardInvoiceDetails`
        
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
  getAvailableInvoicePeriods, // <<< EXPORTADO
};
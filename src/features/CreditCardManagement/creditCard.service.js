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
        logger.warn(`[SERVICE] Tentativa de buscar cartão com nome inválido/vazio para conta ${financialAccountId}.`);
        return null;
    }
    let card = await CreditCard.findOne({
        where: { name: { [Op.iLike]: cardName }, financialAccountId, isActive: true },
        transaction
    });
    if (!card) {
        card = await CreditCard.findOne({
            where: { name: { [Op.iLike]: `${cardName}%` }, financialAccountId, isActive: true },
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

async function closeDueInvoices() {
  const today = new Date().getDate(); // Pega apenas o dia do mês (1-31)
  logger.info(`[INVOICE-JOB] Iniciando fechamento de faturas para o dia ${today}...`);

  try {
    const cardsToProcess = await CreditCard.findAll({
      where: { closingDay: today, isActive: true },
      include: ['financialAccount']
    });

    if (cardsToProcess.length === 0) {
      logger.info(`[INVOICE-JOB] Nenhum cartão com fechamento hoje.`);
      return;
    }

    for (const card of cardsToProcess) {
      const t = await sequelize.transaction();
      try {
        const lastInvoice = await CreditCardInvoice.findOne({
          where: { creditCardId: card.id },
          order: [['endDate', 'DESC']],
          transaction: t
        });

        const startDate = lastInvoice ? new Date(lastInvoice.endDate) : new Date(card.createdAt);
        if (lastInvoice) startDate.setDate(startDate.getDate() + 1); // Período começa um dia após o fim do último

        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);

        // Previne fechamento duplo no mesmo dia
        if (lastInvoice && lastInvoice.endDate === endDate.toISOString().split('T')[0]) {
            logger.warn(`[INVOICE-JOB] Fatura para cartão ${card.id} no dia ${endDate.toISOString().split('T')[0]} já parece fechada. Pulando.`);
            await t.commit();
            continue;
        }

        const transactionsToInclude = await FinancialTransaction.findAll({
          where: {
            creditCardId: card.id,
            invoiceId: null, // Apenas transações que ainda não pertencem a nenhuma fatura
            transactionDate: { [Op.between]: [startDate, endDate] }
          },
          transaction: t
        });

        const totalAmount = transactionsToInclude.reduce((sum, tx) => sum + parseFloat(tx.value), 0);

        if (totalAmount === 0 && transactionsToInclude.length === 0) {
            logger.info(`[INVOICE-JOB] Cartão ${card.id} (${card.name}) sem movimentação no período. Nenhuma fatura gerada.`);
            await t.commit();
            continue;
        }

        const paymentDate = new Date();
        paymentDate.setDate(card.paymentDay);
        if (card.paymentDay < card.closingDay) { // Se o pagamento é no mês seguinte
            paymentDate.setMonth(paymentDate.getMonth() + 1);
        }

        const newInvoice = await CreditCardInvoice.create({
          creditCardId: card.id,
          financialAccountId: card.financialAccountId,
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
          dueDate: paymentDate.toISOString().split('T')[0],
          totalAmount: totalAmount,
          status: 'Fechada',
        }, { transaction: t });

        await FinancialTransaction.update(
          { invoiceId: newInvoice.id },
          { where: { id: { [Op.in]: transactionsToInclude.map(tx => tx.id) } }, transaction: t }
        );
        
        // Criar a "Conta a Pagar" da fatura
        const category = await FinancialCategory.findOne({
            where: { name: {[Op.iLike]: 'Pagamento de Fatura'}, financialAccountId: card.financialAccountId },
            transaction: t
        });
        const paymentTx = await financialService.createTransaction(card.financialAccountId, {
            description: `Pagamento Fatura - ${card.name}`,
            type: 'Saída',
            value: totalAmount,
            financialCategoryId: category ? category.id : null,
            transactionDate: endDate.toISOString().split('T')[0],
            isPayableOrReceivable: true,
            dueDate: paymentDate.toISOString().split('T')[0],
            notes: `Fatura referente ao período de ${newInvoice.startDate} a ${newInvoice.endDate}. Fatura ID: ${newInvoice.id}`
        }, { transaction: t });

        await newInvoice.update({ relatedPaymentTransactionId: paymentTx.id }, { transaction: t });

        await t.commit();
        logger.info(`[INVOICE-JOB] Fatura ID ${newInvoice.id} para o cartão "${card.name}" fechada com valor ${totalAmount}. Conta a pagar ID ${paymentTx.id} criada.`);

      } catch (error) {
        await t.rollback();
        logger.error(`[INVOICE-JOB] Erro ao fechar fatura para o cartão ${card.id}: ${error.message}`, { stack: error.stack });
      }
    }

  } catch (error) {
    logger.error(`[INVOICE-JOB] Erro fatal no job de fechamento de faturas: ${error.message}`, { stack: error.stack });
  }
}



async function createCreditCard(financialAccountId, cardData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);

    const requiredFields = ['name', 'limit', 'closingDay', 'paymentDay'];
    for (const field of requiredFields) {
      // Verifica se o campo existe e não é apenas uma string vazia após trim
      if (cardData[field] === undefined || cardData[field] === null || (typeof cardData[field] === 'string' && cardData[field].trim() === '')) {
        const error = new Error(`Campo obrigatório "${field}" não fornecido ou inválido para o cartão de crédito.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
    }
    // Validações numéricas
    if (isNaN(parseFloat(cardData.limit)) || parseFloat(cardData.limit) < 0) {
        const error = new Error('O limite do cartão deve ser um número zero ou positivo.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (isNaN(parseInt(cardData.closingDay)) || parseInt(cardData.closingDay) < 1 || parseInt(cardData.closingDay) > 28) {
        const error = new Error('O dia de fechamento deve ser um número entre 1 e 28.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (isNaN(parseInt(cardData.paymentDay)) || parseInt(cardData.paymentDay) < 1 || parseInt(cardData.paymentDay) > 28) {
        const error = new Error('O dia de pagamento deve ser um número entre 1 e 28.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (cardData.lastFourDigits && (String(cardData.lastFourDigits).length !== 4 || isNaN(parseInt(cardData.lastFourDigits)))) {
        const error = new Error('Os últimos quatro dígitos, se fornecidos, devem ser 4 números.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }


    const existingCardName = await CreditCard.findOne({
        where: { name: cardData.name, financialAccountId }, transaction: t
    });
    if(existingCardName){
        const error = new Error(`Já existe um cartão com o nome "${cardData.name}" nesta conta financeira.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

    // Normaliza booleanos para isDefault e isActive
    let isDefaultBoolean = false;
    if (cardData.hasOwnProperty('isDefault')) {
        isDefaultBoolean = String(cardData.isDefault).toLowerCase() === 'true' || cardData.isDefault === true;
    }

    let isActiveBoolean = true;
    if (cardData.hasOwnProperty('isActive')) {
        isActiveBoolean = String(cardData.isActive).toLowerCase() === 'true' || cardData.isActive === true;
    }
    
    const dataToCreate = {
        ...cardData,
        financialAccountId,
        limit: parseFloat(cardData.limit),
        closingDay: parseInt(cardData.closingDay),
        paymentDay: parseInt(cardData.paymentDay),
        lastFourDigits: cardData.lastFourDigits ? String(cardData.lastFourDigits) : null,
        isDefault: isDefaultBoolean, // Usar o booleano normalizado
        isActive: isActiveBoolean,   // Usar o booleano normalizado
        dominantColor: cardData.dominantColor || null,
        flagIconUrl: cardData.flagIconUrl || null,
    };


    if (dataToCreate.isDefault) {
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true }, transaction: t }
      );
    } else {
      const defaultCount = await CreditCard.count({ where: { financialAccountId, isDefault: true }, transaction: t });
      if (defaultCount === 0) {
        // Se não houver outros cartões default e este estiver ativo, torna-o default.
        // Se este estiver sendo criado como inativo, ele não se torna default.
        if (dataToCreate.isActive) {
            dataToCreate.isDefault = true;
        }
      }
    }

    const newCard = await CreditCard.create(dataToCreate, { transaction: t });
    await t.commit();
    logger.info(`Cartão de Crédito "${newCard.name}" (ID: ${newCard.id}) criado para FA ID ${financialAccountId}. Default: ${newCard.isDefault}, Ativo: ${newCard.isActive}`);
    return newCard.toJSON();

  } catch (error) {
    if (t && !t.finished && t.finished !== 'rollback' && t.finished !== 'commit') await t.rollback();
    logger.error(`Erro ao criar cartão de crédito para FA ID ${financialAccountId}: ${error.message}`, { error, cardData });
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
    let sortField = validSortBy.includes(sortBy) ? sortBy : 'name';
    let sortDirection = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC';

    const order = [];
    // Prioriza o cartão default no topo se a ordenação principal não for por isDefault,
    // ou se for por isDefault e a direção for DESC.
    if (sortField !== 'isDefault' || (sortField === 'isDefault' && sortDirection === 'DESC')) {
        order.push(['isDefault', 'DESC']);
    } else if (sortField === 'isDefault' && sortDirection === 'ASC') {
        order.push(['isDefault', 'ASC']); // Explicitamente false antes de true
    }

    // Adiciona a ordenação principal, se não for por isDefault ou se for isDefault com direção já coberta
    if (sortField !== 'isDefault') {
      order.push([sortField, sortDirection]);
    }
    order.push(['name', 'ASC']); // Desempate final por nome

    const cards = await CreditCard.findAll({
      where: whereConditions,
      order: order,
    });

    let resultCards = cards.map(c => c.toJSON());

    if (String(includeSummary).toLowerCase() === 'true' || includeSummary === true) {
        resultCards = await Promise.all(resultCards.map(async (cardJson) => {
            if (!cardJson.isActive) { // Não busca resumo para cartões inativos
                return { ...cardJson, availableLimit: null };
            }
            try {
                const limitDetails = await getAvailableCreditLimit(financialAccountId, cardJson.id);
                return { ...cardJson, availableLimit: limitDetails.availableLimit };
            } catch (summaryError) {
                logger.warn(`[SERVICE] Falha ao obter resumo de limite para cartão ID ${cardJson.id} durante listagem: ${summaryError.message}`);
                return { ...cardJson, availableLimit: null };
            }
        }));
    }

    logger.info(`Listados ${resultCards.length} cartões de crédito para FA ID ${financialAccountId}.`);
    return { cards: resultCards, totalItems: resultCards.length };
  } catch (error) {
    logger.error(`Erro ao listar cartões de crédito para FA ID ${financialAccountId}: ${error.message}`, { error });
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
    logger.error(`Erro ao buscar cartão ID ${cardId} para FA ID ${financialAccountId}: ${error.message}`, { error });
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
    
    // Normaliza e trata booleanos para isDefault e isActive
    if (updateData.hasOwnProperty('isDefault')) {
        const wantsToBeDefault = String(updateData.isDefault).toLowerCase() === 'true' || updateData.isDefault === true;
        if (wantsToBeDefault && !card.isDefault) {
            await CreditCard.update(
                { isDefault: false },
                { where: { financialAccountId, isDefault: true, id: { [Op.ne]: cardId } }, transaction: t }
            );
             updateData.isDefault = true; // Garante que o update final use o booleano
        } else if (!wantsToBeDefault && card.isDefault) {
            const otherActiveCard = await CreditCard.findOne({
                where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
                order: [['createdAt', 'ASC']],
                transaction: t,
            });
            if (otherActiveCard) {
                await otherActiveCard.update({ isDefault: true }, { transaction: t });
                updateData.isDefault = false; // Permite desmarcar
            } else if (updateData.hasOwnProperty('isActive') ? (String(updateData.isActive).toLowerCase() === 'true' || updateData.isActive === true) : card.isActive) {
                updateData.isDefault = true;
                logger.warn(`Cartão ID ${cardId} é o único ativo, não pode ser desmarcado como default a menos que seja inativado.`);
            } else {
                updateData.isDefault = false; // Pode desmarcar se estiver sendo inativado e não há outros
            }
        } else {
             updateData.isDefault = wantsToBeDefault; // Mantém o valor se não houver mudança de estado default
        }
    }
    if (updateData.hasOwnProperty('isActive')) {
        updateData.isActive = String(updateData.isActive).toLowerCase() === 'true' || updateData.isActive === true;
        // Se está inativando o cartão default, precisa promover outro
        if (!updateData.isActive && card.isDefault) {
             const otherActiveCardToPromote = await CreditCard.findOne({
                where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } }, // Procura OUTRO que JÁ ESTEJA ativo
                order: [['createdAt', 'ASC']],
                transaction: t,
            });
            if (otherActiveCardToPromote) {
                await otherActiveCardToPromote.update({ isDefault: true }, { transaction: t });
            } else {
                // Se não há outro cartão ativo para ser default, e este está sendo inativado,
                // tecnicamente não haverá cartão default ativo. A UI deve lidar com isso.
                // Ou impedir a inativação se for o único.
                logger.warn(`Cartão default ID ${cardId} inativado. Nenhum outro cartão ativo para ser promovido a default.`);
            }
            updateData.isDefault = false; // Um cartão inativo não pode ser default
        }
    }


    delete updateData.financialAccountId;

    await card.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Cartão de Crédito ID ${cardId} ("${card.name}") atualizado para FA ID ${financialAccountId}.`);
    return card.reload().then(c => c.toJSON());
  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao atualizar cartão ID ${cardId}: ${error.message}`, { error, updateData });
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
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } }, // Procura outro ATIVO
        order: [['createdAt', 'ASC']],
        transaction: t,
      });
      if (otherCard) {
        await otherCard.update({ isDefault: true }, { transaction: t });
        logger.info(`Cartão ID ${otherCard.id} promovido a default para Conta ID ${financialAccountId}.`);
      } else {
          logger.info(`Cartão default ID ${cardId} excluído. Nenhum outro cartão ativo para ser promovido a default na conta ${financialAccountId}.`);
      }
    }

    await card.destroy({ transaction: t });
    await t.commit();
    logger.info(`Cartão ID ${cardId} ("${card.name}") excluído da FA ID ${financialAccountId}.`);
    return true;
  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao excluir cartão ID ${cardId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}
/**
 * Calcula o limite disponível de um cartão de crédito.
 * @param {number} financialAccountId 
 * @param {number} creditCardId 
 * @returns {Promise<{availableLimit: number, totalLimit: number, spentAmount: number}>}
 */
async function getAvailableCreditLimit(financialAccountId, creditCardId) {
    const card = await CreditCard.findOne({ where: { id: creditCardId, financialAccountId } });
    if (!card) throw new Error('Cartão de crédito não encontrado.');

    // Soma o valor de todas as transações de saída não faturadas para este cartão.
    const spentAmount = await FinancialTransaction.sum('value', {
        where: {
            creditCardId: creditCardId,
            type: 'Saída',
            creditCardInvoiceId: null, // Apenas despesas que ainda não pertencem a uma fatura fechada
        }
    }) || 0;

    const totalLimit = parseFloat(card.limit);
    const availableLimit = totalLimit - parseFloat(spentAmount);

    return {
        totalLimit: totalLimit,
        spentAmount: parseFloat(spentAmount),
        availableLimit: availableLimit
    };
}

/**
 * Gera uma nova transação de fatura para um cartão de crédito.
 * @param {number} creditCardId - O ID do cartão de crédito.
 * @returns {Promise<object|null>} A transação de fatura criada ou null.
 */
async function generateCreditCardInvoice(creditCardId) {
    const t = await sequelize.transaction();
    try {
        const card = await CreditCard.findByPk(creditCardId, { transaction: t });
        if (!card) {
            logger.warn(`[CC-SERVICE] Tentativa de gerar fatura para cartão inexistente ID ${creditCardId}.`);
            await t.rollback();
            return null;
        }

        const expensesToInvoice = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id,
                type: 'Saída',
                creditCardInvoiceId: null // Crucial: apenas despesas "soltas"
            },
            transaction: t
        });

        if (expensesToInvoice.length === 0) {
            logger.info(`[CC-SERVICE] Nenhuma despesa nova para faturar no cartão "${card.name}" (ID ${card.id}).`);
            await t.rollback();
            return null;
        }

        const totalValue = expensesToInvoice.reduce((sum, tx) => sum + parseFloat(tx.value), 0);

        // Encontra ou cria a categoria "Pagamento de Fatura"
        let category = await FinancialCategory.findOne({
            where: { name: 'Pagamento de Fatura', financialAccountId: card.financialAccountId },
            transaction: t
        });
        if (!category) {
            category = await FinancialCategory.create({
                name: 'Pagamento de Fatura',
                financialAccountId: card.financialAccountId
            }, { transaction: t });
        }
        
        // Calcula a data de vencimento da fatura
        const closingDate = new Date(); // Hoje é o dia de fechamento
        const paymentDay = card.paymentDay;
        const dueDate = new Date(closingDate.getFullYear(), closingDate.getMonth(), paymentDay);
        if (paymentDay <= card.closingDay) { // Se o pagamento é no mês seguinte
            dueDate.setMonth(dueDate.getMonth() + 1);
        }

        const invoiceTransaction = await financialService.createTransaction(card.financialAccountId, {
            description: `Fatura Cartão ${card.name} - Venc. ${dueDate.toLocaleDateString('pt-BR')}`,
            type: 'Saída',
            value: totalValue,
            financialCategoryId: category.id,
            transactionDate: closingDate.toISOString().split('T')[0], // Data de fechamento
            isPayableOrReceivable: true,
            isPaidOrReceived: false,
            dueDate: dueDate.toISOString().split('T')[0],
        }, { transaction: t });

        // Vincula todas as despesas a esta nova fatura
        const expenseIds = expensesToInvoice.map(tx => tx.id);
        await FinancialTransaction.update(
            { creditCardInvoiceId: invoiceTransaction.id },
            { where: { id: { [Op.in]: expenseIds } }, transaction: t }
        );

        // Atualiza o cartão com o ID da última fatura gerada
        await card.update({ lastInvoiceGeneratedId: invoiceTransaction.id }, { transaction: t });

        await t.commit();
        logger.info(`[CC-SERVICE] Fatura (ID ${invoiceTransaction.id}) de R$ ${totalValue} gerada para o cartão "${card.name}".`);
        return invoiceTransaction;

    } catch (error) {
        await t.rollback();
        logger.error(`[CC-SERVICE] Erro ao gerar fatura para cartão ID ${creditCardId}: ${error.message}`, { stack: error.stack });
        return null;
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

      const today = new Date(); // Data atual para cálculos de ciclo
      let invoiceStartDate, invoiceEndDate, invoiceDescriptionPeriod;
      let referenceYear, referenceMonthZeroBased; // Mês e ano de referência da fatura

      // --- Lógica para determinar o ciclo da fatura (invoiceStartDate, invoiceEndDate) ---
      // (Esta lógica de determinação de datas parece correta e pode ser mantida)
      if (periodOptions.type === 'especifico') {
          // ... (lógica para período específico) ...
          referenceMonthZeroBased = parseInt(periodOptions.month, 10) - 1;
          referenceYear = parseInt(periodOptions.year, 10);
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `${new Date(Date.UTC(referenceYear, referenceMonthZeroBased)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone:'UTC' })}`;

      } else if (periodOptions.type === 'ultima_fechada') {
          // ... (lógica para última fechada) ...
          let targetMonth = today.getUTCMonth();
          let targetYear = today.getUTCFullYear();
          if (today.getUTCDate() <= card.closingDay) { // Se hoje é antes ou no dia do fechamento do mês atual
              targetMonth -= 1; // A última fechada foi a do mês anterior
              if (targetMonth < 0) { targetMonth = 11; targetYear -=1; }
          } // Se hoje é depois do fechamento, a última fechada é a deste mês
          referenceMonthZeroBased = targetMonth;
          referenceYear = targetYear;
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `Última Fatura Fechada (${formatDate(invoiceStartDate.toISOString().split('T')[0])} - ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;

      } else { // Fatura aberta (type === 'aberta')
          // ... (lógica para fatura aberta) ...
          let targetMonth = today.getUTCMonth(); // Mês atual (0-11)
          let targetYear = today.getUTCFullYear();
          // Se hoje for DEPOIS do dia de fechamento do cartão no mês atual,
          // a fatura aberta já é para o próximo mês de fechamento.
          if (today.getUTCDate() > card.closingDay) {
              targetMonth += 1;
              if (targetMonth > 11) { targetMonth = 0; targetYear +=1; }
          }
          // Se hoje for ANTES ou NO dia de fechamento, a fatura aberta é a que fecha neste mês.
          referenceMonthZeroBased = targetMonth; // Mês de fechamento da fatura aberta
          referenceYear = targetYear;           // Ano de fechamento da fatura aberta
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `Fatura Atual/Aberta (Prev. Fechamento: ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;
      }
      // --- Fim da Lógica para determinar o ciclo da fatura ---


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

      const totalSpendsInInvoice = transactions.reduce((sum, tx) => sum + parseFloat(tx.value), 0);

      // --- NOVO: Buscar pagamentos feitos para esta fatura específica ---
      const referenceMonthYearForPaymentSearch = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, 1))
                                              .toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      
      const paymentsForThisInvoice = await FinancialTransaction.sum('value', {
          where: {
              financialAccountId,
              type: 'Saída',
              creditCardId: null, // Pagamentos de fatura não têm creditCardId
              description: {
                  [Op.iLike]: `Pagamento Fatura ${card.name} (${referenceMonthYearForPaymentSearch})%`
              },
              // Opcional: filtrar pagamentos dentro de um período razoável em torno do vencimento da fatura
              // paymentDate: { [Op.between]: [invoiceStartDate, new Date(invoiceEndDate.getTime() + 30 * 24*60*60*1000)]}
          },
          transaction: t
      }) || 0;
      // --- FIM: Buscar pagamentos ---

      const totalAmountDue = totalSpendsInInvoice - parseFloat(paymentsForThisInvoice);

      let paymentDueDate = new Date(invoiceEndDate); // Data de fechamento
      // Adicionar lógica de cálculo do dia de pagamento baseado no closingDay e paymentDay do cartão
      // Se o dia de pagamento é menor ou igual ao dia de fechamento, a fatura vence no mês seguinte ao fechamento.
      // Se o dia de pagamento é maior que o dia de fechamento, a fatura vence no mesmo mês do fechamento (mas após o fechamento).
      if (card.paymentDay <= card.closingDay) {
          paymentDueDate.setUTCMonth(invoiceEndDate.getUTCMonth() + 1); 
      }
      // Se paymentDay > closingDay, o mês já está correto (o mês do fechamento)
      paymentDueDate.setUTCDate(card.paymentDay);


      await t.commit(); 

      const limitDetails = await getAvailableCreditLimit(financialAccountId, creditCardId); // Busca o limite atualizado
      
      return {
          cardId: card.id,
          cardName: card.name,
          financialAccountId: financialAccountId,
          financialAccountName: financialAccount.accountName,
          financialAccountType: financialAccount.accountType,
          invoicePeriodDescription: invoiceDescriptionPeriod,
          invoiceReferenceMonthYear: new Date(Date.UTC(invoiceEndDate.getUTCFullYear(), invoiceEndDate.getUTCMonth())).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
          invoiceCycleStartDate: invoiceStartDate.toISOString().split('T')[0],
          invoiceCycleEndDate: invoiceEndDate.toISOString().split('T')[0],
          paymentDueDate: paymentDueDate.toISOString().split('T')[0], // Data de vencimento calculada
          totalAmount: parseFloat(totalAmountDue.toFixed(2)), // Este é o valor líquido a pagar
          totalSpendsOriginal: parseFloat(totalSpendsInInvoice.toFixed(2)), // Valor original dos gastos
          totalPaidForThisInvoice: parseFloat(paymentsForThisInvoice.toFixed(2)), // Quanto foi pago para ESTA fatura
          transactions: transactions.map(tx => {
              const jsonTx = tx.toJSON();
              if (jsonTx.isParcel && jsonTx.originalAccount && jsonTx.originalAccount.totalParcels) {
                  jsonTx.totalParcels = jsonTx.originalAccount.totalParcels;
              }
              return jsonTx;
          }),
          cardTotalLimit: parseFloat(card.limit),
          availableLimitAfterInvoice: limitDetails.availableLimit // Este vem de getAvailableCreditLimit
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
            groupLiteral = literal("strftime('%Y-%m', \"FinancialTransaction\".\"transactionDate\")"); // Especificar tabela para ambiguidade
            orderLiteral = literal("strftime('%Y-%m', \"FinancialTransaction\".\"transactionDate\")");
        } else if (dialect === 'postgres') {
            dateExtractFunction = fn('TO_CHAR', col('transactionDate'), 'YYYY-MM');
            groupLiteral = literal("TO_CHAR(\"FinancialTransaction\".\"transactionDate\", 'YYYY-MM')");
            orderLiteral = literal("TO_CHAR(\"FinancialTransaction\".\"transactionDate\", 'YYYY-MM')");
        } else if (dialect === 'mysql') {
            dateExtractFunction = fn('DATE_FORMAT', col('transactionDate'), '%Y-%m');
            groupLiteral = literal("DATE_FORMAT(`FinancialTransaction`.`transactionDate`, '%Y-%m')");
            orderLiteral = literal("DATE_FORMAT(`FinancialTransaction`.`transactionDate`, '%Y-%m')");
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
       
        const periodsMap = new Map(); 

        for (const { yearMonth } of distinctTransactionYearMonths) {
            if (yearMonth && typeof yearMonth === 'string') {
                const [yearStr, monthStr] = yearMonth.split('-');
                const year = parseInt(yearStr, 10);
                const monthZeroBased = parseInt(monthStr, 10) - 1;
                
                // Fatura A: fecha no mês da transação (se a transação foi ANTES do closingDay) OU no mês seguinte.
                // Consideramos o mês de fechamento da fatura.
                // Se uma transação é de Maio, ela pode cair na fatura que fecha em Maio ou em Junho.

                // Cenário 1: Transações do mês X caem na fatura que fecha no final do mês X.
                const closingDate1 = new Date(Date.UTC(year, monthZeroBased, card.closingDay));
                const label1 = closingDate1.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                if (!periodsMap.has(label1)) {
                    periodsMap.set(label1, { month: closingDate1.getUTCMonth() + 1, year: closingDate1.getUTCFullYear(), label: label1 });
                }

                // Cenário 2: Transações do mês X caem na fatura que fecha no início do mês X+1.
                const closingDate2 = new Date(Date.UTC(year, monthZeroBased + 1, card.closingDay)); // Mês seguinte
                const label2 = closingDate2.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                 if (!periodsMap.has(label2)) {
                    periodsMap.set(label2, { month: closingDate2.getUTCMonth() + 1, year: closingDate2.getUTCFullYear(), label: label2 });
                }
            }
        }
       
        const uniquePeriodsArray = Array.from(periodsMap.values())
                               .sort((a, b) => {
                                   if (b.year !== a.year) return b.year - a.year;
                                   return b.month - a.month;
                               });
                               
        const today = new Date();
        let openInvoiceRefMonth = today.getUTCMonth() + 1;
        let openInvoiceRefYear = today.getUTCFullYear();
        if (today.getUTCDate() > card.closingDay) {
            openInvoiceRefMonth += 1;
            if (openInvoiceRefMonth > 12) {
                openInvoiceRefMonth = 1;
                openInvoiceRefYear += 1;
            }
        }
        const openInvoiceLabel = new Date(Date.UTC(openInvoiceRefYear, openInvoiceRefMonth - 1)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        
        const openInvoiceKey = `${openInvoiceRefYear}-${String(openInvoiceRefMonth).padStart(2,'0')}`;
        if (!periodsMap.has(openInvoiceLabel)) {
             uniquePeriodsArray.unshift({ month: openInvoiceRefMonth, year: openInvoiceRefYear, label: `${openInvoiceLabel} (Aberta)`});
        } else {
            const existingOpenIdx = uniquePeriodsArray.findIndex(p => p.label === openInvoiceLabel);
            if (existingOpenIdx > -1 && !uniquePeriodsArray[existingOpenIdx].label.includes("(Aberta)")) {
                uniquePeriodsArray[existingOpenIdx].label = `${uniquePeriodsArray[existingOpenIdx].label} (Aberta)`;
            }
        }

        logger.info(`Encontrados ${uniquePeriodsArray.length} períodos de fatura para cartão ID ${creditCardId}.`);
        return uniquePeriodsArray.slice(0, 12);

    } catch (error) {
        logger.error(`Erro ao obter períodos de fatura para cartão ID ${creditCardId} (Conta: ${financialAccountId}): ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}
async function payCreditCardInvoice(financialAccountId, creditCardId, paymentAmount, paymentDate, originatingAccountDescription = null, financialCategoryId = null, actorClientId = null) {
    const t = await sequelize.transaction();
    try {
        const financialAccount = await validateOwningFinancialAccount(financialAccountId, t);
        const card = await CreditCard.findOne({ where: {id: creditCardId, financialAccountId}, transaction: t });

        if (!card) {
            await t.rollback();
            const error = new Error(`Cartão ID ${creditCardId} não encontrado ou não pertence à conta ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        let referenceMonthDescription = "";
        try {
            // Tenta obter o mês/ano da fatura que está sendo paga.
            // Esta lógica assume que o pagamento é referente à fatura que contém a `paymentDate`
            // ou a fatura que acabou de fechar antes da `paymentDate`.
            const paymentDateObj = new Date(paymentDate + 'T00:00:00.000Z'); // Tratar como data local para UTC
            let invoiceClosingYear = paymentDateObj.getUTCFullYear();
            let invoiceClosingMonthZeroBased = paymentDateObj.getUTCMonth();

            // Se a data de pagamento é DEPOIS do dia de fechamento do cartão no mês atual,
            // a fatura paga é a que fechou NESTE mês.
            // Ex: Cartão fecha dia 10. Pagamento dia 15/Maio -> Fatura de Maio (que fechou dia 10/Maio). Mês de ref: Maio.
            // Se a data de pagamento é ANTES ou NO dia de fechamento do cartão no mês atual,
            // a fatura paga é a que fechou no MÊS ANTERIOR.
            // Ex: Cartão fecha dia 10. Pagamento dia 05/Maio -> Fatura de Abril (que fechou dia 10/Abril). Mês de ref: Abril.
            if (paymentDateObj.getUTCDate() <= card.closingDay) {
                invoiceClosingMonthZeroBased -= 1; // Mês de fechamento foi o anterior
                if (invoiceClosingMonthZeroBased < 0) {
                    invoiceClosingMonthZeroBased = 11; // Dezembro
                    invoiceClosingYear -= 1;
                }
            }
            // Agora, invoiceClosingMonthZeroBased e invoiceClosingYear apontam para o mês e ano em que a fatura FECHOU.
            // O mês de referência da fatura é esse mês de fechamento.
            const referenceDateForDescription = new Date(Date.UTC(invoiceClosingYear, invoiceClosingMonthZeroBased, 1));
            referenceMonthDescription = referenceDateForDescription.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

        } catch (dateError) {
            logger.warn(`[payCreditCardInvoice] Erro ao calcular mês de referência para descrição: ${dateError.message}. Usando descrição genérica.`);
            referenceMonthDescription = "Mês Corrente"; // Fallback
        }


        let categoryId = financialCategoryId;
        if (!categoryId) {
            const defaultCategory = await FinancialCategory.findOne({
                where: { 
                    name: { [Op.iLike]: 'Pagamento de Fatura' }, 
                    financialAccountId: financialAccountId,
                },
                transaction: t
            });
            if (defaultCategory) categoryId = defaultCategory.id;
            else {
                const fallbackCategory = await FinancialCategory.findOne({
                    where: { 
                        name: { [Op.iLike]: 'Pagamento de Cartão' },
                        financialAccountId: financialAccountId,
                    },
                    transaction: t
                });
                if (fallbackCategory) categoryId = fallbackCategory.id;
                else logger.warn(`[SERVICE payCreditCardInvoice] Categoria padrão não encontrada para FA ID ${financialAccountId}.`);
            }
        } else {
            const categoryExists = await FinancialCategory.findOne({
                where: { id: financialCategoryId, financialAccountId: financialAccountId },
                transaction: t
            });
            if (!categoryExists) {
                logger.warn(`[SERVICE payCreditCardInvoice] Categoria ID ${financialCategoryId} fornecida não encontrada/pertence à FA ID ${financialAccountId}.`);
                categoryId = null;
            }
        }

        const transactionDescription = `Pagamento Fatura ${card.name} (${referenceMonthDescription})${originatingAccountDescription ? ` - Origem: ${originatingAccountDescription}` : ''}`;

        const paymentTransaction = await FinancialTransaction.create({
            financialAccountId,
            description: transactionDescription,
            value: Math.abs(paymentAmount), type: 'Saída', transactionDate: paymentDate,
            financialCategoryId: categoryId,
            creditCardId: null, 
            isPayableOrReceivable: false, isPaidOrReceived: true, paymentDate: paymentDate,
            notes: `Pagamento da fatura do cartão ${card.name} (ID Cartão: ${card.id}).`
            // createdBy: actorClientId, 
        }, { transaction: t });

        await t.commit();
        logger.info(`Pagamento de ${formatCurrency(paymentAmount)} para fatura do cartão ID ${creditCardId} (${card.name}) registrado. TX ID: ${paymentTransaction.id}. Mês Ref: ${referenceMonthDescription}`);
        const reloadedPaymentTx = await FinancialTransaction.findByPk(paymentTransaction.id, {
            include: [{model: FinancialCategory, as: 'category', attributes: ['id', 'name']}]
        });
        return reloadedPaymentTx.toJSON();

    } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao registrar pagamento de fatura para cartão ID ${creditCardId} (Conta: ${financialAccountId}): ${error.message}`, { error, financialAccountId });
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
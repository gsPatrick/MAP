// src/features/CreditCardManagement/creditCard.service.js
const { CreditCard, FinancialAccount, FinancialTransaction, FinancialCategory, sequelize } = require('../../database');
const { Op, fn, col, literal } = require('sequelize');
const logger = require('../../utils/logger');

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
    // Prioriza busca exata (case-insensitive)
    let card = await CreditCard.findOne({
        where: {
            name: { [Op.iLike]: cardName }, // Busca exata case-insensitive
            financialAccountId,
            isActive: true 
        },
        transaction
    });

    if (!card) { // Se não achou exato, tenta parcial
        card = await CreditCard.findOne({
            where: {
                name: { [Op.iLike]: `${cardName}%` }, // Começa com
                financialAccountId,
                isActive: true
            },
            transaction
        });
    }
    
    if (!card) { // Se ainda não achou, tenta "contém"
        const cards = await CreditCard.findAll({ where: { financialAccountId, isActive: true }, transaction });
        // Filtro manual para "contém", pois Op.iLike com %term% pode ser ineficiente ou não suportado da mesma forma em todos os DBs
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
        order: [['createdAt', 'ASC']], // Promove o mais antigo ativo
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

/**
 * Calcula o limite de crédito disponível em um cartão.
 * Leva em consideração as transações da fatura atual e as parcelas futuras.
 * @param {number} financialAccountId - ID da conta financeira proprietária do cartão.
 * @param {number} creditCardId - ID do cartão de crédito.
 * @returns {Promise<object>} Objeto com detalhes do limite.
 */
async function getAvailableCreditLimit(financialAccountId, creditCardId) {
    const t = await sequelize.transaction(); // Inicia uma transação para consistência da leitura
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
        let comprometidoFaturaAberta = 0;
        let comprometidoParcelasFuturas = 0;

        // 1. Calcular o valor da fatura atual/aberta
        const today = new Date();
        let currentBillingYear = today.getUTCFullYear();
        let currentBillingMonth = today.getUTCMonth(); // 0-11

        let faturaAbertaStartDate, faturaAbertaEndDate;

        // Determina as datas da fatura aberta (ciclo atual de gastos)
        if (today.getUTCDate() <= card.closingDay) {
            // Fatura atual fecha neste mês, começou no mês passado
            faturaAbertaStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1));
            faturaAbertaEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay));
        } else {
            // Fatura atual fecha no próximo mês, começou neste mês
            faturaAbertaStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay + 1));
            faturaAbertaEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth + 1, card.closingDay));
        }
        
        // Soma das transações (saídas) na fatura aberta
        // Inclui tanto compras à vista quanto parcelas que caem nesta fatura
        const transacoesFaturaAberta = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id,
                type: 'Saída',
                // A data da transação no cartão é a data da compra/lançamento,
                // que determina em qual fatura ela entra.
                transactionDate: {
                    [Op.gte]: faturaAbertaStartDate.toISOString().split('T')[0],
                    [Op.lte]: faturaAbertaEndDate.toISOString().split('T')[0],
                },
                // Não consideramos isPaidOrReceived aqui, pois o pagamento da fatura é um evento separado
            },
            attributes: ['value'],
            transaction: t
        });
        transacoesFaturaAberta.forEach(tx => {
            comprometidoFaturaAberta += parseFloat(tx.value);
        });

        // 2. Calcular o valor das parcelas futuras PENDENTES (que ainda não entraram em nenhuma fatura ou estão em faturas futuras)
        // de todas as compras parceladas feitas neste cartão.
        const parcelasFuturasPendentes = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id,
                type: 'Saída',
                isParcel: true,
                isPaidOrReceived: false, // Considera apenas parcelas não pagas (ou seja, que ainda serão cobradas)
                // dueDate aqui representa a data em que a parcela é esperada na fatura.
                // Precisamos de parcelas cuja data de transação (lançamento no cartão) é POSTERIOR ao fim da fatura aberta.
                // Ou, mais precisamente, cujo dueDate (se corretamente setado para o vencimento da parcela na fatura) é futuro.
                transactionDate: { // A data de lançamento da parcela no cartão
                    [Op.gt]: faturaAbertaEndDate.toISOString().split('T')[0]
                }
            },
            attributes: ['value'],
            transaction: t
        });
        parcelasFuturasPendentes.forEach(parcela => {
            comprometidoParcelasFuturas += parseFloat(parcela.value);
        });
        
        const totalComprometido = comprometidoFaturaAberta + comprometidoParcelasFuturas;
        const availableLimit = totalLimit - totalComprometido;

        await t.commit();

        return {
            cardName: card.name,
            totalLimit: totalLimit,
            usedAmountInOpenInvoice: parseFloat(comprometidoFaturaAberta.toFixed(2)), // Valor já na fatura aberta
            futureInstallmentsAmount: parseFloat(comprometidoParcelasFuturas.toFixed(2)), // Valor de parcelas futuras
            totalCommittedAmount: parseFloat(totalComprometido.toFixed(2)), // Total que está usando do limite
            availableLimit: parseFloat(availableLimit.toFixed(2)),
            closingDay: card.closingDay,
            paymentDay: card.paymentDay,
            currentInvoiceCycle: {
                start: faturaAbertaStartDate.toISOString().split('T')[0],
                end: faturaAbertaEndDate.toISOString().split('T')[0]
            }
        };

    } catch (error) {
        if (t && !t.finished) await t.rollback(); // Garante rollback se a transação não foi finalizada
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

      if (periodOptions.type === 'especifico') {
          if (!periodOptions.month || !periodOptions.year || isNaN(parseInt(periodOptions.month)) || isNaN(parseInt(periodOptions.year))) {
              await t.rollback();
              const error = new Error("Mês e ano são obrigatórios e devem ser números para fatura de período específico.");
              error.statusCode = 400; error.status = 'fail'; throw error;
          }
          const requestedMonth = parseInt(periodOptions.month, 10) - 1; // Mês é base 0 no Date
          const requestedYear = parseInt(periodOptions.year, 10);

          // Fatura de "Maio" (mês 4) fecha no dia de fechamento de Maio.
          // Gastos são do dia (fechamento de Abril + 1) até dia (fechamento de Maio).
          invoiceEndDate = new Date(Date.UTC(requestedYear, requestedMonth, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(requestedYear, requestedMonth -1 , card.closingDay + 1)); // Mês anterior, dia seguinte ao fechamento
          invoiceDescriptionPeriod = `${new Date(Date.UTC(requestedYear, requestedMonth)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone:'UTC' })}`;

      } else if (periodOptions.type === 'ultima_fechada') {
          if (today.getUTCDate() <= card.closingDay) { // A fatura deste mês ainda não fechou, então a última fechada é a do mês anterior.
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay));
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 2, card.closingDay + 1));
          } else { // A fatura deste mês já fechou.
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay));
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1));
          }
          invoiceDescriptionPeriod = `Última Fatura Fechada (${formatDate(invoiceStartDate)} - ${formatDate(invoiceEndDate)})`;
      } else { // 'aberta' (default)
          if (today.getUTCDate() <= card.closingDay) {
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1));
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay));
          } else {
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay + 1));
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth + 1, card.closingDay));
          }
          invoiceDescriptionPeriod = `Fatura Atual/Aberta (Prev. Fechamento: ${formatDate(invoiceEndDate)})`;
      }

      const transactions = await FinancialTransaction.findAll({
          where: {
              financialAccountId,
              creditCardId,
              type: 'Saída',
              transactionDate: { // A data da transação é o que define em qual fatura ela entra
                  [Op.gte]: invoiceStartDate.toISOString().split('T')[0],
                  [Op.lte]: invoiceEndDate.toISOString().split('T')[0]
              }
          },
          order: [['transactionDate', 'ASC'], ['createdAt', 'ASC']],
          include: [
              {model: FinancialCategory, as: 'category', attributes: ['name']},
              {model: FinancialTransaction, as: 'originalAccount', attributes:['description']}
          ],
          transaction: t
      });

      let totalAmount = 0;
      transactions.forEach(tx => {
          totalAmount += parseFloat(tx.value);
      });

      let paymentDueDate = new Date(invoiceEndDate); // Começa com a data de fechamento
      // Se o dia de pagamento for menor ou igual ao dia de fechamento, ele é no mês seguinte ao fechamento.
      // Se for maior, é no mesmo mês do fechamento.
      if (card.paymentDay <= card.closingDay) {
          paymentDueDate.setUTCMonth(invoiceEndDate.getUTCMonth() + 1);
      }
      paymentDueDate.setUTCDate(card.paymentDay);

      await t.commit();

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
          cardTotalLimit: parseFloat(card.limit) // Adicionando o limite total do cartão para uso na formatação
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

        // Obtém os meses/anos únicos onde ocorreram transações para este cartão
        const distinctTransactionMonths = await FinancialTransaction.findAll({
            attributes: [
                [fn('strftime', '%Y-%m', col('transactionDate')), 'yearMonth']
            ],
            where: {
                creditCardId: creditCardId,
                financialAccountId: financialAccountId,
                type: 'Saída' 
            },
            group: ['yearMonth'],
            order: [[literal('"yearMonth"'), 'DESC']],
            raw: true,
        });
        
        const periods = [];
        const addedLabels = new Set();

        for (const { yearMonth } of distinctTransactionMonths) {
            if (yearMonth) { 
                const [yearStr, monthStr] = yearMonth.split('-');
                const year = parseInt(yearStr, 10);
                const monthOneBased = parseInt(monthStr, 10); // Mês 1-12
                const monthZeroBased = monthOneBased - 1; // Mês 0-11 para o objeto Date

                // Determinar o mês/ano de FECHAMENTO da fatura para esses gastos
                // Se um gasto ocorreu no dia `d` do mês `m` e o cartão fecha dia `c`:
                // - Se `d <= c`, a fatura de referência é o mês `m`.
                // - Se `d > c`, a fatura de referência é o mês `m+1`.
                // Como estamos agrupando por mês de transação, vamos assumir que a maioria das transações
                // de um determinado "yearMonth" cairá na fatura que fecha *após* ou *no final* desse mês.

                // Data de fechamento da fatura referente aos gastos desse mês.
                // Ex: Gastos de Maio (yearMonth = YYYY-05), cartão fecha dia 20.
                // A fatura de Maio fecha em 20/05.
                // Se gasto foi 25/05, entra na fatura de Junho (fecha 20/06).
                // Esta lógica pode ser complexa. Uma simplificação é listar os meses/anos das transações
                // e deixar o `getCreditCardInvoiceDetails` calcular as datas exatas da fatura para esse mês/ano.

                // Para simplificar a lista de opções, vamos usar o mês/ano da transação como referência.
                const labelDate = new Date(Date.UTC(year, monthZeroBased, 1));
                const label = labelDate.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

                if (!addedLabels.has(label)) {
                    periods.push({
                        month: monthOneBased, 
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
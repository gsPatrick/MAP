// src/features/CreditCardManagement/creditCard.service.js
const { CreditCard, FinancialAccount, FinancialTransaction, FinancialCategory, sequelize } = require('../../database');
const { Op, fn, col, literal } = require('sequelize');
const logger = require('../../utils/logger');
const { formatDate, formatCurrency, formatTime } = require('../../utils/formatters'); // <<< IMPORTAÇÃO ADICIONADA

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

    if (!card) { // Se não achou exato, tenta parcial (começa com)
        card = await CreditCard.findOne({
            where: {
                name: { [Op.iLike]: `${cardName}%` }, // Começa com
                financialAccountId,
                isActive: true
            },
            transaction
        });
    }
   
    if (!card) { // Se ainda não achou, tenta "contém" - mais flexível
        const cards = await CreditCard.findAll({ where: { financialAccountId, isActive: true }, transaction });
        // Filtro manual para "contém", pois Op.iLike com %term% pode ser ineficiente ou não suportado da mesma forma em todos os DBs
        card = cards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
    }


    if (card) {
        logger.info(`Cartão encontrado para "${cardName}": "${card.name}" (ID: ${card.id})`);
    } else {
        // Ajusta a mensagem para ser mais genérica, já que tentamos várias formas
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
      // Se não está marcando como default, verifica se precisa tornar default (se não houver outros)
      const defaultCount = await CreditCard.count({ where: { financialAccountId, isDefault: true }, transaction: t });
      if (defaultCount === 0) { // Nenhum outro cartão é default
        cardData.isDefault = true; // Este novo cartão se torna o default
      } else {
        cardData.isDefault = false; // Já existe um default, este não será
      }
    }
    // Garante que isActive seja booleano, default true
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
    if (!error.statusCode) error.statusCode = 500; // Default para erro interno do servidor
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
    // Sempre prioriza o cartão default no topo da lista, se houver
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
    return { cards: resultCards, totalItems: resultCards.length }; // Retorna objeto com lista e total
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
      // Lança erro 404 para ser tratado pelo controller
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

    // Lógica para manter sempre um cartão default se este for desmarcado ou inativado
    if ((updateData.isDefault === false || updateData.isDefault === 'false') && card.isDefault) {
      // Tenta encontrar outro cartão ativo para ser o default
      const otherActiveCard = await CreditCard.findOne({
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
        order: [['createdAt', 'ASC']], // Promove o mais antigo ativo
        transaction: t,
      });
      if (otherActiveCard) {
        await otherActiveCard.update({ isDefault: true }, { transaction: t });
      } else if (updateData.isActive === undefined || updateData.isActive === true || updateData.isActive === 'true') {
        // Se não há outros cartões ativos e este está sendo desmarcado como default mas continua ativo, ele DEVE ser o default.
        updateData.isDefault = true;
        logger.warn(`Tentativa de desmarcar cartão ID ${cardId} como default, mas não há outros ativos. Ele permanecerá default.`);
      } else {
        // Se está sendo inativado e era o default, e não há outros, ok (não haverá default).
      }
    } else if ((updateData.isDefault === true || updateData.isDefault === 'true') && !card.isDefault) {
      // Se está marcando este como default, desmarca qualquer outro que era default.
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true, id: { [Op.ne]: cardId } }, transaction: t }
      );
    }


    delete updateData.financialAccountId; // Impede a alteração do financialAccountId

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
      error.statusCode = 409; // Conflito
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
async function getAvailableCreditLimit(financialAccountId, creditCardId) { // Renomeado para evitar conflito de nome
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
        let netUsedAmount = 0; // Valor líquido usado na fatura aberta (despesas - pagamentos/créditos na fatura)

        // 1. Calcular o valor da fatura atual/aberta
        const today = new Date();
        let currentBillingYear = today.getUTCFullYear();
        let currentBillingMonth = today.getUTCMonth(); // 0-11

        let faturaAbertaStartDate, faturaAbertaEndDate;

        // Determina as datas da fatura aberta (ciclo atual de gastos)
        if (today.getUTCDate() <= card.closingDay) {
            // Fatura atual fecha neste mês, começou no mês passado
            faturaAbertaStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth - 1, card.closingDay + 1, 0, 0, 0, 0));
            faturaAbertaEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay, 23, 59, 59, 999));
        } else {
            // Fatura atual fecha no próximo mês, começou neste mês
            faturaAbertaStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay + 1, 0, 0, 0, 0));
            faturaAbertaEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth + 1, card.closingDay, 23, 59, 59, 999));
        }
       
        // Soma das transações (saídas) na fatura aberta
        const transacoesFaturaAberta = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id,
                financialAccountId, // Garante que são da conta correta
                // A data da transação no cartão é a data da compra/lançamento,
                // que determina em qual fatura ela entra.
                transactionDate: {
                    [Op.gte]: faturaAbertaStartDate.toISOString().split('T')[0],
                    [Op.lte]: faturaAbertaEndDate.toISOString().split('T')[0],
                },
            },
            attributes: ['value', 'type'],
            transaction: t
        });

        transacoesFaturaAberta.forEach(tx => {
            if (tx.type === 'Saída') {
                netUsedAmount += parseFloat(tx.value);
            } else if (tx.type === 'Entrada') { // Créditos na fatura (estornos, pagamentos parciais diretos)
                netUsedAmount -= parseFloat(tx.value);
            }
        });
       
        const availableLimit = totalLimit - netUsedAmount;

        await t.commit();

        return {
            cardName: card.name,
            totalLimit: totalLimit,
            netUsedAmount: parseFloat(netUsedAmount.toFixed(2)), // Valor líquido usado na fatura aberta
            availableLimit: parseFloat(availableLimit.toFixed(2)),
            closingDay: card.closingDay,
            paymentDay: card.paymentDay,
            currentInvoiceCycle: { // Datas do ciclo de fatura aberta
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
      let currentBillingMonth = today.getUTCMonth(); // 0-11 (Janeiro é 0)

      let invoiceStartDate, invoiceEndDate, invoiceDescriptionPeriod;
      let referenceYear, referenceMonthZeroBased;


      if (periodOptions.type === 'especifico') {
          if (!periodOptions.month || !periodOptions.year || isNaN(parseInt(periodOptions.month)) || isNaN(parseInt(periodOptions.year))) {
              await t.rollback();
              const error = new Error("Mês e ano são obrigatórios e devem ser números para fatura de período específico.");
              error.statusCode = 400; error.status = 'fail'; throw error;
          }
          referenceMonthZeroBased = parseInt(periodOptions.month, 10) - 1; // Ajusta para base 0
          referenceYear = parseInt(periodOptions.year, 10);

          // A fatura "de Maio" (referenceMonthZeroBased = 4) fecha no dia `card.closingDay` de Maio.
          // Ela inclui gastos desde (`card.closingDay` de Abril + 1 dia) até (`card.closingDay` de Maio).
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `${new Date(Date.UTC(referenceYear, referenceMonthZeroBased)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone:'UTC' })}`;

      } else if (periodOptions.type === 'ultima_fechada') {
          // Se hoje é ANTES ou NO dia de fechamento do mês ATUAL, a última fatura fechada é a do MÊS ANTERIOR.
          // Ex: Hoje 15/Maio, cartão fecha dia 20. Fatura de Maio AINDA NÃO FECHOU. Última fechada é a de Abril (gastos de Março/Abril, fechou em 20/Abril).
          if (today.getUTCDate() <= card.closingDay) {
              referenceMonthZeroBased = currentBillingMonth - 1; // Mês anterior
              referenceYear = currentBillingYear;
              if (referenceMonthZeroBased < 0) { // Se era Janeiro, volta para Dezembro do ano anterior
                  referenceMonthZeroBased = 11;
                  referenceYear -= 1;
              }
          } else { // Se hoje é DEPOIS do dia de fechamento do mês ATUAL, a última fatura fechada é a DESTE MÊS.
              // Ex: Hoje 25/Maio, cartão fecha dia 20. Fatura de Maio JÁ FECHOU em 20/Maio.
              referenceMonthZeroBased = currentBillingMonth;
              referenceYear = currentBillingYear;
          }
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `Última Fatura Fechada (${formatDate(invoiceStartDate.toISOString().split('T')[0])} - ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;
      } else { // 'aberta' (default)
          // Fatura aberta: Gastos desde (dia de fechamento do mês passado + 1) até (dia de fechamento do mês atual/próximo).
          // Se hoje é ANTES ou NO dia de fechamento do mês ATUAL, a fatura ABERTA fecha NESTE MÊS.
          // Gastos de (fechamento mês passado + 1) até (fechamento deste mês).
          if (today.getUTCDate() <= card.closingDay) {
              referenceMonthZeroBased = currentBillingMonth; // Fatura atual
              referenceYear = currentBillingYear;
          } else { // Se hoje é DEPOIS do dia de fechamento do mês ATUAL, a fatura ABERTA fecha no PRÓXIMO MÊS.
              // Gastos de (fechamento deste mês + 1) até (fechamento próximo mês).
              referenceMonthZeroBased = currentBillingMonth + 1; // Fatura do próximo mês
              referenceYear = currentBillingYear;
              if (referenceMonthZeroBased > 11) { // Se era Dezembro, vai para Janeiro do próximo ano
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
              {model: FinancialTransaction, as: 'originalAccount', attributes:['description']} // Para parcelas
          ],
          transaction: t
      });

      let totalAmount = 0;
      transactions.forEach(tx => {
          totalAmount += parseFloat(tx.value);
      });

      // Calcular data de vencimento da fatura
      let paymentDueDate = new Date(invoiceEndDate); // Começa com a data de fechamento da fatura
      // Se o dia de pagamento for menor ou igual ao dia de fechamento, o pagamento é no mês seguinte ao fechamento.
      // Se for maior, é no mesmo mês do fechamento.
      if (card.paymentDay <= card.closingDay) {
          paymentDueDate.setUTCMonth(invoiceEndDate.getUTCMonth() + 1); // Próximo mês
      }
      paymentDueDate.setUTCDate(card.paymentDay); // Define o dia do pagamento

      await t.commit();

      return {
          cardName: card.name,
          financialAccountName: financialAccount.accountName,
          financialAccountType: financialAccount.accountType,
          invoicePeriodDescription: invoiceDescriptionPeriod,
          // Mês/Ano de referência da fatura (mês do fechamento)
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
        // Agrupa pela data de TRANSAÇÃO, que é o que define qual fatura a transação entra.
        const distinctTransactionMonths = await FinancialTransaction.findAll({
            attributes: [
                // Agrupa por ano e mês da data da transação
                [fn('strftime', '%Y-%m', col('transactionDate')), 'yearMonth']
            ],
            where: {
                creditCardId: creditCardId,
                financialAccountId: financialAccountId,
                type: 'Saída' // Apenas despesas
            },
            group: [literal("strftime('%Y-%m', transactionDate)")], // Agrupa pela string YYYY-MM
            order: [[literal("strftime('%Y-%m', transactionDate)"), 'DESC']], // Ordena do mais recente para o mais antigo
            raw: true, // Retorna objetos simples
        });
       
        const periods = [];
        const addedLabels = new Set(); // Para evitar rótulos duplicados se a lógica de fatura for complexa

        for (const { yearMonth } of distinctTransactionMonths) {
            if (yearMonth) { // Ex: "2024-05"
                const [yearStr, monthStr] = yearMonth.split('-');
                const year = parseInt(yearStr, 10);
                const monthOneBased = parseInt(monthStr, 10); // Mês 1-12
                const monthZeroBased = monthOneBased - 1; // Mês 0-11 para o objeto Date

                // A fatura de referência para gastos em "YYYY-MM" é a fatura que FECHA em "YYYY-MM" ou "YYYY-MM+1"
                // Ex: Gastos de Maio/2024 (yearMonth = 2024-05). Cartão fecha dia 20.
                // Se gasto em 15/05 -> Fatura de Maio (fecha 20/05). Mês de referência: Maio.
                // Se gasto em 25/05 -> Fatura de Junho (fecha 20/06). Mês de referência: Junho.
                // Para simplificar a lista de "períodos de fatura" para o usuário escolher,
                // vamos apresentar o mês/ano em que a fatura FECHA.

                // Calcula a data de fechamento da fatura que inclui transações do `yearMonth`
                // Esta é uma heurística. A fatura que inclui transações de `yearMonth`
                // geralmente fecha no próprio `yearMonth` ou no `yearMonth + 1`.
                // Para simplificar, vamos apresentar o mês de fechamento.

                // Assumimos que transações de um `yearMonth` podem cair na fatura que fecha nesse `yearMonth`
                // ou na que fecha no `yearMonth` seguinte. Vamos oferecer ambos como opções se houver transações.

                // Fatura que fecha no mês das transações:
                let closingDateOption1 = new Date(Date.UTC(year, monthZeroBased, card.closingDay));
                let label1 = closingDateOption1.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                if (!addedLabels.has(label1)) {
                    periods.push({
                        month: closingDateOption1.getUTCMonth() + 1, // Mês de fechamento
                        year: closingDateOption1.getUTCFullYear(),
                        label: label1
                    });
                    addedLabels.add(label1);
                }

                // Fatura que fecha no mês SEGUINTE ao das transações:
                // (Pode ser relevante se a maioria dos gastos ocorre no fim do mês, após o fechamento)
                let closingDateOption2 = new Date(Date.UTC(year, monthZeroBased + 1, card.closingDay));
                let label2 = closingDateOption2.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                 if (!addedLabels.has(label2)) {
                    periods.push({
                        month: closingDateOption2.getUTCMonth() + 1, // Mês de fechamento
                        year: closingDateOption2.getUTCFullYear(),
                        label: label2
                    });
                    addedLabels.add(label2);
                }
            }
        }
       
        // Remove duplicatas e ordena do mais recente para o mais antigo
        const uniquePeriods = Array.from(new Set(periods.map(p => JSON.stringify({month: p.month, year: p.year, label: p.label}))))
                               .map(s => JSON.parse(s))
                               .sort((a, b) => {
                                   if (b.year !== a.year) return b.year - a.year;
                                   return b.month - a.month;
                               });

        logger.info(`Encontrados ${uniquePeriods.length} períodos de fatura distintos para cartão ID ${creditCardId}.`);
        return uniquePeriods;

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
                where: { name: 'Pagamento de Fatura', type: 'Saída', isActive: true }, // Tenta encontrar uma categoria padrão
                transaction: t
            });
            if (defaultCategory) {
                categoryId = defaultCategory.id;
            } else {
                // Opcional: Criar a categoria "Pagamento de Fatura" se não existir
                // Ou deixar categoryId como null (transação ficará sem categoria)
                logger.warn(`Categoria "Pagamento de Fatura" não encontrada para o pagamento do cartão ${card.name}.`);
            }
        }

        // Cria uma transação de SAÍDA na conta financeira principal para representar o pagamento da fatura.
        // Esta transação NÃO está associada ao cartão de crédito em si (creditCardId: null).
        const paymentTransaction = await FinancialTransaction.create({
            financialAccountId,
            description: `Pagamento Fatura ${card.name}${originatingAccountDescription ? ` (Origem: ${originatingAccountDescription})` : ''}`,
            value: Math.abs(paymentAmount), // Garante que seja positivo
            type: 'Saída',
            transactionDate: paymentDate,
            financialCategoryId: categoryId,
            creditCardId: null, // Pagamento de fatura não é um gasto NO cartão, é um pagamento DO cartão
            isPayableOrReceivable: false, // Pagamento é uma transação realizada
            isPaidOrReceived: true,       // Já foi pago
            paymentDate: paymentDate,     // Data do pagamento
            notes: `Pagamento da fatura do cartão ${card.name} (ID: ${card.id}).`
        }, { transaction: t });

        await t.commit();
        logger.info(`Pagamento de ${formatCurrency(paymentAmount)} para fatura do cartão ID ${creditCardId} (${card.name}) registrado com sucesso. Transação ID: ${paymentTransaction.id}`);
        // Recarrega para incluir a categoria se foi encontrada
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
  getAvailableCreditLimit, // Nome antigo, mantido para compatibilidade se usado externamente (embora agora seja getAvailableCreditLimit)
  getAvailableCreditLimit, // Nome correto da função
  getCreditCardInvoiceDetails,
  getAvailableInvoicePeriods,
  payCreditCardInvoice,
};
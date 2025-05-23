// src/features/CreditCardManagement/creditCard.service.js
const { CreditCard, FinancialAccount, FinancialTransaction, sequelize } = require('../../database');
const { Op } = require('sequelize'); // Op já estava importado
const logger = require('../../utils/logger');
const { formatDate, formatCurrency, formatTime } = require('../../utils/formatters'); // Removidos pois não são usados diretamente aqui

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
            isActive: true // Considerar apenas ativos na busca por nome para uso
        },
        transaction
    });

    if (!card) {
        // Tenta uma busca parcial se a exata falhar
        card = await CreditCard.findOne({
            where: {
                name: { [Op.iLike]: `${cardName}%` }, // Começa com
                financialAccountId,
                isActive: true
            },
            transaction
        });
    }
   
    if (!card) {
        const cards = await CreditCard.findAll({ where: { financialAccountId, isActive: true }, transaction });
        // Busca case-insensitive no array retornado
        card = cards.find(c => c.name.toLowerCase().includes(cardName.toLowerCase()));
    }

    if (card) {
        logger.info(`Cartão encontrado para "${cardName}": "${card.name}" (ID: ${card.id})`);
    } else {
        // Não lança erro aqui, apenas retorna null se não encontrar,
        // para que o chamador (ex: WhatsApp service) possa decidir como lidar.
        logger.warn(`Cartão de crédito ativo com nome parecido com "${cardName}" não encontrado na conta financeira ID ${financialAccountId}.`);
        return null;
    }
    return card; // Retorna o objeto Sequelize ou null
}


async function createCreditCard(financialAccountId, cardData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);

    const requiredFields = ['name', 'limit', 'closingDay', 'paymentDay'];
    for (const field of requiredFields) {
      if (cardData[field] === undefined || cardData[field] === null || 
          (typeof cardData[field] === 'string' && cardData[field].trim() === '')) {
        const error = new Error(`Campo obrigatório "${field}" não fornecido ou inválido.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
    }
    
    // Validação de unicidade do nome já está no índice do modelo, mas verificar aqui evita erro de DB.
    // O índice é financialAccountId + name.
    // A validação no modelo já faz isso no beforeValidate/Create.

    // Lógica para isDefault:
    // Se o novo cartão está sendo marcado como default, desmarca os outros.
    // Se não está sendo marcado como default, e não há nenhum default ainda, torna este default.
    if (cardData.isDefault === true || cardData.isDefault === 'true') {
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true }, transaction: t }
      );
      cardData.isDefault = true; // Garante que é booleano
    } else {
      const defaultCount = await CreditCard.count({ where: { financialAccountId, isDefault: true }, transaction: t });
      if (defaultCount === 0) {
        cardData.isDefault = true; // Primeiro cartão da conta torna-se default
      } else {
        cardData.isDefault = false; // Garante que seja booleano
      }
    }
    cardData.isActive = cardData.isActive === undefined ? true : (cardData.isActive === 'true' || cardData.isActive === true);

    // Inclui os novos campos opcionais
    const createPayload = {
        ...cardData,
        financialAccountId,
        dominantColor: cardData.dominantColor || null,
        flagIconUrl: cardData.flagIconUrl || null,
    };

    const newCard = await CreditCard.create(createPayload, { transaction: t });
    await t.commit();
    logger.info(`Cartão "${newCard.name}" (ID: ${newCard.id}) criado para FinancialAccount ID ${financialAccountId}. Default: ${newCard.isDefault}`);
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
    if (error.name === 'SequelizeUniqueConstraintError' && error.fields) {
        const field = Object.keys(error.fields)[0];
        const valError = new Error(`O campo '${field}' com valor '${error.fields[field]}' já existe para esta conta.`);
        valError.statusCode = 409; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAllCreditCards(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const { isActive, sortBy = 'name', sortOrder = 'ASC', includeSummary = 'false' } = queryParams; // includeSummary default false
    const whereConditions = { financialAccountId };

    if (isActive !== undefined) {
      whereConditions.isActive = (isActive === 'true' || isActive === true);
    }

    const validSortBy = ['name', 'limit', 'closingDay', 'paymentDay', 'createdAt', 'updatedAt', 'isDefault'];
    const validSortOrders = ['ASC', 'DESC'];
    const sortField = validSortBy.includes(sortBy) ? sortBy : 'name';
    const sortDirection = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC';

    const order = [];
    if (sortField === 'isDefault') { // Ordenar por default primeiro se for o critério
        order.push(['isDefault', sortDirection === 'ASC' ? 'DESC' : 'ASC']); // isDefault true primeiro
    } else {
        order.push(['isDefault', 'DESC']); // Sempre default primeiro, a menos que ordenando por ele
        order.push([sortField, sortDirection]);
    }
    if (sortField !== 'name' && sortField !== 'isDefault') order.push(['name', 'ASC']); // Ordenação secundária por nome


    const cards = await CreditCard.findAll({
      where: whereConditions,
      order: order,
    });

    let resultCards = cards.map(c => c.toJSON());

    if (includeSummary === 'true' || includeSummary === true) { // Checa se includeSummary é true
        resultCards = await Promise.all(resultCards.map(async (cardJson) => {
            if(cardJson.isActive) { // Só calcula limite para ativos
                try {
                    const limitDetails = await getAvailableCreditLimit(financialAccountId, cardJson.id);
                    return { ...cardJson, availableLimit: limitDetails.availableLimit };
                } catch (limitError) {
                    logger.warn(`Não foi possível calcular o limite disponível para o cartão ${cardJson.name} (ID: ${cardJson.id}): ${limitError.message}`);
                    return { ...cardJson, availableLimit: null }; // Retorna null se não puder calcular
                }
            }
            return { ...cardJson, availableLimit: null }; // Para cartões inativos
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
      // logger.warn já é feito no controller, não precisa aqui.
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
      const error = new Error(`Cartão de crédito ID ${cardId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    // Validação de unicidade de nome já tratada pelo índice e validação do modelo.
    
    // Lógica de isDefault:
    // Se está marcando este como default E ele NÃO era default antes:
    if ((updateData.isDefault === true || updateData.isDefault === 'true') && !card.isDefault) {
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true, id: { [Op.ne]: cardId } }, transaction: t }
      );
      updateData.isDefault = true; // Garante booleano
    } 
    // Se está desmarcando este como default E ele ERA default antes:
    else if ((updateData.isDefault === false || updateData.isDefault === 'false') && card.isDefault) {
      // Tenta encontrar outro cartão ativo para tornar default
      const otherActiveCard = await CreditCard.findOne({
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
        order: [['createdAt', 'ASC']], // Pega o mais antigo ativo como candidato
        transaction: t,
      });
      if (otherActiveCard && (updateData.isActive === undefined || updateData.isActive === true || updateData.isActive === 'true')) {
        // Se este cartão que está sendo desmarcado como default continua ativo, ok.
        // Mas se não houver outro cartão para ser default, este não pode ser desmarcado
        // A menos que esteja sendo inativado também.
        updateData.isDefault = false; // Permite desmarcar
      } else if (!otherActiveCard && (updateData.isActive === undefined || updateData.isActive === true || updateData.isActive === 'true')) {
          // Se não há outro cartão ativo e este cartão está sendo mantido ativo, ele DEVE ser default.
          updateData.isDefault = true;
          logger.warn(`Tentativa de desmarcar cartão ID ${cardId} como default, mas não há outros ativos. Ele permanecerá default.`);
      } else {
           updateData.isDefault = false; // Permite desmarcar se está sendo inativado ou se há outros.
      }
    }


    // Remove financialAccountId de updateData para não permitir mover entre contas
    delete updateData.financialAccountId;
    // Converte strings 'true'/'false' para booleanos para isActive e isDefault
    if (updateData.hasOwnProperty('isActive')) {
        updateData.isActive = (updateData.isActive === 'true' || updateData.isActive === true);
    }
    if (updateData.hasOwnProperty('isDefault') && typeof updateData.isDefault !== 'boolean') {
        updateData.isDefault = (updateData.isDefault === 'true' || updateData.isDefault === true);
    }


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
    if (error.name === 'SequelizeUniqueConstraintError' && error.fields) {
        const field = Object.keys(error.fields)[0];
        const valError = new Error(`O campo '${field}' com valor '${error.fields[field]}' já existe para esta conta.`);
        valError.statusCode = 409; valError.status = 'fail';
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

    // Se o cartão a ser deletado é o default, promove outro a default se existir
    if (card.isDefault) {
      const otherCard = await CreditCard.findOne({
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } }, // Busca outro ATIVO
        order: [['createdAt', 'ASC']], // O mais antigo ativo
        transaction: t,
      });
      if (otherCard) {
        await otherCard.update({ isDefault: true }, { transaction: t });
        logger.info(`Cartão ID ${otherCard.id} ("${otherCard.name}") promovido a default para FinancialAccount ID ${financialAccountId}.`);
      } else {
        logger.info(`Cartão default ID ${cardId} excluído. Nenhum outro cartão ativo para promover a default na conta ${financialAccountId}.`);
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

        if (!card || card.financialAccountId !== financialAccountId) { /* ... erro 404 ... */ }
        if (!card.isActive) { /* ... erro 400 ... */ }

        const totalLimit = parseFloat(card.limit);
        let totalSpendsImpactingLimit = 0;

        // 1. Soma o VALOR TOTAL de todas as compras parceladas "mãe"
        const parcelledPurchasesMothers = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id,
                financialAccountId,
                type: 'Saída',
                isParcel: true,
                originalAccountId: { [Op.eq]: sequelize.col('id') } 
            },
            transaction: t
        });
        parcelledPurchasesMothers.forEach(motherTx => {
            totalSpendsImpactingLimit += parseFloat(motherTx.originalPurchaseTotalValue || motherTx.value);
        });

        // 2. Soma o valor de todas as compras à vista (não parceladas)
        const singlePurchases = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id,
                financialAccountId,
                type: 'Saída',
                isParcel: false 
            },
            transaction: t
        });
        singlePurchases.forEach(tx => {
            totalSpendsImpactingLimit += parseFloat(tx.value);
        });

        // 3. Subtrai créditos diretos no cartão (estornos, etc.)
        const directCreditsOnCard = await FinancialTransaction.sum('value', {
            where: { creditCardId: card.id, financialAccountId, type: 'Entrada' },
            transaction: t
        }) || 0;
        totalSpendsImpactingLimit -= parseFloat(directCreditsOnCard);

        // 4. Subtrai pagamentos de fatura (esta parte é complexa e depende de como são registrados)
        //    Se a descrição contiver "Pagamento Fatura [Nome do Cartão]"
        const invoicePayments = await FinancialTransaction.sum('value', {
            where: {
                financialAccountId, 
                type: 'Saída',
                creditCardId: null, 
                description: { [Op.iLike]: `Pagamento Fatura ${card.name}%` }
            },
            transaction: t
        }) || 0;
        
        const currentDebtOnCard = Math.max(0, totalSpendsImpactingLimit - parseFloat(invoicePayments));
        const availableLimitFinal = totalLimit - currentDebtOnCard;

        // Cálculo da fatura aberta
        const today = new Date();
        let invoiceStartDate, invoiceEndDate;
        if (today.getUTCDate() <= card.closingDay) {
            invoiceStartDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, card.closingDay + 1, 0,0,0,0));
            invoiceEndDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), card.closingDay, 23,59,59,999));
        } else {
            invoiceStartDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), card.closingDay + 1, 0,0,0,0));
            invoiceEndDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, card.closingDay, 23,59,59,999));
        }
        
        const openInvoiceTransactions = await FinancialTransaction.findAll({
            where: {
                creditCardId: card.id, financialAccountId, type: 'Saída', 
                transactionDate: { 
                    [Op.gte]: invoiceStartDate.toISOString().split('T')[0],
                    [Op.lte]: invoiceEndDate.toISOString().split('T')[0],
                },
            },
            attributes: ['value'], transaction: t
        });
        let netUsedInOpenInvoice = 0;
        openInvoiceTransactions.forEach(tx => { netUsedInOpenInvoice += parseFloat(tx.value); });

        await t.commit();
        return {
            cardName: card.name, totalLimit: totalLimit,
            netUsedAmountInOpenInvoice: parseFloat(netUsedInOpenInvoice.toFixed(2)), // Valor da fatura aberta atual
            totalDebtOnCard: parseFloat(currentDebtOnCard.toFixed(2)),
            availableLimit: parseFloat(availableLimitFinal.toFixed(2)),
            closingDay: card.closingDay, paymentDay: card.paymentDay,
            currentInvoiceCycle: { start: invoiceStartDate.toISOString().split('T')[0], end: invoiceEndDate.toISOString().split('T')[0] }
        };
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao calcular limite para cartão ID ${creditCardId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}


async function getCreditCardInvoiceDetails(financialAccountId, creditCardId, periodOptions = { type: 'aberta' }) {
  const t = await sequelize.transaction();
  try {
      const financialAccount = await validateOwningFinancialAccount(financialAccountId, t);
      const card = await CreditCard.findByPk(creditCardId, { transaction: t });

      if (!card || card.financialAccountId !== financialAccountId) { /* ...erro 404... */ }
      if (!card.isActive) { /* ...erro 400... */ }

      const today = new Date();
      let invoiceStartDate, invoiceEndDate, invoiceDescriptionPeriod;
      let referenceYear, referenceMonthZeroBased;

      if (periodOptions.type === 'especifico') {
          // ... (lógica para período específico mantida) ...
          if (!periodOptions.month || !periodOptions.year || isNaN(parseInt(periodOptions.month)) || isNaN(parseInt(periodOptions.year))) {
              const error = new Error("Mês e ano são obrigatórios para fatura específica.");
              error.statusCode = 400; error.status = 'fail'; throw error;
          }
          referenceMonthZeroBased = parseInt(periodOptions.month, 10) - 1;
          referenceYear = parseInt(periodOptions.year, 10);
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased -1 , card.closingDay + 1));
          invoiceDescriptionPeriod = `${new Date(Date.UTC(referenceYear, referenceMonthZeroBased)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone:'UTC' })}`;

      } else if (periodOptions.type === 'ultima_fechada') {
          // ... (lógica para última fechada mantida) ...
          let targetMonth = today.getUTCMonth();
          let targetYear = today.getUTCFullYear();
          if (today.getUTCDate() <= card.closingDay) { // Se hoje é antes ou no dia do fechamento, a última fechada é do mês anterior ao mês anterior
            targetMonth -=1; 
            if(targetMonth < 0) { targetMonth = 11; targetYear -=1; }
          }
          // Se hoje é depois do dia de fechamento, a última fechada é do mês atual
          referenceMonthZeroBased = targetMonth -1; // Mês anterior ao targetMonth (que é o mês da fatura fechada)
          referenceYear = targetYear;
          if(referenceMonthZeroBased < 0) { referenceMonthZeroBased = 11; referenceYear -=1; }

          invoiceEndDate = new Date(Date.UTC(targetYear, targetMonth, card.closingDay)); // Fim do ciclo é o dia de fechamento do mês da fatura
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased , card.closingDay + 1)); // Início é dia seguinte ao fechamento do mês anterior ao da fatura
          invoiceDescriptionPeriod = `Última Fatura Fechada (${formatDate(invoiceStartDate.toISOString().split('T')[0])} - ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;

      } else { // 'aberta' (default)
          // ... (lógica para fatura aberta mantida) ...
          let currentBillingYear = today.getUTCFullYear();
          let currentBillingMonth = today.getUTCMonth(); // Mês base 0
          if (today.getUTCDate() <= card.closingDay) { // Fatura atual ainda não fechou
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay));
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth -1 , card.closingDay + 1));
          } else { // Fatura atual já fechou, estamos no ciclo da próxima
              invoiceEndDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth + 1, card.closingDay));
              invoiceStartDate = new Date(Date.UTC(currentBillingYear, currentBillingMonth, card.closingDay + 1));
          }
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
              {model: FinancialCategory, as: 'category', attributes: ['name']},
              { model: FinancialTransaction, as: 'originalAccount', attributes:['id','description', 'originalPurchaseTotalValue', 'totalParcels']}
          ],
          transaction: t
      });
      let totalAmount = 0;
      transactions.forEach(tx => { totalAmount += parseFloat(tx.value); });

      let paymentDueDate = new Date(invoiceEndDate); // Base é a data de fechamento
      // Se o dia de pagamento é menor ou igual ao dia de fechamento,
      // significa que o pagamento é no mês SEGUINTE ao fechamento.
      if (card.paymentDay <= card.closingDay) {
          paymentDueDate.setUTCMonth(invoiceEndDate.getUTCMonth() + 1);
      }
      // Se o dia de pagamento é maior que o dia de fechamento,
      // o pagamento é no MESMO mês do fechamento (após o fechamento).
      // (Neste caso, o mês de paymentDueDate já está correto).
      paymentDueDate.setUTCDate(card.paymentDay); // Define o dia do pagamento

      await t.commit();
      const limitDetails = await getAvailableCreditLimit(financialAccountId, creditCardId); // Chamada fora da transação 't'
      
      return {
          cardName: card.name, financialAccountName: financialAccount.accountName,
          invoicePeriodDescription,
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
        if (!card || card.financialAccountId !== financialAccountId) { /* ... erro 404 ... */ }
        if(!card.isActive && card.financialAccountId === financialAccountId) { // Permite ver histórico de inativos SE DA CONTA
             logger.warn(`Buscando períodos de fatura para cartão INATIVO ID ${creditCardId} (${card.name}).`);
        } else if (!card.isActive) { /* ... erro 400 ... */ }


        const distinctTransactionMonths = await FinancialTransaction.findAll({
            attributes: [
                [sequelize.fn('DISTINCT', sequelize.fn('strftime', '%Y-%m', sequelize.col('transactionDate'))), 'yearMonth']
            ],
            where: { creditCardId, financialAccountId, type: 'Saída' },
            order: [[sequelize.col('transactionDate'), 'DESC']], // Mais recentes primeiro
            raw: true,
        });
       
        const periods = new Set(); // Usar Set para evitar duplicatas de label
        const today = new Date();

        // Adicionar período da fatura aberta atual
        let currentOpenYear = today.getUTCFullYear();
        let currentOpenMonthZeroBased = today.getUTCMonth();
        if (today.getUTCDate() > card.closingDay) { // Se já passou o dia de fechamento deste mês, a fatura aberta é do próximo ciclo
            currentOpenMonthZeroBased += 1;
            if (currentOpenMonthZeroBased > 11) {
                currentOpenMonthZeroBased = 0;
                currentOpenYear += 1;
            }
        }
        const openInvoiceLabel = new Date(Date.UTC(currentOpenYear, currentOpenMonthZeroBased)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        if (!periods.has(openInvoiceLabel)) {
            periods.add({
                month: currentOpenMonthZeroBased + 1,
                year: currentOpenYear,
                label: `${openInvoiceLabel} (Aberta)`
            });
        }


        distinctTransactionMonths.forEach(({ yearMonth }) => {
            if (yearMonth) {
                const [yearStr, monthStr] = yearMonth.split('-');
                const year = parseInt(yearStr, 10);
                const monthOneBased = parseInt(monthStr, 10);
                const monthZeroBased = monthOneBased - 1;
                
                // Opção 1: Fatura que FECHA no mês/ano da transação
                const closingDateOpt1 = new Date(Date.UTC(year, monthZeroBased, card.closingDay));
                const label1 = closingDateOpt1.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                 if (!Array.from(periods).some(p=>p.label.startsWith(label1))) { // Verifica se já não tem uma com mesmo mês/ano
                    periods.add({ month: closingDateOpt1.getUTCMonth() + 1, year: closingDateOpt1.getUTCFullYear(), label: label1 });
                }

                // Opção 2: Fatura que FECHA no mês/ano SEGUINTE ao da transação (compras feitas após o fechamento)
                const closingDateOpt2 = new Date(Date.UTC(year, monthZeroBased + 1, card.closingDay));
                const label2 = closingDateOpt2.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                if (!Array.from(periods).some(p=>p.label.startsWith(label2))) {
                     periods.add({ month: closingDateOpt2.getUTCMonth() + 1, year: closingDateOpt2.getUTCFullYear(), label: label2 });
                }
            }
        });
       
        const uniquePeriodsArray = Array.from(periods)
                               .sort((a, b) => {
                                   if (b.year !== a.year) return b.year - a.year;
                                   return b.month - a.month;
                               });

        logger.info(`Encontrados ${uniquePeriodsArray.length} períodos de fatura para cartão ID ${creditCardId}.`);
        return uniquePeriodsArray.slice(0, 12); // Retorna os 12 mais recentes

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
        const card = await CreditCard.findOne({ where: { id: creditCardId, financialAccountId }, transaction: t });

        if (!card) { /* ... erro 404 ... */ }

        let categoryId = financialCategoryId;
        if (!categoryId) {
            const defaultCategory = await FinancialCategory.findOne({
                where: { name: {[Op.iLike]: 'Pagamento de Fatura%'}, type: 'Saída', isActive: true }, // Procura por "Pagamento de Fatura"
                transaction: t
            });
            if (defaultCategory) {
                categoryId = defaultCategory.id;
            } else {
                // Opcional: criar a categoria "Pagamento de Fatura" se não existir
                const createdCat = await FinancialCategory.create({name: 'Pagamento de Fatura (Cartão)', type: 'Saída', isDefault: false, isActive: true}, {transaction: t});
                categoryId = createdCat.id;
                logger.info(`Categoria "Pagamento de Fatura (Cartão)" criada automaticamente.`);
            }
        }

        const paymentDescription = `Pagamento Fatura ${card.name}${originatingAccountDescription ? ` (Origem: ${originatingAccountDescription})` : ''}`;
        const paymentTransaction = await FinancialTransaction.create({
            financialAccountId, description: paymentDescription,
            value: Math.abs(paymentAmount), type: 'Saída',
            transactionDate: paymentDate, financialCategoryId: categoryId,
            creditCardId: null, // Pagamento da fatura NÃO é um gasto no cartão.
            isPayableOrReceivable: false, isPaidOrReceived: true, paymentDate: paymentDate,
            notes: `Pagamento da fatura do cartão ${card.name} (ID: ${card.id}).`
        }, { transaction: t });

        await t.commit();
        logger.info(`Pagamento de ${formatCurrency(paymentAmount)} para fatura do cartão ID ${creditCardId} (${card.name}) registrado. Transação ID: ${paymentTransaction.id}`);
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
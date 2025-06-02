// src/features/CreditCardManagement/creditCard.service.js
const { CreditCard, FinancialAccount, FinancialTransaction, FinancialCategory, sequelize } = require('../../database');
const { Op, fn, col, literal } = require('sequelize');
const logger = require('../../utils/logger');
const { formatDate, formatCurrency, formatTime } = require('../../utils/formatters');
// const { getAvailableCreditLimit } = require('./creditCard.service'); // Auto-referência não é comum, geralmente o frontend chama separadamente

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
        logger.warn(`[SERVICE findCreditCardByName] Tentativa de buscar cartão com nome inválido/vazio para conta ${financialAccountId}.`);
        return null;
    }
    let card = await CreditCard.findOne({
        where: { name: { [Op.iLike]: cardName.trim() }, financialAccountId, isActive: true }, // Adicionado trim()
        transaction
    });
    if (!card) {
        card = await CreditCard.findOne({
            where: { name: { [Op.iLike]: `${cardName.trim()}%` }, financialAccountId, isActive: true },
            transaction
        });
    }
    if (!card) {
        const cards = await CreditCard.findAll({ where: { financialAccountId, isActive: true }, transaction });
        card = cards.find(c => c.name.toLowerCase().includes(cardName.trim().toLowerCase()));
    }
    if (card) {
        logger.info(`[SERVICE findCreditCardByName] Cartão encontrado para "${cardName}" na conta ${financialAccountId}: "${card.name}" (ID: ${card.id})`);
    } else {
        logger.warn(`[SERVICE findCreditCardByName] Cartão de crédito ativo com nome parecido com "${cardName}" não encontrado na conta ${financialAccountId}.`);
    }
    return card; // Retorna a instância do Sequelize ou null
}

async function createCreditCard(financialAccountId, cardData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);

    const requiredFields = ['name', 'limit', 'closingDay', 'paymentDay'];
    for (const field of requiredFields) {
      if (cardData[field] === undefined || cardData[field] === null || (typeof cardData[field] === 'string' && cardData[field].trim() === '')) {
        const error = new Error(`Campo obrigatório "${field}" não fornecido ou inválido para o cartão de crédito.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
      }
    }
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
        where: { name: cardData.name.trim(), financialAccountId }, transaction: t // trim() no nome
    });
    if(existingCardName){
        const error = new Error(`Já existe um cartão com o nome "${cardData.name.trim()}" nesta conta financeira.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }

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
        name: cardData.name.trim(), // Salva nome trimado
        financialAccountId,
        limit: parseFloat(cardData.limit),
        closingDay: parseInt(cardData.closingDay),
        paymentDay: parseInt(cardData.paymentDay),
        lastFourDigits: cardData.lastFourDigits ? String(cardData.lastFourDigits) : null,
        isDefault: isDefaultBoolean,
        isActive: isActiveBoolean,
        dominantColor: cardData.dominantColor || null,
        flagIconUrl: cardData.flagIconUrl || null,
    };

    if (dataToCreate.isDefault) {
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true }, transaction: t }
      );
    } else {
      const defaultCount = await CreditCard.count({ where: { financialAccountId, isDefault: true, isActive: true }, transaction: t }); // Considera apenas ativos
      if (defaultCount === 0 && dataToCreate.isActive) { // Se não houver outro default ATIVO e este estiver ATIVO
        dataToCreate.isDefault = true;
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
    if (sortField !== 'isDefault' || (sortField === 'isDefault' && sortDirection === 'DESC')) {
        order.push(['isDefault', 'DESC']);
    } else if (sortField === 'isDefault' && sortDirection === 'ASC') {
        order.push(['isDefault', 'ASC']);
    }
    if (sortField !== 'isDefault') {
      order.push([sortField, sortDirection]);
    }
    if(sortField !== 'name') order.push(['name', 'ASC']); // Desempate final por nome, se não for a ordenação principal

    const cards = await CreditCard.findAll({
      where: whereConditions,
      order: order,
    });

    let resultCards = cards.map(c => c.toJSON());

    if (String(includeSummary).toLowerCase() === 'true' || includeSummary === true) {
        resultCards = await Promise.all(resultCards.map(async (cardJson) => {
            if (!cardJson.isActive) {
                return { ...cardJson, availableLimit: null, netUsedInOpenInvoice: null }; // Informações de limite não são relevantes para inativos
            }
            try {
                const limitDetails = await getAvailableCreditLimit(financialAccountId, cardJson.id);
                return { ...cardJson, availableLimit: limitDetails.availableLimit, netUsedInOpenInvoice: limitDetails.netUsedInOpenInvoice };
            } catch (summaryError) {
                logger.warn(`[SERVICE getAllCreditCards] Falha ao obter resumo de limite para cartão ID ${cardJson.id} durante listagem: ${summaryError.message}`);
                return { ...cardJson, availableLimit: null, netUsedInOpenInvoice: null };
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

    if (updateData.name && updateData.name.trim() !== card.name) { // trim() no nome
        const existingCardName = await CreditCard.findOne({
            where: { name: updateData.name.trim(), financialAccountId, id: {[Op.ne]: cardId} }, transaction: t
        });
        if(existingCardName){
            await t.rollback();
            const error = new Error(`Já existe outro cartão com o nome "${updateData.name.trim()}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
        updateData.name = updateData.name.trim(); // Salva nome trimado
    }
    
    if (updateData.hasOwnProperty('isDefault')) {
        const wantsToBeDefault = String(updateData.isDefault).toLowerCase() === 'true' || updateData.isDefault === true;
        if (wantsToBeDefault && !card.isDefault) {
            await CreditCard.update(
                { isDefault: false },
                { where: { financialAccountId, isDefault: true, id: { [Op.ne]: cardId } }, transaction: t }
            );
             updateData.isDefault = true;
        } else if (!wantsToBeDefault && card.isDefault) {
             // Apenas permite desmarcar como default se houver outro cartão ATIVO para se tornar default,
             // OU se o cartão atual estiver sendo INATIVADO.
            const isAlsoBeingInactivated = updateData.hasOwnProperty('isActive') && (String(updateData.isActive).toLowerCase() === 'false' || updateData.isActive === false);
            const otherActiveCard = await CreditCard.findOne({
                where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
                order: [['createdAt', 'ASC']],
                transaction: t,
            });
            if (otherActiveCard) {
                updateData.isDefault = false; // Permite desmarcar, outro pode ser promovido
            } else if (isAlsoBeingInactivated) {
                updateData.isDefault = false; // Pode desmarcar se o cartão também está sendo inativado
            } else {
                 // Não há outro cartão ativo, e este (que é default) não está sendo inativado. Impede de desmarcar.
                await t.rollback();
                const error = new Error(`Não é possível desmarcar "${card.name}" como padrão. Defina outro cartão como padrão primeiro ou inative este cartão.`);
                error.statusCode = 400; error.status = 'fail'; throw error;
            }
        } else {
             updateData.isDefault = wantsToBeDefault;
        }
    }

    if (updateData.hasOwnProperty('isActive')) {
        const wantsToBeActive = String(updateData.isActive).toLowerCase() === 'true' || updateData.isActive === true;
        if (!wantsToBeActive && card.isDefault) {
             // Se está inativando o cartão default, precisa promover outro ATIVO (se houver)
            const otherActiveCardToPromote = await CreditCard.findOne({
                where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
                order: [['createdAt', 'ASC']],
                transaction: t,
            });
            if (otherActiveCardToPromote) {
                await otherActiveCardToPromote.update({ isDefault: true }, { transaction: t });
                updateData.isDefault = false; // Cartão inativo não pode ser default
            } else {
                // Se não há outro cartão ativo, e este é o default e está sendo inativado,
                // a conta ficará sem cartão default ativo.
                logger.warn(`Cartão default ID ${cardId} inativado. Nenhum outro cartão ativo para ser promovido a default.`);
                updateData.isDefault = false;
            }
        }
        updateData.isActive = wantsToBeActive;
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
        where: { financialAccountId, isActive: true, id: { [Op.ne]: cardId } },
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

async function getAvailableCreditLimit(financialAccountId, creditCardId) {
    const t = await sequelize.transaction();
    try {
        await validateOwningFinancialAccount(financialAccountId, t);
        const card = await CreditCard.findByPk(creditCardId, { transaction: t });

        if (!card || card.financialAccountId !== financialAccountId) {
            await t.rollback();
            const error = new Error(`Cartão ID ${creditCardId} não encontrado ou não pertence à conta ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        if (!card.isActive) {
            // Retorna 0 para limite disponível se o cartão estiver inativo,
            // mas ainda assim retorna os outros dados para consistência.
            await t.commit();
            return {
                cardId: card.id, cardName: card.name, totalLimit: parseFloat(card.limit),
                netUsedInOpenInvoice: 0, totalDebtOnCard: 0, availableLimit: 0,
                closingDay: card.closingDay, paymentDay: card.paymentDay, currentInvoiceCycle: null,
                isActive: false
            };
        }

        const totalLimit = parseFloat(card.limit);
        
        // Gastos que consomem o limite (compras à vista e valor total de compras parceladas)
        // Somar o 'value' para compras à vista no cartão
        const sumSinglePurchases = await FinancialTransaction.sum('value', {
            where: { creditCardId: card.id, financialAccountId, type: 'Saída', isParcel: false },
            transaction: t
        }) || 0;

        // Somar o 'originalPurchaseTotalValue' das transações "mãe" de parcelamentos
        const sumParcelledMothers = await FinancialTransaction.sum('originalPurchaseTotalValue', {
            where: {
                creditCardId: card.id, financialAccountId, type: 'Saída',
                isParcel: true,
                originalAccountId: col('id') // Garante que estamos pegando a "mãe"
            },
            transaction: t
        }) || 0;
        
        const totalGrossSpends = parseFloat(sumSinglePurchases) + parseFloat(sumParcelledMothers);

        // Créditos diretos no cartão (estornos, etc.) que liberam limite
        const sumDirectCreditsOnCard = await FinancialTransaction.sum('value', {
            where: { creditCardId: card.id, financialAccountId, type: 'Entrada'}, // Entradas no cartão
            transaction: t
        }) || 0;

        // Pagamentos de fatura para ESTE cartão
        // A descrição do pagamento DEVE ser padronizada, ex: "Pagamento Fatura [Nome do Cartão]"
        // E o mês/ano é importante para pagamentos parciais de faturas passadas.
        // Para o limite disponível GERAL, somamos TODOS os pagamentos feitos para este cartão.
        const sumInvoicePayments = await FinancialTransaction.sum('value', {
            where: {
                financialAccountId,
                type: 'Saída',
                creditCardId: null, // Pagamento de fatura não tem creditCardId
                description: { [Op.iLike]: `Pagamento Fatura ${card.name}%` } // Busca pelo nome do cartão
            },
            transaction: t
        }) || 0;

        const currentNetDebt = totalGrossSpends - parseFloat(sumDirectCreditsOnCard) - parseFloat(sumInvoicePayments);
        const availableLimitFinal = totalLimit - Math.max(0, currentNetDebt); // Não pode ser mais que o limite total

        // Calcula o ciclo da fatura aberta para `netUsedInOpenInvoice`
        const today = new Date();
        let invoiceStartDate, invoiceEndDate;
        let openInvoiceRefYear = today.getUTCFullYear();
        let openInvoiceRefMonthZeroBased = today.getUTCMonth();

        if (today.getUTCDate() > card.closingDay) {
            openInvoiceRefMonthZeroBased += 1;
            if (openInvoiceRefMonthZeroBased > 11) { openInvoiceRefMonthZeroBased = 0; openInvoiceRefYear += 1; }
        }
        invoiceEndDate = new Date(Date.UTC(openInvoiceRefYear, openInvoiceRefMonthZeroBased, card.closingDay));
        invoiceStartDate = new Date(Date.UTC(openInvoiceRefYear, openInvoiceRefMonthZeroBased, card.closingDay + 1));
        invoiceStartDate.setUTCMonth(invoiceStartDate.getUTCMonth() - 1);
        
        const spendsInOpenInvoice = await FinancialTransaction.sum('value',{
            where: {
                creditCardId: card.id, financialAccountId, type: 'Saída', 
                transactionDate: { 
                    [Op.gte]: invoiceStartDate.toISOString().split('T')[0],
                    [Op.lte]: invoiceEndDate.toISOString().split('T')[0],
                },
            },
            transaction: t
        }) || 0;
        
        await t.commit();

        return {
            cardId: card.id,
            cardName: card.name,
            totalLimit: totalLimit,
            netUsedInOpenInvoice: parseFloat(parseFloat(spendsInOpenInvoice).toFixed(2)),
            totalDebtOnCard: parseFloat(Math.max(0, currentNetDebt).toFixed(2)), // Dívida líquida não pode ser negativa
            availableLimit: parseFloat(availableLimitFinal.toFixed(2)),
            closingDay: card.closingDay,
            paymentDay: card.paymentDay,
            currentInvoiceCycle: {
                start: invoiceStartDate.toISOString().split('T')[0],
                end: invoiceEndDate.toISOString().split('T')[0]
            },
            isActive: true
        };

    } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao calc limite disp. cartão ID ${creditCardId} (Conta: ${financialAccountId}): ${error.message}`, { error });
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
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay + 1));
          invoiceStartDate.setUTCMonth(invoiceStartDate.getUTCMonth() - 1);
          invoiceDescriptionPeriod = `${new Date(Date.UTC(referenceYear, referenceMonthZeroBased)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone:'UTC' })}`;

      } else if (periodOptions.type === 'ultima_fechada') {
          let currentMonthClosingDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), card.closingDay));
          if (today >= currentMonthClosingDay) { 
              referenceYear = today.getUTCFullYear();
              referenceMonthZeroBased = today.getUTCMonth();
          } else { 
              referenceYear = today.getUTCFullYear();
              referenceMonthZeroBased = today.getUTCMonth() - 1;
              if (referenceMonthZeroBased < 0) {
                  referenceMonthZeroBased = 11;
                  referenceYear -= 1;
              }
          }
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay + 1));
          invoiceStartDate.setUTCMonth(invoiceStartDate.getUTCMonth() - 1);
          invoiceDescriptionPeriod = `Última Fatura Fechada (${formatDate(invoiceStartDate.toISOString().split('T')[0])} - ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;
      } else { // Fatura aberta (type === 'aberta')
          let currentMonthClosingDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), card.closingDay));
          if (today > currentMonthClosingDay) { 
              referenceYear = today.getUTCFullYear();
              referenceMonthZeroBased = today.getUTCMonth() + 1;
              if (referenceMonthZeroBased > 11) {
                  referenceMonthZeroBased = 0;
                  referenceYear += 1;
              }
          } else { 
              referenceYear = today.getUTCFullYear();
              referenceMonthZeroBased = today.getUTCMonth();
          }
          invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
          invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay + 1));
          invoiceStartDate.setUTCMonth(invoiceStartDate.getUTCMonth() - 1);
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

      const totalSpendsInInvoice = transactions.reduce((sum, tx) => sum + parseFloat(tx.value), 0);

      const referenceMonthYearForPaymentSearch = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, 1))
                                              .toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      
      const paymentsForThisInvoice = await FinancialTransaction.sum('value', {
          where: {
              financialAccountId, type: 'Saída', creditCardId: null,
              description: { [Op.iLike]: `Pagamento Fatura ${card.name} (${referenceMonthYearForPaymentSearch})%` },
              // Adicionando filtro de data para pagamentos:
              // Considera pagamentos feitos desde o início do ciclo da fatura até um pouco depois do vencimento.
              // O paymentDueDate precisa ser calculado primeiro.
          },
          transaction: t
      }) || 0;
      
      let paymentDueDate = new Date(invoiceEndDate);
      if (card.paymentDay <= card.closingDay) {
          paymentDueDate.setUTCMonth(invoiceEndDate.getUTCMonth() + 1); 
      }
      paymentDueDate.setUTCDate(card.paymentDay);

      // Agora que temos paymentDueDate, podemos refinar a query de paymentsForThisInvoice se necessário,
      // mas por simplicidade, vamos manter a busca pela descrição por enquanto.

      const totalAmountDue = totalSpendsInInvoice - parseFloat(paymentsForThisInvoice);

      await t.commit(); 
      
      const limitDetails = await getAvailableCreditLimit(financialAccountId, creditCardId); // Busca limite atualizado
      
      return {
          cardId: card.id, cardName: card.name, financialAccountId,
          financialAccountName: financialAccount.accountName, financialAccountType: financialAccount.accountType,
          invoicePeriodDescription,
          invoiceReferenceMonthYear: new Date(Date.UTC(referenceYear, referenceMonthZeroBased, 1)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
          invoiceCycleStartDate: invoiceStartDate.toISOString().split('T')[0],
          invoiceCycleEndDate: invoiceEndDate.toISOString().split('T')[0],
          paymentDueDate: paymentDueDate.toISOString().split('T')[0],
          totalAmount: parseFloat(totalAmountDue.toFixed(2)),
          totalSpendsOriginal: parseFloat(totalSpendsInInvoice.toFixed(2)), 
          totalPaidForThisInvoice: parseFloat(paymentsForThisInvoice.toFixed(2)),
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

        // Determina o mês/ano da fatura ABERTA
        const today = new Date();
        let openInvoiceRefYear = today.getUTCFullYear();
        let openInvoiceRefMonthZeroBased = today.getUTCMonth();
        if (today.getUTCDate() > card.closingDay) {
            openInvoiceRefMonthZeroBased += 1;
            if (openInvoiceRefMonthZeroBased > 11) { openInvoiceRefMonthZeroBased = 0; openInvoiceRefYear += 1; }
        }
        const openInvoiceLabel = `${new Date(Date.UTC(openInvoiceRefYear, openInvoiceRefMonthZeroBased, 1)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })} (Aberta)`;
        const openInvoicePeriodValue = { year: openInvoiceRefYear, month: openInvoiceRefMonthZeroBased + 1, label: openInvoiceLabel };

        // Busca meses com transações no cartão (para faturas fechadas)
        let dateExtractFunction, groupLiteral, orderLiteral;
        const dialect = sequelize.getDialect();
        // ... (lógica do dialeto como antes) ...
        if (dialect === 'sqlite') {
            dateExtractFunction = fn('strftime', '%Y-%m', col('transactionDate'));
            groupLiteral = literal("strftime('%Y-%m', \"FinancialTransaction\".\"transactionDate\")"); 
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
            throw new Error('Dialeto SQL não suportado para esta operação.');
        }


        const distinctTransactionYearMonths = await FinancialTransaction.findAll({
            attributes: [[dateExtractFunction, 'yearMonth']], // YYYY-MM da transação
            where: { creditCardId, financialAccountId, type: 'Saída' },
            group: [groupLiteral],
            order: [[orderLiteral, 'DESC']],
            raw: true,
        });
       
        const periodsMap = new Map(); 
        periodsMap.set(`${openInvoicePeriodValue.year}-${openInvoicePeriodValue.month}`, openInvoicePeriodValue); // Adiciona a aberta primeiro

        for (const { yearMonth: transactionYearMonth } of distinctTransactionYearMonths) {
            if (transactionYearMonth && typeof transactionYearMonth === 'string') {
                const [txYearStr, txMonthStr] = transactionYearMonth.split('-');
                const txYear = parseInt(txYearStr, 10);
                const txMonthZeroBased = parseInt(txMonthStr, 10) - 1; // Mês da TRANSAÇÃO (0-11)
                
                // Determina o mês de FECHAMENTO da fatura onde esta transação entra
                let invoiceClosingRefYear = txYear;
                let invoiceClosingRefMonthZeroBased = txMonthZeroBased;

                if (new Date(Date.UTC(txYear, txMonthZeroBased, card.closingDay)) < new Date(Date.UTC(txYear, txMonthZeroBased, new Date(transactionYearMonth + '-01T00:00:00Z').getUTCDate()))) {
                    // Se o dia da transação é DEPOIS do dia de fechamento no mês da transação,
                    // ela cai na fatura que fecha no PRÓXIMO mês.
                    invoiceClosingRefMonthZeroBased += 1;
                    if (invoiceClosingRefMonthZeroBased > 11) {
                        invoiceClosingRefMonthZeroBased = 0;
                        invoiceClosingRefYear += 1;
                    }
                }
                // Se a transação é ANTES ou NO dia de fechamento, ela cai na fatura que fecha NESTE mês (mês da transação).
                
                const periodKey = `${invoiceClosingRefYear}-${invoiceClosingRefMonthZeroBased + 1}`;
                if (!periodsMap.has(periodKey)) {
                    const label = new Date(Date.UTC(invoiceClosingRefYear, invoiceClosingRefMonthZeroBased, 1)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                    periodsMap.set(periodKey, { year: invoiceClosingRefYear, month: invoiceClosingRefMonthZeroBased + 1, label: label });
                }
            }
        }
       
        const uniquePeriodsArray = Array.from(periodsMap.values())
                               .sort((a, b) => {
                                   if (b.year !== a.year) return b.year - a.year;
                                   return b.month - a.month;
                               });
                               
        logger.info(`Encontrados ${uniquePeriodsArray.length} períodos de fatura para cartão ID ${creditCardId}.`);
        return uniquePeriodsArray.slice(0, 12); // Limita aos últimos 12 períodos para a UI

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
            const paymentDateObj = new Date(paymentDate + 'T00:00:00.000Z');
            let invoiceClosingYear = paymentDateObj.getUTCFullYear();
            let invoiceClosingMonthZeroBased = paymentDateObj.getUTCMonth();
            if (paymentDateObj.getUTCDate() <= card.closingDay) {
                invoiceClosingMonthZeroBased -= 1;
                if (invoiceClosingMonthZeroBased < 0) {
                    invoiceClosingMonthZeroBased = 11;
                    invoiceClosingYear -= 1;
                }
            }
            const referenceDateForDescription = new Date(Date.UTC(invoiceClosingYear, invoiceClosingMonthZeroBased, 1));
            referenceMonthDescription = referenceDateForDescription.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        } catch (dateError) {
            logger.warn(`[payCreditCardInvoice] Erro ao calcular mês de referência para descrição: ${dateError.message}. Usando descrição genérica.`);
            referenceMonthDescription = "Mês Corrente";
        }

        let categoryId = financialCategoryId;
        if (!categoryId) {
            const defaultCategory = await FinancialCategory.findOne({
                where: { name: { [Op.iLike]: 'Pagamento de Fatura' }, financialAccountId: financialAccountId },
                transaction: t
            });
            if (defaultCategory) categoryId = defaultCategory.id;
            else {
                const fallbackCategory = await FinancialCategory.findOne({
                    where: { name: { [Op.iLike]: 'Pagamento de Cartão' }, financialAccountId: financialAccountId },
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
            financialAccountId, description: transactionDescription,
            value: Math.abs(paymentAmount), type: 'Saída', transactionDate: paymentDate,
            financialCategoryId: categoryId, creditCardId: null, 
            isPayableOrReceivable: false, isPaidOrReceived: true, paymentDate: paymentDate,
            notes: `Pagamento da fatura do cartão ${card.name} (ID Cartão: ${card.id}).`
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
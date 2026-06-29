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

/**
 * Liquida a fatura aberta de um cartão de crédito, registrando um pagamento para o valor total devido.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {number} creditCardId - ID do cartão de crédito.
 * @param {string} [paymentDate=currentDate] - Data do pagamento (YYYY-MM-DD). Default é hoje.
 * @param {string} [originatingAccountDescription=null] - Descrição da conta de origem do pagamento.
 * @param {number} [financialCategoryId=null] - ID da categoria financeira para o pagamento da fatura.
 * @param {number} [actorClientId=null] - ID do cliente que realizou a ação.
 * @returns {Promise<object>} A transação de pagamento criada.
 */
async function settleOpenCreditCardInvoice(financialAccountId, creditCardId, paymentDate = null, originatingAccountDescription = null, financialCategoryId = null, actorClientId = null, paymentMethod = 'Pix') {
    const t = await sequelize.transaction();
    try {
        await validateOwningFinancialAccount(financialAccountId, t);
        const card = await CreditCard.findOne({ where: { id: creditCardId, financialAccountId }, transaction: t });

        if (!card) {
            await t.rollback();
            const error = new Error(`Cartão ID ${creditCardId} não encontrado ou não pertence à conta ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        if (!card.isActive) {
            await t.rollback();
            const error = new Error(`Cartão "${card.name}" está inativo e não pode ter a fatura liquidada.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        // 1. Obter o valor da fatura aberta
        const invoiceDetails = await getCreditCardInvoiceDetails(financialAccountId, creditCardId, { type: 'aberta' });
        const amountDue = parseFloat(invoiceDetails.totalAmount);

        if (amountDue <= 0) {
            await t.rollback();
            const error = new Error(`A fatura aberta do cartão "${card.name}" já está paga ou possui crédito (Valor: ${formatCurrency(amountDue)}). Nenhuma ação necessária.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }

        // 2. Registrar o pagamento utilizando a função existente
        const paymentTx = await payCreditCardInvoice(
            financialAccountId,
            creditCardId,
            amountDue,
            paymentDate || new Date().toISOString().split('T')[0], // Usa a data fornecida ou a data atual
            originatingAccountDescription,
            financialCategoryId,
            actorClientId,
            null, // invoiceReferenceMonthYear
            paymentMethod // <<< ADICIONADO
        );

        await t.commit();
        logger.info(`Fatura aberta do cartão ID ${creditCardId} (${card.name}) liquidada com sucesso. Valor: ${formatCurrency(amountDue)}.`);
        return paymentTx;

    } catch (error) {
        if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        logger.error(`Erro ao liquidar fatura aberta do cartão ID ${creditCardId} (Conta: ${financialAccountId}): ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
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
        // Match parcial determinístico: prefere o nome que COMEÇA com o termo e,
        // entre vários, o mais curto (mais próximo do que foi digitado). Evita
        // escolher silenciosamente um cartão arbitrário quando há nomes parecidos.
        const allCards = await CreditCard.findAll({ where: { financialAccountId, isActive: true }, order: [['name', 'ASC']], transaction });
        const term = cardName.toLowerCase().trim();
        const byPrefix = allCards.filter(c => c.name.toLowerCase().startsWith(term)).sort((a, b) => a.name.length - b.name.length);
        const byIncludes = allCards.filter(c => c.name.toLowerCase().includes(term)).sort((a, b) => a.name.length - b.name.length);
        card = byPrefix[0] || byIncludes[0] || null;
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
        if (existingCardName) {
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
            blockedLimit: cardData.blockedLimit !== undefined && cardData.blockedLimit !== null && cardData.blockedLimit !== '' ? parseFloat(cardData.blockedLimit) : 0,
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
                    return {
                        ...cardJson,
                        availableLimit: limitDetails.availableLimit,
                        usedLimit: limitDetails.usedLimit,
                        blockedLimit: limitDetails.blockedLimit,
                    };
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

async function getActiveCreditCardsForAI(financialAccountId) {
    try {
        const cards = await CreditCard.findAll({
            where: {
                financialAccountId: financialAccountId,
                isActive: true,
            },
            // Otimização chave: seleciona apenas os campos que a IA precisa!
            attributes: ['id', 'name'],
            order: [['isDefault', 'DESC'], ['name', 'ASC']],
            raw: true, // Retorna objetos JSON puros, mais leve
        });
        return cards;
    } catch (error) {
        logger.error(`[SERVICE-AI] Erro ao buscar nomes de cartões para FA ID ${financialAccountId}: ${error.message}`);
        // Para a IA, é melhor retornar um array vazio em caso de erro do que travar o fluxo.
        return [];
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
                where: { name: updateData.name, financialAccountId, id: { [Op.ne]: cardId } }, transaction: t
            });
            if (existingCardName) {
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
            await t.rollback();
            const error = new Error(`Cartão "${card.name}" (ID: ${creditCardId}) está inativo.`);
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
            where: { creditCardId: card.id, financialAccountId, type: 'Entrada' },
            transaction: t
        }) || 0;
        totalSpendsImpactingLimit -= parseFloat(directCreditsOnCard);

        // IMPORTANTE: casar o nome do cartão seguido de " (" para não confundir
        // cartões cujo nome é prefixo de outro (ex.: "Nubank" x "Nubank Empresarial").
        // O pagamento é gravado como "Pagamento Fatura {nome} ({mês})...".
        const invoicePayments = await FinancialTransaction.sum('value', {
            where: { financialAccountId, type: 'Saída', creditCardId: null, description: { [Op.iLike]: `Pagamento Fatura ${card.name} (%` } },
            transaction: t
        }) || 0;

        const currentDebtOnCard = Math.max(0, totalSpendsImpactingLimit - parseFloat(invoicePayments));
        // Limite bloqueado: reserva manual do usuário (não pode ser gasto).
        const blockedLimit = parseFloat(card.blockedLimit || 0);
        const availableLimitFinal = totalLimit - currentDebtOnCard - blockedLimit;

        const today = new Date();
        let currentInvoiceYear = today.getUTCFullYear();
        let currentInvoiceMonthZeroBased = today.getUTCMonth();
        let invoiceStartDate, invoiceEndDate;

        if (today.getUTCDate() <= card.closingDay) {
            invoiceEndDate = new Date(Date.UTC(currentInvoiceYear, currentInvoiceMonthZeroBased, card.closingDay));
            invoiceStartDate = new Date(Date.UTC(currentInvoiceYear, currentInvoiceMonthZeroBased - 1, card.closingDay + 1));
        } else {
            invoiceStartDate = new Date(Date.UTC(currentInvoiceYear, currentInvoiceMonthZeroBased, card.closingDay + 1));
            invoiceEndDate = new Date(Date.UTC(currentInvoiceYear, currentInvoiceMonthZeroBased + 1, card.closingDay));
        }

        const openInvoiceSpends = await FinancialTransaction.sum('value', {
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
            blockedLimit: parseFloat(blockedLimit.toFixed(2)),
            usedLimit: parseFloat(currentDebtOnCard.toFixed(2)),
            netUsedInOpenInvoice: parseFloat(parseFloat(openInvoiceSpends).toFixed(2)),
            totalDebtOnCard: parseFloat(currentDebtOnCard.toFixed(2)),
            availableLimit: parseFloat(availableLimitFinal.toFixed(2)),
            closingDay: card.closingDay,
            paymentDay: card.paymentDay,
            currentInvoiceCycle: {
                start: invoiceStartDate.toISOString().split('T')[0],
                end: invoiceEndDate.toISOString().split('T')[0]
            }
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
            invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased - 1, card.closingDay + 1));
            invoiceDescriptionPeriod = `${new Date(Date.UTC(referenceYear, referenceMonthZeroBased)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`;

        } else if (periodOptions.type === 'ultima_fechada') {
            // ... (lógica para última fechada) ...
            let targetMonth = today.getUTCMonth();
            let targetYear = today.getUTCFullYear();
            if (today.getUTCDate() <= card.closingDay) { // Se hoje é antes ou no dia do fechamento do mês atual
                targetMonth -= 1; // A última fechada foi a do mês anterior
                if (targetMonth < 0) { targetMonth = 11; targetYear -= 1; }
            } // Se hoje é depois do fechamento, a última fechada é a deste mês
            referenceMonthZeroBased = targetMonth;
            referenceYear = targetYear;
            invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
            invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased - 1, card.closingDay + 1));
            invoiceDescriptionPeriod = `Última Fatura Fechada (${formatDate(invoiceStartDate.toISOString().split('T')[0])} - ${formatDate(invoiceEndDate.toISOString().split('T')[0])})`;

        } else { // Fatura aberta (type === 'aberta')
            // ... (lógica para fatura aberta) ...
            let targetMonth = today.getUTCMonth(); // Mês atual (0-11)
            let targetYear = today.getUTCFullYear();
            // Se hoje for DEPOIS do dia de fechamento do cartão no mês atual,
            // a fatura aberta já é para o próximo mês de fechamento.
            if (today.getUTCDate() > card.closingDay) {
                targetMonth += 1;
                if (targetMonth > 11) { targetMonth = 0; targetYear += 1; }
            }
            // Se hoje for ANTES ou NO dia de fechamento, a fatura aberta é a que fecha neste mês.
            referenceMonthZeroBased = targetMonth; // Mês de fechamento da fatura aberta
            referenceYear = targetYear;           // Ano de fechamento da fatura aberta
            invoiceEndDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased, card.closingDay));
            invoiceStartDate = new Date(Date.UTC(referenceYear, referenceMonthZeroBased - 1, card.closingDay + 1));
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
                { model: FinancialCategory, as: 'category', attributes: ['id', 'name'] },
                { model: FinancialTransaction, as: 'originalAccount', attributes: ['id', 'description', 'originalPurchaseTotalValue', 'totalParcels'] }
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

        const openInvoiceKey = `${openInvoiceRefYear}-${String(openInvoiceRefMonth).padStart(2, '0')}`;
        if (!periodsMap.has(openInvoiceLabel)) {
            uniquePeriodsArray.unshift({ month: openInvoiceRefMonth, year: openInvoiceRefYear, label: `${openInvoiceLabel} (Aberta)` });
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
async function payCreditCardInvoice(financialAccountId, creditCardId, paymentAmount, paymentDate, originatingAccountDescription = null, financialCategoryId = null, actorClientId = null, invoiceReferenceMonthYear = null, paymentMethod = 'Pix') {
    const t = await sequelize.transaction();
    try {
        const financialAccount = await validateOwningFinancialAccount(financialAccountId, t);
        const card = await CreditCard.findOne({ where: { id: creditCardId, financialAccountId }, transaction: t });

        if (!card) {
            await t.rollback();
            const error = new Error(`Cartão ID ${creditCardId} não encontrado ou não pertence à conta ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        // --- INÍCIO DA CORREÇÃO ---
        let finalInvoiceReferenceMonthYear = invoiceReferenceMonthYear; // Usa o valor passado pelo frontend

        // Se o frontend NÃO passou o invoiceReferenceMonthYear (fallback), tenta calcular um valor razoável.
        // Esta é uma lógica de contingência, o ideal é que o frontend sempre passe.
        if (!finalInvoiceReferenceMonthYear) {
            const paymentDateObj = new Date(paymentDate + 'T00:00:00.000Z'); // Tratar como UTC
            let targetMonth = paymentDateObj.getUTCMonth();
            let targetYear = paymentDateObj.getUTCFullYear();

            // Lógica para determinar o mês de referência da fatura que o pagamento está quitando
            // Se o pagamento é feito antes ou no dia de fechamento do cartão, ele se refere à fatura que fecha naquele mês.
            // Se é feito depois, já se refere à fatura do próximo mês.
            if (paymentDateObj.getUTCDate() > card.closingDay) {
                targetMonth += 1;
                if (targetMonth > 11) { targetMonth = 0; targetYear += 1; }
            }
            // O mês de referência da fatura é o mês em que ela FECHA.
            finalInvoiceReferenceMonthYear = new Date(Date.UTC(targetYear, targetMonth, 1)).toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
            logger.warn(`[payCreditCardInvoice] invoiceReferenceMonthYear não fornecido no payload. Recalculando como fallback para: ${finalInvoiceReferenceMonthYear}`);
        }
        // --- FIM DA CORREÇÃO ---

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

        // Usa o finalInvoiceReferenceMonthYear na descrição da transação
        const transactionDescription = `Pagamento Fatura ${card.name} (${finalInvoiceReferenceMonthYear})${originatingAccountDescription ? ` - Origem: ${originatingAccountDescription}` : ''}`;

        const paymentTransaction = await FinancialTransaction.create({
            financialAccountId,
            description: transactionDescription,
            value: Math.abs(paymentAmount), type: 'Saída', transactionDate: paymentDate,
            financialCategoryId: categoryId,
            paymentMethod: paymentMethod, // <<< ADICIONADO
            creditCardId: null,
            isPayableOrReceivable: false, isPaidOrReceived: true, paymentDate: paymentDate,
            notes: `Pagamento da fatura do cartão ${card.name} (ID Cartão: ${card.id}).`
            // createdBy: actorClientId, 
        }, { transaction: t });

        await t.commit();
        logger.info(`Pagamento de ${formatCurrency(paymentAmount)} para fatura do cartão ID ${creditCardId} (${card.name}) registrado. TX ID: ${paymentTransaction.id}. Mês Ref: ${finalInvoiceReferenceMonthYear}`);
        const reloadedPaymentTx = await FinancialTransaction.findByPk(paymentTransaction.id, {
            include: [{ model: FinancialCategory, as: 'category', attributes: ['id', 'name'] }]
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
    settleOpenCreditCardInvoice, // <<< ADICIONADO
    getActiveCreditCardsForAI
};
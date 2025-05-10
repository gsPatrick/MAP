// src/features/CreditCardManagement/creditCard.service.js
const { CreditCard, FinancialAccount, FinancialTransaction, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Valida se a FinancialAccount existe e está ativa.
 * @param {number} financialAccountId
 * @param {object} transaction - Transação Sequelize opcional.
 */
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
 * Cria um novo cartão de crédito para uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} cardData - Dados do cartão (name, limit, closingDay, paymentDay, lastFourDigits, flag, isDefault, isActive).
 * @returns {Promise<object>} O cartão criado.
 */
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
    // Validação de unicidade de nome do cartão DENTRO da financialAccount
    const existingCardName = await CreditCard.findOne({
        where: { name: cardData.name, financialAccountId }, transaction: t
    });
    if(existingCardName){
        const error = new Error(`Já existe um cartão com o nome "${cardData.name}" nesta conta financeira.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
    }


    // Lógica para 'isDefault': se este for marcado como default, desmarcar outros da mesma financialAccount.
    if (cardData.isDefault === true || cardData.isDefault === 'true') {
      await CreditCard.update(
        { isDefault: false },
        { where: { financialAccountId, isDefault: true }, transaction: t }
      );
    } else {
      // Se não for default e não houver nenhum default para a financialAccount, torna este o default
      const defaultCount = await CreditCard.count({ where: { financialAccountId, isDefault: true }, transaction: t });
      if (defaultCount === 0) {
        cardData.isDefault = true;
      } else {
        cardData.isDefault = false; // Garante que seja false se não explicitamente true
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

/**
 * Lista todos os cartões de crédito de uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} queryParams - { isActive }
 * @returns {Promise<Array<object>>}
 */
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
      order: [['isDefault', 'DESC'], order], // Padrão primeiro, depois pela ordenação solicitada
    });

    logger.info(`Listados ${cards.length} cartões de crédito para FinancialAccount ID ${financialAccountId}.`);
    return cards.map(c => c.toJSON());
  } catch (error) {
    logger.error(`Erro ao listar cartões de crédito para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca um cartão de crédito pelo ID, verificando se pertence à FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} cardId
 * @returns {Promise<object|null>}
 */
async function getCreditCardById(financialAccountId, cardId) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const card = await CreditCard.findOne({
      where: { id: cardId, financialAccountId },
      // include: [{ model: FinancialAccount, as: 'financialAccount' }] // Já validado
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

/**
 * Atualiza um cartão de crédito.
 * @param {number} financialAccountId
 * @param {number} cardId
 * @param {object} updateData
 * @returns {Promise<object|null>}
 */
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

    // Validação de unicidade de nome do cartão DENTRO da financialAccount, se o nome estiver sendo alterado
    if (updateData.name && updateData.name !== card.name) {
        const existingCardName = await CreditCard.findOne({
            where: { name: updateData.name, financialAccountId, id: {[Op.ne]: cardId} }, transaction: t
        });
        if(existingCardName){
            const error = new Error(`Já existe outro cartão com o nome "${updateData.name}" nesta conta financeira.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
        }
    }

    // Lógica para 'isDefault'
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
        // Não impedir aqui, mas a UI deve tratar. Se for a API pura, pode ser um problema.
        // Poderia promover outro a default aqui ou lançar erro. Por ora, permite.
      } else if (otherActiveCardsCount === 0) {
          updateData.isDefault = true; // Se for o único cartão, força a ser default
      }
    }
    
    // Remover financialAccountId de updateData
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

/**
 * Exclui um cartão de crédito.
 * @param {number} financialAccountId
 * @param {number} cardId
 * @returns {Promise<boolean>}
 */
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

    // Verificar se o cartão está em uso em transações financeiras
    const transactionsCount = await FinancialTransaction.count({ where: { creditCardId: cardId }, transaction: t });
    if (transactionsCount > 0) {
      // A FK em FinancialTransaction para CreditCard DEVE ter onDelete: 'SET NULL' ou 'RESTRICT'.
      // Se 'RESTRICT', o DB impedirá. Se 'SET NULL', as transações ficarão sem cartão.
      const error = new Error(`Não é possível excluir o cartão de crédito "${card.name}" (ID ${cardId}) pois está associado a ${transactionsCount} transações. Remova a associação das transações ou marque o cartão como inativo.`);
      error.statusCode = 409; // Conflict
      error.status = 'fail';
      throw error; // Ou apenas logar e retornar false, dependendo da política
    }

    // Se este for o cartão default, e houver outros, promover outro a default
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

module.exports = {
  createCreditCard,
  getAllCreditCards,
  getCreditCardById,
  updateCreditCard,
  deleteCreditCard,
};
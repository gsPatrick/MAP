// src/features/FinancialCategory/financialCategory.service.js
const { FinancialCategory, FinancialAccount, FinancialTransaction, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Valida se a FinancialAccount existe e está ativa.
 * (Função auxiliar, pode ser movida para um utils de FinancialAccount se usada em múltiplos services)
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
 * Cria uma nova categoria financeira para uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {object} categoryData - { name, type, parentId (opcional) }
 * @returns {Promise<object>}
 */
async function createFinancialCategory(financialAccountId, categoryData) {
  const { name, type, parentId } = categoryData;
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t); // Valida a conta dona

    if (!name || !type) {
      const error = new Error('Nome e Tipo são obrigatórios para a categoria financeira.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!['Entrada', 'Saída', 'Ambos'].includes(type)) {
        const error = new Error('Tipo de categoria inválido. Use Entrada, Saída ou Ambos.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const finalParentId = parentId === undefined || parentId === null || parentId === '' ? null : parseInt(parentId, 10);

    const existingCategory = await FinancialCategory.findOne({
      where: {
        name: { [Op.iLike]: name },
        financialAccountId, // Filtra pela conta financeira
        parentId: finalParentId,
      },
      transaction: t
    });
    if (existingCategory) {
      const parentMsg = finalParentId ? `dentro da categoria pai ID ${finalParentId}` : 'como categoria principal';
      const error = new Error(`Já existe uma categoria com o nome "${name}" nesta conta financeira ${parentMsg}.`);
      error.statusCode = 409; error.status = 'fail'; throw error;
    }

    if (finalParentId !== null) {
      const parent = await FinancialCategory.findOne({ where: {id: finalParentId, financialAccountId }, transaction: t});
      if (!parent) {
        const error = new Error(`Categoria pai com ID ${finalParentId} não encontrada nesta conta financeira.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
      }
      // Adicional: Verificar se o tipo da subcategoria é compatível com o tipo da categoria pai, se necessário.
      // Ex: Se pai é 'Saída', subcategoria não pode ser 'Entrada' (a menos que 'Ambos')
      if (parent.type !== 'Ambos' && type !== 'Ambos' && parent.type !== type) {
          const error = new Error(`O tipo "${type}" da subcategoria não é compatível com o tipo "${parent.type}" da categoria pai "${parent.name}".`);
          error.statusCode = 400; error.status = 'fail'; throw error;
      }
    }

    const category = await FinancialCategory.create({
        name,
        type,
        parentId: finalParentId,
        financialAccountId // Associa à conta
    }, { transaction: t });
    
    await t.commit();
    logger.info(`Categoria Financeira criada: "${category.name}" (ID: ${category.id}) para Conta ID ${financialAccountId}${finalParentId ? `, Pai ID: ${finalParentId}` : ''}`);
    return category.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar categoria financeira para Conta ID ${financialAccountId}: ${error.message}`, { error, categoryData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todas as categorias financeiras de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {object} queryParams - { hierarchical, onlyTopLevel, type }
 * @returns {Promise<Array<object>>}
 */
async function getAllFinancialCategories(financialAccountId, queryParams = {}) {
  const { hierarchical = false, onlyTopLevel = false, type } = queryParams;
  try {
    await validateOwningFinancialAccount(financialAccountId); 
    const whereConditions = { financialAccountId }; // Filtro principal

    if (onlyTopLevel) {
      whereConditions.parentId = null;
    }
    if (type) {
        whereConditions.type = { [Op.or]: [type, 'Ambos'] };
    }

    if (!hierarchical) {
      const categories = await FinancialCategory.findAll({
        where: whereConditions,
        order: [
            sequelize.literal('"parentId" IS NULL DESC'),
            ['parentId', 'ASC NULLS FIRST'],
            ['name', 'ASC']
        ],
        include: [{ model: FinancialCategory, as: 'parentCategory', attributes: ['id', 'name'] }]
      });
      return categories.map(c => c.toJSON());
    } else {
      const allCategoriesForAccount = await FinancialCategory.findAll({
          where: whereConditions, // Aplica filtro de tipo aqui também para consistência
          order: [['name', 'ASC']]
      });

      const categoriesMap = new Map();
      const rootCategories = [];

      allCategoriesForAccount.forEach(category => {
        const catJson = category.toJSON();
        catJson.subcategories = [];
        categoriesMap.set(catJson.id, catJson);
      });

      categoriesMap.forEach(category => {
        if (category.parentId && categoriesMap.has(category.parentId)) {
           // Adiciona apenas se a subcategoria estiver no mapa (passou no filtro type)
           if (categoriesMap.has(category.id)) { 
                categoriesMap.get(category.parentId).subcategories.push(category);
           }
        } else if (!category.parentId) { // É uma categoria raiz
          rootCategories.push(category);
        }
      });
      return rootCategories;
    }
  } catch (error) {
    logger.error(`Erro ao listar categorias financeiras da Conta ID ${financialAccountId}: ${error.message}`, { error, queryParams });
    if (!error.statusCode) error.statusCode = 500; // Garante statusCode se não tiver
    throw error;
  }
}

/**
 * Busca uma categoria financeira pelo ID, dentro de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} categoryId
 * @returns {Promise<object|null>}
 */
async function getFinancialCategoryById(financialAccountId, categoryId) {
    try {
        await validateOwningFinancialAccount(financialAccountId);
        const category = await FinancialCategory.findOne({
            where: { id: categoryId, financialAccountId },
            include: [
                { model: FinancialCategory, as: 'subcategories', include: [{model: FinancialCategory, as: 'parentCategory'}] }, // Inclui netas se necessário
                { model: FinancialCategory, as: 'parentCategory', attributes: ['id', 'name'] }
            ]
        });
        if (!category) {
            logger.warn(`Categoria financeira ID ${categoryId} não encontrada para Conta ID ${financialAccountId}.`);
            return null;
        }
        return category.toJSON();
    } catch (error) {
        logger.error(`Erro ao buscar categoria financeira ID ${categoryId} para Conta ID ${financialAccountId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

/**
 * Atualiza uma categoria financeira de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} categoryId
 * @param {object} updateData - { name, type, parentId }
 * @returns {Promise<object|null>}
 */
async function updateFinancialCategory(financialAccountId, categoryId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);
    const category = await FinancialCategory.findOne({ where: {id: categoryId, financialAccountId}, transaction: t });
    if (!category) {
      await t.rollback();
      const e = new Error('Categoria financeira não encontrada nesta conta.');
      e.statusCode = 404; e.status = 'fail'; throw e;
    }

    const newName = updateData.hasOwnProperty('name') ? updateData.name : category.name;
    const newParentId = updateData.hasOwnProperty('parentId')
        ? (updateData.parentId === null || updateData.parentId === undefined || updateData.parentId === '' ? null : parseInt(updateData.parentId,10))
        : category.parentId;

    if ((updateData.hasOwnProperty('name') && updateData.name !== category.name) ||
        (updateData.hasOwnProperty('parentId') && newParentId !== category.parentId)) {
      const existingCategory = await FinancialCategory.findOne({
        where: {
          name: { [Op.iLike]: newName },
          parentId: newParentId,
          financialAccountId, // << ADICIONADO
          id: { [Op.ne]: categoryId }
        },
        transaction: t
      });
      if (existingCategory) {
        const parentMsg = newParentId ? `dentro da categoria pai ID ${newParentId}` : 'como categoria principal';
        const error = new Error(`Já existe outra categoria com o nome "${newName}" nesta conta financeira ${parentMsg}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
    }
    
    if (newParentId !== null && newParentId !== undefined) {
        if (newParentId === categoryId) { /* ... erro ciclo ... */ }
        const parentCandidate = await FinancialCategory.findOne({where: {id: newParentId, financialAccountId}, transaction:t});
        if(!parentCandidate){
            const error = new Error(`Categoria pai ID ${newParentId} não encontrada nesta conta financeira ou inválida.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        async function isDescendant(potentialChildId, ancestorIdToFind, transaction) { /* ... */ } // Mesma função de antes
        if (await isDescendant(newParentId, categoryId, t)) { /* ... erro ciclo ... */ }
    }


    const allowedFields = ['name', 'type', 'parentId']; // Removido isActive
    const filteredUpdateData = {};
    for(const key of allowedFields){
        if(updateData.hasOwnProperty(key)){
            if(key === 'parentId'){
                filteredUpdateData[key] = (updateData[key] === null || updateData[key] === undefined || updateData[key] === '') ? null : parseInt(updateData[key],10);
            } else if (key === 'type' && !['Entrada', 'Saída', 'Ambos'].includes(updateData[key])) {
                logger.warn(`Tipo de categoria inválido fornecido na atualização: ${updateData[key]}. Mantendo o tipo atual.`);
            }
            else {
                filteredUpdateData[key] = updateData[key];
            }
        }
    }

    if (Object.keys(filteredUpdateData).length > 0) {
        await category.update(filteredUpdateData, { transaction: t });
    }

    await t.commit();
    logger.info(`Categoria Financeira ID ${categoryId} ("${category.name}") atualizada para Conta ID ${financialAccountId}.`);
    const reloadedCategory = await FinancialCategory.findByPk(categoryId, {
        include: [
            { model: FinancialCategory, as: 'subcategories' },
            { model: FinancialCategory, as: 'parentCategory', attributes: ['id', 'name'] }
        ]
    });
    return reloadedCategory.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar categoria financeira ID ${categoryId} para Conta ID ${financialAccountId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui uma categoria financeira de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} categoryId
 * @param {object} options - { actionForSubcategories, actionForTransactions, reassignToCategoryId }
 * @returns {Promise<boolean>}
 */
async function deleteFinancialCategory(financialAccountId, categoryId, options = {}) {
  const {
    actionForSubcategories = 'restrict', 
    actionForTransactions = 'set_null', // Alterado para 'set_null' como default mais seguro
    reassignToCategoryId = null
  } = options;

  const t = options.transaction || await sequelize.transaction();

  try {
    await validateOwningFinancialAccount(financialAccountId, t);
    const category = await FinancialCategory.findOne({ where: {id: categoryId, financialAccountId}, transaction: t });
    if (!category) {
      if (!options.transaction) await t.rollback();
      return false;
    }

    const transactionsCount = await FinancialTransaction.count({ where: { financialCategoryId: categoryId, financialAccountId }, transaction: t });
    if (transactionsCount > 0) {
      if (actionForTransactions === 'restrict') { /* ... erro ... */ }
      else if (actionForTransactions === 'reassign') {
        if (!reassignToCategoryId) { /* ... erro ... */ }
        const targetCategory = await FinancialCategory.findOne({where: {id: reassignToCategoryId, financialAccountId}, transaction: t });
        if (!targetCategory || targetCategory.id === categoryId) { /* ... erro ... */ }
        await FinancialTransaction.update(
          { financialCategoryId: reassignToCategoryId },
          { where: { financialCategoryId: categoryId, financialAccountId }, transaction: t } // Filtra pela conta
        );
      } else if (actionForTransactions === 'set_null') {
        await FinancialTransaction.update(
          { financialCategoryId: null },
          { where: { financialCategoryId: categoryId, financialAccountId }, transaction: t } // Filtra pela conta
        );
      } else if (actionForTransactions === 'delete') {
        await FinancialTransaction.destroy({ where: { financialCategoryId: categoryId, financialAccountId }, transaction: t }); // Filtra pela conta
      }
    }

    const subcategories = await FinancialCategory.findAll({ where: { parentId: categoryId, financialAccountId }, transaction: t });
    if (subcategories.length > 0) {
      if (actionForSubcategories === 'restrict') { /* ... erro ... */ }
      else if (actionForSubcategories === 'promote') {
        await FinancialCategory.update(
          { parentId: category.parentId }, // Novo pai é o pai da categoria deletada (pode ser null)
          { where: { parentId: categoryId, financialAccountId }, transaction: t } // Filtra pela conta
        );
      } else if (actionForSubcategories === 'delete') {
        for (const sub of subcategories) {
          // A chamada recursiva precisa do financialAccountId
          await deleteFinancialCategory(financialAccountId, sub.id, { ...options, transaction: t });
        }
      }
    }

    await category.destroy({ transaction: t });
    if (!options.transaction) await t.commit();
    return true;
  } catch (error) {
    if (!options.transaction && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback(); // Garante rollback
    logger.error(`Erro ao deletar categoria financeira ID ${categoryId} da Conta ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}


/**
 * Busca uma categoria financeira pelo nome e tipo DENTRO de uma financialAccount.
 * @param {string} name - Nome da categoria.
 * @param {string|null} type - 'Entrada', 'Saída', ou null.
 * @param {number} financialAccountId - ID da conta financeira.
 * @returns {Promise<object|null>}
 */
async function findFinancialCategoryByNameAndTypeForAccount(name, type, financialAccountId) {
  if (!name || typeof name !== 'string' || name.trim() === '' || !financialAccountId) return null;
  try {
    const whereConditions = {
      name: { [Op.iLike]: name },
      financialAccountId, // Filtro pela conta
      // isActive não existe mais no modelo, então removemos
    };
    if (type) {
      whereConditions.type = { [Op.or]: [type, 'Ambos'] };
    }

    const category = await FinancialCategory.findOne({ where: whereConditions });
    if (category) {
      logger.info(`[FINCAT SERVICE] Categoria encontrada: "${category.name}" para Conta ID ${financialAccountId}.`);
      return category.toJSON();
    }
    logger.warn(`[FINCAT SERVICE] Categoria "${name}" (Tipo: ${type || 'qualquer'}) não encontrada para Conta ID ${financialAccountId}.`);
    return null;
  } catch (error) {
    logger.error(`Erro ao buscar categoria por nome/tipo para Conta ID ${financialAccountId}: ${error.message}`, { error });
    return null;
  }
}


module.exports = {
  createFinancialCategory,
  getAllFinancialCategories,
  getFinancialCategoryById,
  updateFinancialCategory,
  deleteFinancialCategory,
  findFinancialCategoryByNameAndTypeForAccount, // Renomeado para clareza
};
// src/features/FinancialCategory/financialCategory.service.js
const { FinancialCategory, FinancialAccount, FinancialTransaction, sequelize } = require('../../database');
const { Op } = require('sequelize');
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

async function createFinancialCategory(financialAccountId, categoryData) {
  const { name, parentId } = categoryData; // Removido 'type'
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccount(financialAccountId, t);

    if (!name) { // Apenas 'name' é obrigatório agora do categoryData
      const error = new Error('Nome é obrigatório para a categoria financeira.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const finalParentId = parentId === undefined || parentId === null || parentId === '' ? null : parseInt(parentId, 10);

    const existingCategory = await FinancialCategory.findOne({
      where: {
        name: { [Op.iLike]: name },
        financialAccountId,
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
      // Validação de compatibilidade de tipo removida
    }

    const category = await FinancialCategory.create({
        name,
        // type removido
        parentId: finalParentId,
        financialAccountId
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

async function getAllFinancialCategories(financialAccountId, queryParams = {}) {
  const { hierarchical = false, onlyTopLevel = false /*, type (removido) */ } = queryParams;
  try {
    await validateOwningFinancialAccount(financialAccountId); 
    const whereConditions = { financialAccountId };

    if (onlyTopLevel) {
      whereConditions.parentId = null;
    }
    // Filtro por 'type' removido

    if (!hierarchical) {
      const categories = await FinancialCategory.findAll({
        where: whereConditions,
        order: [
            sequelize.literal('"FinancialCategory"."parentId" IS NULL DESC'),
            [sequelize.col('"FinancialCategory"."parentId"'), 'ASC NULLS FIRST'],
            ['name', 'ASC']
        ],
        include: [{ model: FinancialCategory, as: 'parentCategory', attributes: ['id', 'name'] }]
      });
      return categories.map(c => c.toJSON());
    } else {
      const allCategoriesForAccount = await FinancialCategory.findAll({
          where: whereConditions,
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
           if (categoriesMap.has(category.id)) { 
                categoriesMap.get(category.parentId).subcategories.push(category);
           }
        } else if (!category.parentId) {
          rootCategories.push(category);
        }
      });
      return rootCategories;
    }
  } catch (error) {
    logger.error(`Erro ao listar categorias financeiras da Conta ID ${financialAccountId}: ${error.message}`, { error, queryParams });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getFinancialCategoryById(financialAccountId, categoryId) {
    try {
        await validateOwningFinancialAccount(financialAccountId);
        const category = await FinancialCategory.findOne({
            where: { id: categoryId, financialAccountId },
            include: [
                { model: FinancialCategory, as: 'subcategories', include: [{model: FinancialCategory, as: 'parentCategory'}] },
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
          financialAccountId,
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
        if (newParentId === categoryId) { 
            const error = new Error('Uma categoria não pode ser pai de si mesma.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        const parentCandidate = await FinancialCategory.findOne({where: {id: newParentId, financialAccountId}, transaction:t});
        if(!parentCandidate){
            const error = new Error(`Categoria pai ID ${newParentId} não encontrada nesta conta financeira ou inválida.`);
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        async function isDescendant(potentialChildId, ancestorIdToFind, transaction) {
            let current = await FinancialCategory.findByPk(potentialChildId, { attributes: ['parentId'], transaction });
            while (current && current.parentId !== null) {
                if (current.parentId === ancestorIdToFind) return true;
                current = await FinancialCategory.findByPk(current.parentId, { attributes: ['parentId'], transaction });
            }
            return false;
        }
        if (await isDescendant(newParentId, categoryId, t)) { 
            const error = new Error('Não é possível mover uma categoria para ser filha de um de seus próprios descendentes (cria um ciclo).');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }

    const allowedFields = ['name', 'parentId']; // Removido 'type'
    const filteredUpdateData = {};
    for(const key of allowedFields){
        if(updateData.hasOwnProperty(key)){
            if(key === 'parentId'){
                filteredUpdateData[key] = (updateData[key] === null || updateData[key] === undefined || updateData[key] === '') ? null : parseInt(updateData[key],10);
            } 
            // Removida validação de type
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

async function deleteFinancialCategory(financialAccountId, categoryId, options = {}) {
  // ... (função deleteFinancialCategory permanece a mesma, pois 'type' não era usado nela diretamente para lógica de deleção)
  // Apenas certifique-se de que as mensagens de erro ou logs não mencionem mais 'tipo' se não for relevante.
  const {
    actionForSubcategories = 'restrict', 
    actionForTransactions = 'set_null',
    reassignToCategoryId = null
  } = options;

  const t = options.transaction || await sequelize.transaction();

  try {
    await validateOwningFinancialAccount(financialAccountId, t);
    const category = await FinancialCategory.findOne({ where: {id: categoryId, financialAccountId}, transaction: t });
    if (!category) {
      if (!options.transaction) await t.rollback();
      const e = new Error('Categoria financeira não encontrada nesta conta para exclusão.');
      e.statusCode = 404; e.status = 'fail'; throw e;
    }

    const transactionsCount = await FinancialTransaction.count({ where: { financialCategoryId: categoryId, financialAccountId }, transaction: t });
    if (transactionsCount > 0) {
      if (actionForTransactions === 'restrict') {
        const e = new Error(`Categoria "${category.name}" (ID ${categoryId}) tem ${transactionsCount} transações. Ação 'restrict' impede a exclusão.`);
        e.statusCode = 409; e.status = 'fail'; throw e;
      } else if (actionForTransactions === 'reassign') {
        if (!reassignToCategoryId) {
          const e = new Error('Para reassociar transações, "reassignToCategoryId" é obrigatório.');
          e.statusCode = 400; e.status = 'fail'; throw e;
        }
        const targetCategory = await FinancialCategory.findOne({where: {id: reassignToCategoryId, financialAccountId}, transaction: t });
        if (!targetCategory || targetCategory.id === categoryId) {
          const e = new Error(`Categoria de destino para transações (ID: ${reassignToCategoryId}) é inválida ou é a mesma.`);
          e.statusCode = 400; e.status = 'fail'; throw e;
        }
        await FinancialTransaction.update(
          { financialCategoryId: reassignToCategoryId },
          { where: { financialCategoryId: categoryId, financialAccountId }, transaction: t }
        );
      } else if (actionForTransactions === 'set_null') {
        await FinancialTransaction.update(
          { financialCategoryId: null },
          { where: { financialCategoryId: categoryId, financialAccountId }, transaction: t }
        );
      } else if (actionForTransactions === 'delete') {
        await FinancialTransaction.destroy({ where: { financialCategoryId: categoryId, financialAccountId }, transaction: t });
      }
    }

    const subcategories = await FinancialCategory.findAll({ where: { parentId: categoryId, financialAccountId }, transaction: t });
    if (subcategories.length > 0) {
      if (actionForSubcategories === 'restrict') {
        const e = new Error(`Categoria "${category.name}" (ID ${categoryId}) tem ${subcategories.length} subcategorias. Ação 'restrict' impede a exclusão.`);
        e.statusCode = 409; e.status = 'fail'; throw e;
      } else if (actionForSubcategories === 'promote') {
        await FinancialCategory.update(
          { parentId: category.parentId },
          { where: { parentId: categoryId, financialAccountId }, transaction: t }
        );
      } else if (actionForSubcategories === 'delete') {
        for (const sub of subcategories) {
          await deleteFinancialCategory(financialAccountId, sub.id, { ...options, transaction: t });
        }
      }
    }

    await category.destroy({ transaction: t });
    if (!options.transaction) await t.commit();
    return true;
  } catch (error) {
    if (!options.transaction && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao deletar categoria financeira ID ${categoryId} da Conta ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function findFinancialCategoryByNameAndTypeForAccount(name, type, financialAccountId) { // 'type' não é mais usado aqui
  if (!name || typeof name !== 'string' || name.trim() === '' || !financialAccountId) return null;
  try {
    const whereConditions = {
      name: { [Op.iLike]: name },
      financialAccountId,
    };
    // Condição de tipo removida

    const category = await FinancialCategory.findOne({ where: whereConditions });
    if (category) {
      logger.info(`[FINCAT SERVICE] Categoria encontrada: "${category.name}" para Conta ID ${financialAccountId}.`);
      return category.toJSON();
    }
    logger.warn(`[FINCAT SERVICE] Categoria "${name}" não encontrada para Conta ID ${financialAccountId}.`);
    return null;
  } catch (error) {
    logger.error(`Erro ao buscar categoria por nome para Conta ID ${financialAccountId}: ${error.message}`, { error });
    return null;
  }
}

module.exports = {
  createFinancialCategory,
  getAllFinancialCategories,
  getFinancialCategoryById,
  updateFinancialCategory,
  deleteFinancialCategory,
  findFinancialCategoryByNameAndTypeForAccount, // O nome da função pode ser simplificado para findFinancialCategoryByNameForAccount
};
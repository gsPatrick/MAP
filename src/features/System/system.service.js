// src/features/System/system.service.js
const { UserPreference, FinancialCategory, FinancialTransaction, MotivationalPhrase, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

/**
 * Obtém as preferências/configurações do sistema.
 * Assume que há apenas um registro de UserPreference ou que estamos buscando um específico.
 * Para simplificar, buscaremos o primeiro registro. Em um sistema multi-admin,
 * você buscaria pelo userId ou teria um ID fixo para configurações globais.
 * @returns {Promise<object|null>} As configurações do sistema.
 */
async function getSystemPreferences() {
  try {
    let preferences = await UserPreference.findOne({ order: [['id', 'ASC']] });
    if (!preferences) {
      logger.info('Nenhuma preferência do sistema encontrada. Criando com valores padrão.');
      preferences = await UserPreference.create({});
    }
    logger.info('Preferências do sistema recuperadas.');
    return preferences.toJSON();
  } catch (error) {
    logger.error(`Erro ao obter preferências do sistema: ${error.message}`, { error });
    throw new Error(`Erro ao obter preferências do sistema: ${error.message}`);
  }
}

/**
 * Atualiza as preferências/configurações do sistema.
 * @param {object} updateData - Dados a serem atualizados no UserPreference.
 * @returns {Promise<object|null>} As configurações atualizadas.
 */
async function updateSystemPreferences(updateData) {
  const t = await sequelize.transaction();
  try {
    let preferences = await UserPreference.findOne({ order: [['id', 'ASC']], transaction: t });
    if (!preferences) {
      logger.info('Nenhuma preferência do sistema encontrada para atualizar. Criando uma nova.');
      preferences = await UserPreference.create(updateData, { transaction: t });
    } else {
      const allowedUpdates = [
        'enableWaterReminder', 'waterReminderFrequencyType', 'waterReminderCustomIntervalMinutes',
        'waterReminderStartTime', 'waterReminderEndTime', 'enableMotivationMessage',
        'motivationMessageTime', 'dailySummaryTime', 'weeklySummaryDayOfWeek',
        'weeklySummaryTime', 'monthlyReportDayOfMonth', 'monthlyReportTime',
        'defaultAppointmentReminderLeadTimeMinutes'
      ];
      const filteredData = {};
      for (const key of allowedUpdates) {
        if (updateData[key] !== undefined) {
          filteredData[key] = updateData[key];
        }
      }
      await preferences.update(filteredData, { transaction: t });
    }
    await t.commit();
    logger.info('Preferências do sistema atualizadas com sucesso.');
    return preferences.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar preferências do sistema: ${error.message}`, { error, updateData });
    throw new Error(`Erro ao atualizar preferências do sistema: ${error.message}`);
  }
}

// --- Gerenciamento de Categorias Financeiras (COM SUB-CATEGORIAS) ---

/**
 * Cria uma nova categoria financeira (pode ser principal ou subcategoria).
 * @param {object} categoryData - { name, type, parentId (opcional), isDefault (opcional), isActive (opcional) }
 * @returns {Promise<object>}
 */
async function createFinancialCategory(categoryData) {
  const { name, type, parentId, isDefault = false, isActive = true } = categoryData;
  try {
    if (!name || !type) {
      const error = new Error('Nome e Tipo são obrigatórios para a categoria financeira.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const finalParentId = parentId === undefined || parentId === null || parentId === '' ? null : parseInt(parentId, 10);

    const existingCategory = await FinancialCategory.findOne({
      where: {
        name: name,
        parentId: finalParentId
      }
    });
    if (existingCategory) {
      const parentMsg = finalParentId ? `dentro da categoria pai ID ${finalParentId}` : 'como categoria principal';
      const error = new Error(`Já existe uma categoria com o nome "${name}" ${parentMsg}.`);
      error.statusCode = 409; error.status = 'fail'; throw error;
    }

    if (finalParentId !== null) {
      const parent = await FinancialCategory.findByPk(finalParentId);
      if (!parent) {
        const error = new Error(`Categoria pai com ID ${finalParentId} não encontrada.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
      }
    }

    const category = await FinancialCategory.create({ name, type, parentId: finalParentId, isDefault, isActive });
    logger.info(`Categoria Financeira criada: "${category.name}" (ID: ${category.id})${finalParentId ? `, Pai ID: ${finalParentId}` : ''}`);
    return category.toJSON();
  } catch (error) {
    logger.error(`Erro ao criar categoria financeira: ${error.message}`, { error, categoryData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todas as categorias financeiras, opcionalmente de forma hierárquica.
 * @param {object} queryParams - { hierarchical (boolean, default: false), onlyTopLevel (boolean, default: false), isActive (boolean) }
 * @returns {Promise<Array<object>>}
 */
async function getAllFinancialCategories(queryParams = {}) {
  const { hierarchical = false, onlyTopLevel = false, isActive } = queryParams;
  try {
    const whereConditions = {};
    if (onlyTopLevel) {
      whereConditions.parentId = null;
    }
    if (isActive !== undefined) {
        whereConditions.isActive = (isActive === 'true' || isActive === true);
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
      const activeFilter = isActive !== undefined ? {isActive: (isActive === 'true' || isActive === true)} : {};
      const allCategories = await FinancialCategory.findAll({
          where: activeFilter, // Aplica filtro de isActive aqui
          order: [['name', 'ASC']]
        });

      const categoriesMap = new Map();
      const rootCategories = [];

      allCategories.forEach(category => {
        const catJson = category.toJSON();
        catJson.subcategories = [];
        categoriesMap.set(catJson.id, catJson);
      });

      categoriesMap.forEach(category => {
        if (category.parentId && categoriesMap.has(category.parentId)) {
          categoriesMap.get(category.parentId).subcategories.push(category);
        } else if (!category.parentId) {
          rootCategories.push(category);
        }
      });
      
      // Se onlyTopLevel for true com hierarchical, retornamos apenas as raízes (que já contêm seus filhos)
      // Se onlyTopLevel for false (padrão) com hierarchical, o resultado já é o desejado (raízes com filhos)
      return rootCategories;
    }
  } catch (error) {
    logger.error(`Erro ao listar categorias financeiras: ${error.message}`, { error, queryParams });
    throw new Error(`Erro ao listar categorias financeiras: ${error.message}`);
  }
}

/**
 * Busca uma categoria financeira pelo ID, incluindo suas subcategorias e pai.
 * @param {number} categoryId - ID da categoria.
 * @returns {Promise<object|null>}
 */
async function getFinancialCategoryById(categoryId) {
    try {
        const category = await FinancialCategory.findByPk(categoryId, {
            include: [
                {
                    model: FinancialCategory,
                    as: 'subcategories',
                    include: [{ // Para ver o pai da subcategoria (que é a categoria atual) - opcional aqui
                        model: FinancialCategory,
                        as: 'parentCategory',
                        attributes:['id','name']
                    }]
                },
                { model: FinancialCategory, as: 'parentCategory', attributes: ['id', 'name'] }
            ]
        });
        if (!category) {
            logger.warn(`Categoria financeira ID ${categoryId} não encontrada.`);
            return null;
        }
        return category.toJSON();
    } catch (error) {
        logger.error(`Erro ao buscar categoria financeira ID ${categoryId}: ${error.message}`, { error });
        throw new Error(`Erro ao buscar categoria financeira: ${error.message}`);
    }
}

/**
 * Atualiza uma categoria financeira.
 * @param {number} categoryId - ID da categoria.
 * @param {object} updateData - { name, type, parentId, isActive, isDefault }
 * @returns {Promise<object|null>}
 */
async function updateFinancialCategory(categoryId, updateData) {
  const t = await sequelize.transaction();
  try {
    const category = await FinancialCategory.findByPk(categoryId, { transaction: t });
    if (!category) {
      await t.rollback();
      const e = new Error('Categoria financeira não encontrada.');
      e.statusCode = 404; e.status = 'fail'; throw e;
    }

    const { name } = updateData;
    // Trata parentId: se "parentId" está no updateData, usa seu valor (null se string vazia/null/undefined). Senão, mantém o parentId atual.
    const newParentId = updateData.hasOwnProperty('parentId') ? (updateData.parentId === null || updateData.parentId === undefined || updateData.parentId === '' ? null : parseInt(updateData.parentId,10) ) : category.parentId;
    const newName = name !== undefined ? name : category.name;

    if ((name !== undefined && name !== category.name) || (updateData.hasOwnProperty('parentId') && newParentId !== category.parentId)) {
      const existingCategory = await FinancialCategory.findOne({
        where: {
          name: newName,
          parentId: newParentId,
          id: { [Op.ne]: categoryId }
        },
        transaction: t
      });
      if (existingCategory) {
        const parentMsg = newParentId ? `dentro da categoria pai ID ${newParentId}` : 'como categoria principal';
        const error = new Error(`Já existe uma categoria com o nome "${newName}" ${parentMsg}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
    }
    
    if (newParentId !== null && newParentId !== undefined) {
        if (newParentId === categoryId) {
            const error = new Error('Uma categoria não pode ser pai de si mesma.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        // Lógica para prevenir ciclo: buscar todos os descendentes da categoria atual
        // e verificar se newParentId é um deles.
        // Esta é uma query recursiva ou um loop de busca. Para simplificar:
        async function isDescendant(childId, ancestorId, transaction) {
            let currentId = childId;
            const visited = new Set();
            while (currentId !== null && currentId !== undefined) {
                if (currentId === ancestorId) return true; // Encontrou ciclo
                if (visited.has(currentId)) break; // Ciclo detectado de outra forma ou já visitado
                visited.add(currentId);
                const currentCat = await FinancialCategory.findByPk(currentId, { attributes: ['parentId'], transaction });
                if (!currentCat) break;
                currentId = currentCat.parentId;
            }
            return false;
        }
        if (await isDescendant(newParentId, categoryId, t)) {
             const error = new Error('Não é possível mover uma categoria para ser filha de um de seus próprios descendentes (cria um ciclo).');
             error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }

    // Campos permitidos para atualização
    const allowedFields = ['name', 'type', 'parentId', 'isActive', 'isDefault'];
    const filteredUpdateData = {};
    for(const key of allowedFields){
        if(updateData.hasOwnProperty(key)){
            if(key === 'parentId'){
                filteredUpdateData[key] = (updateData[key] === null || updateData[key] === undefined || updateData[key] === '') ? null : parseInt(updateData[key],10);
            } else {
                filteredUpdateData[key] = updateData[key];
            }
        }
    }

    await category.update(filteredUpdateData, { transaction: t });
    await t.commit();
    logger.info(`Categoria Financeira ID ${categoryId} atualizada: "${category.name}"`);
    
    const reloadedCategory = await FinancialCategory.findByPk(categoryId, {
        include: [
            { model: FinancialCategory, as: 'subcategories' },
            { model: FinancialCategory, as: 'parentCategory', attributes: ['id', 'name'] }
        ]
    });
    return reloadedCategory.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar categoria financeira ID ${categoryId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui uma categoria financeira, com opções para subcategorias e transações.
 * @param {number} categoryId - ID da categoria.
 * @param {object} options - { actionForSubcategories, actionForTransactions, reassignToCategoryId }
 * @returns {Promise<boolean>}
 */
async function deleteFinancialCategory(categoryId, options = {}) {
  const {
    actionForSubcategories = 'restrict', // 'delete', 'promote', 'restrict'
    actionForTransactions = 'restrict',  // 'delete', 'reassign', 'restrict'
    reassignToCategoryId = null
  } = options;

  // Usar uma transação gerenciada externamente se options.transaction for fornecido (para chamadas recursivas)
  // Senão, iniciar uma nova transação.
  const t = options.transaction || await sequelize.transaction();

  try {
    const category = await FinancialCategory.findByPk(categoryId, { transaction: t });
    if (!category) {
      if (!options.transaction) await t.rollback(); // Só faz rollback se esta função iniciou a transação
      logger.warn(`Categoria Financeira ID ${categoryId} não encontrada para exclusão.`);
      return false;
    }

    // 1. Lidar com transações
    const transactions = await FinancialTransaction.findAll({ where: { financialCategoryId: categoryId }, transaction: t });
    if (transactions.length > 0) {
      if (actionForTransactions === 'restrict') {
        const e = new Error(`Não é possível excluir a categoria "${category.name}" (ID ${categoryId}) pois está associada a ${transactions.length} transações. Ação: 'restrict'.`);
        e.statusCode = 409; e.status = 'fail'; throw e;
      } else if (actionForTransactions === 'reassign') {
        if (!reassignToCategoryId) {
          const e = new Error('ID da categoria para reassociação de transações é obrigatório (reassignToCategoryId).');
          e.statusCode = 400; e.status = 'fail'; throw e;
        }
        const targetCategory = await FinancialCategory.findByPk(reassignToCategoryId, { transaction: t });
        if (!targetCategory || targetCategory.id === categoryId) {
          const e = new Error(`Categoria de destino para reassociação (ID: ${reassignToCategoryId}) inválida ou é a mesma.`);
          e.statusCode = 400; e.status = 'fail'; throw e;
        }
        await FinancialTransaction.update(
          { financialCategoryId: reassignToCategoryId },
          { where: { financialCategoryId: categoryId }, transaction: t }
        );
        logger.info(`${transactions.length} transações da categoria "${category.name}" reassociadas para "${targetCategory.name}".`);
      } else if (actionForTransactions === 'delete') {
        await FinancialTransaction.destroy({ where: { financialCategoryId: categoryId }, transaction: t });
        logger.warn(`${transactions.length} transações associadas à categoria "${category.name}" foram DELETADAS.`);
      }
    }

    // 2. Lidar com subcategorias
    const subcategories = await FinancialCategory.findAll({ where: { parentId: categoryId }, transaction: t });
    if (subcategories.length > 0) {
      if (actionForSubcategories === 'restrict') {
        const e = new Error(`Não é possível excluir a categoria "${category.name}" (ID ${categoryId}) pois possui ${subcategories.length} subcategorias. Ação: 'restrict'.`);
        e.statusCode = 409; e.status = 'fail'; throw e;
      } else if (actionForSubcategories === 'promote') {
        await FinancialCategory.update(
          { parentId: null },
          { where: { parentId: categoryId }, transaction: t }
        );
        logger.info(`${subcategories.length} subcategorias de "${category.name}" foram promovidas.`);
      } else if (actionForSubcategories === 'delete') {
        for (const sub of subcategories) {
          // Chamada recursiva, passando a mesma transação e opções
          await deleteFinancialCategory(sub.id, { ...options, transaction: t });
        }
        logger.warn(`${subcategories.length} subcategorias de "${category.name}" foram DELETADAS recursivamente.`);
      }
    }

    // 3. Deletar a categoria
    await category.destroy({ transaction: t });
    
    if (!options.transaction) await t.commit(); // Só faz commit se esta função iniciou a transação
    logger.info(`Categoria Financeira ID ${categoryId} ("${category.name}") deletada.`);
    return true;
  } catch (error) {
    if (!options.transaction) await t.rollback(); // Só faz rollback se esta função iniciou a transação
    logger.error(`Erro ao deletar categoria financeira ID ${categoryId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}


// --- Gerenciamento de Frases Motivacionais (Permanece o mesmo) ---
async function createMotivationalPhrase(phraseData) { /* ...código anterior... */ }
async function getAllMotivationalPhrases(queryParams = {}) { /* ...código anterior... */ }
async function updateMotivationalPhrase(phraseId, updateData) { /* ...código anterior... */ }
async function deleteMotivationalPhrase(phraseId) { /* ...código anterior... */ }
// (Cole os códigos das funções de MotivationalPhrase aqui, eles não mudam)
// COPIANDO AS FUNÇÕES DE MOTIVATIONALPHRASE PARA COMPLETUDE DO ARQUIVO:
async function createMotivationalPhrase(phraseData) {
  try {
    if (!phraseData.text) {
      const error = new Error('Texto é obrigatório para a frase motivacional.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    const phrase = await MotivationalPhrase.create(phraseData);
    logger.info(`Frase Motivacional criada: ID ${phrase.id}`);
    return phrase.toJSON();
  } catch (error) {
    logger.error(`Erro ao criar frase motivacional: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getAllMotivationalPhrases(queryParams = {}) {
    const { isActive } = queryParams;
    const whereConditions = {};
    if (isActive !== undefined) {
        whereConditions.isActive = (isActive === 'true' || isActive === true);
    }
  try {
    const phrases = await MotivationalPhrase.findAll({ where: whereConditions, order: [['createdAt', 'DESC']] });
    return phrases.map(p => p.toJSON());
  } catch (error) {
    logger.error(`Erro ao listar frases motivacionais: ${error.message}`, { error });
    throw new Error(`Erro ao listar frases motivacionais: ${error.message}`);
  }
}

async function updateMotivationalPhrase(phraseId, updateData) {
  try {
    const phrase = await MotivationalPhrase.findByPk(phraseId);
    if (!phrase) {
        const e = new Error('Frase motivacional não encontrada.');
        e.statusCode = 404; e.status = 'fail'; throw e;
    }
    await phrase.update(updateData);
    logger.info(`Frase Motivacional atualizada: ID ${phrase.id}`);
    return phrase.toJSON();
  } catch (error) {
    logger.error(`Erro ao atualizar frase motivacional ID ${phraseId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteMotivationalPhrase(phraseId) {
  try {
    const phrase = await MotivationalPhrase.findByPk(phraseId);
    if (!phrase) {
        logger.warn(`Frase motivacional ID ${phraseId} não encontrada para exclusão.`);
        return false;
    }
    await phrase.destroy();
    logger.info(`Frase Motivacional deletada: ID ${phrase.id}`);
    return true;
  } catch (error) {
    logger.error(`Erro ao deletar frase motivacional ID ${phraseId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}


module.exports = {
  getSystemPreferences,
  updateSystemPreferences,
  createFinancialCategory,
  getAllFinancialCategories,
  getFinancialCategoryById,
  updateFinancialCategory,
  deleteFinancialCategory, // A chamada direta já usa a lógica interna de transação
  createMotivationalPhrase,
  getAllMotivationalPhrases,
  updateMotivationalPhrase,
  deleteMotivationalPhrase,
};
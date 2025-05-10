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
      preferences = await UserPreference.create({}); // Cria com defaults do modelo
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
      // Se criar aqui, garantir que todos os campos possíveis sejam passados ou que o modelo tenha defaults.
      preferences = await UserPreference.create(updateData, { transaction: t });
    } else {
      // Lista de campos permitidos para atualização para evitar que campos indesejados sejam passados.
      const allowedUpdates = [
        'enableWaterReminder', 'waterReminderFrequencyType', 'waterReminderCustomIntervalMinutes',
        'waterReminderStartTime', 'waterReminderEndTime', 'enableMotivationMessage',
        'motivationMessageTime', 'dailySummaryTime', 'weeklySummaryDayOfWeek',
        'weeklySummaryTime', 'monthlyReportDayOfMonth', 'monthlyReportTime',
        'defaultAppointmentReminderLeadTimeMinutes', 'recurringJobSchedule',
        'appointmentReminderJobSchedule', 'alertsJobSchedule', 'dueAlertLeadDays', 'fiscalAlertLeadDaysMEI'
        // Adicionar outros campos de UserPreference aqui se existirem
      ];
      const filteredData = {};
      for (const key of allowedUpdates) {
        if (updateData.hasOwnProperty(key)) { // Usar hasOwnProperty para incluir valores como false ou 0
          filteredData[key] = updateData[key];
        }
      }
      if (Object.keys(filteredData).length > 0) {
        await preferences.update(filteredData, { transaction: t });
      } else {
        logger.info('[SYSTEM SERVICE] Nenhum dado válido para atualizar preferências do sistema.');
      }
    }
    await t.commit();
    logger.info('Preferências do sistema atualizadas com sucesso.');
    return preferences.reload().then(p => p.toJSON()); // Recarregar para garantir dados mais recentes
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
    if (!['Entrada', 'Saída', 'Ambos'].includes(type)) {
        const error = new Error('Tipo de categoria inválido. Use Entrada, Saída ou Ambos.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const finalParentId = parentId === undefined || parentId === null || parentId === '' ? null : parseInt(parentId, 10);

    const existingCategory = await FinancialCategory.findOne({
      where: {
        name: { [Op.iLike]: name }, // Verifica case-insensitive para evitar duplicidade de nomes parecidos
        parentId: finalParentId,
        // type: type // Descomentar se o tipo também fizer parte da unicidade com o pai
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
      // Opcional: Verificar se o tipo da subcategoria é compatível com o tipo da categoria pai
      // Ex: Se pai é 'Saída', subcategoria não pode ser 'Entrada' (a menos que 'Ambos')
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
  const { hierarchical = false, onlyTopLevel = false, isActive, type } = queryParams;
  try {
    const whereConditions = {};
    if (onlyTopLevel) {
      whereConditions.parentId = null;
    }
    if (isActive !== undefined) {
        whereConditions.isActive = (isActive === 'true' || isActive === true);
    }
    if (type) {
        whereConditions.type = { [Op.or]: [type, 'Ambos'] };
    }


    if (!hierarchical) {
      const categories = await FinancialCategory.findAll({
        where: whereConditions,
        order: [
            sequelize.literal('"parentId" IS NULL DESC'), // Principais primeiro
            ['parentId', 'ASC NULLS FIRST'],
            ['name', 'ASC']
        ],
        include: [{ model: FinancialCategory, as: 'parentCategory', attributes: ['id', 'name'] }]
      });
      return categories.map(c => c.toJSON());
    } else {
      // Para a busca hierárquica, aplicamos o filtro isActive e type na busca inicial
      const allCategories = await FinancialCategory.findAll({
          where: whereConditions, // whereConditions já inclui isActive e type se fornecidos
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
          // Adiciona apenas se a subcategoria estiver no mapa (ou seja, passou no filtro isActive/type)
           if (categoriesMap.has(category.id)) { // Garante que a subcategoria em si também passou no filtro
                categoriesMap.get(category.parentId).subcategories.push(category);
           }
        } else if (!category.parentId) {
          rootCategories.push(category);
        }
      });
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
                    // Opcional: filtrar subcategorias ativas se necessário
                    // where: { isActive: true },
                    // required: false, // para não falhar se não tiver subcategorias
                    include: [{ model: FinancialCategory, as: 'parentCategory', attributes:['id','name']}]
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

    const newName = updateData.hasOwnProperty('name') ? updateData.name : category.name;
    const newParentId = updateData.hasOwnProperty('parentId')
        ? (updateData.parentId === null || updateData.parentId === undefined || updateData.parentId === '' ? null : parseInt(updateData.parentId,10))
        : category.parentId;

    // Verifica unicidade de nome dentro do mesmo pai
    if ((updateData.hasOwnProperty('name') && updateData.name !== category.name) ||
        (updateData.hasOwnProperty('parentId') && newParentId !== category.parentId)) {
      const existingCategory = await FinancialCategory.findOne({
        where: {
          name: { [Op.iLike]: newName },
          parentId: newParentId,
          id: { [Op.ne]: categoryId }
        },
        transaction: t
      });
      if (existingCategory) {
        const parentMsg = newParentId ? `dentro da categoria pai ID ${newParentId}` : 'como categoria principal';
        const error = new Error(`Já existe outra categoria com o nome "${newName}" ${parentMsg}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
    }

    // Prevenção de ciclo de parentesco
    if (newParentId !== null && newParentId !== undefined) {
        if (newParentId === categoryId) { // Categoria não pode ser pai de si mesma
            const error = new Error('Uma categoria não pode ser pai de si mesma.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        // Verifica se o novo pai proposto é um descendente da categoria atual
        async function isDescendant(potentialChildId, ancestorIdToFind, transaction) {
            let current = await FinancialCategory.findByPk(potentialChildId, { attributes: ['parentId'], transaction });
            while (current && current.parentId !== null) {
                if (current.parentId === ancestorIdToFind) return true; // Ciclo encontrado
                current = await FinancialCategory.findByPk(current.parentId, { attributes: ['parentId'], transaction });
            }
            return false;
        }
        if (await isDescendant(newParentId, categoryId, t)) {
             const error = new Error('Não é possível mover uma categoria para ser filha de um de seus próprios descendentes (cria um ciclo).');
             error.statusCode = 400; error.status = 'fail'; throw error;
        }
    }

    const allowedFields = ['name', 'type', 'parentId', 'isActive', 'isDefault'];
    const filteredUpdateData = {};
    for(const key of allowedFields){
        if(updateData.hasOwnProperty(key)){
            if(key === 'parentId'){
                filteredUpdateData[key] = (updateData[key] === null || updateData[key] === undefined || updateData[key] === '') ? null : parseInt(updateData[key],10);
            } else if (key === 'type' && !['Entrada', 'Saída', 'Ambos'].includes(updateData[key])) {
                // Ignorar tipo inválido ou lançar erro
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
    actionForSubcategories = 'restrict', // 'delete', 'promote', 'reassign_children_to_grandparent', 'restrict'
    actionForTransactions = 'restrict',  // 'delete', 'reassign', 'set_null', 'restrict'
    reassignToCategoryId = null
  } = options;

  const t = options.transaction || await sequelize.transaction();

  try {
    const category = await FinancialCategory.findByPk(categoryId, { transaction: t });
    if (!category) {
      if (!options.transaction) await t.rollback();
      logger.warn(`Categoria Financeira ID ${categoryId} não encontrada para exclusão.`);
      return false;
    }

    // 1. Lidar com transações associadas à categoria a ser deletada
    const transactionsCount = await FinancialTransaction.count({ where: { financialCategoryId: categoryId }, transaction: t });
    if (transactionsCount > 0) {
      if (actionForTransactions === 'restrict') {
        const e = new Error(`Categoria "${category.name}" (ID ${categoryId}) tem ${transactionsCount} transações. Ação 'restrict' impede a exclusão.`);
        e.statusCode = 409; e.status = 'fail'; throw e;
      } else if (actionForTransactions === 'reassign') {
        if (!reassignToCategoryId) {
          const e = new Error('Para reassociar transações, "reassignToCategoryId" é obrigatório.');
          e.statusCode = 400; e.status = 'fail'; throw e;
        }
        const targetCategory = await FinancialCategory.findByPk(reassignToCategoryId, { transaction: t });
        if (!targetCategory || targetCategory.id === categoryId) {
          const e = new Error(`Categoria de destino para transações (ID: ${reassignToCategoryId}) é inválida ou é a mesma.`);
          e.statusCode = 400; e.status = 'fail'; throw e;
        }
        await FinancialTransaction.update(
          { financialCategoryId: reassignToCategoryId },
          { where: { financialCategoryId: categoryId }, transaction: t }
        );
        logger.info(`${transactionsCount} transações da categoria "${category.name}" reassociadas para "${targetCategory.name}".`);
      } else if (actionForTransactions === 'set_null') {
        await FinancialTransaction.update(
          { financialCategoryId: null },
          { where: { financialCategoryId: categoryId }, transaction: t }
        );
        logger.info(`${transactionsCount} transações da categoria "${category.name}" agora estão sem categoria.`);
      } else if (actionForTransactions === 'delete') {
        await FinancialTransaction.destroy({ where: { financialCategoryId: categoryId }, transaction: t });
        logger.warn(`${transactionsCount} transações associadas à categoria "${category.name}" foram DELETADAS.`);
      }
    }

    // 2. Lidar com subcategorias
    const subcategories = await FinancialCategory.findAll({ where: { parentId: categoryId }, transaction: t });
    if (subcategories.length > 0) {
      if (actionForSubcategories === 'restrict') {
        const e = new Error(`Categoria "${category.name}" (ID ${categoryId}) tem ${subcategories.length} subcategorias. Ação 'restrict' impede a exclusão.`);
        e.statusCode = 409; e.status = 'fail'; throw e;
      } else if (actionForSubcategories === 'promote') { // Promove para o nível da categoria deletada
        await FinancialCategory.update(
          { parentId: category.parentId }, // Novo pai é o pai da categoria deletada
          { where: { parentId: categoryId }, transaction: t }
        );
        logger.info(`${subcategories.length} subcategorias de "${category.name}" foram promovidas para o nível do pai (ID: ${category.parentId || 'raiz'}).`);
      } else if (actionForSubcategories === 'delete') {
        for (const sub of subcategories) {
          // Chamada recursiva, passando a mesma transação e as mesmas opções para consistência
          await deleteFinancialCategory(sub.id, { ...options, transaction: t });
        }
        logger.warn(`${subcategories.length} subcategorias de "${category.name}" foram DELETADAS recursivamente.`);
      }
      // Opção 'reassign_children_to_grandparent' é a mesma que 'promote' neste contexto.
    }

    // 3. Deletar a categoria em si
    await category.destroy({ transaction: t });

    if (!options.transaction) await t.commit();
    logger.info(`Categoria Financeira ID ${categoryId} ("${category.name}") e seus dependentes (conforme opções) foram deletados.`);
    return true;
  } catch (error) {
    if (!options.transaction) await t.rollback();
    logger.error(`Erro ao deletar categoria financeira ID ${categoryId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}


/**
 * Busca uma categoria financeira pelo nome e opcionalmente pelo tipo.
 * @param {string} name - Nome da categoria.
 * @param {string|null} type - 'Entrada', 'Saída', ou null para não filtrar por tipo.
 * @param {number|null} financialAccountId - Opcional, para futuras buscas com escopo por conta.
 * @returns {Promise<object|null>} A categoria encontrada ou null.
 */
async function findFinancialCategoryByNameAndType(name, type = null, financialAccountId = null) {
  if (!name || typeof name !== 'string' || name.trim() === '') return null;
  try {
    const whereConditions = {
      // name: { [Op.iLike]: name }, // Busca exata case-insensitive
      isActive: true
    };
    // Para busca exata, podemos usar LOWER diretamente no DB se suportado, ou buscar e filtrar no JS.
    // Sequelize iLike funciona bem para PostgreSQL. Para outros, pode ser necessário Op.eq com name.toLowerCase() se o DB for case sensitive por padrão.

    if (type) {
      whereConditions.type = { [Op.or]: [type, 'Ambos'] };
    }
    // financialAccountId não está no modelo FinancialCategory, então não pode ser usado aqui.

    const categories = await FinancialCategory.findAll({ where: whereConditions });
    // Filtro case-insensitive no nome após a busca, se iLike não for suficiente ou para garantir
    const foundCategory = categories.find(cat => cat.name.toLowerCase() === name.toLowerCase());

    if (foundCategory) {
      logger.info(`[SYSTEM SERVICE] Categoria encontrada: "${foundCategory.name}" (ID: ${foundCategory.id}) para nome "${name}" e tipo "${type || 'qualquer'}".`);
      return foundCategory.toJSON();
    }
    logger.warn(`[SYSTEM SERVICE] Categoria não encontrada por nome exato "${name}" e tipo "${type || 'qualquer'}".`);
    return null;
  } catch (error) {
    logger.error(`Erro ao buscar categoria por nome e tipo: ${error.message}`, { error, name, type });
    return null;
  }
}

// Função genérica para buscar por nome (usada como fallback ou se tipo não importa)
async function findFinancialCategoryByName(name, financialAccountId = null) {
    // financialAccountId não é usado aqui, pois FinancialCategory não está ligada diretamente a FinancialAccount
    return findFinancialCategoryByNameAndType(name, null, null); // Passa null para type e financialAccountId
}


// --- Gerenciamento de Frases Motivacionais ---
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
    // Filtrar campos permitidos para atualização
    const allowedFields = ['text', 'isActive'];
    const filteredData = {};
    for (const key of allowedFields) {
        if (updateData.hasOwnProperty(key)) {
            filteredData[key] = updateData[key];
        }
    }
    if (Object.keys(filteredData).length === 0) {
        return phrase.toJSON(); // Nada a atualizar
    }
    await phrase.update(filteredData);
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
  deleteFinancialCategory,
  findFinancialCategoryByNameAndType, // EXPORTADA
  findFinancialCategoryByName,        // EXPORTADA
  createMotivationalPhrase,
  getAllMotivationalPhrases,
  updateMotivationalPhrase,
  deleteMotivationalPhrase,
};
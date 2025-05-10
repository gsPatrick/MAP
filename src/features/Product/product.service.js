// src/features/Product/product.service.js
const { Product, FinancialAccount, StockMovement, sequelize } = require('../../database'); // ProductCategory se for usar
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Valida se a FinancialAccount existe e está ativa, e se é do tipo PJ ou MEI para produtos.
 * @param {number} financialAccountId
 * @param {object} transaction - Transação Sequelize opcional.
 */
async function validateProductOwningAccount(financialAccountId, transaction = null) {
  const account = await FinancialAccount.findByPk(financialAccountId, { transaction });
  if (!account) {
    const error = new Error(`Conta Financeira com ID ${financialAccountId} não encontrada.`);
    error.statusCode = 404; error.status = 'fail'; throw error;
  }
  if (!account.isActive) {
    const error = new Error(`A Conta Financeira ID ${financialAccountId} ("${account.accountName}") está inativa.`);
    error.statusCode = 403; error.status = 'fail'; throw error;
  }
  // Produtos geralmente são para contas empresariais
  if (!['PJ', 'MEI'].includes(account.accountType)) {
    const error = new Error(`Produtos só podem ser associados a Contas Financeiras do tipo PJ ou MEI. Conta ID ${financialAccountId} é ${account.accountType}.`);
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  return account;
}

/**
 * Cria um novo produto para uma FinancialAccount.
 * @param {number} financialAccountId - ID da conta financeira (PJ/MEI).
 * @param {object} productData - Dados do produto.
 * @returns {Promise<object>} O produto criado.
 */
async function createProduct(financialAccountId, productData) {
  const t = await sequelize.transaction();
  try {
    await validateProductOwningAccount(financialAccountId, t);

    if (!productData.name || productData.salePrice === undefined || productData.salePrice === null) {
      const error = new Error('Nome e Preço de Venda são obrigatórios para criar um produto.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    // Validação de unicidade de nome/código DENTRO da financialAccount
    if (productData.name) {
      const existingByName = await Product.findOne({ where: { name: productData.name, financialAccountId }, transaction:t });
      if (existingByName) {
        const error = new Error(`Já existe um produto com o nome "${productData.name}" nesta conta financeira.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
    }
    if (productData.code) {
      const existingByCode = await Product.findOne({ where: { code: productData.code, financialAccountId }, transaction:t });
      if (existingByCode) {
        const error = new Error(`Já existe um produto com o código "${productData.code}" nesta conta financeira.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
    }
    // if (productData.productCategoryId && !(await ProductCategory.findByPk(productData.productCategoryId, {transaction:t}))) { /* ... erro ... */ }

    productData.quantity = productData.quantity === undefined ? 0 : parseInt(productData.quantity, 10);
    if (isNaN(productData.quantity) || productData.quantity < 0) productData.quantity = 0;


    const newProduct = await Product.create({ ...productData, financialAccountId }, { transaction: t });
    await t.commit();
    logger.info(`Produto "${newProduct.name}" (ID: ${newProduct.id}) criado para FinancialAccount ID ${financialAccountId}.`);
    return newProduct.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar produto para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error, productData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista todos os produtos de uma FinancialAccount com filtros e paginação.
 * @param {number} financialAccountId - ID da conta financeira.
 * @param {object} queryParams - Parâmetros.
 * @returns {Promise<object>}
 */
async function getAllProducts(financialAccountId, queryParams = {}) {
  try {
    await validateProductOwningAccount(financialAccountId);
    const { page = 1, limit = 10, search, productCategoryId, lowStock, isActive, sortBy = 'name', sortOrder = 'ASC' } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const whereConditions = { financialAccountId }; // Filtro principal
    // if (productCategoryId) whereConditions.productCategoryId = productCategoryId;
    if (isActive !== undefined) {
        whereConditions.isActive = (isActive === 'true' || isActive === true);
    }

    if (search) {
      whereConditions[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { code: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (lowStock === 'true' || lowStock === true) {
      const { col } = require('sequelize');
      whereConditions[Op.and] = [
        sequelize.where(col('quantity'), Op.lte, col('minimumStock')),
        { minimumStock: { [Op.gt]: 0 } }
      ];
    }
    
    const includeOptions = [];
    // if (ProductCategory) { includeOptions.push({ model: ProductCategory, as: 'category', attributes: ['id', 'name'] }); }

    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];

    const { count, rows } = await Product.findAndCountAll({
      where: whereConditions,
      include: includeOptions,
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
      distinct: true,
    });

    logger.info(`Listados ${rows.length} produtos para FinancialAccount ID ${financialAccountId} (Total: ${count}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      products: rows.map(p => p.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar produtos para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Busca um produto pelo ID, verificando se pertence à FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} productId
 * @returns {Promise<object|null>}
 */
async function getProductById(financialAccountId, productId) {
  try {
    await validateProductOwningAccount(financialAccountId);
    const product = await Product.findOne({
      where: { id: productId, financialAccountId },
      // include: ProductCategory ? [{ model: ProductCategory, as: 'category' }] : []
    });

    if (!product) {
      logger.warn(`Produto ID ${productId} não encontrado ou não pertence à FinancialAccount ID ${financialAccountId}.`);
      return null;
    }
    return product.toJSON();
  } catch (error) {
    logger.error(`Erro ao buscar produto ID ${productId} para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Atualiza um produto de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} productId
 * @param {object} updateData
 * @returns {Promise<object|null>}
 */
async function updateProduct(financialAccountId, productId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateProductOwningAccount(financialAccountId, t);
    const product = await Product.findOne({
      where: { id: productId, financialAccountId },
      transaction: t
    });
    if (!product) {
      await t.rollback();
      logger.warn(`Produto ID ${productId} não encontrado para atualização na FinancialAccount ID ${financialAccountId}.`);
      return null;
    }

    // Validações de unicidade se campos únicos forem alterados
    if (updateData.name && updateData.name !== product.name) {
      const existingByName = await Product.findOne({ where: { name: updateData.name, financialAccountId, id: {[Op.ne]: productId} }, transaction: t });
      if (existingByName) { /* ... erro 409 ... */ }
    }
    if (updateData.code && updateData.code !== product.code) {
      const existingByCode = await Product.findOne({ where: { code: updateData.code, financialAccountId, id: {[Op.ne]: productId} }, transaction: t });
      if (existingByCode) { /* ... erro 409 ... */ }
    }
    // if (updateData.productCategoryId && ...) { /* ... validação categoria ... */ }

    // ATENÇÃO com `updateData.quantity` - deve ser tratado por movimentações de estoque.
    // Se for permitido ajuste manual aqui, deve ser um caso excepcional.
    if (updateData.hasOwnProperty('quantity') && parseInt(updateData.quantity, 10) !== product.quantity) {
        const oldQuantity = product.quantity;
        const newQuantity = parseInt(updateData.quantity, 10);
        if(isNaN(newQuantity) || newQuantity < 0) {
            const error = new Error('Quantidade para ajuste manual inválida.');
            error.statusCode = 400; error.status = 'fail'; throw error;
        }
        logger.warn(`Ajuste manual de estoque para Produto ID ${productId} de ${oldQuantity} para ${newQuantity}. Criando movimentação de AJUSTE.`);
        
        // Criar uma movimentação de estoque do tipo 'Ajuste'
        const adjustmentQuantity = newQuantity - oldQuantity;
        await StockMovement.create({
            productId,
            type: adjustmentQuantity > 0 ? 'Entrada' : 'Saída',
            quantity: Math.abs(adjustmentQuantity),
            reason: `Ajuste manual de estoque (via API updateProduct)`,
            movementDate: new Date(),
        }, { transaction: t });
        // A quantidade no produto será atualizada aqui
        updateData.quantity = newQuantity; // Garante que o update abaixo pegue a nova quantidade
    }

    // Remover financialAccountId de updateData para não permitir mover entre contas por este método
    delete updateData.financialAccountId;

    await product.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Produto ID ${productId} ("${product.name}") atualizado para FinancialAccount ID ${financialAccountId}.`);
    return product.reload({
        // include: ProductCategory ? [{ model: ProductCategory, as: 'category' }] : []
    }).then(p => p.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar produto ID ${productId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Exclui um produto de uma FinancialAccount.
 * @param {number} financialAccountId
 * @param {number} productId
 * @returns {Promise<boolean>}
 */
async function deleteProduct(financialAccountId, productId) {
  const t = await sequelize.transaction();
  try {
    await validateProductOwningAccount(financialAccountId, t);
    const product = await Product.findOne({
      where: { id: productId, financialAccountId },
      transaction: t
    });
    if (!product) {
      await t.rollback();
      logger.warn(`Produto ID ${productId} não encontrado para exclusão na FinancialAccount ID ${financialAccountId}.`);
      return false;
    }

    const movementsCount = await StockMovement.count({ where: { productId: productId }, transaction: t });
    if (movementsCount > 0) {
      // Opção: marcar como inativo em vez de deletar, ou permitir deletar e as movimentações ficariam órfãs (se FK permitir)
      // A FK em StockMovement para Product DEVE ter onDelete: 'RESTRICT' ou 'SET NULL'.
      // Se for RESTRICT, o DB impedirá.
      const error = new Error(`Não é possível excluir o produto "${product.name}" (ID ${productId}) pois existem ${movementsCount} movimentações de estoque associadas.`);
      error.statusCode = 409; error.status = 'fail'; throw error;
    }

    await product.destroy({ transaction: t });
    await t.commit();
    logger.info(`Produto ID ${productId} ("${product.name}") excluído da FinancialAccount ID ${financialAccountId}.`);
    return true;
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao excluir produto ID ${productId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
};
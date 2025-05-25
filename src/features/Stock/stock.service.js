// src/features/Stock/stock.service.js
const { Product, StockMovement, FinancialAccount, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

// ... (validateProductAndOwningAccount e recordStockMovement permanecem como na última versão) ...
async function validateProductAndOwningAccount(productId, transaction = null) {
  const product = await Product.findByPk(productId, {
    include: [{ model: FinancialAccount, as: 'financialAccount' }],
    transaction
  });

  if (!product) {
    const error = new Error(`Produto com ID ${productId} não encontrado.`);
    error.statusCode = 404; error.status = 'fail'; throw error;
  }
  if (!product.financialAccount) { 
    const error = new Error(`Produto ID ${productId} não está associado a nenhuma Conta Financeira.`);
    error.statusCode = 500; error.status = 'error'; throw error;
  }
  if (!product.financialAccount.isActive) {
    const error = new Error(`A Conta Financeira ID ${product.financialAccountId} ("${product.financialAccount.accountName}") à qual o produto pertence está inativa.`);
    error.statusCode = 403; error.status = 'fail'; throw error;
  }
  if (!['PJ', 'MEI'].includes(product.financialAccount.accountType)) {
    const error = new Error(`Movimentações de estoque só são permitidas para produtos de Contas Financeiras PJ ou MEI. Produto ID ${productId} pertence a uma conta ${product.financialAccount.accountType}.`);
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  if (!product.isActive) {
    const error = new Error(`O Produto ID ${productId} ("${product.name}") está inativo e não pode ter seu estoque movimentado.`);
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  return product;
}

async function recordStockMovement(productId, movementData) {
  const { type, quantity, reason, movementDate, relatedTransactionId } = movementData;

  if (!type || quantity === undefined || (type !== 'Ajuste' && parseFloat(quantity) <= 0) || (type === 'Ajuste' && parseFloat(quantity) === 0) ) {
    const error = new Error('Tipo e Quantidade (positiva para Entrada/Saída, diferente de zero para Ajuste) são obrigatórios.');
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  if (!['Entrada', 'Saída', 'Ajuste'].includes(type)) {
    const error = new Error("Tipo de movimentação inválido. Use 'Entrada', 'Saída' ou 'Ajuste'.");
    error.statusCode = 400; error.status = 'fail'; throw error;
  }

  const t = await sequelize.transaction();
  try {
    const product = await Product.findByPk(productId, { transaction: t, lock: t.LOCK.UPDATE });
    
    if (!product) {
      await t.rollback();
      const error = new Error(`Produto com ID ${productId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    const financialAccount = await FinancialAccount.findByPk(product.financialAccountId, { transaction: t });
    if (!financialAccount || !financialAccount.isActive) {
        await t.rollback();
        const error = new Error(`A conta financeira associada ao produto ID ${productId} está inativa ou não foi encontrada.`);
        error.statusCode = 403; error.status = 'fail'; throw error;
    }
    if (!['PJ', 'MEI'].includes(financialAccount.accountType)) {
        await t.rollback();
        const error = new Error(`Movimentações de estoque não permitidas para tipo de conta ${financialAccount.accountType}.`);
        error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!product.isActive) {
      await t.rollback();
      const error = new Error(`O Produto ID ${productId} ("${product.name}") está inativo.`);
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    let newQuantity = parseFloat(product.quantity);
    let effectiveTypeForLog = type;
    let movementQuantityForLog = parseFloat(quantity);

    if (type === 'Entrada') {
      if (movementQuantityForLog <=0) { await t.rollback(); throw new Error("Quantidade de entrada deve ser positiva."); }
      newQuantity += movementQuantityForLog;
    } else if (type === 'Saída') {
      if (movementQuantityForLog <=0) { await t.rollback(); throw new Error("Quantidade de saída deve ser positiva."); }
      if (newQuantity < movementQuantityForLog) {
        await t.rollback();
        const error = new Error(`Estoque insuficiente para ${product.name} (ID: ${productId}). Disponível: ${product.quantity}, Saída: ${movementQuantityForLog}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
      newQuantity -= movementQuantityForLog;
    } else if (type === 'Ajuste') {
      if (movementQuantityForLog > 0) {
          effectiveTypeForLog = 'Entrada';
      } else if (movementQuantityForLog < 0) {
          effectiveTypeForLog = 'Saída';
          if (newQuantity < Math.abs(movementQuantityForLog)) {
            await t.rollback();
            const error = new Error(`Ajuste de saída excede estoque para ${product.name}. Disponível: ${product.quantity}, Ajuste: ${movementQuantityForLog}.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
          }
      } else {
          await t.rollback();
          throw new Error("Quantidade para ajuste não pode ser zero.");
      }
      newQuantity += movementQuantityForLog;
    }

    const stockMovement = await StockMovement.create({
      productId,
      type: effectiveTypeForLog,
      quantity: Math.abs(movementQuantityForLog),
      reason: reason || (type === 'Ajuste' ? `Ajuste (${movementQuantityForLog > 0 ? '+' : ''}${movementQuantityForLog})` : (effectiveTypeForLog === 'Entrada' ? 'Entrada manual' : 'Saída manual')),
      movementDate: movementDate || new Date(),
      relatedTransactionId,
    }, { transaction: t });

    await product.update({ quantity: newQuantity }, { transaction: t });

    await t.commit();
    logger.info(`Movimentação (${type} original: ${quantity}) para Produto ID ${productId}. Tipo Log: ${effectiveTypeForLog}, Qtd Log: ${Math.abs(movementQuantityForLog)}. Novo saldo: ${newQuantity}.`);

    if (product.minimumStock !== null && product.minimumStock > 0 && newQuantity <= product.minimumStock && newQuantity < parseFloat(product.quantity)) {
        logger.warn(`ALERTA DE ESTOQUE MÍNIMO: Produto ${product.name} (ID: ${productId}) atingiu ${newQuantity} un. (Mín: ${product.minimumStock}).`);
    }
    return stockMovement.toJSON();
  } catch (error) {
    if (t && !t.finished && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
    logger.error(`Erro ao registrar movimentação de estoque para Produto ID ${productId}: ${error.message}`, { error, movementData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getStockMovements(queryParams = {}) {
  try {
    const { page = 1, limit = 10, productId, financialAccountId, type, dateStart, dateEnd, sortBy = 'movementDate', sortOrder = 'DESC' } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const whereMovement = {};
    const productIncludeOptions = {
        model: Product,
        as: 'product',
        attributes: ['id', 'name', 'code', 'financialAccountId'],
        required: false, 
    };

    if (productId) whereMovement.productId = parseInt(productId, 10);
    if (type) whereMovement.type = type;
    if (dateStart) whereMovement.movementDate = { ...whereMovement.movementDate, [Op.gte]: dateStart };
    if (dateEnd) {
        const endOfDay = new Date(dateEnd);
        endOfDay.setUTCHours(23, 59, 59, 999);
        whereMovement.movementDate = { ...whereMovement.movementDate, [Op.lte]: endOfDay };
    }

    if (financialAccountId) {
        const account = await FinancialAccount.findByPk(parseInt(financialAccountId, 10));
        if (!account) {
            const error = new Error(`Conta Financeira ID ${financialAccountId} não encontrada para filtrar movimentações de estoque.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        productIncludeOptions.where = { financialAccountId: parseInt(financialAccountId, 10) };
        productIncludeOptions.required = true; 
    }
    
    const validSortFields = ['movementDate', 'quantity', 'type', 'createdAt', 'reason'];
    const validSortOrders = ['ASC', 'DESC'];
    let finalSortBy = sortBy;

    if (!validSortFields.includes(sortBy)) {
        logger.warn(`[StockService] sortBy inválido '${sortBy}', usando 'movementDate' como padrão.`);
        finalSortBy = 'movementDate';
    }
    const finalSortOrder = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
    
    const order = [[finalSortBy, finalSortOrder]];

    const { count, rows } = await StockMovement.findAndCountAll({
      where: whereMovement,
      include: [productIncludeOptions],
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
      // distinct: true, // <<< REMOVIDO/COMENTADO
      // subQuery: true, // <<< REMOVIDO/COMENTADO por enquanto
    });

    logger.info(`Listadas ${rows.length} movimentações de estoque de um total de ${count}. Filtros: FA ID: ${financialAccountId || 'N/A'}, Prod ID: ${productId || 'N/A'}`);
    return {
      totalItems: count, // Este count pode ser o total de linhas retornadas ANTES do limit/offset se não usar subQuery.
                         // Se precisar do count total real desconsiderando paginação, pode ser necessário uma query de count separada.
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      movements: rows.map(m => m.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar movimentações de estoque: ${error.message}`, { error, queryParams });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function getProductStockBalance(productId) {
  try {
    const product = await validateProductAndOwningAccount(productId);
    return {
        id: product.id,
        name: product.name,
        code: product.code,
        quantity: product.quantity,
        unit: product.unit,
        minimumStock: product.minimumStock,
        financialAccountId: product.financialAccountId,
        financialAccountName: product.financialAccount.accountName,
    };
  } catch (error) {
    logger.error(`Erro ao consultar saldo do produto ID ${productId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  recordStockMovement,
  getStockMovements,
  getProductStockBalance,
};
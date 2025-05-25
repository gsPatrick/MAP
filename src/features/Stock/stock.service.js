// src/features/Stock/stock.service.js
const { Product, StockMovement, FinancialAccount, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

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

  if (!type || quantity === undefined || (type !== 'Ajuste' && quantity <= 0) || (type === 'Ajuste' && quantity === 0) ) {
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
      await t.rollback(); // Rollback antes de lançar
      const error = new Error(`Produto com ID ${productId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    const financialAccount = await FinancialAccount.findByPk(product.financialAccountId, { transaction: t });
    if (!financialAccount) {
      await t.rollback();
      const error = new Error(`Conta financeira associada ao produto ID ${productId} não encontrada.`);
      error.statusCode = 500; error.status = 'error'; throw error;
    }
    if (!financialAccount.isActive) {
      await t.rollback();
      const error = new Error(`A conta financeira "${financialAccount.accountName}" está inativa.`);
      error.statusCode = 403; error.status = 'fail'; throw error;
    }
     if (!['PJ', 'MEI'].includes(financialAccount.accountType)) {
      await t.rollback();
      const error = new Error(`Produtos só podem ser associados a Contas Financeiras PJ ou MEI. Produto ID ${productId} pertence a uma conta ${financialAccount.accountType}.`);
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!product.isActive) {
      await t.rollback();
      const error = new Error(`O Produto ID ${productId} ("${product.name}") está inativo.`);
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    let newQuantity = product.quantity;
    let effectiveTypeForLog = type;
    let movementQuantityForLog = parseFloat(quantity); // Quantidade que veio do request

    if (type === 'Entrada') {
      if (movementQuantityForLog <=0) { await t.rollback(); throw new Error("Quantidade de entrada deve ser positiva."); }
      newQuantity += movementQuantityForLog;
    } else if (type === 'Saída') {
      if (movementQuantityForLog <=0) { await t.rollback(); throw new Error("Quantidade de saída deve ser positiva."); }
      if (product.quantity < movementQuantityForLog) {
        await t.rollback();
        const error = new Error(`Estoque insuficiente para ${product.name} (ID: ${productId}). Disponível: ${product.quantity}, Saída: ${movementQuantityForLog}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
      newQuantity -= movementQuantityForLog;
    } else if (type === 'Ajuste') {
      // movementQuantityForLog pode ser positivo (aumentar) ou negativo (diminuir)
      if (movementQuantityForLog > 0) {
          effectiveTypeForLog = 'Entrada'; // Ajuste de entrada
      } else if (movementQuantityForLog < 0) {
          effectiveTypeForLog = 'Saída'; // Ajuste de saída
          if (product.quantity < Math.abs(movementQuantityForLog)) {
            await t.rollback();
            const error = new Error(`Ajuste de saída excede estoque para ${product.name}. Disponível: ${product.quantity}, Ajuste: ${movementQuantityForLog}.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
          }
      } else { // movementQuantityForLog é 0
          await t.rollback();
          throw new Error("Quantidade para ajuste não pode ser zero.");
      }
      newQuantity += movementQuantityForLog; // Soma direto, pois movementQuantityForLog já tem o sinal
    }

    const stockMovement = await StockMovement.create({
      productId,
      type: effectiveTypeForLog, // 'Entrada' ou 'Saída'
      quantity: Math.abs(movementQuantityForLog), // Sempre positivo no log
      reason: reason || (type === 'Ajuste' ? `Ajuste (${movementQuantityForLog > 0 ? '+' : ''}${movementQuantityForLog})` : (effectiveTypeForLog === 'Entrada' ? 'Entrada manual' : 'Saída manual')),
      movementDate: movementDate || new Date(),
      relatedTransactionId,
    }, { transaction: t });

    await product.update({ quantity: newQuantity }, { transaction: t });

    await t.commit();
    logger.info(`Movimentação de estoque (${type} original: ${quantity}) registrada para Produto ID ${productId}. Tipo Log: ${effectiveTypeForLog}, Qtd Log: ${Math.abs(movementQuantityForLog)}. Novo saldo: ${newQuantity}.`);

    if (product.minimumStock && newQuantity <= product.minimumStock && newQuantity < product.quantity) {
        logger.warn(`ALERTA DE ESTOQUE MÍNIMO: Produto ${product.name} (ID: ${productId}) atingiu ${newQuantity} un. (Mín: ${product.minimumStock}).`);
    }
    return stockMovement.toJSON();
  } catch (error) {
    if (t && !t.finished) await t.rollback(); // Garante rollback se a transação não foi finalizada
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
        required: false, // Inicia como false (LEFT JOIN)
    };

    if (productId) whereMovement.productId = parseInt(productId, 10);
    if (type) whereMovement.type = type;
    if (dateStart) whereMovement.movementDate = { ...whereMovement.movementDate, [Op.gte]: dateStart };
    if (dateEnd) {
        // Para incluir o dia todo em dateEnd
        const endOfDay = new Date(dateEnd);
        endOfDay.setUTCHours(23, 59, 59, 999);
        whereMovement.movementDate = { ...whereMovement.movementDate, [Op.lte]: endOfDay };
    }


    if (financialAccountId) {
        const account = await FinancialAccount.findByPk(parseInt(financialAccountId, 10));
        if (!account) {
            const error = new Error(`Conta Financeira ID ${financialAccountId} não encontrada.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }
        // Se financialAccountId é fornecido, filtramos as movimentações onde o produto associado
        // pertence a esta conta. Isso requer um INNER JOIN.
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
      distinct: true, // Importante para contagem correta com includes
      // subQuery: true, // Descomente e teste se a contagem ou paginação estiverem incorretas, especialmente com PostgreSQL
    });

    logger.info(`Listadas ${rows.length} movimentações de estoque de um total de ${count}. Filtros: FA ID: ${financialAccountId || 'N/A'}, Prod ID: ${productId || 'N/A'}`);
    return {
      totalItems: count,
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
    const product = await validateProductAndOwningAccount(productId); // Já valida e inclui financialAccount
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
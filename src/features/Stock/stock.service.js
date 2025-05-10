// src/features/Stock/stock.service.js
const { Product, StockMovement, FinancialAccount, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Valida se a FinancialAccount do Produto existe, está ativa e é do tipo PJ ou MEI.
 * @param {number} productId - ID do Produto para encontrar sua FinancialAccount.
 * @param {object} transaction - Transação Sequelize opcional.
 */
async function validateProductAndOwningAccount(productId, transaction = null) {
  const product = await Product.findByPk(productId, {
    include: [{ model: FinancialAccount, as: 'financialAccount' }],
    transaction
  });

  if (!product) {
    const error = new Error(`Produto com ID ${productId} não encontrado.`);
    error.statusCode = 404; error.status = 'fail'; throw error;
  }
  if (!product.financialAccount) { // Deveria sempre ter, mas é uma checagem de segurança
    const error = new Error(`Produto ID ${productId} não está associado a nenhuma Conta Financeira.`);
    error.statusCode = 500; error.status = 'error'; throw error; // Erro de integridade de dados
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
  return product; // Retorna o produto com sua financialAccount aninhada
}

/**
 * Registra uma movimentação de estoque e atualiza a quantidade do produto.
 * @param {number} productId - ID do Produto a ser movimentado.
 * @param {object} movementData - { type: 'Entrada'|'Saída', quantity, reason, movementDate, relatedTransactionId (opcional) }
 * @returns {Promise<object>} A movimentação de estoque registrada.
 */
async function recordStockMovement(productId, movementData) {
  const { type, quantity, reason, movementDate, relatedTransactionId } = movementData;

  if (!type || !quantity || quantity <= 0) {
    const error = new Error('Tipo e Quantidade (positiva) são obrigatórios para movimentação de estoque.');
    error.statusCode = 400; error.status = 'fail'; throw error;
  }
  if (!['Entrada', 'Saída', 'Ajuste'].includes(type)) { // Adicionado 'Ajuste'
    const error = new Error("Tipo de movimentação inválido. Use 'Entrada', 'Saída' ou 'Ajuste'.");
    error.statusCode = 400; error.status = 'fail'; throw error;
  }

  const t = await sequelize.transaction();
  try {
    // Valida o produto e sua conta financeira associada, e bloqueia a linha do produto
    const product = await Product.findByPk(productId, { transaction: t, lock: t.LOCK.UPDATE });
    
    if (!product) {
      const error = new Error(`Produto com ID ${productId} não encontrado.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }
    // Valida a conta financeira do produto (tipo PJ/MEI e ativa)
    const financialAccount = await FinancialAccount.findByPk(product.financialAccountId, { transaction: t });
    if (!financialAccount) {
      const error = new Error(`Conta financeira associada ao produto ID ${productId} não encontrada.`);
      error.statusCode = 500; error.status = 'error'; throw error; // Integridade de dados
    }
    if (!financialAccount.isActive) {
      const error = new Error(`A conta financeira "${financialAccount.accountName}" está inativa. Movimentações de estoque bloqueadas.`);
      error.statusCode = 403; error.status = 'fail'; throw error;
    }
     if (!['PJ', 'MEI'].includes(financialAccount.accountType)) {
      const error = new Error(`Produtos só podem ser associados a Contas Financeiras do tipo PJ ou MEI. Produto ID ${productId} pertence a uma conta ${financialAccount.accountType}.`);
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    if (!product.isActive) {
      const error = new Error(`O Produto ID ${productId} ("${product.name}") está inativo.`);
      error.statusCode = 400; error.status = 'fail'; throw error;
    }


    let newQuantity = product.quantity;
    let effectiveType = type; // Para o caso de 'Ajuste'

    if (type === 'Entrada') {
      newQuantity += quantity;
    } else if (type === 'Saída') {
      if (product.quantity < quantity) {
        const error = new Error(`Estoque insuficiente para ${product.name} (ID: ${productId}). Disponível: ${product.quantity}, Saída: ${quantity}.`);
        error.statusCode = 409; error.status = 'fail'; throw error;
      }
      newQuantity -= quantity;
    } else if (type === 'Ajuste') {
      // A 'quantity' em movementData para 'Ajuste' PODE ser negativa para ajuste de saída
      // ou positiva para ajuste de entrada.
      // O modelo StockMovement.quantity deve ser sempre positivo, então ajustamos aqui.
      if (quantity > 0) { // Ajuste de entrada
          newQuantity += Math.abs(quantity);
          effectiveType = 'Entrada'; // Registra como entrada
      } else { // Ajuste de saída (quantity é negativo)
          if (product.quantity < Math.abs(quantity)) {
            const error = new Error(`Ajuste de saída excede estoque para ${product.name}. Disponível: ${product.quantity}, Ajuste: ${quantity}.`);
            error.statusCode = 409; error.status = 'fail'; throw error;
          }
          newQuantity -= Math.abs(quantity);
          effectiveType = 'Saída'; // Registra como saída
      }
    }


    const stockMovement = await StockMovement.create({
      productId,
      type: effectiveType, // Usa o tipo efetivo (Entrada/Saída)
      quantity: Math.abs(quantity), // Garante que a quantidade no log seja sempre positiva
      reason: reason || (type === 'Ajuste' ? `Ajuste de estoque (${quantity > 0 ? '+' : ''}${quantity})` : (effectiveType === 'Entrada' ? 'Entrada manual' : 'Saída manual')),
      movementDate: movementDate || new Date(),
      relatedTransactionId, // Se a movimentação estiver ligada a uma venda/compra financeira
    }, { transaction: t });

    await product.update({ quantity: newQuantity }, { transaction: t });

    await t.commit();
    logger.info(`Movimentação de estoque (${type}) registrada para Produto ID ${productId}: Qtd ${quantity}. Novo saldo: ${newQuantity}.`);

    if (product.minimumStock && newQuantity <= product.minimumStock && newQuantity < product.quantity) { // Só alerta se diminuiu para baixo do mínimo
        logger.warn(`ALERTA DE ESTOQUE MÍNIMO: Produto ${product.name} (ID: ${productId}) atingiu ${newQuantity} un. (Mín: ${product.minimumStock}).`);
    }

    return stockMovement.toJSON();

  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao registrar movimentação de estoque para Produto ID ${productId}: ${error.message}`, { error, movementData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Lista as movimentações de estoque. Pode filtrar por financialAccountId (indiretamente via produto).
 * @param {object} queryParams - { page, limit, productId, financialAccountId, type, dateStart, dateEnd }.
 * @returns {Promise<object>}
 */
async function getStockMovements(queryParams = {}) {
  try {
    const { page = 1, limit = 10, productId, financialAccountId, type, dateStart, dateEnd, sortBy = 'movementDate', sortOrder = 'DESC' } = queryParams;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const whereMovement = {}; // Condições para StockMovement
    const whereProduct = {};  // Condições para Product (usado no include)

    if (productId) whereMovement.productId = productId;
    if (type) whereMovement.type = type;
    if (dateStart) whereMovement.movementDate = { ...whereMovement.movementDate, [Op.gte]: dateStart };
    if (dateEnd) whereMovement.movementDate = { ...whereMovement.movementDate, [Op.lte]: dateEnd };

    if (financialAccountId) {
        await FinancialAccount.findByPk(financialAccountId).then(acc => {
            if(!acc) {
                const error = new Error(`Conta Financeira ID ${financialAccountId} não encontrada para filtrar movimentações.`);
                error.statusCode = 404; error.status = 'fail'; throw error;
            }
        });
        whereProduct.financialAccountId = financialAccountId;
    }
    
    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC']];

    const { count, rows } = await StockMovement.findAndCountAll({
      where: whereMovement,
      include: [{
        model: Product,
        as: 'product',
        attributes: ['id', 'name', 'code', 'financialAccountId'],
        where: Object.keys(whereProduct).length > 0 ? whereProduct : undefined, // Aplica filtro no include se houver
        required: Object.keys(whereProduct).length > 0 // Torna o include obrigatório se houver filtro em Product
      }],
      limit: parseInt(limit, 10),
      offset: offset,
      order: order,
      distinct: true, // Para contagem correta com include
    });

    logger.info(`Listadas ${rows.length} movimentações de estoque de um total de ${count} (Filtro Conta: ${financialAccountId || 'N/A'}).`);
    return {
      totalItems: count,
      totalPages: Math.ceil(count / parseInt(limit, 10)),
      currentPage: parseInt(page, 10),
      movements: rows.map(m => m.toJSON()),
    };
  } catch (error) {
    logger.error(`Erro ao listar movimentações de estoque: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

/**
 * Obtém o saldo atual de um produto específico.
 * @param {number} productId - ID do produto.
 * @returns {Promise<object|null>} Objeto com dados do produto e saldo.
 */
async function getProductStockBalance(productId) {
  try {
    // A validação validateProductAndOwningAccount já busca o produto
    const product = await validateProductAndOwningAccount(productId);
    // A quantidade em product.quantity é o saldo atualizado.

    logger.info(`Consulta de saldo para Produto ID ${productId} ("${product.name}") da Conta ID ${product.financialAccountId}: ${product.quantity} ${product.unit || ''}`);
    // Retornar apenas os dados relevantes do produto para saldo
    return {
        id: product.id,
        name: product.name,
        code: product.code,
        quantity: product.quantity,
        unit: product.unit,
        minimumStock: product.minimumStock,
        financialAccountId: product.financialAccountId,
        financialAccountName: product.financialAccount.accountName // Do include feito em validate...
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
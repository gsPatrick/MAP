// src/features/Kanban/kanbanColumn.service.js
const { KanbanColumn, FinancialAccount, KanbanTask, sequelize } = require('../../database');
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

async function validateOwningFinancialAccountForColumn(financialAccountId, transaction = null) {
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

async function getAllColumns(financialAccountId) {
  try {
    await validateOwningFinancialAccountForColumn(financialAccountId);
    const columns = await KanbanColumn.findAll({
      where: { financialAccountId },
      order: [['order', 'ASC']],
      include: [{
        model: KanbanTask,
        as: 'tasks',
        required: false, // Para retornar colunas mesmo que não tenham tarefas
        order: [['order', 'ASC']], // Ordena as tarefas dentro de cada coluna
      }]
    });
    // As tarefas já virão aninhadas e ordenadas devido ao include e order.
    return columns.map(col => col.toJSON());
  } catch (error) {
    logger.error(`Erro ao listar colunas Kanban para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function createColumn(financialAccountId, columnData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccountForColumn(financialAccountId, t);
    if (!columnData.title) {
      const error = new Error('Título é obrigatório para criar uma coluna Kanban.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }

    const maxOrderResult = await KanbanColumn.findOne({
        attributes: [[sequelize.fn('MAX', sequelize.col('order')), 'maxOrder']],
        where: { financialAccountId },
        raw: true,
        transaction: t
    });
    const nextOrder = (maxOrderResult && typeof maxOrderResult.maxOrder === 'number' ? maxOrderResult.maxOrder : -1) + 1;

    const newColumn = await KanbanColumn.create({
      ...columnData,
      financialAccountId,
      order: nextOrder, // Adiciona ao final
    }, { transaction: t });

    await t.commit();
    logger.info(`Coluna Kanban "${newColumn.title}" (ID: ${newColumn.id}) criada para FinancialAccount ID ${financialAccountId} com ordem ${newColumn.order}.`);
    return newColumn.toJSON();
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar coluna Kanban: ${error.message}`, { error, columnData });
    if (error.name === 'SequelizeValidationError') {
        const valError = new Error(error.errors.map(e => e.message).join(', '));
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateColumn(financialAccountId, columnId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccountForColumn(financialAccountId, t);
    const column = await KanbanColumn.findOne({ where: { id: columnId, financialAccountId }, transaction: t });
    if (!column) {
      await t.rollback();
      const error = new Error(`Coluna Kanban ID ${columnId} não encontrada ou não pertence à conta.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    delete updateData.financialAccountId; // Não permitir mover entre contas
    // Não permitir mudar a ordem diretamente aqui, usar updateColumnOrder

    await column.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Coluna Kanban ID ${columnId} ("${column.title}") atualizada.`);
    return column.reload().then(c => c.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar coluna Kanban ID ${columnId}: ${error.message}`, { error, updateData });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateColumnOrder(financialAccountId, columnOrderArray) {
  // columnOrderArray é [{ id: columnId1, order: 0 }, { id: columnId2, order: 1 }, ...]
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccountForColumn(financialAccountId, t);
    if (!Array.isArray(columnOrderArray) || columnOrderArray.some(item => item.id === undefined || item.order === undefined)) {
        const error = new Error('Formato inválido para reordenar colunas. Esperado array de {id, order}.');
        error.statusCode = 400; error.status = 'fail'; throw error;
    }

    for (const item of columnOrderArray) {
      await KanbanColumn.update(
        { order: item.order },
        { where: { id: item.id, financialAccountId }, transaction: t }
      );
    }
    await t.commit();
    logger.info(`Ordem das colunas Kanban para FinancialAccount ID ${financialAccountId} atualizada.`);
    // Retornar as colunas reordenadas
    return getAllColumns(financialAccountId);
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao reordenar colunas Kanban: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function deleteColumn(financialAccountId, columnId) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccountForColumn(financialAccountId, t);
    const column = await KanbanColumn.findOne({ where: { id: columnId, financialAccountId }, transaction: t });
    if (!column) {
      await t.rollback();
      const error = new Error(`Coluna Kanban ID ${columnId} não encontrada para exclusão.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    // Tasks associadas serão deletadas em cascata (onDelete: 'CASCADE' no modelo KanbanColumn)
    await column.destroy({ transaction: t });
    
    // Reordenar as colunas restantes
    const remainingColumns = await KanbanColumn.findAll({
        where: { financialAccountId, id: { [Op.ne]: columnId } },
        order: [['order', 'ASC']],
        transaction: t
    });

    for (let i = 0; i < remainingColumns.length; i++) {
        if (remainingColumns[i].order !== i) {
            await remainingColumns[i].update({ order: i }, { transaction: t });
        }
    }

    await t.commit();
    logger.info(`Coluna Kanban ID ${columnId} ("${column.title}") e suas tarefas foram excluídas. Colunas restantes reordenadas.`);
    return true;
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao excluir coluna Kanban ID ${columnId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

module.exports = {
  getAllColumns,
  createColumn,
  updateColumn,
  updateColumnOrder,
  deleteColumn,
};
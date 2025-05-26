// src/features/Kanban/kanban.service.js
const { KanbanTask, KanbanColumn, FinancialAccount, sequelize } = require('../../database'); // Adicionado KanbanColumn
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

async function validateOwningFinancialAccountForTask(financialAccountId, transaction = null) {
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

async function getAllTasks(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccountForTask(financialAccountId);
    // queryParams para tasks podem incluir kanbanColumnId, priority, etc.
    const { kanbanColumnId, priority, sortBy = 'order', sortOrder = 'ASC', page = 1, limit = 500 } = queryParams;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };
    if (kanbanColumnId) whereConditions.kanbanColumnId = kanbanColumnId;
    if (priority) whereConditions.priority = priority;
    
    const validSortOrders = ['ASC', 'DESC'];
    const order = [[sortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];
    if (sortBy === 'order') order.push(['createdAt', 'ASC']);


    const { count, rows: tasks } = await KanbanTask.findAndCountAll({
      where: whereConditions,
      order: order,
      limit: parseInt(limit, 10),
      offset: offset,
      include: [{model: KanbanColumn, as: 'column', attributes: ['id', 'title']}] // Inclui info da coluna
    });

    return {
        totalItems: count,
        totalPages: Math.ceil(count / parseInt(limit, 10)),
        currentPage: parseInt(page, 10),
        tasks: tasks.map(task => task.toJSON())
    };
  } catch (error) {
    logger.error(`Erro ao listar tarefas Kanban para FinancialAccount ID ${financialAccountId}: ${error.message}`, { error });
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function createTask(financialAccountId, taskData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccountForTask(financialAccountId, t);
    // Agora 'kanbanColumnId' é obrigatório em vez de 'status'
    if (!taskData.title || !taskData.kanbanColumnId) {
      const error = new Error('Título e ID da Coluna são obrigatórios para criar uma tarefa Kanban.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    // Verifica se a coluna pertence à financialAccount
    const column = await KanbanColumn.findOne({ 
        where: { id: taskData.kanbanColumnId, financialAccountId },
        transaction: t
    });
    if (!column) {
        const error = new Error(`Coluna Kanban ID ${taskData.kanbanColumnId} não encontrada ou não pertence à conta financeira ${financialAccountId}.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
    }

    if (taskData.order === undefined || taskData.order === null) {
        const maxOrderResult = await KanbanTask.findOne({
            attributes: [[sequelize.fn('MAX', sequelize.col('order')), 'maxOrder']],
            where: { financialAccountId, kanbanColumnId: taskData.kanbanColumnId },
            raw: true,
            transaction: t
        });
        taskData.order = (maxOrderResult && typeof maxOrderResult.maxOrder === 'number' ? maxOrderResult.maxOrder : -1) + 1;
    }

    const newTask = await KanbanTask.create({ ...taskData, financialAccountId }, { transaction: t });
    await t.commit();
    logger.info(`Tarefa Kanban "${newTask.title}" (ID: ${newTask.id}) criada na coluna ID ${newTask.kanbanColumnId} para FinancialAccount ID ${financialAccountId}. Ordem: ${newTask.order}`);
    return newTask.reload({include: [{model: KanbanColumn, as: 'column', attributes:['id', 'title']}]}).then(nt => nt.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao criar tarefa Kanban: ${error.message}`, { error, taskData });
    if (error.name === 'SequelizeValidationError') {
        const valError = new Error(error.errors.map(e => e.message).join(', '));
        valError.statusCode = 400; valError.status = 'fail'; throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateTask(financialAccountId, taskId, updateData) {
  const t = await sequelize.transaction();
  try {
    await validateOwningFinancialAccountForTask(financialAccountId, t);
    const task = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t });
    if (!task) {
      await t.rollback();
      const error = new Error(`Tarefa Kanban ID ${taskId} não encontrada ou não pertence à conta.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    delete updateData.financialAccountId;

    // Se kanbanColumnId (status) mudou E a ordem não foi fornecida, recalcula a ordem para o final da nova coluna
    if (updateData.kanbanColumnId && updateData.kanbanColumnId !== task.kanbanColumnId && (updateData.order === undefined || updateData.order === null)) {
        const column = await KanbanColumn.findOne({ 
            where: { id: updateData.kanbanColumnId, financialAccountId },
            transaction: t
        });
        if (!column) {
            const error = new Error(`Nova Coluna Kanban ID ${updateData.kanbanColumnId} não encontrada ou não pertence à conta ${financialAccountId}.`);
            error.statusCode = 404; error.status = 'fail'; throw error;
        }

        const maxOrderResult = await KanbanTask.findOne({
            attributes: [[sequelize.fn('MAX', sequelize.col('order')), 'maxOrder']],
            where: { financialAccountId, kanbanColumnId: updateData.kanbanColumnId, id: {[Op.ne]: taskId} },
            raw: true,
            transaction: t
        });
        updateData.order = (maxOrderResult && typeof maxOrderResult.maxOrder === 'number' ? maxOrderResult.maxOrder : -1) + 1;
        logger.info(`Tarefa ID ${taskId} movida para coluna ID ${updateData.kanbanColumnId}, nova ordem calculada: ${updateData.order}`);
    }

    await task.update(updateData, { transaction: t });
    await t.commit();
    logger.info(`Tarefa Kanban ID ${taskId} ("${task.title}") atualizada.`);
    return task.reload({include: [{model: KanbanColumn, as: 'column', attributes:['id', 'title']}]}).then(tUpdated => tUpdated.toJSON());
  } catch (error) {
    await t.rollback();
    logger.error(`Erro ao atualizar tarefa Kanban ID ${taskId}: ${error.message}`, { error, updateData });
    if (error.name === 'SequelizeValidationError') {
        const valError = new Error(error.errors.map(e => e.message).join(', '));
        valError.statusCode = 400; valError.status = 'fail'; throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateTaskOrderAndColumn(financialAccountId, taskId, newKanbanColumnId, newOrder) {
    const t = await sequelize.transaction();
    try {
      await validateOwningFinancialAccountForTask(financialAccountId, t);
      const taskToMove = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!taskToMove) {
        await t.rollback();
        const error = new Error(`Tarefa Kanban ID ${taskId} não encontrada ou não pertence à conta.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
      }
      
      // Verifica se a nova coluna de destino existe e pertence à mesma financialAccount
      const destinationColumn = await KanbanColumn.findOne({
          where: { id: newKanbanColumnId, financialAccountId },
          transaction: t
      });
      if(!destinationColumn) {
          await t.rollback();
          const error = new Error(`Coluna de destino ID ${newKanbanColumnId} não encontrada ou não pertence à conta financeira.`);
          error.statusCode = 400; error.status = 'fail'; throw error;
      }

      const oldColumnId = taskToMove.kanbanColumnId;
      const oldOrder = taskToMove.order;
  
      // Reordenar a coluna de origem se a tarefa mudou de coluna ou de ordem dentro da mesma coluna
      if (oldColumnId !== newKanbanColumnId || (oldColumnId === newKanbanColumnId && oldOrder !== newOrder)) {
        await KanbanTask.update(
          { order: sequelize.literal('"order" - 1') },
          {
            where: {
              financialAccountId,
              kanbanColumnId: oldColumnId,
              order: { [Op.gt]: oldOrder },
              id: { [Op.ne]: taskId }
            },
            transaction: t,
          }
        );
      }
  
      // Abrir espaço na coluna de destino
      await KanbanTask.update(
        { order: sequelize.literal('"order" + 1') },
        {
          where: {
            financialAccountId,
            kanbanColumnId: newKanbanColumnId,
            order: { [Op.gte]: newOrder },
            id: { [Op.ne]: taskId }
          },
          transaction: t,
        }
      );
  
      await taskToMove.update({ kanbanColumnId: newKanbanColumnId, order: newOrder }, { transaction: t });
  
      await t.commit();
      logger.info(`Ordem/Coluna da Tarefa Kanban ID ${taskId} atualizados. Nova Coluna: ${newKanbanColumnId}, Nova Ordem: ${newOrder}.`);
      return taskToMove.reload({include: [{model: KanbanColumn, as: 'column', attributes:['id', 'title']}]}).then(tUpdated => tUpdated.toJSON());
  
    } catch (error) {
      await t.rollback();
      logger.error(`Erro ao atualizar ordem/coluna da tarefa Kanban ID ${taskId}: ${error.message}`, { error, details: { financialAccountId, taskId, newKanbanColumnId, newOrder } });
      if (!error.statusCode) error.statusCode = 500;
      throw error;
    }
}
  
async function deleteTask(financialAccountId, taskId) {
    const t = await sequelize.transaction();
    try {
      await validateOwningFinancialAccountForTask(financialAccountId, t);
      const task = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t });
      if (!task) {
        await t.rollback();
        const error = new Error(`Tarefa Kanban ID ${taskId} não encontrada para exclusão.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
      }
      
      const columnIdOfDeletedTask = task.kanbanColumnId;
      const orderOfDeletedTask = task.order;

      await task.destroy({ transaction: t });

      await KanbanTask.update(
        { order: sequelize.literal('"order" - 1') },
        {
          where: {
            financialAccountId,
            kanbanColumnId: columnIdOfDeletedTask,
            order: { [Op.gt]: orderOfDeletedTask },
          },
          transaction: t,
        }
      );

      await t.commit();
      logger.info(`Tarefa Kanban ID ${taskId} ("${task.title}") excluída e coluna ID ${columnIdOfDeletedTask} reordenada.`);
      return true;
    } catch (error) {
      await t.rollback();
      logger.error(`Erro ao excluir tarefa Kanban ID ${taskId}: ${error.message}`, { error });
      if (!error.statusCode) error.statusCode = 500;
      throw error;
    }
}

module.exports = {
  getAllTasks,
  createTask,
  updateTask,
  updateTaskOrderAndColumn, // Renomeado para refletir a funcionalidade
  deleteTask,
};
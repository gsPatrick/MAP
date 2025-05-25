// src/features/Kanban/kanban.service.js
const { KanbanTask, FinancialAccount } = require('../../database'); // KanbanTask importado aqui
const logger = require('../../utils/logger');
const { Op } = require('sequelize');

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
  // Removida a restrição de accountType para permitir Kanban em PF, PJ, MEI
  // if (!['PJ', 'MEI'].includes(account.accountType)) {
  //   const error = new Error(`Kanban só pode ser usado com Contas Financeiras do tipo PJ ou MEI. Conta ID ${financialAccountId} é ${account.accountType}.`);
  //   error.statusCode = 400; error.status = 'fail'; throw error;
  // }
  return account;
}

async function getAllTasks(financialAccountId, queryParams = {}) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const { status, priority, sortBy = 'order', sortOrder = 'ASC', page = 1, limit = 500 } = queryParams; // Limite alto para pegar todas por padrão no Kanban

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const whereConditions = { financialAccountId };
    if (status) whereConditions.status = status;
    if (priority) whereConditions.priority = priority;
    
    const validSortOrders = ['ASC', 'DESC'];
    let effectiveSortBy = sortBy;
    // Mapear 'order' para order no banco, 'title' para title, etc.
    if (sortBy === 'order') effectiveSortBy = 'order';
    else if (sortBy === 'title') effectiveSortBy = 'title';
    else if (sortBy === 'dueDate') effectiveSortBy = 'dueDate';
    // Adicione mais mapeamentos se necessário

    const order = [[effectiveSortBy, validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'ASC']];

    // Se sortBy for 'order', também adicionar um segundo critério de ordenação para desempate
    if (effectiveSortBy === 'order') {
        order.push(['createdAt', 'ASC']); // Ou 'updatedAt' ou 'id'
    }


    const { count, rows: tasks } = await KanbanTask.findAndCountAll({ // Alterado para findAndCountAll
      where: whereConditions,
      order: order,
      limit: parseInt(limit, 10),
      offset: offset,
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
  try {
    await validateOwningFinancialAccount(financialAccountId);
    if (!taskData.title || !taskData.status) {
      const error = new Error('Título e Status são obrigatórios para criar uma tarefa Kanban.');
      error.statusCode = 400; error.status = 'fail'; throw error;
    }
    
    if (taskData.order === undefined || taskData.order === null) {
        const maxOrderResult = await KanbanTask.findOne({
            attributes: [[require('sequelize').fn('MAX', require('sequelize').col('order')), 'maxOrder']],
            where: { financialAccountId, status: taskData.status },
            raw: true,
        });
        taskData.order = (maxOrderResult && typeof maxOrderResult.maxOrder === 'number' ? maxOrderResult.maxOrder : -1) + 1;
    }


    const newTask = await KanbanTask.create({ ...taskData, financialAccountId });
    logger.info(`Tarefa Kanban "${newTask.title}" (ID: ${newTask.id}) criada para FinancialAccount ID ${financialAccountId}. Ordem: ${newTask.order}`);
    return newTask.toJSON();
  } catch (error) {
    logger.error(`Erro ao criar tarefa Kanban: ${error.message}`, { error, taskData });
    if (error.name === 'SequelizeValidationError') {
        const valError = new Error(error.errors.map(e => e.message).join(', '));
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateTask(financialAccountId, taskId, updateData) {
  try {
    await validateOwningFinancialAccount(financialAccountId);
    const task = await KanbanTask.findOne({ where: { id: taskId, financialAccountId } });
    if (!task) {
      const error = new Error(`Tarefa Kanban ID ${taskId} não encontrada ou não pertence à conta.`);
      error.statusCode = 404; error.status = 'fail'; throw error;
    }

    delete updateData.financialAccountId; // Não permitir mover entre contas por este método

    // Se o status mudou e a ordem não foi fornecida, recalcula a ordem para o final da nova coluna
    if (updateData.status && updateData.status !== task.status && (updateData.order === undefined || updateData.order === null)) {
        const maxOrderResult = await KanbanTask.findOne({
            attributes: [[require('sequelize').fn('MAX', require('sequelize').col('order')), 'maxOrder']],
            where: { financialAccountId, status: updateData.status, id: {[Op.ne]: taskId} }, // Exclui a própria tarefa da contagem
            raw: true,
        });
        updateData.order = (maxOrderResult && typeof maxOrderResult.maxOrder === 'number' ? maxOrderResult.maxOrder : -1) + 1;
        logger.info(`Tarefa ID ${taskId} movida para status ${updateData.status}, nova ordem calculada: ${updateData.order}`);
    }


    await task.update(updateData);
    logger.info(`Tarefa Kanban ID ${taskId} ("${task.title}") atualizada.`);
    return task.reload().then(t => t.toJSON());
  } catch (error) {
    logger.error(`Erro ao atualizar tarefa Kanban ID ${taskId}: ${error.message}`, { error, updateData });
     if (error.name === 'SequelizeValidationError') {
        const valError = new Error(error.errors.map(e => e.message).join(', '));
        valError.statusCode = 400; valError.status = 'fail';
        throw valError;
    }
    if (!error.statusCode) error.statusCode = 500;
    throw error;
  }
}

async function updateTaskOrderAndStatus(financialAccountId, taskId, newStatus, newOrder) {
    const t = await require('../../database').sequelize.transaction(); // Inicia uma transação
    try {
      await validateOwningFinancialAccount(financialAccountId, t);
      const taskToMove = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!taskToMove) {
        await t.rollback();
        const error = new Error(`Tarefa Kanban ID ${taskId} não encontrada ou não pertence à conta.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
      }
  
      const oldStatus = taskToMove.status;
      const oldOrder = taskToMove.order;
  
      // 1. Remove a tarefa da posição antiga na coluna de origem (se o status mudou ou se a ordem mudou dentro da mesma coluna)
      if (oldStatus !== newStatus || (oldStatus === newStatus && oldOrder !== newOrder)) {
        await KanbanTask.update(
          { order: require('sequelize').literal('"order" - 1') },
          {
            where: {
              financialAccountId,
              status: oldStatus,
              order: { [Op.gt]: oldOrder },
              id: { [Op.ne]: taskId } // Não atualiza a própria tarefa que está sendo movida
            },
            transaction: t,
          }
        );
      }
  
      // 2. Abre espaço na coluna de destino para a nova posição
      await KanbanTask.update(
        { order: require('sequelize').literal('"order" + 1') },
        {
          where: {
            financialAccountId,
            status: newStatus,
            order: { [Op.gte]: newOrder },
            id: { [Op.ne]: taskId } // Não atualiza a própria tarefa (importante se move dentro da mesma coluna)
          },
          transaction: t,
        }
      );
  
      // 3. Atualiza a tarefa movida com o novo status e nova ordem
      await taskToMove.update({ status: newStatus, order: newOrder }, { transaction: t });
  
      await t.commit();
      logger.info(`Ordem/Status da Tarefa Kanban ID ${taskId} atualizados. Novo Status: ${newStatus}, Nova Ordem: ${newOrder}. Coluna de origem ${oldStatus} reordenada (se aplicável). Coluna de destino ${newStatus} reordenada.`);
      return taskToMove.reload().then(tUpdated => tUpdated.toJSON());
  
    } catch (error) {
      await t.rollback();
      logger.error(`Erro ao atualizar ordem/status da tarefa Kanban ID ${taskId}: ${error.message}`, { error, details: { financialAccountId, taskId, newStatus, newOrder } });
      if (!error.statusCode) error.statusCode = 500;
      throw error;
    }
}
  

async function deleteTask(financialAccountId, taskId) {
    const t = await require('../../database').sequelize.transaction();
    try {
      await validateOwningFinancialAccount(financialAccountId, t);
      const task = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t });
      if (!task) {
        await t.rollback();
        const error = new Error(`Tarefa Kanban ID ${taskId} não encontrada para exclusão.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
      }
      
      const statusOfDeletedTask = task.status;
      const orderOfDeletedTask = task.order;

      await task.destroy({ transaction: t });

      // Reordena os itens restantes na coluna da tarefa deletada
      await KanbanTask.update(
        { order: require('sequelize').literal('"order" - 1') },
        {
          where: {
            financialAccountId,
            status: statusOfDeletedTask,
            order: { [Op.gt]: orderOfDeletedTask },
          },
          transaction: t,
        }
      );

      await t.commit();
      logger.info(`Tarefa Kanban ID ${taskId} ("${task.title}") excluída e coluna ${statusOfDeletedTask} reordenada.`);
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
  updateTaskOrderAndStatus,
  deleteTask,
};
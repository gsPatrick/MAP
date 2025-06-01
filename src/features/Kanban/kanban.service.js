// src/features/Kanban/kanban.service.js
const { KanbanColumn, KanbanTask, FinancialAccount, sequelize } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

// Helper para validar a conta financeira
async function validateFinancialAccount(financialAccountId, transaction = null) {
    const account = await FinancialAccount.findByPk(financialAccountId, { transaction });
    if (!account) {
        const error = new Error(`Conta Financeira ID ${financialAccountId} não encontrada.`);
        error.statusCode = 404; error.status = 'fail'; throw error;
    }
    if (!account.isActive) {
        const error = new Error(`A Conta Financeira ID ${financialAccountId} ("${account.accountName}") está inativa.`);
        error.statusCode = 403; error.status = 'fail'; throw error;
    }
    return account;
}

// --- Serviço para o Quadro Kanban Completo ---
async function getBoardData(financialAccountId) {
    await validateFinancialAccount(financialAccountId);
    const columns = await KanbanColumn.findAll({
        where: { financialAccountId },
        include: [{
            model: KanbanTask,
            as: 'tasks',
            // attributes: ['id', 'title', 'priority', 'dueDate', 'cardColor', 'isCompleted', 'labels', 'order'], // Seleciona campos
            order: [['order', 'ASC']],
        }],
        order: [['order', 'ASC']],
    });

    const board = {
        tasks: {},
        columns: {},
        columnOrder: [],
        // boardLabels: {}, // TODO: Implementar busca de labels definidos pelo usuário para o board
    };

    columns.forEach(col => {
        const columnData = col.toJSON();
        board.columns[columnData.id] = {
            id: columnData.id.toString(), // IDs como string para o frontend
            title: columnData.title,
            taskIds: [], // Será populado abaixo
            color: columnData.color,
        };
        board.columnOrder.push(columnData.id.toString());

        if (columnData.tasks && columnData.tasks.length > 0) {
            columnData.tasks.forEach(task => {
                const taskData = {
                    ...task,
                    id: task.id.toString(), // IDs como string
                    kanbanColumnId: task.kanbanColumnId.toString(),
                     // O frontend usa 'content' para o título principal da tarefa, mas pode ser que o ModalTaskDetails use 'title'.
                    // Se 'title' do modelo é o conteúdo, não precisa de 'content'.
                    // Se for diferente, mapear aqui. O modelo atual usa 'title' para o conteúdo.
                };
                board.tasks[taskData.id] = taskData;
                board.columns[columnData.id].taskIds.push(taskData.id);
            });
        }
    });

    logger.info(`Dados do quadro Kanban para FA ID ${financialAccountId} recuperados.`);
    return board;
}


// --- Serviços para Colunas ---
async function createColumn(financialAccountId, columnData) {
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        if (!columnData.title || columnData.title.trim() === '') {
            throw new Error('Título da coluna é obrigatório.');
        }

        // Definir a ordem da nova coluna
        let order = columnData.order;
        if (order === undefined || order === null) {
            const maxOrder = await KanbanColumn.max('order', { where: { financialAccountId }, transaction: t });
            order = (maxOrder === null || isNaN(maxOrder)) ? 0 : maxOrder + 1;
        }

        const newColumn = await KanbanColumn.create({
            ...columnData,
            financialAccountId,
            order
        }, { transaction: t });

        await t.commit();
        logger.info(`Coluna Kanban "${newColumn.title}" criada para FA ID ${financialAccountId}.`);
        // Retorna o objeto incluindo as tasks vazias para consistência com getBoardData
        const reloadedColumn = await KanbanColumn.findByPk(newColumn.id, { include: [{model:KanbanTask, as: 'tasks'}]});
        return reloadedColumn.toJSON();
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao criar coluna Kanban: ${error.message}`, { error, financialAccountId, columnData });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function updateColumn(financialAccountId, columnId, updateData) {
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        const column = await KanbanColumn.findOne({ where: { id: columnId, financialAccountId }, transaction: t });
        if (!column) {
            const e = new Error('Coluna Kanban não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }
        // Não permitir mudar financialAccountId
        delete updateData.financialAccountId;

        await column.update(updateData, { transaction: t });
        await t.commit();
        logger.info(`Coluna Kanban ID ${columnId} atualizada.`);
        const reloadedColumn = await KanbanColumn.findByPk(columnId, { include: [{model:KanbanTask, as: 'tasks'}]});
        return reloadedColumn.toJSON();
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao atualizar coluna Kanban ID ${columnId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function deleteColumn(financialAccountId, columnId) {
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        const column = await KanbanColumn.findOne({ where: { id: columnId, financialAccountId }, transaction: t });
        if (!column) {
            const e = new Error('Coluna Kanban não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }
        // As tarefas associadas serão deletadas em CASCADE (definido no modelo KanbanColumn)
        await column.destroy({ transaction: t });
        // Reordenar colunas restantes se necessário (opcional, ou deixar para o frontend/próxima carga)
        await t.commit();
        logger.info(`Coluna Kanban ID ${columnId} e suas tarefas foram excluídas.`);
        return true;
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao excluir coluna Kanban ID ${columnId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function reorderColumns(financialAccountId, columnOrderArray) {
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        for (let i = 0; i < columnOrderArray.length; i++) {
            await KanbanColumn.update(
                { order: i },
                { where: { id: columnOrderArray[i], financialAccountId }, transaction: t }
            );
        }
        await t.commit();
        logger.info(`Ordem das colunas Kanban atualizada para FA ID ${financialAccountId}.`);
        return true;
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao reordenar colunas Kanban: ${error.message}`, { error });
        throw error;
    }
}


// --- Serviços para Tarefas ---
async function createTask(financialAccountId, columnId, taskData) {
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        const column = await KanbanColumn.findOne({ where: { id: columnId, financialAccountId }, transaction: t });
        if (!column) {
            const e = new Error('Coluna Kanban de destino não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }

        if (!taskData.title || taskData.title.trim() === '') {
             throw new Error('Título da tarefa é obrigatório.');
        }

        // Definir a ordem da nova tarefa
        let order = taskData.order;
        if (order === undefined || order === null) {
            const maxOrder = await KanbanTask.max('order', { where: { kanbanColumnId: columnId }, transaction: t });
            order = (maxOrder === null || isNaN(maxOrder)) ? 0 : maxOrder + 1;
        }
        
        const newTask = await KanbanTask.create({
            ...taskData,
            kanbanColumnId: columnId,
            financialAccountId, // Adiciona o FA ID na tarefa também
            order,
            isCompleted: taskData.isCompleted === undefined ? false : !!taskData.isCompleted,
            labels: taskData.labels || [] // Garante que seja um array
        }, { transaction: t });

        await t.commit();
        logger.info(`Tarefa Kanban "${newTask.title}" criada na coluna ID ${columnId}.`);
        return newTask.toJSON();
    } catch (error) {
        if (t && !t.finished) await t.rollback();
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
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        const task = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t });
        if (!task) {
            const e = new Error('Tarefa Kanban não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }

        // Não permitir mudar financialAccountId ou kanbanColumnId diretamente aqui se não for um movimento
        // O movimento entre colunas é melhor tratado por uma lógica específica em reorderTasks
        delete updateData.financialAccountId;
        const newColumnId = updateData.kanbanColumnId; // Salva se vier, para usar em reorderTasks
        delete updateData.kanbanColumnId;

        // Se a coluna for mudada, reorderTasks deve ser chamado pelo controller.
        // Aqui, só atualizamos os dados da tarefa.
        if (newColumnId && newColumnId !== task.kanbanColumnId) {
            logger.warn(`[SERVICE] Tentativa de mudar coluna de tarefa ID ${taskId} via updateTask. Isso deve ser feito via reorderTasks. Ignorando kanbanColumnId.`);
        }

        await task.update(updateData, { transaction: t });
        await t.commit();
        logger.info(`Tarefa Kanban ID ${taskId} atualizada.`);
        return task.reload().then(t => t.toJSON());
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao atualizar tarefa Kanban ID ${taskId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function deleteTask(financialAccountId, taskId) {
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        const task = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t });
        if (!task) {
            const e = new Error('Tarefa Kanban não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }
        await task.destroy({ transaction: t });
        await t.commit();
        logger.info(`Tarefa Kanban ID ${taskId} excluída.`);
        return true;
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao excluir tarefa Kanban ID ${taskId}: ${error.message}`, { error });
        if (!error.statusCode) error.statusCode = 500;
        throw error;
    }
}

async function toggleTaskComplete(financialAccountId, taskId) {
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        const task = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t });
        if (!task) {
            const e = new Error('Tarefa Kanban não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }
        await task.update({ isCompleted: !task.isCompleted }, { transaction: t });
        await t.commit();
        logger.info(`Status de conclusão da Tarefa ID ${taskId} alterado para ${task.isCompleted}.`);
        return task.reload().then(t => t.toJSON());
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao alternar status de conclusão da tarefa ID ${taskId}: ${error.message}`, { error });
        throw error;
    }
}

async function reorderTasks(financialAccountId, dragResult) {
    const { taskId, source, destination } = dragResult;
    const t = await sequelize.transaction();
    try {
        await validateFinancialAccount(financialAccountId, t);
        const taskToMove = await KanbanTask.findOne({ where: { id: taskId, financialAccountId }, transaction: t });
        if (!taskToMove) {
            const e = new Error('Tarefa a ser movida não encontrada.'); e.statusCode = 404; e.status = 'fail'; throw e;
        }

        const sourceColumnId = source.droppableId;
        const destinationColumnId = destination.droppableId;
        const destinationIndex = destination.index;

        // 1. Remover da lista de origem (ajustar ordens)
        const tasksInSourceColumn = await KanbanTask.findAll({
            where: { kanbanColumnId: sourceColumnId, financialAccountId, id: { [Op.ne]: taskId } },
            order: [['order', 'ASC']],
            transaction: t
        });
        for (let i = 0; i < tasksInSourceColumn.length; i++) {
            if (tasksInSourceColumn[i].order >= source.index) { // Reajusta apenas os que estavam depois
                await tasksInSourceColumn[i].update({ order: i }, { transaction: t });
            }
        }
        // Na verdade, a lógica é mais simples: pegar todos os tasks da coluna de origem, exceto o movido,
        // e reatribuir `order` de 0 a N-1.
        const sourceTasksSansMoved = await KanbanTask.findAll({
            where: { kanbanColumnId: sourceColumnId, financialAccountId, id: {[Op.ne]: taskId} },
            order: [['order', 'ASC']],
            transaction: t
        });
        for (let i = 0; i < sourceTasksSansMoved.length; i++) {
            await sourceTasksSansMoved[i].update({ order: i }, { transaction: t });
        }


        // 2. Adicionar na lista de destino (ajustar ordens)
        const tasksInDestColumn = await KanbanTask.findAll({
            where: { kanbanColumnId: destinationColumnId, financialAccountId, id: { [Op.ne]: taskId } }, // Exclui a tarefa caso ela já esteja na coluna de destino (reordenando na mesma coluna)
            order: [['order', 'ASC']],
            transaction: t
        });

        // Faz espaço para a tarefa movida
        for (let i = 0; i < tasksInDestColumn.length; i++) {
            if (tasksInDestColumn[i].order >= destinationIndex) {
                await tasksInDestColumn[i].update({ order: tasksInDestColumn[i].order + 1 }, { transaction: t });
            }
        }
        // Atualiza a tarefa movida
        await taskToMove.update({
            kanbanColumnId: destinationColumnId,
            order: destinationIndex
        }, { transaction: t });

        // Normaliza a ordem na coluna de destino (opcional, mas bom para garantir consistência)
        const finalTasksInDest = await KanbanTask.findAll({
            where: { kanbanColumnId: destinationColumnId, financialAccountId },
            order: [['order', 'ASC']],
            transaction: t
        });
        for (let i = 0; i < finalTasksInDest.length; i++) {
            if (finalTasksInDest[i].order !== i) { // Se a ordem não estiver sequencial
                await finalTasksInDest[i].update({ order: i }, { transaction: t });
            }
        }


        await t.commit();
        logger.info(`Tarefa ID ${taskId} movida/reordenada para Coluna ID ${destinationColumnId}, Posição ${destinationIndex}.`);
        return true;
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        logger.error(`Erro ao reordenar tarefas: ${error.message}`, { error });
        throw error;
    }
}

module.exports = {
    getBoardData,
    createColumn,
    updateColumn,
    deleteColumn,
    reorderColumns,
    createTask,
    updateTask,
    deleteTask,
    toggleTaskComplete,
    reorderTasks,
};
// src/features/Checklist/checklist.service.js
const { DailyChecklist, ChecklistItem, FinancialAccount, Client } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService');

/**
 * Obtém ou cria o checklist para uma data específica.
 * @param {number} financialAccountId O ID da conta financeira (PJ/MEI).
 * @param {string} date A data no formato 'YYYY-MM-DD'.
 * @returns {Promise<object>} O objeto DailyChecklist com seus itens.
 */
async function getChecklistByDate(financialAccountId, date) {
  // Use findOrCreate para garantir que o registro DailyChecklist exista para a data e conta
  const [dailyChecklistRecord, created] = await DailyChecklist.findOrCreate({
    where: { financialAccountId, date },
    defaults: { financialAccountId, date },
  });

  // Agora, busque os ChecklistItems para este DailyChecklist específico.
  // CRITICAMENTE, inclua o DailyChecklist pai dentro de cada item, usando o alias 'checklist'.
  // Isso é o que tornará 'item.checklist' acessível no frontend e permitirá a verificação de posse.
  const checklistItems = await ChecklistItem.findAll({
    where: { dailyChecklistId: dailyChecklistRecord.id },
    include: [{
      model: DailyChecklist,
      as: 'checklist', // Este alias é definido em ChecklistItem.associate
      attributes: ['financialAccountId'] // Busca apenas o financialAccountId do DailyChecklist
    }],
    order: [['createdAt', 'ASC']],
  });

  // Prepara a estrutura de resposta: o objeto DailyChecklist contendo seus itens
  const result = dailyChecklistRecord.toJSON();
  result.items = checklistItems.map(item => item.toJSON()); // Converte os itens para objetos JSON planos

  return result;
}

/**
 * Adiciona um novo item a um checklist diário.
 * @param {number} financialAccountId O ID da conta.
 * @param {string} date A data do checklist ('YYYY-MM-DD').
 * @param {object} itemData Dados do item: { text, priority, notes }.
 * @returns {Promise<object>} O item recém-criado.
 */
async function addChecklistItem(financialAccountId, date, itemData) {
  const checklist = await getChecklistByDate(financialAccountId, date);
  if (!checklist) {
    // Embora getChecklistByDate sempre crie um, esta verificação serve como segurança extra.
    throw { statusCode: 404, message: 'Checklist para esta data não encontrado.' };
  }

  const newItem = await ChecklistItem.create({
    dailyChecklistId: checklist.id,
    text: itemData.text,
    priority: itemData.priority || 'medium',
    notes: itemData.notes || null,
    completed: false,
    order: (checklist.items.length > 0 ? Math.max(...checklist.items.map(item => item.order)) + 1 : 0) // Define uma ordem
  });

  logger.info(`Novo item de checklist (ID: ${newItem.id}) adicionado para a conta ${financialAccountId} na data ${date}.`);
  return newItem.toJSON();
}

/**
 * Atualiza um item de checklist existente.
 * @param {number} financialAccountId O ID da conta (para verificação de posse).
 * @param {number} itemId O ID do item a ser atualizado.
 * @param {object} updateData Dados a serem atualizados.
 * @returns {Promise<object>} O item atualizado.
 */
async function updateChecklistItem(financialAccountId, itemId, updateData) {
  const item = await ChecklistItem.findByPk(itemId, {
    include: [{ 
        model: DailyChecklist, 
        as: 'checklist', 
        attributes: ['financialAccountId', 'date'] // <<<< MUDANÇA: Adiciona 'date' ao include
    }]
  });

  if (!item) {
    throw { statusCode: 404, message: 'Item de checklist não encontrado.' };
  }
  if (item.checklist.financialAccountId !== financialAccountId) {
    throw { statusCode: 403, message: 'Você não tem permissão para editar este item.' };
  }

  // <<<< INÍCIO DA MUDANÇA >>>>
  const wasCompletedNow = updateData.completed === true && item.completed === false;
  // <<<< FIM DA MUDANÇA >>>>

  await item.update(updateData);
  logger.info(`Item de checklist (ID: ${item.id}) atualizado para a conta ${financialAccountId}.`);

  // <<<< INÍCIO DA MUDANÇA >>>>
  // Verifica se a tarefa foi marcada como concluída NESTA atualização
  if (wasCompletedNow) {
    // Busca todas as tarefas do mesmo checklist para verificar se todas estão concluídas
    const allItemsOfChecklist = await ChecklistItem.findAll({
        where: { dailyChecklistId: item.dailyChecklistId }
    });

    const allCompleted = allItemsOfChecklist.every(i => i.completed);

    if (allCompleted) {
        // Se todas foram concluídas, busca o cliente para enviar a mensagem
        const financialAccount = await FinancialAccount.findByPk(financialAccountId, {
            include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
        });

        const client = financialAccount?.ownerClient;
        if (client && client.phone) {
            const clientFirstName = client.name ? client.name.split(' ')[0] : 'Você';
            const congratulationsMessage = `*PARABÉNS, ${clientFirstName}!* 🏆 Você finalizou todas as tarefas do seu checklist de hoje! Momento de celebrar e relaxar!`;
            
            // Envia a mensagem de forma assíncrona (não precisa esperar a resposta para retornar o item atualizado)
            sendWhatsappMessage(client.phone, congratulationsMessage)
                .then(() => logger.info(`[Checklist Service] Mensagem de conclusão de checklist enviada para ${client.phone}.`))
                .catch(err => logger.error(`[Checklist Service] Erro ao enviar mensagem de conclusão de checklist: ${err.message}`));
        }
    }
  }
  // <<<< FIM DA MUDANÇA >>>>

  return item.toJSON();
}


/**
 * Exclui um item de checklist.
 * @param {number} financialAccountId O ID da conta (para verificação de posse).
 * @param {number} itemId O ID do item a ser excluído.
 * @returns {Promise<boolean>} True se foi excluído.
 */
async function deleteChecklistItem(financialAccountId, itemId) {
  const item = await ChecklistItem.findByPk(itemId, {
    include: [{ model: DailyChecklist, as: 'checklist', attributes: ['financialAccountId'] }]
  });

  if (!item) {
    throw { statusCode: 404, message: 'Item de checklist não encontrado.' };
  }
  if (item.checklist.financialAccountId !== financialAccountId) {
    throw { statusCode: 403, message: 'Você não tem permissão para excluir este item.' };
  }

  await item.destroy();
  logger.info(`Item de checklist (ID: ${item.id}) excluído para a conta ${financialAccountId}.`);
  return true;
}

module.exports = {
  getChecklistByDate,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
};
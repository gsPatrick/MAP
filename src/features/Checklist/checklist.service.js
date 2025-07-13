// src/features/Checklist/checklist.service.js
const { DailyChecklist, ChecklistItem, FinancialAccount, Client } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { sendWhatsappMessage } = require('../../services/whatsappService');
const aiModelService = require('../../services/aiModelService');
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
        attributes: ['financialAccountId', 'date']
    }]
  });

  if (!item) {
    throw { statusCode: 404, message: 'Item de checklist não encontrado.' };
  }
  if (item.checklist.financialAccountId !== financialAccountId) {
    throw { statusCode: 403, message: 'Você não tem permissão para editar este item.' };
  }

  const wasCompletedNow = updateData.completed === true && item.completed === false;

  await item.update(updateData);
  logger.info(`Item de checklist (ID: ${item.id}) atualizado para a conta ${financialAccountId}.`);

  if (wasCompletedNow) {
    const allItemsOfChecklist = await ChecklistItem.findAll({
        where: { dailyChecklistId: item.dailyChecklistId }
    });

    const allCompleted = allItemsOfChecklist.every(i => i.completed);

    if (allCompleted) {
        const financialAccount = await FinancialAccount.findByPk(financialAccountId, {
            include: [{ model: Client, as: 'ownerClient', attributes: ['id', 'name', 'phone'] }]
        });

        const client = financialAccount?.ownerClient;
        if (client && client.phone) {
            const clientFirstName = client.name ? client.name.split(' ')[0] : 'Você';
            
            // <<<< INÍCIO DA MUDANÇA >>>>
            // Extrai os textos das tarefas para enviar à IA
            const completedTaskTexts = allItemsOfChecklist.map(task => task.text);

            // Chama a nova função da IA para obter a introdução e os comentários
            const aiResponse = await aiModelService.generateChecklistCompletionMessage(clientFirstName, completedTaskTexts);
            
            // Monta a mensagem final e rica
            let finalMessage = `${aiResponse.celebratory_intro}\n\n🏆 *Tarefas Concluídas Hoje:*\n`;

            allItemsOfChecklist.forEach((task, index) => {
                const comment = aiResponse.task_comments[index] || "Mandou bem!"; // Fallback
                finalMessage += `\n> ✅ *${task.text}*\n> 💬 _${comment}_\n`;
            });
            // <<<< FIM DA MUDANÇA >>>>
            
            sendWhatsappMessage(client.phone, finalMessage)
                .then(() => logger.info(`[Checklist Service] Mensagem de conclusão de checklist rica enviada para ${client.phone}.`))
                .catch(err => logger.error(`[Checklist Service] Erro ao enviar mensagem de conclusão de checklist rica: ${err.message}`));
        }
    }
  }

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
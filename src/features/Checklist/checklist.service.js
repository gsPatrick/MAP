// src/features/Checklist/checklist.service.js
const { DailyChecklist, ChecklistItem, FinancialAccount } = require('../../database');
const { Op } = require('sequelize');
const logger = require('../../utils/logger');

/**
 * Obtém ou cria o checklist para uma data específica.
 * @param {number} financialAccountId O ID da conta financeira (PJ/MEI).
 * @param {string} date A data no formato 'YYYY-MM-DD'.
 * @returns {Promise<object>} O objeto DailyChecklist com seus itens.
 */
async function getChecklistByDate(financialAccountId, date) {
  const [checklist] = await DailyChecklist.findOrCreate({
    where: { financialAccountId, date },
    defaults: { financialAccountId, date },
    include: [{
      model: ChecklistItem,
      as: 'items',
      order: [['createdAt', 'ASC']],
    }],
    order: [
      [{ model: ChecklistItem, as: 'items' }, 'createdAt', 'ASC']
    ]
  });

  // findOrCreate retorna um array [instance, created]. Queremos a instância.
  // Se foi recém-criado, o `include` não funciona, então buscamos de novo.
  if (!checklist.items) {
    const freshChecklist = await DailyChecklist.findByPk(checklist.id, {
        include: [{ model: ChecklistItem, as: 'items' }],
        order: [[{ model: ChecklistItem, as: 'items' }, 'createdAt', 'ASC']]
    });
    return freshChecklist.toJSON();
  }

  return checklist.toJSON();
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
    throw { statusCode: 404, message: 'Checklist para esta data não encontrado.' };
  }

  const newItem = await ChecklistItem.create({
    dailyChecklistId: checklist.id,
    text: itemData.text,
    priority: itemData.priority || 'medium',
    notes: itemData.notes || null,
    completed: false,
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
    include: [{ model: DailyChecklist, as: 'checklist', attributes: ['financialAccountId'] }]
  });

  if (!item) {
    throw { statusCode: 404, message: 'Item de checklist não encontrado.' };
  }
  if (item.checklist.financialAccountId !== financialAccountId) {
    throw { statusCode: 403, message: 'Você não tem permissão para editar este item.' };
  }

  await item.update(updateData);
  logger.info(`Item de checklist (ID: ${item.id}) atualizado para a conta ${financialAccountId}.`);
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
// src/features/Checklist/checklist.controller.js
const checklistService = require('./checklist.service');

async function getChecklist(req, res, next) {
  try {
    const { financialAccountId, date } = req.params; // financialAccountId correto aqui
    // Validação básica da data
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ status: 'fail', message: 'Formato de data inválido. Use YYYY-MM-DD.' });
    }
    const checklist = await checklistService.getChecklistByDate(parseInt(financialAccountId, 10), date);
    res.status(200).json({ status: 'success', data: checklist });
  } catch (error) {
    next(error);
  }
}

async function addItem(req, res, next) {
  try {
    const { financialAccountId, date } = req.params; // financialAccountId correto aqui
    const item = await checklistService.addChecklistItem(parseInt(financialAccountId, 10), date, req.body);
    res.status(201).json({ status: 'success', data: item });
  } catch (error) {
    next(error);
  }
}

async function updateItem(req, res, next) {
  try {
    // CORREÇÃO AQUI: Pegar financialAccountId de req.params
    const { financialAccountId, itemId } = req.params; 
    const item = await checklistService.updateChecklistItem(parseInt(financialAccountId, 10), parseInt(itemId, 10), req.body);
    res.status(200).json({ status: 'success', data: item });
  } catch (error) {
    next(error);
  }
}

async function deleteItem(req, res, next) {
  try {
    // CORREÇÃO AQUI: Pegar financialAccountId de req.params
    const { financialAccountId, itemId } = req.params;
    await checklistService.deleteChecklistItem(parseInt(financialAccountId, 10), parseInt(itemId, 10));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getChecklist,
  addItem,
  updateItem,
  deleteItem,
};
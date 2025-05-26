// src/models/KanbanTask.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const KanbanTask = sequelize.define('KanbanTask', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  // financialAccountId não é mais necessário aqui diretamente se a tarefa pertence a uma coluna,
  // e a coluna pertence a uma financialAccount. Mas manter pode facilitar algumas queries.
  // Por simplicidade e para evitar joins extras em todas as buscas de tasks, vamos manter.
  financialAccountId: { 
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', 
  },
  kanbanColumnId: { // Nova FK para a KanbanColumn
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'kanban_columns', // Nome da tabela de KanbanColumn
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se a coluna for deletada, as tarefas também são
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // O campo 'status' foi removido, pois agora é determinado pela 'kanbanColumnId'
  priority: {
    type: DataTypes.ENUM('Baixa', 'Média', 'Alta'),
    allowNull: true,
  },
  dueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  order: { // Ordem das tarefas DENTRO de uma coluna
    type: DataTypes.INTEGER,
    allowNull: true, // Será gerenciado pelo serviço
    defaultValue: 0,
  },
  tags: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
}, {
  tableName: 'kanban_tasks',
  timestamps: true,
  comment: 'Tarefas para o quadro Kanban',
  indexes: [
    { fields: ['financialAccountId'] }, // Ainda útil para buscar todas as tasks de uma FA
    { fields: ['kanbanColumnId'] },
    { fields: ['kanbanColumnId', 'order'] },
    { fields: ['priority'] },
    { fields: ['dueDate'] },
  ]
});

KanbanTask.associate = (models) => {
  KanbanTask.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  KanbanTask.belongsTo(models.KanbanColumn, { foreignKey: 'kanbanColumnId', as: 'column' });
};

module.exports = KanbanTask;
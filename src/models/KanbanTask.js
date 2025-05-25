// src/models/KanbanTask.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const KanbanTask = sequelize.define('KanbanTask', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts', // Nome da tabela de FinancialAccount
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se a FinancialAccount for deletada, suas tarefas Kanban também são
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('Pendente', 'Em Andamento', 'Concluído', 'Bloqueado'),
    allowNull: false,
    defaultValue: 'Pendente',
  },
  priority: {
    type: DataTypes.ENUM('Baixa', 'Média', 'Alta'),
    allowNull: true,
  },
  dueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  order: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
  },
  tags: {
    type: DataTypes.JSONB, // Para PostgreSQL. Use DataTypes.TEXT para outros e serialize/deserialize.
    allowNull: true,
  },
}, {
  tableName: 'kanban_tasks',
  timestamps: true,
  comment: 'Tarefas para o quadro Kanban de uma FinancialAccount',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['financialAccountId', 'status'] },
    { fields: ['financialAccountId', 'priority'] },
    { fields: ['financialAccountId', 'dueDate'] },
  ]
});

KanbanTask.associate = (models) => {
  KanbanTask.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
};

module.exports = KanbanTask;
// src/models/KanbanColumn.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const KanbanColumn = sequelize.define('KanbanColumn', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    comment: 'ID da Conta Financeira à qual esta coluna Kanban pertence',
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Título da coluna Kanban (ex: A Fazer, Em Andamento)',
  },
  color: {
    type: DataTypes.STRING(20), // Pode ser um código HEX, nome de cor, ou classe CSS
    allowNull: true,
    comment: 'Cor associada à coluna (opcional, para UI)',
  },
  order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: 'Ordem de exibição da coluna no quadro Kanban',
  },
}, {
  sequelize,
  modelName: 'KanbanColumn',
  tableName: 'kanban_columns',
  timestamps: true,
  comment: 'Colunas do quadro Kanban, associadas a uma FinancialAccount',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['financialAccountId', 'order'] },
    { unique: true, fields: ['financialAccountId', 'title'], name: 'unique_kanban_column_title_per_account'}
  ]
});

KanbanColumn.associate = (models) => {
  KanbanColumn.belongsTo(models.FinancialAccount, {
    foreignKey: 'financialAccountId',
    as: 'financialAccount'
  });
  KanbanColumn.hasMany(models.KanbanTask, {
    foreignKey: 'kanbanColumnId',
    as: 'tasks',
    onDelete: 'CASCADE' // Se a coluna for deletada, suas tarefas também são
  });
};

module.exports = KanbanColumn;
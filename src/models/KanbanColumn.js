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
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  color: { // Opcional, para cor da coluna
    type: DataTypes.STRING(7), // Hex color like #RRGGBB
    allowNull: true,
    defaultValue: '#4A90E2', // Cor padrão
  },
  order: { // Ordem das colunas no quadro
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'kanban_columns',
  timestamps: true,
  comment: 'Colunas para o quadro Kanban de uma FinancialAccount',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['financialAccountId', 'order'] },
  ]
});

KanbanColumn.associate = (models) => {
  KanbanColumn.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  KanbanColumn.hasMany(models.KanbanTask, { foreignKey: 'kanbanColumnId', as: 'tasks', onDelete: 'CASCADE' }); // Tarefas são deletadas se a coluna for
};

module.exports = KanbanColumn;
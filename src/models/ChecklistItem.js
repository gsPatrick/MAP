// src/models/ChecklistItem.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ChecklistItem = sequelize.define('ChecklistItem', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  dailyChecklistId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'daily_checklists', // Nome da tabela criada acima
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    comment: 'ID do checklist diário ao qual este item pertence.',
  },
  text: {
    type: DataTypes.STRING(500),
    allowNull: false,
    comment: 'O texto da tarefa a ser realizada.',
  },
  completed: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Indica se a tarefa foi concluída.',
  },
  priority: {
    type: DataTypes.ENUM('low', 'medium', 'high'),
    allowNull: false,
    defaultValue: 'medium',
    comment: 'Prioridade da tarefa.',
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Notas ou detalhes adicionais sobre a tarefa.',
  },
  order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: 'Usado para ordenação visual no frontend.',
  }
}, {
  tableName: 'checklist_items',
  timestamps: true,
  comment: 'Um item individual de uma lista de tarefas diária.',
  indexes: [
    { fields: ['dailyChecklistId'] }
  ]
});

ChecklistItem.associate = (models) => {
  ChecklistItem.belongsTo(models.DailyChecklist, { foreignKey: 'dailyChecklistId', as: 'checklist' });
};

module.exports = ChecklistItem;
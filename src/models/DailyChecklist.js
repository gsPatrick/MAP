// src/models/DailyChecklist.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DailyChecklist = sequelize.define('DailyChecklist', {
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
    comment: 'ID da conta PJ/MEI à qual este checklist pertence.',
  },
  date: {
    type: DataTypes.DATEONLY, // Apenas 'YYYY-MM-DD'
    allowNull: false,
    comment: 'A data específica para este checklist.',
  },
}, {
  tableName: 'daily_checklists',
  timestamps: true,
  comment: 'Um container para a lista de tarefas de um dia específico para uma conta de negócio.',
  indexes: [
    // Garante que só exista UM checklist por dia para cada conta. Essencial!
    {
      unique: true,
      fields: ['financialAccountId', 'date'],
      name: 'unique_checklist_per_account_per_day'
    }
  ]
});

DailyChecklist.associate = (models) => {
  DailyChecklist.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  DailyChecklist.hasMany(models.ChecklistItem, { foreignKey: 'dailyChecklistId', as: 'items', onDelete: 'CASCADE' });
};

module.exports = DailyChecklist;
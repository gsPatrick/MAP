// src/models/RecurringTransactionRule.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RecurringTransactionRule = sequelize.define('RecurringTransactionRule', {
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
  description: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM('Entrada', 'Saída'),
    allowNull: false,
  },
  value: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    validate: { min: 0.01 }
  },
  financialCategoryId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'financial_categories', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  frequency: {
    // <<< MUDANÇA CRÍTICA: Adicionando 'minutely' e 'hourly'
    type: DataTypes.ENUM('minutely', 'hourly', 'daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'semi-annually', 'annually'),
    allowNull: false,
  },
  interval: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    validate: { min: 1 },
  },
  startDate: {
    // <<< MUDANÇA CRÍTICA: De DATEONLY para DATE
    type: DataTypes.DATE, // Armazena data e hora de início
    allowNull: false,
  },
  endDate: {
    // <<< MUDANÇA CRÍTICA: De DATEONLY para DATE
    type: DataTypes.DATE, // Armazena data e hora de término
    allowNull: true,
  },
  dayOfWeek: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 0, max: 6 },
  },
  dayOfMonth: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1, max: 31 },
  },
  nextDueDate: {
    // <<< MUDANÇA CRÍTICA: De DATEONLY para DATE
    type: DataTypes.DATE, // Agora armazena a data e hora exatas do próximo vencimento
    allowNull: false,
  },
  autoCreateTransaction: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  isPayableOrReceivable: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
  },
  paymentMethod: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  lastGeneratedDate: {
    // <<< MUDANÇA CRÍTICA: De DATEONLY para DATE
    type: DataTypes.DATE, // Armazena data e hora da última geração
    allowNull: true,
  }
}, {
  tableName: 'recurring_transaction_rules',
  timestamps: true,
  comment: 'Regras para transações financeiras recorrentes, vinculadas a uma FinancialAccount',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['isActive', 'nextDueDate'] },
  ]
});

RecurringTransactionRule.associate = (models) => {
  RecurringTransactionRule.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  RecurringTransactionRule.belongsTo(models.FinancialCategory, { foreignKey: 'financialCategoryId', as: 'category' });
  RecurringTransactionRule.hasMany(models.FinancialTransaction, {
    foreignKey: 'recurringTransactionRuleId',
    as: 'generatedTransactions',
  });
};

module.exports = RecurringTransactionRule;
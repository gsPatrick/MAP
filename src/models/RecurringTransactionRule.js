// src/models/RecurringTransactionRule.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RecurringTransactionRule = sequelize.define('RecurringTransactionRule', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: { // Chave estrangeira para FinancialAccount
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts', // Nome da tabela 'financial_accounts'
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se a FinancialAccount for deletada, suas regras de recorrência também são
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
    type: DataTypes.ENUM('daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'semi-annually', 'annually'),
    allowNull: false,
  },
  interval: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    validate: { min: 1 },
  },
  startDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  endDate: {
    type: DataTypes.DATEONLY,
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
    validate: { min: 1, max: 31 }, // Lógica para dias > 28 será no job
  },
  nextDueDate: {
    type: DataTypes.DATEONLY,
    allowNull: false, // Calculada e atualizada pelo sistema/job
  },
  autoCreateTransaction: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  isPayableOrReceivable: {
      type: DataTypes.BOOLEAN,
      defaultValue: true, // Transações recorrentes geralmente são contas
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
    type: DataTypes.DATEONLY,
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

  // NOVA ASSOCIAÇÃO (INVERSA)
  RecurringTransactionRule.hasMany(models.FinancialTransaction, {
    foreignKey: 'recurringTransactionRuleId',
    as: 'generatedTransactions', // Nome do alias para acessar as transações geradas
  });
};

module.exports = RecurringTransactionRule;
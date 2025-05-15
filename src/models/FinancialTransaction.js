// src/models/FinancialTransaction.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const FinancialTransaction = sequelize.define('FinancialTransaction', {
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
    validate: {
      isDecimal: true,
      min: 0.01
    },
  },
  financialCategoryId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_categories',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', 
  },
  transactionDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  isPayableOrReceivable: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  dueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  isPaidOrReceived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  paymentDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
  },
  isParcel: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  parcelNumber: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
  },
  totalParcels: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
  },
  originalAccountId: { 
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_transactions',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', 
  },
  // NOVO CAMPO PARA ARMAZENAR O VALOR TOTAL DA COMPRA PARCELADA
  originalPurchaseTotalValue: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true,
    comment: 'Valor total da compra original, se esta transação for uma parcela.',
  },
  paymentMethod: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  creditCardId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'credit_cards',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', 
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  recurringTransactionRuleId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
        model: 'recurring_transaction_rules', 
        key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', 
    comment: 'ID da regra de recorrência que originou esta transação (se aplicável)',
  }
}, {
  tableName: 'financial_transactions',
  timestamps: true,
  comment: 'Registros de transações financeiras, vinculadas a uma FinancialAccount',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['transactionDate'] },
    { fields: ['dueDate'] },
    { fields: ['financialCategoryId'] },
    { fields: ['creditCardId'] },
    { fields: ['originalAccountId'] },
    { fields: ['recurringTransactionRuleId'] }, 
  ],
  hooks: {
    beforeUpdate: (transaction, options) => {
      if (transaction.changed('isPaidOrReceived') && transaction.isPaidOrReceived && !transaction.paymentDate) {
        const today = new Date();
        transaction.paymentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      }
      if (transaction.changed('isPaidOrReceived') && !transaction.isPaidOrReceived) {
        transaction.paymentDate = null;
      }
    },
  }
});

FinancialTransaction.associate = (models) => {
  FinancialTransaction.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  FinancialTransaction.belongsTo(models.FinancialCategory, { foreignKey: 'financialCategoryId', as: 'category' });
  FinancialTransaction.belongsTo(models.CreditCard, { foreignKey: 'creditCardId', as: 'creditCard' });
  
  FinancialTransaction.hasMany(models.FinancialTransaction, {
    as: 'parcels', // Uma transação original (isParcel=true, parcelNumber=1, originalAccountId=id) pode ter várias parcelas
    foreignKey: 'originalAccountId',
    useJunctionTable: false,
    // constraints: false // Pode ser necessário se houver problemas com a auto-referência circular
  });
  FinancialTransaction.belongsTo(models.FinancialTransaction, {
    as: 'originalAccount', // Uma parcela (parcelNumber > 1 OU parcelNumber=1 com originalAccountId != id) pertence a uma transação original
    foreignKey: 'originalAccountId',
    targetKey: 'id'
  });

  FinancialTransaction.belongsTo(models.RecurringTransactionRule, {
    foreignKey: 'recurringTransactionRuleId',
    as: 'recurringRuleOrigin', 
  });
};

module.exports = FinancialTransaction;
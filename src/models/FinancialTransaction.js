// src/models/FinancialTransaction.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const FinancialTransaction = sequelize.define('FinancialTransaction', {
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
    onDelete: 'CASCADE', // Se a FinancialAccount for deletada, suas transações também são
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
    onDelete: 'SET NULL', // Se categoria for deletada, transação fica sem categoria
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
  originalAccountId: { // ID da transação "mãe" desta parcela (auto-referência)
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_transactions',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', // Se a transação original for deletada, as parcelas perdem a referência (ou CASCADE)
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
    onDelete: 'SET NULL', // Se o cartão for deletado, a transação fica sem cartão associado
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // NOVO CAMPO
  recurringTransactionRuleId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
        model: 'recurring_transaction_rules', // Nome da tabela 'recurring_transaction_rules'
        key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', // Se a regra for deletada, as transações geradas por ela perdem a referência, mas não são deletadas
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
    { fields: ['recurringTransactionRuleId'] }, // <<< NOVO ÍNDICE
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
    // Manter o beforeValidate se necessário para lógica de parcelas e contas a pagar/receber
  }
});

FinancialTransaction.associate = (models) => {
  FinancialTransaction.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  FinancialTransaction.belongsTo(models.FinancialCategory, { foreignKey: 'financialCategoryId', as: 'category' });
  FinancialTransaction.belongsTo(models.CreditCard, { foreignKey: 'creditCardId', as: 'creditCard' });
  
  FinancialTransaction.hasMany(models.FinancialTransaction, {
    as: 'parcels',
    foreignKey: 'originalAccountId',
    useJunctionTable: false
  });
  FinancialTransaction.belongsTo(models.FinancialTransaction, {
    as: 'originalAccount',
    foreignKey: 'originalAccountId'
  });

  // NOVA ASSOCIAÇÃO
  FinancialTransaction.belongsTo(models.RecurringTransactionRule, {
    foreignKey: 'recurringTransactionRuleId',
    as: 'recurringRuleOrigin', // Nome do alias para a associação
  });
};

module.exports = FinancialTransaction;
// src/models/CreditCardInvoice.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CreditCardInvoice = sequelize.define('CreditCardInvoice', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  creditCardId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'credit_cards', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  },
  financialAccountId: { // Para facilitar a busca
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'financial_accounts', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  },
  startDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    comment: 'Data de início do período da fatura',
  },
  endDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    comment: 'Data de fechamento (fim do período) da fatura',
  },
  dueDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    comment: 'Data de vencimento do pagamento da fatura',
  },
  totalAmount: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    defaultValue: 0.00,
    comment: 'Valor total da fatura calculada no fechamento',
  },
  paidAmount: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    defaultValue: 0.00,
    comment: 'Valor total já pago para esta fatura',
  },
  status: {
    type: DataTypes.ENUM('Aberta', 'Fechada', 'Paga', 'Paga Parcialmente', 'Vencida'),
    allowNull: false,
    defaultValue: 'Aberta',
  },
  relatedPaymentTransactionId: { // Para vincular à transação de "Conta a Pagar"
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'financial_transactions', key: 'id' },
    onDelete: 'SET NULL',
  }
}, {
  tableName: 'credit_card_invoices',
  timestamps: true,
  comment: 'Representa as faturas mensais de um cartão de crédito.',
  indexes: [
    { fields: ['creditCardId', 'endDate'], unique: true },
    { fields: ['status', 'dueDate'] },
  ]
});

CreditCardInvoice.associate = (models) => {
  CreditCardInvoice.belongsTo(models.CreditCard, { foreignKey: 'creditCardId', as: 'creditCard' });
  CreditCardInvoice.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  CreditCardInvoice.belongsTo(models.FinancialTransaction, { foreignKey: 'relatedPaymentTransactionId', as: 'paymentTransaction' });
  CreditCardInvoice.hasMany(models.FinancialTransaction, { foreignKey: 'invoiceId', as: 'transactions' });
};

module.exports = CreditCardInvoice;
// src/models/CreditCard.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CreditCard = sequelize.define('CreditCard', {
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
    onDelete: 'CASCADE', // Se a FinancialAccount for deletada, seus cartões também são
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  limit: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    validate: { min: 0 }
  },
  closingDay: { // Dia do mês que a fatura fecha (1-28, simplificado)
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1, max: 28 } // Para evitar problemas com meses curtos
  },
  paymentDay: { // Dia do mês para pagamento da fatura (1-28, simplificado)
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1, max: 28 }
  },
  isDefault: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false, // Lógica de serviço garante um default por FinancialAccount
  },
  lastFourDigits: {
    type: DataTypes.STRING(4),
    allowNull: true,
    validate: { isNumeric: true, len: [4,4] }
  },
  flag: { // Bandeira (Visa, Mastercard, Amex, Elo, etc.)
    type: DataTypes.STRING,
    allowNull: true,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  }
}, {
  tableName: 'credit_cards',
  timestamps: true,
  comment: 'Cartões de crédito vinculados a uma FinancialAccount',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['financialAccountId', 'isDefault'] }
  ]
});

CreditCard.associate = (models) => {
  CreditCard.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  CreditCard.hasMany(models.FinancialTransaction, { foreignKey: 'creditCardId', as: 'transactions', onDelete: 'SET NULL' }); // Se cartão deletado, transações perdem a FK
};

module.exports = CreditCard;
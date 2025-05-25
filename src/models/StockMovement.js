// src/models/StockMovement.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StockMovement = sequelize.define('StockMovement', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  productId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'products', // Nome da tabela 'products'
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
    comment: 'ID do produto movimentado',
  },
  type: {
    type: DataTypes.ENUM('Entrada', 'Saída'),
    allowNull: false,
    comment: 'Tipo de movimentação: Entrada ou Saída',
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 1,
    },
    comment: 'Quantidade movimentada',
  },
  movementDate: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    comment: 'Data e hora da movimentação',
  },
  reason: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Motivo da movimentação de estoque',
  },
  relatedTransactionId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_transactions', // Nome da tabela 'financial_transactions'
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
    comment: 'ID da transação financeira relacionada (se aplicável)',
  }
}, {
  tableName: 'stock_movements',
  timestamps: true,
  updatedAt: false,
  comment: 'Tabela de Movimentações de Estoque (Entradas e Saídas)',
  indexes: [ // Adicionar índices pode melhorar a performance de queries
    { fields: ['productId'] },
    { fields: ['movementDate'] },
    { fields: ['relatedTransactionId'] },
  ]
});

// ***** CORREÇÃO IMPORTANTE: DESCOMENTAR E DEFINIR ASSOCIAÇÕES *****
StockMovement.associate = (models) => {
  StockMovement.belongsTo(models.Product, { // O modelo Product será passado como models.Product
    foreignKey: 'productId',
    as: 'product' // Este alias deve corresponder ao usado no 'include'
  });
  StockMovement.belongsTo(models.FinancialTransaction, { // O modelo FinancialTransaction
    foreignKey: 'relatedTransactionId',
    as: 'financialTransaction', // Alias para a transação financeira relacionada
    required: false // Torna o join opcional
  });
};

module.exports = StockMovement;
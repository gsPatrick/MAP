// src/models/Plan.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Plan = sequelize.define('Plan', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true, // Ex: 'Mensal Padrão', 'Anual Premium'
    comment: 'Nome identificador do plano',
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Descrição detalhada do plano',
  },
  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    validate: { min: 0 },
    comment: 'Preço do plano',
  },
  currency: {
    type: DataTypes.STRING(3),
    allowNull: false,
    defaultValue: 'BRL',
    comment: 'Moeda do preço (ex: BRL, USD)',
  },
  durationDays: { // Duração em dias. Ex: 30 para mensal, 365 para anual.
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1 },
    comment: 'Duração do plano em dias (ex: 30 para mensal, 365 para anual)',
  },
  isActive: { // Se o plano está atualmente disponível para novas assinaturas
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Indica se o plano está ativo para novas assinaturas',
  },
  // externalId: { // Para ID do plano na plataforma de pagamento (Hotmart, Stripe, etc.)
  //   type: DataTypes.STRING,
  //   allowNull: true,
  //   unique: true,
  //   comment: 'ID do plano na plataforma de pagamento externa'
  // }
}, {
  tableName: 'plans',
  timestamps: true,
  comment: 'Define os diferentes planos de assinatura disponíveis',
});

Plan.associate = (models) => {
  Plan.hasMany(models.Subscription, { foreignKey: 'planId', as: 'subscriptions' });
};

module.exports = Plan;
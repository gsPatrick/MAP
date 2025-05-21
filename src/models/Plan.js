// src/models/Plan.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Plan = sequelize.define('Plan', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: { // Ex: "Básico Mensal", "Avançado Anual"
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
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
  durationDays: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1 },
    comment: 'Duração do plano em dias (ex: 30 para mensal, 365 para anual)',
  },
  // NOVO CAMPO OPCIONAL para diferenciar o "nível" do plano
  tier: {
    type: DataTypes.ENUM('basico', 'avancado', 'gratuito', 'vitalicio'), // Ou apenas 'basico', 'avancado'
    allowNull: false,
    defaultValue: 'basico', // Ou um valor que faça sentido
    comment: 'Nível de funcionalidade do plano (basico, avancado)',
  },
  // O campo `accessLevel` no `Client` seria uma combinação de `tier` e `durationDays`
  // Ex: tier='avancado', durationDays=30 -> client.accessLevel = 'avancado_mensal'
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Indica se o plano está ativo para novas assinaturas',
  },
  // externalId: { ... }
}, {
  tableName: 'plans',
  timestamps: true,
  comment: 'Define os diferentes planos de assinatura disponíveis',
});

Plan.associate = (models) => {
  Plan.hasMany(models.Subscription, { foreignKey: 'planId', as: 'subscriptions' });
};

module.exports = Plan;
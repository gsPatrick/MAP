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
  tier: {
    type: DataTypes.ENUM('basico', 'avancado', 'gratuito', 'vitalicio'),
    allowNull: false,
    defaultValue: 'basico',
    comment: 'Nível de funcionalidade do plano (basico, avancado)',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Indica se o plano está ativo para novas assinaturas',
  },
  hotmartProductId: { // <<< NOVO CAMPO
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    comment: 'ID do produto correspondente na Hotmart (se aplicável)',
  },
   asaasProductId: { // <<<<<< NOVO CAMPO
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    comment: 'ID do plano de assinatura (subscription plan) no ASAAS',
  },
  // externalId: { ... } // Se você tivesse um ID genérico para outros gateways
}, {
  tableName: 'plans',
  timestamps: true,
  comment: 'Define os diferentes planos de assinatura disponíveis',
  indexes: [ // <<< ADICIONAR ÍNDICE PARA O NOVO CAMPO
    { fields: ['hotmartProductId'], unique: true, where: { hotmartProductId: { [require('sequelize').Op.ne]: null } } },
    { fields: ['asaasProductId'], unique: true, where: { asaasProductId: { [require('sequelize').Op.ne]: null } } }
  ]
});

Plan.associate = (models) => {
  Plan.hasMany(models.Subscription, { foreignKey: 'planId', as: 'subscriptions' });
};

module.exports = Plan;
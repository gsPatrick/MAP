// src/models/AffiliateClick.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Cada ABERTURA do link de um afiliado (um "possível cliente" abriu o link).
// createdAt = horário que abriu. convertedClientId = cliente que se cadastrou a
// partir dessa abertura (melhor esforço), null = ainda não converteu.
const AffiliateClick = sequelize.define('AffiliateClick', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  affiliateClientId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  convertedClientId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  ip: { // IP de quem abriu (para deduplicar aberturas do mesmo visitante na janela)
    type: DataTypes.STRING,
    allowNull: true,
  },
  lastPlanId: { // último plano que o visitante abriu (mesmo sem converter)
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  lastStage: { // última etapa/página: 'link' | 'planos' | 'checkout'
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  tableName: 'affiliate_clicks',
  timestamps: true,
  comment: 'Aberturas do link de afiliado (possíveis clientes).',
  indexes: [
    { fields: ['affiliateClientId'] },
    { fields: ['convertedClientId'] },
    { fields: ['ip'] },
  ],
});

AffiliateClick.associate = (models) => {
  AffiliateClick.belongsTo(models.Client, { foreignKey: 'affiliateClientId', as: 'affiliate' });
  AffiliateClick.belongsTo(models.Client, { foreignKey: 'convertedClientId', as: 'converted' });
};

module.exports = AffiliateClick;

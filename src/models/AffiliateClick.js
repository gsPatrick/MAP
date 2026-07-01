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
}, {
  tableName: 'affiliate_clicks',
  timestamps: true,
  comment: 'Aberturas do link de afiliado (possíveis clientes).',
  indexes: [
    { fields: ['affiliateClientId'] },
    { fields: ['convertedClientId'] },
  ],
});

AffiliateClick.associate = (models) => {
  AffiliateClick.belongsTo(models.Client, { foreignKey: 'affiliateClientId', as: 'affiliate' });
  AffiliateClick.belongsTo(models.Client, { foreignKey: 'convertedClientId', as: 'converted' });
};

module.exports = AffiliateClick;

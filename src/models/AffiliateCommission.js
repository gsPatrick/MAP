// src/models/AffiliateCommission.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Registro POR VENDA da comissão de afiliado (ledger). Permite histórico
// (diário/semanal/mensal/anual), idempotência (1 comissão por assinatura) e estorno.
const AffiliateCommission = sequelize.define('AffiliateCommission', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  affiliateClientId: { // Quem GANHA a comissão (o indicador)
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  referredClientId: { // Quem foi indicado (comprou)
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  subscriptionId: { // Assinatura que gerou a comissão (UNIQUE -> idempotência)
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
  },
  planId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  planName: { // snapshot do nome do plano na hora da venda
    type: DataTypes.STRING,
    allowNull: true,
  },
  amount: { // valor da comissão (snapshot)
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  status: {
    type: DataTypes.ENUM('Creditada', 'Estornada'),
    defaultValue: 'Creditada',
    allowNull: false,
  },
  payoutId: { // Saque que "fechou" esta comissão (null = ainda em aberto)
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  tableName: 'affiliate_commissions',
  timestamps: true,
  comment: 'Ledger de comissões de afiliado (uma linha por venda).',
  indexes: [
    { fields: ['affiliateClientId'] },
    { unique: true, fields: ['subscriptionId'] },
  ],
});

AffiliateCommission.associate = (models) => {
  AffiliateCommission.belongsTo(models.Client, { foreignKey: 'affiliateClientId', as: 'affiliate' });
  AffiliateCommission.belongsTo(models.Client, { foreignKey: 'referredClientId', as: 'referred' });
  AffiliateCommission.belongsTo(models.Plan, { foreignKey: 'planId', as: 'plan' });
  AffiliateCommission.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', as: 'subscription' });
};

module.exports = AffiliateCommission;

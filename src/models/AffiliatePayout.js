// src/models/AffiliatePayout.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Histórico de SAQUES do afiliado. Ao solicitar, o saldo é zerado e vira um
// registro aqui (status 'Solicitado'); o admin marca como 'Pago' após transferir.
const AffiliatePayout = sequelize.define('AffiliatePayout', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  affiliateClientId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  pixKey: { // snapshot da chave PIX no momento do pedido
    type: DataTypes.STRING,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('Solicitado', 'Pago', 'Cancelado'),
    defaultValue: 'Solicitado',
    allowNull: false,
  },
  paidAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  notes: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  tableName: 'affiliate_payouts',
  timestamps: true, // createdAt = data do pedido
  comment: 'Histórico de saques de comissão do afiliado.',
  indexes: [
    { fields: ['affiliateClientId'] },
    { fields: ['status'] },
  ],
});

AffiliatePayout.associate = (models) => {
  AffiliatePayout.belongsTo(models.Client, { foreignKey: 'affiliateClientId', as: 'affiliate' });
};

module.exports = AffiliatePayout;

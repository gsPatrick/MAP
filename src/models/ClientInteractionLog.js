// src/models/ClientInteractionLog.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ClientInteractionLog = sequelize.define('ClientInteractionLog', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  clientId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'clients',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se deletar o cliente, deleta o log (ou SET NULL se preferir manter o log anônimo)
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false,
  },
  messageType: {
    type: DataTypes.ENUM('Incoming', 'Outgoing_Automatic', 'Outgoing_Manual'),
    allowNull: false,
  },
  channel: {
    type: DataTypes.ENUM('WhatsApp', 'System'), // System para logs internos relacionados ao cliente
    defaultValue: 'WhatsApp',
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  status: { // Opcional, dependendo da API do WhatsApp
    type: DataTypes.STRING, // Ex: 'Sent', 'Delivered', 'Read', 'Failed', 'Received'
    allowNull: true,
  }
}, {
  tableName: 'client_interaction_logs',
  timestamps: false, // O timestamp do log já é o 'timestamp' do evento. createdAt/updatedAt não são tão úteis.
  comment: 'Log de interações com clientes via WhatsApp',
});

// ClientInteractionLog.associate = (models) => {
//   ClientInteractionLog.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
// };

module.exports = ClientInteractionLog;
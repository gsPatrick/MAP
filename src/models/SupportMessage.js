// src/models/SupportMessage.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Mensagens do chat de um chamado de suporte.
const SupportMessage = sequelize.define('SupportMessage', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  ticketId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'support_tickets', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  },
  senderType: { // quem enviou
    type: DataTypes.ENUM('client', 'admin'),
    allowNull: false,
  },
  senderName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
}, {
  tableName: 'support_messages',
  timestamps: true,
  indexes: [
    { fields: ['ticketId'] },
  ],
});

SupportMessage.associate = (models) => {
  SupportMessage.belongsTo(models.SupportTicket, { foreignKey: 'ticketId', as: 'ticket' });
  if (models.SupportTicket) {
    models.SupportTicket.hasMany(SupportMessage, { foreignKey: 'ticketId', as: 'messages' });
  }
};

module.exports = SupportMessage;

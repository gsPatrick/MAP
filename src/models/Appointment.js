// src/models/Appointment.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Appointment = sequelize.define('Appointment', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  },
  title: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  eventDateTime: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  durationMinutes: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
  },
  location: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('Scheduled', 'Confirmed', 'Cancelled', 'Completed', 'Rescheduled'),
    defaultValue: 'Scheduled',
    allowNull: false,
  },
  reminderEnabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
  },
  reminderLeadTimeMinutes: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
  },
  reminderSentTimestamp: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // --- CAMPOS PARA TRANSAÇÃO AUTOMÁTICA ---
  associatedValue: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true,
    comment: 'Valor financeiro associado ao compromisso.',
  },
  associatedTransactionType: {
    type: DataTypes.ENUM('Entrada', 'Saída'),
    allowNull: true,
    comment: 'Tipo da transação financeira (Entrada/Saída) a ser criada.',
  },
  transactionGeneratedTimestamp: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Timestamp de quando a transação financeira foi gerada a partir deste compromisso.',
  },
  relatedTransactionId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_transactions',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
    comment: 'ID da transação financeira gerada a partir deste compromisso.',
  },
  // --- FIM DOS CAMPOS ---
  googleEventId: {
    type: DataTypes.STRING(255),
    allowNull: true,
    unique: true,
    comment: 'ID do evento correspondente no Google Calendar',
  },
  googleEventLastUpdated: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Timestamp da última sincronização com o Google Calendar para este evento',
  },
}, {
  tableName: 'appointments',
  timestamps: true,
  comment: 'Compromissos, vinculados a uma FinancialAccount específica',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['eventDateTime'] },
    { fields: ['googleEventId'], unique: true, where: { googleEventId: { [require('sequelize').Op.ne]: null } } },
    { fields: ['status', 'transactionGeneratedTimestamp', 'eventDateTime', 'associatedValue'] }
  ]
});

Appointment.associate = (models) => {
  Appointment.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  Appointment.belongsToMany(models.BusinessClient, {
    through: models.AppointmentBusinessClient,
    foreignKey: 'appointmentId',
    otherKey: 'businessClientId',
    as: 'businessClients'
  });
  Appointment.belongsTo(models.FinancialTransaction, {
      foreignKey: 'relatedTransactionId',
      as: 'relatedTransaction',
      constraints: false
  });
};

module.exports = Appointment;
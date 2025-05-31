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
  // --- Campos para Integração Google Calendar ---
  googleEventId: {
    type: DataTypes.STRING(255), // ID do evento no Google Calendar
    allowNull: true,
    unique: true, // Garante que um evento do Google não seja mapeado para múltiplos appointments
    comment: 'ID do evento correspondente no Google Calendar',
  },
  googleEventLastUpdated: {
    type: DataTypes.DATE, // Timestamp da última atualização vinda do Google ou enviada para o Google
    allowNull: true,
    comment: 'Timestamp da última sincronização com o Google Calendar para este evento',
  },
  // --- Fim dos Campos Google Calendar ---
}, {
  tableName: 'appointments',
  timestamps: true,
  comment: 'Compromissos, vinculados a uma FinancialAccount específica',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['eventDateTime'] },
    { fields: ['googleEventId'], unique: true, where: { googleEventId: { [require('sequelize').Op.ne]: null } } }, // Índice único condicional
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
};

module.exports = Appointment;
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
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },

  // --- Campos de Lembrete para Contas PF (Fluxo Antigo/Simples) ---
  reminderEnabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Usado APENAS para o sistema de lembrete simples de contas PF.',
  },
  reminderLeadTimeMinutes: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
    comment: 'Usado APENAS para o sistema de lembrete simples de contas PF.',
  },
  reminderSentTimestamp: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Usado APENAS para o sistema de lembrete simples de contas PF.',
  },
  // --- Fim dos Campos PF ---

  // --- Campos para Integração Google Calendar ---
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
  // --- Fim dos Campos Google Calendar ---

  // =================================================================
  // === NOVOS CAMPOS PARA FLUXO DE AGENDAMENTO PJ/MEI ===
  // =================================================================
  origin: {
    type: DataTypes.ENUM('System', 'GoogleCalendar'),
    allowNull: false,
    defaultValue: 'System',
    comment: 'Indica a origem do agendamento (criado no sistema ou importado do Google).',
  },
  reminder24hSentAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Timestamp do envio do lembrete de 24h para o cliente final (fluxo PJ/MEI).',
  },
  reminder30minSentAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Timestamp do envio do lembrete de 30min para o cliente final (fluxo PJ/MEI).',
  },
  // =================================================================
  // === FIM DOS NOVOS CAMPOS ===
  // =================================================================

}, {
  tableName: 'appointments',
  timestamps: true,
  comment: 'Compromissos, vinculados a uma FinancialAccount específica',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['eventDateTime'] },
    { fields: ['googleEventId'], unique: true, where: { googleEventId: { [require('sequelize').Op.ne]: null } } },
    // Novos índices para o job de lembretes PJ/MEI
    { fields: ['status', 'eventDateTime', 'reminder24hSentAt'] },
    { fields: ['status', 'eventDateTime', 'reminder30minSentAt'] },
  ]
});

Appointment.associate = (models) => {
  // Associação existente com a conta financeira
  Appointment.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  
  // Associação existente com os clientes do negócio
  Appointment.belongsToMany(models.BusinessClient, {
    through: models.AppointmentBusinessClient,
    foreignKey: 'appointmentId',
    otherKey: 'businessClientId',
    as: 'businessClients'
  });

  // =================================================================
  // === NOVA ASSOCIAÇÃO COM SERVIÇOS (FLUXO PJ/MEI) ===
  // =================================================================
  Appointment.belongsToMany(models.Service, {
    through: models.AppointmentService, // <<< CORREÇÃO AQUI
    foreignKey: 'appointmentId',
    otherKey: 'serviceId',
    as: 'services'
  });
  // =================================================================
  // === FIM DA NOVA ASSOCIAÇÃO ===
  // =================================================================
};


module.exports = Appointment;
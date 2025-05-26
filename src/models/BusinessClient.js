// src/models/Appointment.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Appointment = sequelize.define('Appointment', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: { // Contexto do compromisso (pessoal via conta PF, ou profissional via conta PJ/MEI)
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts', // Nome da tabela 'financial_accounts'
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se a FinancialAccount for deletada, seus compromissos também são
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
    type: DataTypes.DATE, // Data e Hora com fuso horário
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
  // userId: { // Se um User (admin do sistema) agendou para uma FinancialAccount
  //   type: DataTypes.INTEGER,
  //   allowNull: true,
  //   references: { model: 'users', key: 'id' },
  //   onUpdate: 'CASCADE',
  //   onDelete: 'SET NULL',
  // },
}, {
  tableName: 'appointments',
  timestamps: true,
  comment: 'Compromissos, vinculados a uma FinancialAccount específica',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['eventDateTime'] },
  ]
});

Appointment.associate = (models) => {
  Appointment.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  // if (models.User) {
  //   Appointment.belongsTo(models.User, { foreignKey: 'userId', as: 'schedulerAdmin' });
  // }
  // NOVA ASSOCIAÇÃO: Many-to-Many com BusinessClient através de AppointmentBusinessClient
  Appointment.belongsToMany(models.BusinessClient, {
    through: models.AppointmentBusinessClient,
    foreignKey: 'appointmentId', // FK neste modelo (Appointment) para a tabela de junção
    otherKey: 'businessClientId', // FK no outro modelo (BusinessClient) para a tabela de junção
    as: 'businessClients' // Alias para acessar os clientes de negócio associados
  });

};

module.exports = Appointment;
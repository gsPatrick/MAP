// src/models/UserPreference.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UserPreference = sequelize.define('UserPreference', {
  id: { // Se for 1:1 com User, pode ser a FK. Se for configuração global, pode ser autoIncrement.
    type: DataTypes.INTEGER,
    autoIncrement: true, // Se for uma tabela de configs gerais, não atrelada a um User específico
    primaryKey: true,
  },
  // userId: { // Descomente se for 1:1 com o modelo User
  //   type: DataTypes.INTEGER,
  //   allowNull: false,
  //   unique: true,
  //   references: {
  //     model: 'users',
  //     key: 'id',
  //   },
  //   onUpdate: 'CASCADE',
  //   onDelete: 'CASCADE',
  // },

  // Lembrete de Beber Água
  enableWaterReminder: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  waterReminderFrequencyType: {
    type: DataTypes.ENUM('disabled', '2h', '3h', 'custom'), // 'disabled' para desligar sem perder config
    defaultValue: 'disabled',
  },
  waterReminderCustomIntervalMinutes: { // Usado se frequencyType for 'custom'
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 30 }, // Ex: mínimo 30 minutos
  },
  waterReminderStartTime: {
    type: DataTypes.TIME, // Formato 'HH:MM:SS'
    defaultValue: '09:00:00',
  },
  waterReminderEndTime: {
    type: DataTypes.TIME,
    defaultValue: '18:00:00',
  },
  dailyGoalMl: { // Adicionado para meta de água
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 0 }
  },
  lastWaterReminderSentTimestamp: { // NOVO CAMPO para controle de envio dos lembretes de água
    type: DataTypes.DATE,           // DATETIME para guardar data e hora precisa do último envio
    allowNull: true,
  },


  // Mensagem Diária de Motivação
  enableMotivationMessage: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  motivationMessageTime: {
    type: DataTypes.TIME,
    defaultValue: '08:00:00',
  },
  lastMotivationalMessageSentDate: { 
    type: DataTypes.DATEONLY,        
    allowNull: true,
  },

  // Configurações de Relatórios e Resumos Automáticos
  dailySummaryTime: { 
    type: DataTypes.TIME,
    defaultValue: '19:00:00',
  },
  weeklySummaryDayOfWeek: { 
    type: DataTypes.INTEGER,
    defaultValue: 5, 
    validate: { min: 0, max: 6},
  },
  weeklySummaryTime: {
    type: DataTypes.TIME,
    defaultValue: '10:00:00',
  },
  monthlyReportDayOfMonth: { 
    type: DataTypes.INTEGER,
    defaultValue: 1, 
    validate: { min: 1, max: 28 }, 
  },
  monthlyReportTime: {
    type: DataTypes.TIME,
    defaultValue: '10:00:00',
  },

  // Configurações de Lembretes de Compromisso (Padrões)
  defaultAppointmentReminderLeadTimeMinutes: {
    type: DataTypes.INTEGER,
    defaultValue: 60, 
    comment: 'Tempo padrão de antecedência para lembretes de compromissos (em minutos)',
  },

  // --- Campos para agendamento dos Jobs ---
  recurringJobSchedule: {
    type: DataTypes.STRING,
    defaultValue: '0 4 * * *', 
    comment: 'Schedule cron para o job de transações recorrentes.',
  },
  appointmentReminderJobSchedule: {
    type: DataTypes.STRING,
    defaultValue: '*/5 * * * *', 
    comment: 'Schedule cron para o job de lembretes de compromisso.',
  },
  alertsJobSchedule: {
    type: DataTypes.STRING,
    defaultValue: '0 9 * * *', 
    comment: 'Schedule cron para o job de alertas (vencimentos, estoque).',
  },
  // --- Campos para controle de alertas ---
  dueAlertLeadDays: {
    type: DataTypes.INTEGER,
    defaultValue: 3,
    comment: 'Dias de antecedência para alerta de contas a vencer.'
  },
  fiscalAlertLeadDaysMEI: {
    type: DataTypes.INTEGER,
    defaultValue: 5,
    comment: 'Dias de antecedência para alerta fiscal MEI (ex: DAS).'
  },

}, {
  tableName: 'user_preferences',
  timestamps: true,
  comment: 'Configurações gerais do sistema e preferências do usuário (atualmente globais)',
});

// UserPreference.associate = (models) => {
//   if (models.User) { // Se o modelo User existir e as preferências forem por usuário
//      UserPreference.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
//   }
// };

module.exports = UserPreference;
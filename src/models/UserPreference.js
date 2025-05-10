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

  // Mensagem Diária de Motivação
  enableMotivationMessage: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  motivationMessageTime: {
    type: DataTypes.TIME,
    defaultValue: '08:00:00',
  },

  // Configurações de Relatórios e Resumos Automáticos
  dailySummaryTime: { // Para resumo financeiro diário, etc.
    type: DataTypes.TIME,
    defaultValue: '19:00:00',
  },
  weeklySummaryDayOfWeek: { // 0 (Dom) a 6 (Sab)
    type: DataTypes.INTEGER,
    defaultValue: 5, // Sexta-feira
    validate: { min: 0, max: 6},
  },
  weeklySummaryTime: {
    type: DataTypes.TIME,
    defaultValue: '10:00:00',
  },
  monthlyReportDayOfMonth: { // 1 a 28 (para simplificar, evitar meses com menos dias) ou -1 para último dia
    type: DataTypes.INTEGER,
    defaultValue: 1, // Dia 1 do mês
    validate: { min: 1, max: 28 }, // ou lógica mais complexa para último dia do mês
  },
  monthlyReportTime: {
    type: DataTypes.TIME,
    defaultValue: '10:00:00',
  },

  // Configurações de Lembretes de Compromisso (Padrões)
  defaultAppointmentReminderLeadTimeMinutes: {
    type: DataTypes.INTEGER,
    defaultValue: 60, // 1 hora antes como padrão
    comment: 'Tempo padrão de antecedência para lembretes de compromissos (em minutos)',
  },

  // Poderia ter IDs de categorias padrão aqui
  // defaultExpenseCategoryId: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'financial_categories', key: 'id' }},
  // defaultIncomeCategoryId: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'financial_categories', key: 'id' }},

}, {
  tableName: 'user_preferences',
  timestamps: true,
  comment: 'Configurações gerais do sistema e preferências do usuário',
});

// UserPreference.associate = (models) => {
//   if (models.User) { // Se o modelo User existir
//      UserPreference.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
//   }
// };

module.exports = UserPreference;
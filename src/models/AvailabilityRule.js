// src/models/AvailabilityRule.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AvailabilityRule = sequelize.define('AvailabilityRule', {
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
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Um título para a regra (ex: "Horário de Trabalho Padrão", "Feriado de Natal").'
  },
  type: {
    type: DataTypes.ENUM('work', 'break', 'day_off'),
    allowNull: false,
    comment: "'work' para horários de trabalho, 'break' para pausas, 'day_off' para folgas.",
  },
  rrule: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Regra de recorrência no formato iCalendar (RRULE string), ex: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR".'
  },
  startTime: {
    type: DataTypes.TIME, // Ex: '09:00:00'
    allowNull: true,
    comment: 'Hora de início para a regra (para work e break).',
  },
  endTime: {
    type: DataTypes.TIME, // Ex: '18:00:00'
    allowNull: true,
    comment: 'Hora de fim para a regra (para work e break).',
  },
  specificDate: {
    type: DataTypes.DATEONLY, // Ex: '2024-12-25'
    allowNull: true,
    comment: 'Data específica para regras de folga de um dia.',
  },
  slotIntervalMinutes: {
    type: DataTypes.INTEGER,
    defaultValue: 15,
    allowNull: true,
    comment: 'Intervalo em minutos para sugerir slots de agendamento (ex: de 15 em 15 min). Aplicável a regras "work".'
  }
}, {
  tableName: 'availability_rules',
  timestamps: true,
  comment: 'Regras de disponibilidade e horários de trabalho para contas PJ/MEI.',
  indexes: [
    { fields: ['financialAccountId', 'type'] }
  ],
});

AvailabilityRule.associate = (models) => {
  AvailabilityRule.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
};

module.exports = AvailabilityRule;
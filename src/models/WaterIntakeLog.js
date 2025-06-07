// src/models/WaterIntakeLog.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WaterIntakeLog = sequelize.define('WaterIntakeLog', {
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
    onDelete: 'CASCADE',
  },
  intakeDate: { // A data do registro
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  scheduledTime: { // O horário que estava agendado para beber
    type: DataTypes.TIME, // Formato 'HH:MM:SS'
    allowNull: false,
  },
  amount: { // Quantidade em ml
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('pending', 'completed', 'notified'),
    defaultValue: 'pending',
    allowNull: false,
  },
  completedAt: { // Timestamp de quando foi marcado como completo
    type: DataTypes.DATE,
    allowNull: true,
  }
}, {
  tableName: 'water_intake_logs',
  timestamps: true,
  comment: 'Log de consumo de água diário por cliente.',
  indexes: [
    { fields: ['clientId', 'intakeDate'] }
  ]
});

WaterIntakeLog.associate = (models) => {
  WaterIntakeLog.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
};

module.exports = WaterIntakeLog;
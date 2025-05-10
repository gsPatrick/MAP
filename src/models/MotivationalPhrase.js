// src/models/MotivationalPhrase.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MotivationalPhrase = sequelize.define('MotivationalPhrase', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  // category: { // Opcional: para categorizar frases (ex: Negócios, Vida, etc.)
  //   type: DataTypes.STRING,
  //   allowNull: true,
  // }
}, {
  tableName: 'motivational_phrases',
  timestamps: true, // Para saber quando foi adicionada/modificada
  comment: 'Frases motivacionais para envio diário',
});

module.exports = MotivationalPhrase;
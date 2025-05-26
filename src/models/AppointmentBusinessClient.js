// src/models/AppointmentBusinessClient.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database'); // <--- Importa a instância

// Tabela de junção para o relacionamento Many-to-Many entre Appointment e BusinessClient
const AppointmentBusinessClient = sequelize.define('AppointmentBusinessClient', {
  appointmentId: {
    type: DataTypes.INTEGER,
    references: {
      model: 'appointments', // Nome da tabela
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se um compromisso for deletado, a associação é deletada
    primaryKey: true, // Parte da chave primária composta
  },
  businessClientId: {
    type: DataTypes.INTEGER,
    references: {
      model: 'business_clients', // Nome da tabela
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se um business client for deletado, a associação é deletada
    primaryKey: true, // Parte da chave primária composta
  },
}, {
  sequelize, // <--- Passa a instância do sequelize importada
  modelName: 'AppointmentBusinessClient', // <--- Define explicitamente o nome do modelo
  tableName: 'appointment_business_clients',
  timestamps: true, // createdAt e updatedAt para saber quando a associação foi feita
  comment: 'Tabela de junção para associar BusinessClients a Appointments',
});

// Nenhuma associação é definida NESTE modelo, mas sim nos modelos Appointment e BusinessClient
// através da opção 'through'.

module.exports = AppointmentBusinessClient;
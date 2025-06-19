// src/models/AppointmentService.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * Tabela de junção para o relacionamento Muitos-para-Muitos (N:N)
 * entre Appointment e Service. Esta tabela representa os "itens" de
 * um agendamento, permitindo que múltiplos serviços sejam associados
 * a um único compromisso.
 */
const AppointmentService = sequelize.define('AppointmentService', {
  appointmentId: {
    type: DataTypes.INTEGER,
    references: {
      model: 'appointments', // Nome da tabela de compromissos
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se o compromisso for deletado, a associação com o serviço também é.
    primaryKey: true,    // Parte da chave primária composta
  },
  serviceId: {
    type: DataTypes.INTEGER,
    references: {
      model: 'services', // Nome da nova tabela de serviços
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se o serviço for deletado do catálogo, a associação é removida.
    primaryKey: true,    // Parte da chave primária composta
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    validate: {
      min: 1,
    },
    comment: 'Quantidade do serviço agendado (ex: 2x Manicure)',
  },
  priceAtTimeOfBooking: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    comment: 'Preço do serviço no momento do agendamento, para garantir integridade financeira caso o preço no catálogo mude.',
    validate: {
      isDecimal: true,
      min: 0
    }
  }
}, {
  sequelize,
  modelName: 'AppointmentService',
  tableName: 'appointment_services',
  timestamps: true, // Adiciona createdAt e updatedAt para saber quando a associação foi feita/alterada.
  comment: 'Tabela de junção para associar Serviços a Compromissos (Appointments).',
});

// Nenhuma associação (belongsTo, hasMany) é definida DIRETAMENTE neste modelo.
// A mágica acontece nos modelos Appointment e Service através da opção 'through'.

module.exports = AppointmentService;
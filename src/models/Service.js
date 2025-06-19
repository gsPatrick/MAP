// src/models/Service.js
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');

const Service = sequelize.define('Service', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts', // Nome da tabela
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    comment: 'ID da Conta Financeira (PJ/MEI) que oferece este serviço.',
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'Nome do serviço oferecido (ex: "Consulta Inicial", "Manicure e Pedicure").',
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Descrição detalhada do que o serviço inclui.',
  },
  durationMinutes: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 1,
    },
    comment: 'Duração padrão do serviço em minutos.',
  },
  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    validate: {
      isDecimal: true,
      min: 0,
    },
    comment: 'Preço do serviço.',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Indica se o serviço está ativo e pode ser agendado.',
  },
}, {
  sequelize,
  modelName: 'Service',
  tableName: 'services',
  timestamps: true,
  comment: 'Catálogo de serviços oferecidos por contas PJ/MEI.',
  indexes: [
    {
      fields: ['financialAccountId'],
    },
    {
      unique: true,
      fields: ['financialAccountId', 'name'],
      name: 'unique_service_name_per_account',
    },
  ],
});

Service.associate = (models) => {
  // Um serviço pertence a uma única Conta Financeira (PJ/MEI)
  Service.belongsTo(models.FinancialAccount, {
    foreignKey: 'financialAccountId',
    as: 'offeredBy',
  });

  // Um serviço pode estar em múltiplos agendamentos
  Service.belongsToMany(models.Appointment, {
    through: models.AppointmentService,
    foreignKey: 'serviceId',
    otherKey: 'appointmentId',
    as: 'appointments',
  });
};

module.exports = Service;
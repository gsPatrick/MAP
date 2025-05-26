// src/models/BusinessClient.js
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database'); // <--- Importa a instância

const BusinessClient = sequelize.define('BusinessClient', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: { // A qual conta PJ/MEI este cliente pertence
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts', // Nome da tabela
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se a conta financeira for deletada, seus BusinessClients são deletados
    comment: 'ID da Conta Financeira (PJ/MEI) à qual este cliente pertence',
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Nome do cliente do negócio (pessoa física ou empresa)',
  },
  phone: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Número de telefone do cliente do negócio (opcional)',
    validate: {
      isNumeric: { msg: 'Telefone deve conter apenas números.', args: ['pt-BR'], skipNull: true },
      len: { msg: 'Telefone deve ter entre 8 e 15 dígitos.', args: [8, 15], skipNull: true }, // Ajuste o range conforme necessário
    }
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Email do cliente do negócio (opcional)',
    validate: {
      isEmail: { msg: 'Formato de email inválido.', skipNull: true },
    }
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Notas sobre o cliente do negócio',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Indica se o cliente do negócio está ativo',
  }
}, {
  sequelize, // <--- Passa a instância do sequelize importada
  modelName: 'BusinessClient', // <--- Define explicitamente o nome do modelo
  tableName: 'business_clients',
  timestamps: true,
  comment: 'Clientes de Negócio associados a contas PJ/MEI',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['financialAccountId', 'isActive'] },
    // Índice único combinado para nome DENTRO da mesma conta financeira
    { unique: true, fields: ['financialAccountId', 'name'], name: 'unique_business_client_name_per_account' },
    // Índices únicos opcionais para telefone/email DENTRO da mesma conta financeira (ignorando NULLs)
    { unique: true, fields: ['financialAccountId', 'phone'], where: { phone: { [Op.ne]: null } }, name: 'unique_business_client_phone_per_account' },
    { unique: true, fields: ['financialAccountId', 'email'], where: { email: { [Op.ne]: null } }, name: 'unique_business_client_email_per_account' }
  ],
  hooks: {
    beforeCreate: (client) => {
      if (client.phone) client.phone = client.phone.replace(/\D/g, '');
      if (client.email) client.email = client.email.toLowerCase();
    },
    beforeUpdate: (client) => {
       if (client.changed('phone') && client.phone) client.phone = client.phone.replace(/\D/g, '');
       if (client.changed('email') && client.email) client.email = client.email.toLowerCase();
    }
  }
});

BusinessClient.associate = (models) => {
  BusinessClient.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  // Relacionamento Many-to-Many com Appointment através da tabela de junção AppointmentBusinessClient
  BusinessClient.belongsToMany(models.Appointment, {
    through: models.AppointmentBusinessClient,
    foreignKey: 'businessClientId',
    otherKey: 'appointmentId',
    as: 'appointments'
  });
};

module.exports = BusinessClient;
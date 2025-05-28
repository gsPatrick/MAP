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
    onDelete: 'CASCADE',
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
    // A validação isNumeric e len foi movida para o serviço para permitir flexibilidade e normalização
    // Se quiser manter no modelo, certifique-se que a normalização acontece ANTES da validação.
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Email do cliente do negócio (opcional)',
    validate: {
      isEmailOrNull(value) {
        if (value === null || value === '' || value === undefined) return;
        if (!/^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/g.test(value)) {
          throw new Error('Formato de email inválido.');
        }
      }
    }
  },
  photoUrl: { // <<< CAMPO ADICIONADO AQUI
    type: DataTypes.STRING(2048), // URL pode ser longa
    allowNull: true,
    validate: {
      isUrlOrNull(value) {
        if (value === null || value === '' || value === undefined) return;
        // Regex simples para URL, pode ser aprimorada se necessário
        if (!/^(https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*))$/i.test(value)) {
          throw new Error('URL da foto inválida. Deve ser uma URL HTTP/HTTPS válida.');
        }
      }
    },
    comment: 'URL para a foto/logo do cliente de negócio (opcional)',
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
  sequelize,
  modelName: 'BusinessClient',
  tableName: 'business_clients',
  timestamps: true,
  comment: 'Clientes de Negócio associados a contas PJ/MEI',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['financialAccountId', 'isActive'] },
    { unique: true, fields: ['financialAccountId', 'name'], name: 'unique_business_client_name_per_account' },
    { unique: true, fields: ['financialAccountId', 'phone'], where: { phone: { [Op.ne]: null } }, name: 'unique_business_client_phone_per_account' },
    { unique: true, fields: ['financialAccountId', 'email'], where: { email: { [Op.ne]: null } }, name: 'unique_business_client_email_per_account' }
  ],
  hooks: {
    beforeValidate: (client, options) => { // Adicionado options para consistência
      if (client.phone && typeof client.phone === 'string') {
        client.phone = client.phone.replace(/\D/g, '');
      }
      if (client.email && typeof client.email === 'string') {
        client.email = client.email.toLowerCase().trim();
      }
      // Garante que photoUrl seja null se for uma string vazia ou apenas espaços
      if (client.photoUrl && typeof client.photoUrl === 'string' && client.photoUrl.trim() === '') {
        client.photoUrl = null;
      }
      // Garante que notes seja null se for uma string vazia ou apenas espaços
      if (client.notes && typeof client.notes === 'string' && client.notes.trim() === '') {
        client.notes = null;
      }
    },
    // Os hooks beforeCreate e beforeUpdate são redundantes se beforeValidate já faz a normalização.
    // Removidos para simplificar, já que beforeValidate é chamado em ambos os casos.
  }
});

BusinessClient.associate = (models) => {
  BusinessClient.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  BusinessClient.belongsToMany(models.Appointment, {
    through: models.AppointmentBusinessClient, // Nome do modelo da tabela de junção
    foreignKey: 'businessClientId',
    otherKey: 'appointmentId',
    as: 'appointments'
  });
};

module.exports = BusinessClient;
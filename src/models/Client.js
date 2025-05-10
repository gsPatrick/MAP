// src/models/Client.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Client = sequelize.define('Client', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: { // Nome da pessoa/contato do WhatsApp
    type: DataTypes.STRING,
    allowNull: true, // Pode ser preenchido após o primeiro contato, ou vir do WhatsApp (pushName)
    comment: 'Nome do contato do WhatsApp (pessoa física)',
  },
  phone: { // Número do WhatsApp, identificador principal do contato
    type: DataTypes.STRING,
    allowNull: false,
    unique: true, // Garante que cada número de telefone seja único
    comment: 'Número de telefone do WhatsApp do cliente (com DDI+DDD)',
  },
  email: { // Opcional, se o sistema coletar e usar email para algo além do WhatsApp
    type: DataTypes.STRING,
    allowNull: true,
    unique: true, // Se presente, deve ser único
    validate: {
      isEmail: true,
    },
    comment: 'Email opcional do cliente',
  },
  status: { // Status do contato no sistema
    type: DataTypes.ENUM('Ativo', 'Inativo', 'Bloqueado'),
    defaultValue: 'Ativo',
    allowNull: false,
    comment: 'Status do cliente no sistema (ex: Ativo, Bloqueado)',
  },
  // O campo 'type' (PF/PJ) foi movido para FinancialAccount.js
  // Outros campos que eram do Cliente e agora são da FinancialAccount (document, fantasyName) também foram movidos.
}, {
  tableName: 'clients',
  timestamps: true, // createdAt, updatedAt
  comment: 'Representa o contato do WhatsApp (a pessoa física/usuário do bot)',
  indexes: [
    { unique: true, fields: ['phone'] }
  ]
});

Client.associate = (models) => {
  // Um Cliente (pessoa) pode ter várias Contas Financeiras (PF, PJ, MEI)
  Client.hasMany(models.FinancialAccount, {
    foreignKey: 'clientId',
    as: 'financialAccounts',
    onDelete: 'CASCADE', // Se o cliente for deletado, suas contas financeiras também são
  });

  // Log de interações do WhatsApp com este cliente
  Client.hasMany(models.ClientInteractionLog, {
    foreignKey: 'clientId',
    as: 'interactionLogs',
    onDelete: 'CASCADE',
  });

  // Outras associações diretas com Client, se houver (ex: preferências de notificação globais do Client)
};

module.exports = Client;
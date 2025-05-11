// src/models/Subscription.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Subscription = sequelize.define('Subscription', {
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
    onDelete: 'CASCADE', // Se o cliente for deletado, suas assinaturas também são
  },
  planId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'plans',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT', // Não permitir deletar um plano se houver assinaturas ativas (ou SET NULL e tratar)
  },
  startDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    comment: 'Data de início da vigência da assinatura',
  },
  endDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    comment: 'Data de término da vigência da assinatura',
  },
  status: {
    type: DataTypes.ENUM('Ativa', 'Inativa', 'Cancelada', 'Pendente', 'Expirada'),
    allowNull: false,
    defaultValue: 'Pendente',
    comment: 'Status atual da assinatura',
  },
  // externalSubscriptionId: { // Para ID da assinatura na plataforma de pagamento
  //   type: DataTypes.STRING,
  //   allowNull: true,
  //   unique: true,
  //   comment: 'ID da assinatura na plataforma de pagamento externa'
  // },
  // paymentDetails: { // JSONB para armazenar detalhes do último pagamento ou da configuração do pagamento
  //   type: DataTypes.JSONB,
  //   allowNull: true,
  //   comment: 'Detalhes do pagamento ou configuração da assinatura externa'
  // },
  autoRenew: { // Se a assinatura deve ser renovada automaticamente (lógica a ser implementada com webhooks)
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  }
}, {
  tableName: 'subscriptions',
  timestamps: true,
  comment: 'Registra as assinaturas dos clientes aos planos',
  indexes: [
    { fields: ['clientId'] },
    { fields: ['planId'] },
    { fields: ['status'] },
    { fields: ['endDate'] },
    // Índice para buscar rapidamente a assinatura ativa de um cliente
    { fields: ['clientId', 'status', 'endDate'] }
  ]
});

Subscription.associate = (models) => {
  Subscription.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
  Subscription.belongsTo(models.Plan, { foreignKey: 'planId', as: 'plan' });
};

module.exports = Subscription;
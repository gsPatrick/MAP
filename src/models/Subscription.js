// src/models/Subscription.js
const { DataTypes, Op } = require('sequelize'); // Adicione Op se for usar no índice
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
    onDelete: 'CASCADE',
  },
  planId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'plans',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
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
    type: DataTypes.ENUM('Ativa', 'Inativa', 'Cancelada', 'Pendente', 'Expirada', 'Pagamento Falhou'), // Adicionei 'Pagamento Falhou'
    allowNull: false,
    defaultValue: 'Pendente',
    comment: 'Status atual da assinatura',
  },
  externalSubscriptionId: { // <<<<<< DESCOMENTE ESTA SEÇÃO
    type: DataTypes.STRING,
    allowNull: true, // Pode ser nulo se a assinatura não for de um gateway externo
    unique: true,    // Garante que cada ID externo seja único
    comment: 'ID da assinatura na plataforma de pagamento externa (ex: Hotmart subscriber_code ou transactionId)'
  },
  // paymentDetails: { ... } // Mantenha comentado se não estiver usando
  autoRenew: {
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
    { fields: ['clientId', 'status', 'endDate'] },
    // Adicione um índice para externalSubscriptionId se você descomentá-lo:
    { fields: ['externalSubscriptionId'], unique: true, where: { externalSubscriptionId: { [Op.ne]: null } } } // <<< DESCOMENTE OU ADICIONE
  ]
});

Subscription.associate = (models) => {
  Subscription.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
  Subscription.belongsTo(models.Plan, { foreignKey: 'planId', as: 'plan' });
};

module.exports = Subscription;
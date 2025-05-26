// src/models/FinancialAccount.js
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');

const FinancialAccount = sequelize.define('FinancialAccount', {
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
  accountName: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Nome identificador da conta financeira (ex: Pessoal, Empresa X)',
  },
  accountType: {
    type: DataTypes.ENUM('PF', 'PJ', 'MEI'),
    allowNull: false,
    comment: 'Tipo de conta financeira: PF, PJ, ou MEI',
  },
  documentNumber: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    comment: 'CPF (para PF) ou CNPJ (para PJ/MEI) associado a esta conta financeira',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Indica se a conta financeira está ativa e pode ser usada',
  },
  isDefault: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
    comment: 'Indica se esta é a conta padrão para operações do cliente',
  },
}, {
  tableName: 'financial_accounts',
  timestamps: true,
  comment: 'Contas/Perfis financeiros distintos de um Cliente (PF, PJ, MEI)',
  indexes: [
    { fields: ['clientId'] },
    { unique: true, fields: ['clientId', 'accountName'] },
    { unique: true, fields: ['documentNumber'], where: { documentNumber: { [Op.ne]: null } } },
  ]
});

FinancialAccount.associate = (models) => {
  FinancialAccount.belongsTo(models.Client, { foreignKey: 'clientId', as: 'ownerClient' });

  FinancialAccount.hasMany(models.FinancialTransaction, { foreignKey: 'financialAccountId', as: 'transactions', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.RecurringTransactionRule, { foreignKey: 'financialAccountId', as: 'recurringRules', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.CreditCard, { foreignKey: 'financialAccountId', as: 'creditCards', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.Product, { foreignKey: 'financialAccountId', as: 'products', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.Appointment, { foreignKey: 'financialAccountId', as: 'appointments', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.KanbanColumn, { foreignKey: 'financialAccountId', as: 'kanbanColumns', onDelete: 'CASCADE' }); // <<< ADICIONADO AQUI
  // FinancialAccount.hasMany(models.KanbanTask, { foreignKey: 'financialAccountId', as: 'kanbanTasks', onDelete: 'CASCADE' }); // <<< REMOVIDO DAQUI
};

module.exports = FinancialAccount;
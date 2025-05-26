// src/models/FinancialAccount.js
const { DataTypes, Op } = require('sequelize');
// Importa a instância do Sequelize configurada
const sequelize = require('../config/database'); 

const FinancialAccount = sequelize.define('FinancialAccount', { // 'sequelize' é passado explicitamente nas opções abaixo
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
  sequelize, // Passa a instância do sequelize importada
  modelName: 'FinancialAccount', // Define explicitamente o nome do modelo
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
  // --- DEBUG: Dentro de FinancialAccount.associate ---
  console.log("--- DEBUG: Dentro de FinancialAccount.associate ---");
  console.log("models object keys:", Object.keys(models));
  console.log("models.BusinessClient exists:", !!models.BusinessClient);
  console.log("typeof models.BusinessClient:", typeof models.BusinessClient);
  const SequelizeModel = require('sequelize').Model;
  console.log("models.BusinessClient instanceof Sequelize.Model:", models.BusinessClient?.prototype instanceof SequelizeModel);
  console.log("----------------------------------------------------");
  // --- FIM DEBUG ---

  FinancialAccount.belongsTo(models.Client, { foreignKey: 'clientId', as: 'ownerClient' });

  FinancialAccount.hasMany(models.FinancialTransaction, { foreignKey: 'financialAccountId', as: 'transactions', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.RecurringTransactionRule, { foreignKey: 'financialAccountId', as: 'recurringRules', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.CreditCard, { foreignKey: 'financialAccountId', as: 'creditCards', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.Product, { foreignKey: 'financialAccountId', as: 'products', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.Appointment, { foreignKey: 'financialAccountId', as: 'appointments', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.KanbanColumn, { foreignKey: 'financialAccountId', as: 'kanbanColumns', onDelete: 'CASCADE' });
  // NOVA ASSOCIAÇÃO: FinancialAccount tem muitos BusinessClients (linha 68 ou próxima)
  FinancialAccount.hasMany(models.BusinessClient, { foreignKey: 'financialAccountId', as: 'businessClients', onDelete: 'CASCADE' }); // <--- Esta é a linha provável

};

module.exports = FinancialAccount;
// src/models/FinancialAccount.js
const { DataTypes, Op } = require('sequelize'); // <<< ADICIONAR Op AQUI
const sequelize = require('../config/database');

const FinancialAccount = sequelize.define('FinancialAccount', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  clientId: { // Chave estrangeira para o modelo Client
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'clients', // Nome da tabela 'clients'
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se o Client for deletado, suas FinancialAccounts são deletadas
  },
  accountName: { // Nome dado pelo usuário para esta conta (ex: "Pessoal", "Minha Empresa MEI", "Consultoria XPTO")
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Nome identificador da conta financeira (ex: Pessoal, Empresa X)',
  },
  accountType: { // PF (Pessoa Física), PJ (Pessoa Jurídica - Geral), MEI (Microempreendedor Individual)
    type: DataTypes.ENUM('PF', 'PJ', 'MEI'),
    allowNull: false,
    comment: 'Tipo de conta financeira: PF, PJ, ou MEI',
  },
  documentNumber: { // CPF para PF, CNPJ para PJ/MEI
    type: DataTypes.STRING,
    allowNull: true, // Pode ser opcional ou preenchido depois
    unique: true, // Se preenchido, deve ser único no sistema
    comment: 'CPF (para PF) ou CNPJ (para PJ/MEI) associado a esta conta financeira',
  },
  // Adicionar campos específicos para PJ/MEI se necessário para lembretes ou funcionalidades
  // Exemplo:
  // regimeTributario: { // Para PJ
  //   type: DataTypes.ENUM('Simples Nacional', 'Lucro Presumido', 'Lucro Real'),
  //   allowNull: true, // Só se aplica a PJ
  // },
  // dataAberturaEmpresa: { // Para PJ/MEI
  //   type: DataTypes.DATEONLY,
  //   allowNull: true,
  // },
  isActive: { // Se esta conta financeira está ativa para uso
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Indica se a conta financeira está ativa e pode ser usada',
  },
  isDefault: { // Se esta é a conta financeira padrão para o Client no WhatsApp
    type: DataTypes.BOOLEAN,
    defaultValue: false, // A lógica de serviço garantirá que apenas uma seja default por Client
    allowNull: false,
    comment: 'Indica se esta é a conta padrão para operações do cliente',
  },
  // Outros campos específicos da conta, se necessário (ex: banco principal, agência, conta)
}, {
  tableName: 'financial_accounts',
  timestamps: true,
  comment: 'Contas/Perfis financeiros distintos de um Cliente (PF, PJ, MEI)',
  indexes: [
    { fields: ['clientId'] },
    { unique: true, fields: ['clientId', 'accountName'] }, // Um cliente não pode ter duas contas com o mesmo nome
    { unique: true, fields: ['documentNumber'], where: { documentNumber: { [Op.ne]: null } } }, // Documento único se não for nulo // <<< ALTERAÇÃO AQUI PARA USAR Op.ne
    // Índice para ajudar a encontrar a conta default de um cliente rapidamente
    // A unicidade do isDefault=true por clientId será gerenciada na lógica de serviço
  ]
});

FinancialAccount.associate = (models) => {
  FinancialAccount.belongsTo(models.Client, { foreignKey: 'clientId', as: 'ownerClient' });

  // Cada FinancialAccount tem suas próprias transações, recorrências, cartões, produtos, compromissos
  FinancialAccount.hasMany(models.FinancialTransaction, { foreignKey: 'financialAccountId', as: 'transactions', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.RecurringTransactionRule, { foreignKey: 'financialAccountId', as: 'recurringRules', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.CreditCard, { foreignKey: 'financialAccountId', as: 'creditCards', onDelete: 'CASCADE' });
  FinancialAccount.hasMany(models.Product, { foreignKey: 'financialAccountId', as: 'products', onDelete: 'CASCADE' }); // Produtos são por conta PJ/MEI
  FinancialAccount.hasMany(models.Appointment, { foreignKey: 'financialAccountId', as: 'appointments', onDelete: 'CASCADE' });
};

module.exports = FinancialAccount;
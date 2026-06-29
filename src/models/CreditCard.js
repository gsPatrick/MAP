// src/models/CreditCard.js
const { DataTypes, Op } = require('sequelize'); // Op pode ser necessário para índices condicionais
const sequelize = require('../config/database');

const CreditCard = sequelize.define('CreditCard', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: { 
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts', 
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', 
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      notEmpty: { msg: "O nome do cartão não pode ser vazio." },
      len: { args: [2, 100], msg: "O nome do cartão deve ter entre 2 e 100 caracteres."}
    }
  },
  limit: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    validate: {
      min: { args: [0], msg: "O limite do cartão deve ser zero ou positivo." }
    }
  },
  blockedLimit: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    defaultValue: 0,
    comment: 'Parte do limite que o usuário reservou/bloqueou para não gastar.',
    validate: { min: { args: [0], msg: "O limite bloqueado deve ser zero ou positivo." } }
  },
  closingDay: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { 
      min: { args: [1], msg: "O dia de fechamento deve ser entre 1 e 28." }, 
      max: { args: [28], msg: "O dia de fechamento deve ser entre 1 e 28." }
    }
  },
  paymentDay: { 
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { 
      min: { args: [1], msg: "O dia de pagamento deve ser entre 1 e 28." }, 
      max: { args: [28], msg: "O dia de pagamento deve ser entre 1 e 28." }
    }
  },
  isDefault: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  lastFourDigits: {
    type: DataTypes.STRING(4),
    allowNull: true,
    validate: { 
      isNumeric: { msg: "Os últimos quatro dígitos devem ser numéricos." , skipNull: true }, // skipNull para permitir nulo
      len: { args: [4,4], msg: "Os últimos quatro dígitos devem conter exatamente 4 números.", skipNull: true }
    }
  },
  flag: { 
    type: DataTypes.STRING(50), // Aumentado para acomodar nomes de bandeiras
    allowNull: true,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  // NOVOS CAMPOS OPCIONAIS PARA UI
  dominantColor: { 
    type: DataTypes.STRING(20), // Ex: "#6A0DAD" ou "purple-500" ou nome da cor
    allowNull: true,
    comment: 'Cor predominante para UI (opcional, ex: #RRGGBB ou nome)',
  },
  flagIconUrl: { 
    type: DataTypes.STRING(2048), // URL pode ser longa
    allowNull: true,
    validate: {
        isUrlOrNull(value) { // Validação customizada para aceitar null ou URL válida
            if (value === null || value === '') return;
            if (!/^https?:\/\/.+\..+/.test(value)) { // Regex simples para URL
                throw new Error('URL do ícone da bandeira inválida.');
            }
        }
    },
    comment: 'URL para um ícone customizado da bandeira (opcional)',
  }
}, {
  tableName: 'credit_cards',
  timestamps: true,
  comment: 'Cartões de crédito vinculados a uma FinancialAccount',
  indexes: [
    { fields: ['financialAccountId'] },
    // Garante que apenas um cartão pode ser default por financialAccountId
    // Esta unicidade é melhor gerenciada na lógica de serviço ao criar/atualizar,
    // mas um índice parcial pode ajudar se o DB suportar bem.
    // { 
    //   unique: true, 
    //   fields: ['financialAccountId'], 
    //   where: { isDefault: true },
    //   name: 'unique_default_card_per_account' 
    // } 
    // A lógica de um único default é mais complexa de impor via índice único se 
    // você permite que todos sejam false. O serviço já trata isso.
    { 
      unique: true, 
      fields: ['financialAccountId', 'name'],
      name: 'unique_card_name_per_account'
    }
  ]
});

CreditCard.associate = (models) => {
  CreditCard.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  // Se um cartão for deletado, as transações financeiras associadas a ele terão creditCardId = NULL.
  // Se quiser deletar as transações junto (CASCADE), mude onDelete, mas SET NULL é mais seguro para histórico.
  CreditCard.hasMany(models.FinancialTransaction, { foreignKey: 'creditCardId', as: 'transactions', onDelete: 'SET NULL' }); 
};

module.exports = CreditCard;
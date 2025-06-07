// src/models/CreditCard.js
const { DataTypes, Op } = require('sequelize');
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
      isNumeric: { msg: "Os últimos quatro dígitos devem ser numéricos." , skipNull: true },
      len: { args: [4,4], msg: "Os últimos quatro dígitos devem conter exatamente 4 números.", skipNull: true }
    }
  },
  flag: { 
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  lastInvoiceGeneratedId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_transactions',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
    comment: 'ID da última transação de fatura gerada para este cartão.',
  },
  dominantColor: { 
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'Cor predominante para UI (opcional, ex: #RRGGBB ou nome)',
  },
  flagIconUrl: { 
    type: DataTypes.STRING(2048),
    allowNull: true,
    validate: {
        isUrlOrNull(value) {
            if (value === null || value === '') return;
            if (!/^https?:\/\/.+\..+/.test(value)) {
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
    { 
      unique: true, 
      fields: ['financialAccountId', 'name'],
      name: 'unique_card_name_per_account'
    }
  ]
});

CreditCard.associate = (models) => {
  CreditCard.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  CreditCard.hasMany(models.FinancialTransaction, { foreignKey: 'creditCardId', as: 'transactions', onDelete: 'SET NULL' }); 
  
  CreditCard.belongsTo(models.FinancialTransaction, {
    foreignKey: 'lastInvoiceGeneratedId',
    as: 'lastInvoiceGenerated',
    constraints: false,
  });
};

module.exports = CreditCard;
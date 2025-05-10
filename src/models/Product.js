// src/models/Product.js
const { DataTypes, Op } = require('sequelize'); // << IMPORTAR Op AQUI
const sequelize = require('../config/database');

const Product = sequelize.define('Product', {
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
  },
  code: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  costPrice: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true,
    validate: { min: 0 }
  },
  salePrice: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    validate: { min: 0 }
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0 }
  },
  minimumStock: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
    validate: { min: 0 }
  },
  unit: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'UN',
  },
  isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false,
  }
}, {
  tableName: 'products',
  timestamps: true,
  comment: 'Produtos para Controle de Estoque, vinculados a uma FinancialAccount (PJ/MEI)',
  indexes: [
    { fields: ['financialAccountId'] },
    { unique: true, fields: ['financialAccountId', 'name'] },
    // Correção aqui: Usar Op.ne
    { unique: true, fields: ['financialAccountId', 'code'], where: { code: { [Op.ne]: null } } }
  ]
});

Product.associate = (models) => {
  Product.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  Product.hasMany(models.StockMovement, { foreignKey: 'productId', as: 'stockMovements', onDelete: 'RESTRICT' });
};

module.exports = Product;
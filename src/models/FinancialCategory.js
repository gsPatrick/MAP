// src/models/FinancialCategory.js
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');

const FinancialCategory = sequelize.define('FinancialCategory', {
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
    comment: 'ID da Conta Financeira à qual esta categoria pertence',
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Nome da categoria ou subcategoria',
  },
  // CAMPO 'type' REMOVIDO
  parentId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_categories',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    comment: 'ID da categoria pai (para subcategorias)',
  }
}, {
  tableName: 'financial_categories',
  timestamps: true,
  comment: 'Categorias para transações financeiras, vinculadas a uma FinancialAccount e suportando hierarquia',
  indexes: [
    { fields: ['financialAccountId'] },
    // Unicidade do nome da categoria DENTRO de uma financialAccount e DENTRO de um mesmo parentId
    {
      unique: true,
      fields: ['financialAccountId', 'name', 'parentId'],
      name: 'unique_category_name_per_account_parent'
    },
    { fields: ['parentId'] }
  ]
});

FinancialCategory.associate = (models) => {
  FinancialCategory.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  
  FinancialCategory.hasMany(models.FinancialCategory, { as: 'subcategories', foreignKey: 'parentId', onDelete: 'CASCADE' });
  FinancialCategory.belongsTo(models.FinancialCategory, { as: 'parentCategory', foreignKey: 'parentId' });
  
  FinancialCategory.hasMany(models.FinancialTransaction, { foreignKey: 'financialCategoryId', as: 'transactions', onDelete: 'SET NULL' });
};

module.exports = FinancialCategory;
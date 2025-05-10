// src/models/FinancialCategory.js
const { DataTypes } = require('sequelize'); // Não precisa de Op aqui se não usar em where de index
const sequelize = require('../config/database');

const FinancialCategory = sequelize.define('FinancialCategory', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Nome da categoria ou subcategoria',
  },
  type: {
    type: DataTypes.ENUM('Entrada', 'Saída', 'Ambos'),
    allowNull: false,
    defaultValue: 'Ambos',
    comment: 'Indica se a categoria é para Entradas, Saídas ou Ambas',
  },
  isDefault: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Indica se é uma categoria padrão do sistema',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
    comment: 'Indica se a categoria está ativa e pode ser usada',
  },
  parentId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_categories',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
    comment: 'ID da categoria pai (para subcategorias)',
  }
}, {
  tableName: 'financial_categories',
  timestamps: true,
  comment: 'Categorias para transações financeiras (suporta hierarquia de subcategorias)',
  indexes: [
    // Removido o objeto de índice vazio ou problemático.
    // Se você precisar de outros índices, adicione-os aqui corretamente.
    // Exemplo: { fields: ['parentId'] } // Se quiser indexar parentId para buscas rápidas
  ]
});

FinancialCategory.associate = (models) => {
  FinancialCategory.hasMany(models.FinancialCategory, { as: 'subcategories', foreignKey: 'parentId' });
  FinancialCategory.belongsTo(models.FinancialCategory, { as: 'parentCategory', foreignKey: 'parentId' });
  FinancialCategory.hasMany(models.FinancialTransaction, { foreignKey: 'financialCategoryId', as: 'transactions' });
};

module.exports = FinancialCategory;
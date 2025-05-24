// src/models/FinancialCategory.js
const { DataTypes, Op } = require('sequelize'); // Adicionar Op se for usar em índices complexos
const sequelize = require('../config/database');

const FinancialCategory = sequelize.define('FinancialCategory', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: { // NOVO CAMPO: Chave estrangeira para FinancialAccount
    type: DataTypes.INTEGER,
    allowNull: false, // Uma categoria agora SEMPRE pertence a uma FinancialAccount
    references: {
      model: 'financial_accounts',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se a FinancialAccount for deletada, suas categorias também são
    comment: 'ID da Conta Financeira à qual esta categoria pertence',
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Nome da categoria ou subcategoria',
  },
  type: {
    type: DataTypes.ENUM('Entrada', 'Saída', 'Ambos'),
    allowNull: false,
    defaultValue: 'Ambos', // 'Saída' pode ser um default melhor para despesas comuns
    comment: 'Indica se a categoria é para Entradas, Saídas ou Ambas',
  },
  // isDefault não faz mais tanto sentido se as categorias são por perfil,
  // a menos que você queira um conjunto de categorias padrão criadas para cada NOVO perfil.
  // Se for esse o caso, a lógica de criação de FinancialAccount precisaria criar essas categorias padrão.
  // Por ora, vamos remover isDefault e isActive do modelo FinancialCategory individual.
  // A ativação pode ser controlada pela financialAccount pai ou pela presença da categoria.
  // Se uma categoria não for mais desejada, ela pode ser excluída (se não tiver transações)
  // ou as transações podem ser movidas para outra categoria.

  // Removidos isDefault e isActive do modelo de categoria individual.
  // A lógica de "categorias padrão" será gerenciada na criação da FinancialAccount se necessário.
  // A "atividade" de uma categoria pode ser simplesmente sua existência.
  
  parentId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_categories', // Auto-referência
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se a pai for deletada, as filhas também. Ou SET NULL se preferir promover.
                         // CASCADE é mais simples se a estrutura é estritamente hierárquica.
    comment: 'ID da categoria pai (para subcategorias)',
  }
}, {
  tableName: 'financial_categories',
  timestamps: true,
  comment: 'Categorias para transações financeiras, vinculadas a uma FinancialAccount e suportando hierarquia',
  indexes: [
    { fields: ['financialAccountId'] },
    // Unicidade do nome da categoria DENTRO de uma financialAccount e DENTRO de um mesmo parentId
    // (ou seja, duas categorias principais não podem ter o mesmo nome na mesma conta;
    // duas subcategorias do mesmo pai não podem ter o mesmo nome na mesma conta)
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
  // Ao deletar uma categoria, as transações associadas terão financialCategoryId = NULL.
  // Você pode querer impedir a exclusão se houver transações (onDelete: 'RESTRICT') ou reatribuí-las.
};

module.exports = FinancialCategory;
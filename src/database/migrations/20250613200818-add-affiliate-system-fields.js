// src/database/migrations/[timestamp]-add-affiliate-system-fields.js

'use strict';

// Importe DataTypes para usar os tipos de dados do Sequelize
const { DataTypes } = require('sequelize');

module.exports = {
  async up (queryInterface, Sequelize) {
    // Usamos uma transação para garantir que todas as alterações aconteçam ou nenhuma aconteça.
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Adicionar colunas na tabela 'clients'
      await queryInterface.addColumn('clients', 'affiliateCode', {
        type: DataTypes.STRING(12),
        allowNull: true,
        unique: true,
      }, { transaction });

      await queryInterface.addColumn('clients', 'referredByClientId', {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'clients', // Nome da tabela referenciada
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }, { transaction });

      await queryInterface.addColumn('clients', 'balance', {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
      }, { transaction });

      // Adicionar coluna na tabela 'plans'
      await queryInterface.addColumn('plans', 'affiliateCommissionValue', {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
      }, { transaction });

      // Criar as novas tabelas (se você decidir usar a versão complexa no futuro)
      // Por enquanto, vamos manter simples como você pediu.

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  async down (queryInterface, Sequelize) {
    // O 'down' reverte o que o 'up' fez. É importante para rollbacks.
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('clients', 'affiliateCode', { transaction });
      await queryInterface.removeColumn('clients', 'referredByClientId', { transaction });
      await queryInterface.removeColumn('clients', 'balance', { transaction });
      await queryInterface.removeColumn('plans', 'affiliateCommissionValue', { transaction });
      
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
};
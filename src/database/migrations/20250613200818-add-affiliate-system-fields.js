'use strict';

const { DataTypes } = require('sequelize');

module.exports = {
  async up (queryInterface, Sequelize) {
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
          model: 'clients',
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

      // <<<< COLUNA FALTANTE ADICIONADA AQUI >>>>
      await queryInterface.addColumn('clients', 'asaasPayoutPixKey', {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Chave PIX do cliente para receber pagamentos de comissão.',
      }, { transaction });
      // <<<< FIM DA ADIÇÃO >>>>

      // Adicionar coluna na tabela 'plans'
      await queryInterface.addColumn('plans', 'affiliateCommissionValue', {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
      }, { transaction });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  async down (queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('clients', 'affiliateCode', { transaction });
      await queryInterface.removeColumn('clients', 'referredByClientId', { transaction });
      await queryInterface.removeColumn('clients', 'balance', { transaction });
      await queryInterface.removeColumn('clients', 'asaasPayoutPixKey', { transaction }); // <<<< Adicionado ao 'down' também
      await queryInterface.removeColumn('plans', 'affiliateCommissionValue', { transaction });
      
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
};
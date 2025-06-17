// src/database/migrations/[timestamp]-fix-add-asaas-payout-pix-key-to-clients.js

'use strict';

const { DataTypes } = require('sequelize');

module.exports = {
  async up (queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Adiciona APENAS a coluna que estava faltando na migração anterior.
      await queryInterface.addColumn('clients', 'asaasPayoutPixKey', {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Chave PIX do cliente para receber pagamentos de comissão.',
      }, { transaction });

      await transaction.commit();
    } catch (err) {
      // Se a coluna já existir por algum motivo, não quebre o deploy.
      if (err.message.includes('column "asaasPayoutPixKey" of relation "clients" already exists')) {
        console.warn('Coluna "asaasPayoutPixKey" já existe. Pulando a adição.');
        await transaction.commit(); // Commit mesmo assim para não falhar.
      } else {
        await transaction.rollback();
        throw err;
      }
    }
  },

  async down (queryInterface, Sequelize) {
    // O 'down' reverte a ação.
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('clients', 'asaasPayoutPixKey', { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
};
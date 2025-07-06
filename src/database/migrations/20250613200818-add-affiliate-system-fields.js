'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Pega a descrição da tabela 'clients' para verificar as colunas existentes
      const tableInfo = await queryInterface.describeTable('clients', { transaction });

      // Adiciona a coluna 'affiliateCode' APENAS SE ELA NÃO EXISTIR
      if (!tableInfo.affiliateCode) {
        console.log("Coluna 'affiliateCode' não encontrada. Adicionando...");
        await queryInterface.addColumn('clients', 'affiliateCode', {
          type: Sequelize.STRING(12),
          allowNull: true,
          unique: true,
          comment: 'Código único de afiliado deste cliente.',
        }, { transaction });
      } else {
        console.log("Coluna 'affiliateCode' já existe. Pulando adição.");
      }

      // Adiciona a coluna 'referredByClientId' APENAS SE ELA NÃO EXISTIR
      if (!tableInfo.referredByClientId) {
        console.log("Coluna 'referredByClientId' não encontrada. Adicionando...");
        await queryInterface.addColumn('clients', 'referredByClientId', {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: {
            model: 'clients',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
          comment: 'ID do cliente afiliado que indicou este cliente.',
        }, { transaction });
      } else {
        console.log("Coluna 'referredByClientId' já existe. Pulando adição.");
      }
      
      // Adiciona a coluna 'balance' APENAS SE ELA NÃO EXISTIR
      if (!tableInfo.balance) {
        console.log("Coluna 'balance' não encontrada. Adicionando...");
        await queryInterface.addColumn('clients', 'balance', {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0.00,
          comment: 'Saldo de comissões disponível para saque.',
        }, { transaction });
      } else {
        console.log("Coluna 'balance' já existe. Pulando adição.");
      }
      
      // Adiciona a coluna 'asaasPayoutPixKey' APENAS SE ELA NÃO EXISTIR
      if (!tableInfo.asaasPayoutPixKey) {
        console.log("Coluna 'asaasPayoutPixKey' não encontrada. Adicionando...");
        await queryInterface.addColumn('clients', 'asaasPayoutPixKey', {
          type: Sequelize.STRING,
          allowNull: true,
          comment: 'Chave PIX do cliente para receber pagamentos de comissão.',
        }, { transaction });
      } else {
        console.log("Coluna 'asaasPayoutPixKey' já existe. Pulando adição.");
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  async down(queryInterface, Sequelize) {
    // A função 'down' também é modificada para ser segura
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tableInfo = await queryInterface.describeTable('clients', { transaction });
      
      if (tableInfo.affiliateCode) {
        await queryInterface.removeColumn('clients', 'affiliateCode', { transaction });
      }
      if (tableInfo.referredByClientId) {
        await queryInterface.removeColumn('clients', 'referredByClientId', { transaction });
      }
      if (tableInfo.balance) {
        await queryInterface.removeColumn('clients', 'balance', { transaction });
      }
      if (tableInfo.asaasPayoutPixKey) {
        await queryInterface.removeColumn('clients', 'asaasPayoutPixKey', { transaction });
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
};
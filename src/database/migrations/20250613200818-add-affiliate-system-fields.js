'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tableInfo = await queryInterface.describeTable('clients', { transaction });

      if (!tableInfo.affiliateCode) {
        console.log("Coluna 'affiliateCode' não encontrada. Adicionando...");
        await queryInterface.addColumn('clients', 'affiliateCode', {
          type: Sequelize.STRING(12), allowNull: true, unique: true, comment: 'Código único de afiliado deste cliente.',
        }, { transaction });
      } else {
        console.log("Coluna 'affiliateCode' já existe. Pulando adição.");
      }

      if (!tableInfo.referredByClientId) {
        console.log("Coluna 'referredByClientId' não encontrada. Adicionando...");
        await queryInterface.addColumn('clients', 'referredByClientId', {
          type: Sequelize.INTEGER, allowNull: true, references: { model: 'clients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL', comment: 'ID do cliente afiliado que indicou este cliente.',
        }, { transaction });
      } else {
        console.log("Coluna 'referredByClientId' já existe. Pulando adição.");
      }
      
      if (!tableInfo.balance) {
        console.log("Coluna 'balance' não encontrada. Adicionando...");
        await queryInterface.addColumn('clients', 'balance', {
          type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0.00, comment: 'Saldo de comissões disponível para saque.',
        }, { transaction });
      } else {
        console.log("Coluna 'balance' já existe. Pulando adição.");
      }
      
      if (!tableInfo.asaasPayoutPixKey) {
        console.log("Coluna 'asaasPayoutPixKey' não encontrada. Adicionando...");
        await queryInterface.addColumn('clients', 'asaasPayoutPixKey', {
          type: Sequelize.STRING, allowNull: true, comment: 'Chave PIX do cliente para receber pagamentos de comissão.',
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
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // A função 'down' também é segura e só remove se existir
      await queryInterface.removeColumn('clients', 'affiliateCode', { transaction }).catch(() => console.log("Coluna 'affiliateCode' não existia para ser removida."));
      await queryInterface.removeColumn('clients', 'referredByClientId', { transaction }).catch(() => console.log("Coluna 'referredByClientId' não existia para ser removida."));
      await queryInterface.removeColumn('clients', 'balance', { transaction }).catch(() => console.log("Coluna 'balance' não existia para ser removida."));
      await queryInterface.removeColumn('clients', 'asaasPayoutPixKey', { transaction }).catch(() => console.log("Coluna 'asaasPayoutPixKey' não existia para ser removida."));
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
};
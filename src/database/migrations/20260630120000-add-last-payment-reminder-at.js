'use strict';

/**
 * Adiciona financial_transactions.lastPaymentReminderAt — controla a cadência da
 * cobrança "pagou? / ainda não" das contas a pagar/recorrências.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('financial_transactions');
    if (!table.lastPaymentReminderAt) {
      await queryInterface.addColumn('financial_transactions', 'lastPaymentReminderAt', {
        type: Sequelize.DATEONLY,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeColumn('financial_transactions', 'lastPaymentReminderAt');
    } catch (e) {
      // coluna pode não existir; ignora
    }
  },
};

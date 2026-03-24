'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Adicionar novos campos de antecedência para alertas de cartão
    await queryInterface.addColumn('user_preferences', 'cardClosingAlertLeadDays', {
      type: Sequelize.DataTypes.INTEGER,
      defaultValue: 2,
      allowNull: false,
      comment: 'Dias de antecedência para alerta de fechamento de fatura de cartão.'
    });

    await queryInterface.addColumn('user_preferences', 'cardPaymentAlertLeadDays', {
      type: Sequelize.DataTypes.INTEGER,
      defaultValue: 3,
      allowNull: false,
      comment: 'Dias de antecedência para alerta de vencimento de fatura de cartão.'
    });

    // 2. Garantir que a chave mestra de automações esteja ligada por padrão
    // Primeiro, alteramos o default da coluna (para novos registros)
    await queryInterface.changeColumn('user_preferences', 'areAutomatedJobsEnabled', {
      type: Sequelize.DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false
    });

    // Depois, atualizamos o registro existente
    await queryInterface.bulkUpdate('user_preferences', { areAutomatedJobsEnabled: true }, {});
    
    console.log('[MIGRATION] Campos de alerta expandidos e automações habilitadas.');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('user_preferences', 'cardClosingAlertLeadDays');
    await queryInterface.removeColumn('user_preferences', 'cardPaymentAlertLeadDays');
    
    await queryInterface.changeColumn('user_preferences', 'areAutomatedJobsEnabled', {
      type: Sequelize.DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false
    });
  }
};

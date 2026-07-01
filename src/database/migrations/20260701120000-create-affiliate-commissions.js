'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    let exists = true;
    try { await queryInterface.describeTable('affiliate_commissions'); }
    catch (e) { exists = false; }
    if (exists) return;

    await queryInterface.createTable('affiliate_commissions', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      affiliateClientId: { type: Sequelize.INTEGER, allowNull: false },
      referredClientId: { type: Sequelize.INTEGER, allowNull: false },
      subscriptionId: { type: Sequelize.INTEGER, allowNull: false, unique: true },
      planId: { type: Sequelize.INTEGER, allowNull: true },
      planName: { type: Sequelize.STRING, allowNull: true },
      amount: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.ENUM('Creditada', 'Estornada'), allowNull: false, defaultValue: 'Creditada' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('affiliate_commissions', ['affiliateClientId']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('affiliate_commissions');
  },
};

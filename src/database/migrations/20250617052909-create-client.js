'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
  },

  async down (queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
  }
};
'use strict';
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('clients', {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING, allowNull: true },
      phone: { type: DataTypes.STRING, allowNull: false, unique: true },
      email: { type: DataTypes.STRING, allowNull: true, unique: true },
      passwordHash: { type: DataTypes.STRING, allowNull: true },
      debugPassword: { type: DataTypes.STRING, allowNull: true },
      status: { type: DataTypes.ENUM('Ativo', 'Inativo', 'Bloqueado', 'Aguardando Pagamento', 'Pagamento Falhou'), defaultValue: 'Ativo', allowNull: false },
      accessLevel: { type: DataTypes.ENUM('gratuito', 'basico_mensal', 'basico_anual', 'avancado_mensal', 'avancado_anual', 'vitalicio_basico', 'vitalicio_avancado'), defaultValue: 'gratuito', allowNull: false },
      accessExpiresAt: { type: DataTypes.DATEONLY, allowNull: true },
      openai_thread_id: { type: DataTypes.STRING, allowNull: true, unique: true },
      googleAccessToken: { type: DataTypes.STRING(1024), allowNull: true },
      googleRefreshToken: { type: DataTypes.STRING(1024), allowNull: true },
      googleTokenExpiryDate: { type: DataTypes.DATE, allowNull: true },
      googleCalendarIdPrincipal: { type: DataTypes.STRING, allowNull: true },
      isGoogleCalendarSynced: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
      googleCalendarColorIdPF: { type: DataTypes.STRING(2), defaultValue: '1', allowNull: true },
      googleCalendarColorIdPJ: { type: DataTypes.STRING(2), defaultValue: '2', allowNull: true },
      googleChannelId: { type: DataTypes.STRING(255), allowNull: true },
      googleChannelResourceId: { type: DataTypes.STRING(255), allowNull: true },
      googleChannelExpiryDate: { type: DataTypes.DATE, allowNull: true },
      googleLastSyncToken: { type: DataTypes.STRING(255), allowNull: true },
      wantsMotivationMessage: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false },
      motivationMessageTime: { type: DataTypes.TIME, defaultValue: '13:00:00', allowNull: false },
      lastMotivationSentDate: { type: DataTypes.DATEONLY, allowNull: true },
      asaasCustomerId: { type: DataTypes.STRING, allowNull: true, unique: true },
      affiliateCode: { type: DataTypes.STRING(12), allowNull: true, unique: true },
      referredByClientId: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'clients', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      balance: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0.00, allowNull: false },
      asaasPayoutPixKey: { type: DataTypes.STRING, allowNull: true },
      createdAt: { allowNull: false, type: DataTypes.DATE },
      updatedAt: { allowNull: false, type: DataTypes.DATE }
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('clients');
  }
};
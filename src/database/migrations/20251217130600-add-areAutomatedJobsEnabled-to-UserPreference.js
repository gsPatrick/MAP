'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.addColumn('user_preferences', 'areAutomatedJobsEnabled', {
            type: Sequelize.BOOLEAN,
            defaultValue: false,
            allowNull: false,
            comment: 'Switch global para ativar/desativar todos os disparos automáticos de mensagens.'
        });
    },

    async down(queryInterface, Sequelize) {
        await queryInterface.removeColumn('user_preferences', 'areAutomatedJobsEnabled');
    }
};

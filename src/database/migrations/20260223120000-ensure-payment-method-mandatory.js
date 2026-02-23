'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // 1. Atualizar registros existentes que estão como NULL para evitar erro ao mudar para NOT NULL
        // Usamos 'Pix' como valor padrão para transações legadas.
        await queryInterface.sequelize.query(
            'UPDATE "financial_transactions" SET "paymentMethod" = \'Pix\' WHERE "paymentMethod" IS NULL'
        );

        // 2. Alterar a coluna para ser obrigatória (NOT NULL) e ter valor padrão
        await queryInterface.changeColumn('financial_transactions', 'paymentMethod', {
            type: Sequelize.STRING,
            allowNull: false,
            defaultValue: 'Pix'
        });
    },

    async down(queryInterface, Sequelize) {
        // Reverter a obrigatoriedade
        await queryInterface.changeColumn('financial_transactions', 'paymentMethod', {
            type: Sequelize.STRING,
            allowNull: true
        });
    }
};

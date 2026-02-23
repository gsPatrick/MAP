'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // 1. Adicionar campos de atividade no model Client
        await queryInterface.addColumn('clients', 'lastLoginAt', {
            type: Sequelize.DATE,
            allowNull: true,
            comment: 'Data e hora do último login no dashboard web'
        });

        await queryInterface.addColumn('clients', 'lastActiveAt', {
            type: Sequelize.DATE,
            allowNull: true,
            comment: 'Data e hora da última atividade (WhatsApp ou Web)'
        });

        // 2. Adicionar campo originalPurchaseTotalValue em financial_transactions
        await queryInterface.addColumn('financial_transactions', 'originalPurchaseTotalValue', {
            type: Sequelize.DECIMAL(12, 2),
            allowNull: true,
            comment: 'Valor total da compra original, se esta transação for uma parcela ou a "mãe" de um parcelamento.'
        });

        // 3. Adicionar campos de UI em credit_cards
        await queryInterface.addColumn('credit_cards', 'dominantColor', {
            type: Sequelize.STRING(20),
            allowNull: true,
            comment: 'Cor predominante para UI (opcional, ex: #RRGGBB ou nome)'
        });

        await queryInterface.addColumn('credit_cards', 'flagIconUrl', {
            type: Sequelize.STRING(2048),
            allowNull: true,
            comment: 'URL para um ícone customizado da bandeira (opcional)'
        });
    },

    async down(queryInterface, Sequelize) {
        // Remover campos na ordem inversa
        await queryInterface.removeColumn('credit_cards', 'flagIconUrl');
        await queryInterface.removeColumn('credit_cards', 'dominantColor');
        await queryInterface.removeColumn('financial_transactions', 'originalPurchaseTotalValue');
        await queryInterface.removeColumn('clients', 'lastActiveAt');
        await queryInterface.removeColumn('clients', 'lastLoginAt');
    }
};

'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const tableDefinition = await queryInterface.describeTable('clients');
        const transTableDefinition = await queryInterface.describeTable('financial_transactions');
        const cardTableDefinition = await queryInterface.describeTable('credit_cards');

        // 1. Adicionar campos de atividade no model Client
        if (!tableDefinition.lastLoginAt) {
            await queryInterface.addColumn('clients', 'lastLoginAt', {
                type: Sequelize.DATE,
                allowNull: true,
                comment: 'Data e hora do último login no dashboard web'
            });
        }

        if (!tableDefinition.lastActiveAt) {
            await queryInterface.addColumn('clients', 'lastActiveAt', {
                type: Sequelize.DATE,
                allowNull: true,
                comment: 'Data e hora da última atividade (WhatsApp ou Web)'
            });
        }

        // 2. Adicionar campo originalPurchaseTotalValue em financial_transactions
        if (!transTableDefinition.originalPurchaseTotalValue) {
            await queryInterface.addColumn('financial_transactions', 'originalPurchaseTotalValue', {
                type: Sequelize.DECIMAL(12, 2),
                allowNull: true,
                comment: 'Valor total da compra original, se esta transação for uma parcela ou a "mãe" de um parcelamento.'
            });
        }

        // 3. Adicionar campos de UI em credit_cards
        if (!cardTableDefinition.dominantColor) {
            await queryInterface.addColumn('credit_cards', 'dominantColor', {
                type: Sequelize.STRING(20),
                allowNull: true,
                comment: 'Cor predominante para UI (opcional, ex: #RRGGBB ou nome)'
            });
        }

        if (!cardTableDefinition.flagIconUrl) {
            await queryInterface.addColumn('credit_cards', 'flagIconUrl', {
                type: Sequelize.STRING(2048),
                allowNull: true,
                comment: 'URL para um ícone customizado da bandeira (opcional)'
            });
        }
    },

    async down(queryInterface, Sequelize) {
        // Remover campos (o Sequelize removeColumn já é seguro se a coluna não existir ele dá erro, mas aqui mantemos o padrão)
        try { await queryInterface.removeColumn('credit_cards', 'flagIconUrl'); } catch (e) { }
        try { await queryInterface.removeColumn('credit_cards', 'dominantColor'); } catch (e) { }
        try { await queryInterface.removeColumn('financial_transactions', 'originalPurchaseTotalValue'); } catch (e) { }
        try { await queryInterface.removeColumn('clients', 'lastActiveAt'); } catch (e) { }
        try { await queryInterface.removeColumn('clients', 'lastLoginAt'); } catch (e) { }
    }
};

'use strict';

module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('support_tickets', {
            id: {
                type: Sequelize.UUID,
                defaultValue: Sequelize.UUIDV4,
                primaryKey: true,
            },
            clientId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'clients',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            type: {
                type: Sequelize.ENUM('Tecnico', 'Financeiro', 'Duvida', 'Sugestao'),
                allowNull: false,
            },
            subject: {
                type: Sequelize.STRING,
                allowNull: false,
            },
            description: {
                type: Sequelize.TEXT,
                allowNull: false,
            },
            status: {
                type: Sequelize.ENUM('Aberto', 'Em andamento', 'Resolvido'),
                allowNull: false,
                defaultValue: 'Aberto',
            },
            priority: {
                type: Sequelize.ENUM('Baixa', 'Media', 'Alta'),
                allowNull: false,
                defaultValue: 'Media',
            },
            lastResponseAt: {
                type: Sequelize.DATE,
                allowNull: true,
            },
            resolvedAt: {
                type: Sequelize.DATE,
                allowNull: true,
            },
            createdAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
            updatedAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
        });

        await queryInterface.addIndex('support_tickets', ['clientId']);
        await queryInterface.addIndex('support_tickets', ['status']);
        await queryInterface.addIndex('support_tickets', ['type']);
    },

    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('support_tickets');
    }
};

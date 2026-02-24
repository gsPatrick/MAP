'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const transaction = await queryInterface.sequelize.transaction();
        try {
            const tableInfo = await queryInterface.describeTable('clients', { transaction });

            if (!tableInfo.affiliateLinkClicks) {
                await queryInterface.addColumn('clients', 'affiliateLinkClicks', {
                    type: Sequelize.INTEGER,
                    allowNull: false,
                    defaultValue: 0,
                    comment: 'Número de cliques no link de afiliado.',
                }, { transaction });
            }

            if (!tableInfo.affiliateSlug) {
                await queryInterface.addColumn('clients', 'affiliateSlug', {
                    type: Sequelize.STRING(100),
                    allowNull: true,
                    unique: true,
                    comment: 'Slug personalizado para o link de afiliado.',
                }, { transaction });
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
            await queryInterface.removeColumn('clients', 'affiliateLinkClicks', { transaction });
            await queryInterface.removeColumn('clients', 'affiliateSlug', { transaction });
            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    }
};

'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // <<< ANOTAÇÃO IMPORTANTE >>>
    // A função 'up' é o que acontece quando você RODA a migration.
    // Usamos Promise.all para garantir que ambas as tabelas sejam criadas.
    await queryInterface.sequelize.transaction(async (t) => {
      // 1. Criar a tabela 'daily_checklists' primeiro, pois 'checklist_items' depende dela.
      await queryInterface.createTable('daily_checklists', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
        },
        financialAccountId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'financial_accounts', // Nome EXATO da tabela no banco de dados
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        date: {
          type: Sequelize.DATEONLY,
          allowNull: false,
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE
        }
      }, { transaction: t });

      // Adiciona o índice único separadamente para melhor controle e nomeação
      await queryInterface.addIndex('daily_checklists', ['financialAccountId', 'date'], {
        unique: true,
        name: 'unique_checklist_per_account_per_day',
        transaction: t
      });

      // 2. Criar a tabela 'checklist_items' depois.
      await queryInterface.createTable('checklist_items', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
        },
        dailyChecklistId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'daily_checklists', // Nome EXATO da tabela criada acima
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        text: {
          type: Sequelize.STRING(500),
          allowNull: false,
        },
        completed: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        priority: {
          type: Sequelize.ENUM('low', 'medium', 'high'),
          allowNull: false,
          defaultValue: 'medium',
        },
        notes: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        order: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE
        }
      }, { transaction: t });
    });
  },

  async down(queryInterface, Sequelize) {
    // <<< ANOTAÇÃO IMPORTANTE >>>
    // A função 'down' é o que acontece se você precisar REVERTER a migration.
    // A ordem de exclusão é a INVERSA da criação devido às chaves estrangeiras.
    await queryInterface.sequelize.transaction(async (t) => {
      await queryInterface.dropTable('checklist_items', { transaction: t });
      await queryInterface.dropTable('daily_checklists', { transaction: t });
    });
  }
};
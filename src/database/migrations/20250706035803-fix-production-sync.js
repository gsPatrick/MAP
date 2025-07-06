'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Lista de migrations que já existem no banco mas não na SequelizeMeta.
    // Adicionamos todas as migrations de afiliados para garantir.
    const migrationsToMarkAsDone = [
      '20250613200818-add-affiliate-system-fields.js',
      '20250613212453-fix-add-asaas-payout-pix-key-to-clients.js',
      '20250614011024-create-affiliate-tables.js'
    ];

    console.log('Sincronizando migrations de afiliados que já existem no banco...');
    
    // O bulkInsert insere múltiplos registros de uma vez na tabela de controle do Sequelize.
    await queryInterface.bulkInsert('SequelizeMeta',
      migrationsToMarkAsDone.map(name => ({ name })),
      {}
    );

    console.log('Migrations de afiliados marcadas como concluídas.');
  },

  async down(queryInterface, Sequelize) {
    // O 'down' reverteria isso, removendo os registros da SequelizeMeta.
    const migrationsToUndo = [
      '20250613200818-add-affiliate-system-fields.js',
      '20250613212453-fix-add-asaas-payout-pix-key-to-clients.js',
      '20250614011024-create-affiliate-tables.js'
    ];
    
    console.log('Revertendo a sincronização das migrations de afiliados...');
    
    await queryInterface.bulkDelete('SequelizeMeta', {
      name: {
        [Sequelize.Op.in]: migrationsToUndo
      }
    }, {});

    console.log('Sincronização revertida.');
  }
};
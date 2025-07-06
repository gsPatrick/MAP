'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Lista de migrations que já existem no banco mas não na SequelizeMeta
    const migrationsToMarkAsDone = [
      '20250613200818-add-affiliate-system-fields.js' 
      // Se houver outras migrations antigas causando erro, adicione os nomes dos arquivos aqui
    ];

    // O bulkInsert insere múltiplos registros de uma vez
    await queryInterface.bulkInsert('SequelizeMeta',
      migrationsToMarkAsDone.map(name => ({ name })),
      {}
    );
  },

  async down(queryInterface, Sequelize) {
    // O 'down' reverteria isso, removendo os registros da SequelizeMeta
    const migrationsToUndo = [
      '20250613200818-add-affiliate-system-fields.js'
    ];
    
    await queryInterface.bulkDelete('SequelizeMeta', {
      name: {
        [Sequelize.Op.in]: migrationsToUndo
      }
    }, {});
  }
};
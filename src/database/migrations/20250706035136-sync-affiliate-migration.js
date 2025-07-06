'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Esta migration vai dizer ao Sequelize que a migration 'add-affiliate-system-fields' já foi aplicada.
    // Isso vai fazê-lo pular essa etapa e ir para a próxima.
    console.log('Sincronizando a migration de afiliados que já existe no banco...');
    
    await queryInterface.bulkInsert('SequelizeMeta',
      [{ name: '20250613200818-add-affiliate-system-fields.js' }],
      {}
    );

    console.log('Migration de afiliados marcada como concluída.');
  },

  async down(queryInterface, Sequelize) {
    // O 'down' reverte isso, removendo o registro da SequelizeMeta.
    console.log('Revertendo a sincronização da migration de afiliados...');
    
    await queryInterface.bulkDelete('SequelizeMeta', {
      name: '20250613200818-add-affiliate-system-fields.js'
    }, {});

    console.log('Sincronização revertida.');
  }
};
// config/config.js
// Este arquivo traduz suas configurações existentes para o formato que o sequelize-cli entende.

// Carrega as mesmas variáveis de ambiente que sua aplicação usa
require('dotenv').config(); 

// Importa suas opções de banco de dados já existentes
const dbOptions = require('./database-options');

module.exports = {
  development: {
    username: dbOptions.development.username,
    password: dbOptions.development.password,
    database: dbOptions.development.database,
    host: dbOptions.development.host,
    dialect: 'postgres'
  },
  production: {
    username: dbOptions.production.username,
    password: dbOptions.production.password,
    database: dbOptions.production.database,
    host: dbOptions.production.host,
    port: dbOptions.production.port, // Adicionar a porta para produção
    dialect: 'postgres',
    dialectOptions: { // Adicionar opções de SSL para produção
      ssl: dbOptions.production.dialectOptions.ssl
    }
  }
};
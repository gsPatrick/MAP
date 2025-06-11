// src/config/database.js
require('dotenv').config();
const Sequelize = require('sequelize'); // Sequelize com S maiúsculo aqui

const environment = process.env.NODE_ENV || 'production';
const dbConfigOptions = require('./database-options'); // Renomeei o arquivo original para evitar conflito
const config = dbConfigOptions[environment]; // Usando as opções do arquivo renomeado

let sequelizeInstance;

if (config.use_env_variable) {
  sequelizeInstance = new Sequelize(process.env[config.use_env_variable], config);
} else {
  sequelizeInstance = new Sequelize(config.database, config.username, config.password, config);
}

module.exports = sequelizeInstance; // Exporta a INSTÂNCIA do Sequelize
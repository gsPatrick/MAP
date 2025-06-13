// src/config/database-options.js
const fs = require('fs');

// Helper para parsear booleano de string
const parseEnvBoolean = (envVar) => envVar === 'true';

module.exports = {
  development: {
    username: 'agentewhatsappbddev',
    password: 'agentewhatsappbddev',
    database: 'agentewhatsappbddev',
    host: '69.62.99.122',
    port: 5440,
    dialect: 'postgres',
    dialectOptions: {
      // Pode adicionar opções específicas de dev aqui se necessário
    },
    logging: (msg) => console.log(`[SEQUELIZE DEV SQL]: ${msg.substring(0, 1000)}`), // Loga no console
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    retry: {
        max: 2,
        match: [ /SequelizeConnectionError/, /SequelizeConnectionRefusedError/, /TimeoutError/ ],
        backoffBase: 500,
        backoffExponent: 1.2,
    },
    seederStorage: 'sequelize',
    seederStorageTableName: 'SequelizeDataSeedDev',
  },
  test: { // Configurações para ambiente de teste automatizado
    username: 'agentewhatsappbddev',
    password: 'agentewhatsappbddev',
    database: 'agentewhatsappbddev',
    host: '69.62.99.122',
    port: 5440,
    dialect: 'postgres',
    logging: false, // Geralmente desabilitado para testes
    pool: { max: 5, min: 0, acquire: 30000, idle: 5000 },
    retry: { max: 1 },
    seederStorageTableName: 'SequelizeDataSeedTest',
  },
  production: {
    username: 'agentewhatsappbddev',
    password: 'agentewhatsappbddev',
    database: 'agentewhatsappbddev',
    host: '69.62.99.122',
    port: 5440,
    dialect: 'postgres',
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false, // Ignorando validação de certificado
      },
    },
    logging: (msg) => console.log(`[SEQUELIZE PROD SQL]: ${msg.substring(0, 500)}`), // Loga no console
    pool: {
      max: 20,
      min: 5,
      acquire: 60000,
      idle: 10000,
    },
    retry: {
        max: 5,
        match: [
            /SequelizeConnectionError/,
            /SequelizeConnectionRefusedError/,
            /SequelizeHostNotFoundError/,
            /SequelizeHostNotReachableError/,
            /SequelizeInvalidConnectionError/,
            /SequelizeConnectionTimedOutError/,
            /TimeoutError/,
            /ECONNREFUSED/
        ],
        backoffBase: 1000,
        backoffExponent: 1.5,
    },
    seederStorage: 'sequelize',
    seederStorageTableName: 'SequelizeDataSeedProd',
  },
};

// Se você não tiver um logger configurado, o `console.log` será usado.
// A linha abaixo foi removida ou comentada porque o logger não foi fornecido no prompt inicial.
// const logger = require('../utils/logger');
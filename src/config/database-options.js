// src/config/database-options.js
require('dotenv').config(); // Carrega variáveis de ambiente do .env
const fs = require('fs'); // Para ler arquivos de CA SSL, se necessário

// Helper para parsear booleano de string do .env
const parseEnvBoolean = (envVar) => envVar === 'true';

module.exports = {
  development: {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'docker',    // Senha padrão DEV
    database: process.env.DB_NAME || 'assessor_dev',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    dialect: 'postgres',
    dialectOptions: {
      // Pode adicionar opções específicas de dev aqui se necessário
    },
    logging: parseEnvBoolean(process.env.DB_LOGGING) ? (msg) => logger.debug(`[SEQUELIZE DEV SQL]: ${msg.substring(0, 1000)}`) : false,
    pool: {
      max: parseInt(process.env.DB_POOL_MAX, 10) || 5,
      min: parseInt(process.env.DB_POOL_MIN, 10) || 0,
      acquire: parseInt(process.env.DB_POOL_ACQUIRE, 10) || 30000,
      idle: parseInt(process.env.DB_POOL_IDLE, 10) || 10000,
    },
    retry: {
        max: parseInt(process.env.DB_RETRY_MAX, 10) || 2, // Menos retries em dev
        match: [ /SequelizeConnectionError/, /SequelizeConnectionRefusedError/, /TimeoutError/ ],
        backoffBase: 500,
        backoffExponent: 1.2,
    },
    seederStorage: 'sequelize',
    seederStorageTableName: 'SequelizeDataSeedDev',
  },
  test: { // Configurações para ambiente de teste automatizado
    username: process.env.DB_USER_TEST || process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS_TEST || process.env.DB_PASS || 'docker', // Use uma senha de teste
    database: process.env.DB_NAME_TEST || 'assessor_test',
    host: process.env.DB_HOST_TEST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT_TEST, 10) || 5433, // Porta diferente para evitar conflitos
    dialect: 'postgres',
    logging: false, // Geralmente desabilitado para testes
    pool: { max: 5, min: 0, acquire: 30000, idle: 5000 },
    retry: { max: 1 },
    seederStorageTableName: 'SequelizeDataSeedTest',
  },
  production: {
    username: process.env.DB_USER_PROD || process.env.DB_USER,
    password: process.env.DB_PASS_PROD || process.env.DB_PASS, // !! DEVE VIR DE SEGREDOS DO AMBIENTE !!
    database: process.env.DB_NAME_PROD || process.env.DB_NAME,
    host: process.env.DB_HOST_PROD || process.env.DB_HOST, // Ex: seu 'geral_agentewhatsappbd'
    port: parseInt(process.env.DB_PORT_PROD, 10) || parseInt(process.env.DB_PORT, 10) || 5432,
    dialect: 'postgres',
    dialectOptions: {
      ssl: parseEnvBoolean(process.env.DB_SSL_PROD) ? {
        require: true,
        // Se rejectUnauthorized for false, a conexão é vulnerável a ataques man-in-the-middle
        // se o certificado do servidor não for de uma CA confiável.
        // Use apenas se você souber EXATAMENTE o que está fazendo (ex: CAs internas e controladas).
        rejectUnauthorized: parseEnvBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED_PROD),
        // Exemplo de como carregar um CA se necessário (raro para DBaaS populares):
        // ca: process.env.DB_SSL_CA_PATH ? fs.readFileSync(process.env.DB_SSL_CA_PATH).toString() : undefined,
      } : undefined,
    },
    logging: parseEnvBoolean(process.env.DB_LOGGING_PROD) ? (msg) => logger.info(`[SEQUELIZE PROD SQL]: ${msg.substring(0, 500)}`) : false,
    pool: {
      max: parseInt(process.env.DB_POOL_MAX_PROD, 10) || 20,
      min: parseInt(process.env.DB_POOL_MIN_PROD, 10) || 5,
      acquire: parseInt(process.env.DB_POOL_ACQUIRE_PROD, 10) || 60000,
      idle: parseInt(process.env.DB_POOL_IDLE_PROD, 10) || 10000,
    },
    retry: {
        max: parseInt(process.env.DB_RETRY_MAX_PROD, 10) || 5,
        match: [
            /SequelizeConnectionError/,
            /SequelizeConnectionRefusedError/,
            /SequelizeHostNotFoundError/,
            /SequelizeHostNotReachableError/,
            /SequelizeInvalidConnectionError/,
            /SequelizeConnectionTimedOutError/,
            /TimeoutError/,
            /ECONNREFUSED/ // Erro comum de conexão recusada
        ],
        backoffBase: 1000, // Tempo base para backoff exponencial (ms)
        backoffExponent: 1.5, // Expoente para backoff
    },
    seederStorage: 'sequelize',
    seederStorageTableName: 'SequelizeDataSeedProd', // Tabela de seeds específica para produção
  },
};

// Importar o logger aqui para ser usado na função de logging do Sequelize
// Deve ser feito após a exportação para evitar dependências circulares se o logger usar .env também
const logger = require('../utils/logger');
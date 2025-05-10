// src/config/database-options.js
require('dotenv').config(); // Carrega variáveis de ambiente do .env

module.exports = {
  development: {
    username: process.env.DB_USER || 'postgres', // Usuário padrão do PostgreSQL
    password: process.env.DB_PASS || 'docker',    // Senha padrão (exemplo para Docker, ajuste)
    database: process.env.DB_NAME || 'assessor_dev', // Nome do banco para desenvolvimento
    host: process.env.DB_HOST || 'localhost',      // Host do banco de dados
    port: process.env.DB_PORT || 5432,             // Porta do PostgreSQL
    dialect: 'postgres',
    dialectOptions: {
      // Opções específicas do dialeto PostgreSQL
      // Exemplo: Configurações de SSL para conexões seguras em produção (descomente e ajuste se necessário)
      // ssl: {
      //   require: process.env.DB_SSL === 'true', // Ativar SSL baseado em variável de ambiente
      //   rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true', // Importante para CAs auto-assinados
      //   // ca: fs.readFileSync('/path/to/server-ca.pem').toString(), // Se precisar de um CA específico
      // }
    },
    logging: (msg) => {
      // Log SQL customizado, só loga se DB_LOGGING for 'true'
      if (process.env.DB_LOGGING === 'true') {
        console.log(`[SEQUELIZE SQL] ${new Date().toISOString()}: ${msg.substring(0, 1000)}${msg.length > 1000 ? '...' : ''}`);
      }
    }, // Loga as queries SQL no console (pode ser console.log ou uma função customizada)
    // Configurações de Pool de Conexões (importante para performance)
    pool: {
      max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 5,        // Máximo de conexões no pool
      min: process.env.DB_POOL_MIN ? parseInt(process.env.DB_POOL_MIN, 10) : 0,        // Mínimo de conexões no pool
      acquire: process.env.DB_POOL_ACQUIRE ? parseInt(process.env.DB_POOL_ACQUIRE, 10) : 30000, // Timeout para adquirir conexão (ms)
      idle: process.env.DB_POOL_IDLE ? parseInt(process.env.DB_POOL_IDLE, 10) : 10000,      // Timeout para conexão ociosa (ms)
    },
    // define: {
    //   // Opções globais para todos os modelos
    //   // underscored: true, // se quiser nomes de tabela e colunas em snake_case (ex: created_at)
    //   // freezeTableName: true, // impede o Sequelize de pluralizar nomes de tabelas
    //   // timestamps: true, // já é o padrão, mas pode ser explicitado
    // },
    retry: { // Configurações de retry para conexão
        max: process.env.DB_RETRY_MAX ? parseInt(process.env.DB_RETRY_MAX, 10) : 3, // Número máximo de tentativas
        match: [ // Tipos de erro que devem acionar um retry
            /SequelizeConnectionError/,
            /SequelizeConnectionRefusedError/,
            /SequelizeHostNotFoundError/,
            /SequelizeHostNotReachableError/,
            /SequelizeInvalidConnectionError/,
            /SequelizeConnectionTimedOutError/,
            /TimeoutError/, // Adicionado para cobrir erros de timeout genéricos na conexão
        ],
        backoffBase: 1000, // Tempo base para backoff exponencial (ms)
        backoffExponent: 1.5, // Expoente para backoff
    },
    seederStorage: 'sequelize', // Opcional: especifica a tabela para armazenar o estado dos seeders
    seederStorageTableName: 'SequelizeDataSeed', // Opcional: nome da tabela de seeders
  },
  test: {
    username: process.env.DB_USER_TEST || process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS_TEST || process.env.DB_PASS || 'docker',
    database: process.env.DB_NAME_TEST || 'assessor_test', // Banco de dados específico para testes
    host: process.env.DB_HOST_TEST || process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT_TEST || process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false, // Desabilitar logs SQL em testes para não poluir a saída
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    // define: {
    //   timestamps: false, // Exemplo: desabilitar timestamps para tabelas de teste se não forem relevantes
    // }
  },
  production: {
    username: process.env.DB_USER_PROD || process.env.DB_USER,
    password: process.env.DB_PASS_PROD || process.env.DB_PASS,
    database: process.env.DB_NAME_PROD || 'assessor_prod',
    host: process.env.DB_HOST_PROD || process.env.DB_HOST,
    port: process.env.DB_PORT_PROD || process.env.DB_PORT || 5432,
    dialect: 'postgres',
    dialectOptions: {
      ssl: { // Exemplo: Forçar SSL em produção
        require: true,
        // Em muitos serviços de DBaaS (AWS RDS, Heroku Postgres, etc.),
        // rejectUnauthorized: false pode ser necessário se eles usam CAs que não estão no seu sistema local.
        // Verifique a documentação do seu provedor de banco de dados.
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true', // Defina como 'false' com cautela
      },
    },
    logging: (msg) => { // Log mais controlado em produção
        if (process.env.DB_LOGGING_PROD === 'true') { // Só loga SQL em produção se explicitamente habilitado
            // Poderia enviar para um serviço de logging centralizado (ex: Sentry, Logstash)
            console.log(`[PROD SQL] ${new Date().toISOString()}: ${msg.substring(0, 500)}...`);
        }
    },
    pool: { // Pool de conexões mais robusto para produção
      max: process.env.DB_POOL_MAX_PROD ? parseInt(process.env.DB_POOL_MAX_PROD, 10) : 20,
      min: process.env.DB_POOL_MIN_PROD ? parseInt(process.env.DB_POOL_MIN_PROD, 10) : 5,
      acquire: process.env.DB_POOL_ACQUIRE_PROD ? parseInt(process.env.DB_POOL_ACQUIRE_PROD, 10) : 60000,
      idle: process.env.DB_POOL_IDLE_PROD ? parseInt(process.env.DB_POOL_IDLE_PROD, 10) : 10000,
    },
    // define: {
    //   // Exemplo: freezeTableName pode ser útil para manter consistência
    //   // freezeTableName: true,
    // },
    retry: { // Configurações de retry para produção
        max: process.env.DB_RETRY_MAX_PROD ? parseInt(process.env.DB_RETRY_MAX_PROD, 10) : 5,
        match: [
            /SequelizeConnectionError/,
            /SequelizeConnectionRefusedError/,
            /SequelizeHostNotFoundError/,
            /SequelizeHostNotReachableError/,
            /SequelizeInvalidConnectionError/,
            /SequelizeConnectionTimedOutError/,
            /TimeoutError/,
        ],
        backoffBase: 2000,
        backoffExponent: 2,
    },
  },
};
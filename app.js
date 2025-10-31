// src/app.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas primeiro
const express = require('express');
const cors = require('cors');
const punycode = require('punycode/');

// Caminhos para os módulos
const { sequelize } = require('./src/database');
const errorHandler = require('./src/middlewares/errorHandler');
const { startJobs } = require('./src/jobs');
const mainApiRouter = require('./src/routes');
const { initializeBasePlans } = require('./src/scripts/initializePlans'); // <<< ADICIONE ESTA LINHA


async function initializeDatabaseAndJobs() {
  try {
    console.log('Tentando autenticar com o banco de dados...');
    await sequelize.authenticate();
    console.log('Conexão com o banco de dados estabelecida com sucesso.');

    const isProduction = process.env.NODE_ENV === 'production';
    const forceReset = process.env.FORCE_DB_RESET === 'true';

    // ==========================================================================
    // LÓGICA DE SINCRONIZAÇÃO SEGURA (HARDCODED)
    // ==========================================================================
    if (isProduction) {
      // --- MODO PRODUÇÃO ---
      console.log('Ambiente de PRODUÇÃO detectado.');
      console.log('Sincronização automática (sync) do banco de dados está DESATIVADA por segurança.');
      console.log('A estrutura do banco de dados não será alterada pela aplicação.');
    } else {
      // --- MODO DESENVOLVIMENTO ---
      if (forceReset) {
        console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        console.warn('!! ATENÇÃO: MODO DESENVOLVIMENTO com FORCE_DB_RESET=true.                 !!');
        console.warn('!! O BANCO DE DADOS SERÁ COMPLETAMENTE APAGADO E RECRIADO.                !!');
        console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        await sequelize.sync({ alter: false });
        console.log('Banco de dados resetado com sucesso (force: true).');
      } else {
        console.log('Ambiente de DESENVOLVIMENTO. Sincronizando modelos com { alter: true }...');
        await sequelize.sync({ alter: false });
        console.log('Modelos sincronizados com o banco de dados (alter: true).');
      }
    }

    await initializeBasePlans();

    // Inicia os jobs agendados após a confirmação da conexão com o banco.
    console.log('Iniciando agendamento de jobs...');
    await startJobs();

  } catch (error) {
    console.error('❌ Não foi possível conectar ou inicializar o banco de dados e os serviços:', error);
    throw error; // Propaga o erro para o bloco catch principal
  }
}

/**
 * Cria e configura a instância do aplicativo Express.
 */
function createApp() {
  const app = express();

  // ==========================================================================
  // CONFIGURAÇÃO SEGURA DE CORS
  // ==========================================================================
const allowedOrigins = [
  'https://www.map-nocontrole.com.br',
  'https://map-nocontrole.com.br',
  'http://localhost:3000',
  'https://api.z-api.io' // ✅ adicionado para permitir webhooks da Z-API
];

  app.use(cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // permite Postman e requests internas
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`🚫 CORS bloqueado para origem não autorizada: ${origin}`);
        callback(new Error('CORS não permitido para esta origem.'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // ==========================================================================
  // MIDDLEWARES ESSENCIAIS
  // ==========================================================================
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ==========================================================================
  // ROTAS PRINCIPAIS
  // ==========================================================================
  // Rota de health check básica
  app.get('/health', (req, res) => res.status(200).json({ status: 'OK', timestamp: new Date() }));

  // Configura as rotas da aplicação com prefixo /api
  app.use('/api', mainApiRouter);

  // Tratamento para rotas não encontradas (404)
  app.use((req, res, next) => {
    res.status(404).json({ message: `Rota não encontrada: ${req.originalUrl}` });
  });

  // Middleware de tratamento de erros
  app.use(errorHandler);

  return app;
}

// ==========================================================================
// BLOCO PRINCIPAL PARA INICIAR O SERVIDOR
// ==========================================================================
if (require.main === module) {
  const app = createApp();
  const PORT = process.env.PORT || 3000;

  initializeDatabaseAndJobs()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`🚀 Servidor rodando na porta ${PORT}`);
        console.log(`   Health Check: http://localhost:${PORT}/health`);
        console.log(`   API Principal: http://localhost:${PORT}/api`);
        console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
        if (process.env.NODE_ENV !== 'production' && process.env.FORCE_DB_RESET === 'true') {
          console.warn('   AVISO: MODO RESET DO BANCO DE DADOS ESTÁ ATIVO.');
        }
      });
    })
    .catch(error => {
      console.error("❌ Falha crítica durante a inicialização. Servidor não iniciado.", error.message);
      process.exit(1); // Encerrar o processo com código de erro
    });
}

module.exports = createApp;

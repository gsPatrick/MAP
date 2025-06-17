// src/app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const punycode = require('punycode/');

const { sequelize } = require('./src/database');
const errorHandler = require('./src/middlewares/errorHandler');
const { startJobs } = require('./src/jobs');
const mainApiRouter = require('./src/routes');


async function initializeDatabaseAndJobs() {
  try {
    console.log('Tentando autenticar com o banco de dados...');
    await sequelize.authenticate();
    console.log('Conexão com o banco de dados estabelecida com sucesso.');

    // ==========================================================================
    // LÓGICA DE SINCRONIZAÇÃO HARDCODED PARA RESET EM AMBIENTE DE TESTE/PROD
    // ==========================================================================
    
    // <<< MUDANÇA PRINCIPAL AQUI >>>
    // A lógica original foi substituída por um comando direto de reset.
    // Isto irá apagar todas as tabelas e recriá-las a partir dos modelos.
    console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.warn('!! ATENÇÃO: MODO DE RESET FORÇADO (HARDCODED) ATIVO.                      !!');
    console.warn('!! O BANCO DE DADOS SERÁ COMPLETAMENTE APAGADO E RECRIADO.                !!');
    console.warn('!! REMOVA ESTA LÓGICA ANTES DE USAR EM PRODUÇÃO REAL.                      !!');
    console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    
    await sequelize.sync({ force: true });
    
    console.log('Banco de dados resetado e recriado com sucesso via { force: true }.');
    // <<< FIM DA MUDANÇA PRINCIPAL >>>


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

  // Middlewares Essenciais
  app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

// Bloco principal para iniciar o servidor
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
        console.warn('   AVISO: MODO RESET DO BANCO DE DADOS (HARDCODED) ESTÁ ATIVO.');
      });
    })
    .catch(error => {
      console.error("❌ Falha crítica durante a inicialização. Servidor não iniciado.", error.message);
      process.exit(1); // Encerrar o processo com código de erro
    });
}

module.exports = createApp;
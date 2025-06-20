// src/app.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas primeiro
const express = require('express');
const cors = require('cors');
// O require de 'punycode' não é mais necessário em versões recentes do Node.js
// e pode ser removido para limpar o código.
// const punycode = require('punycode/');

// Caminhos para os módulos
const { sequelize } = require('./src/database'); // Correção do caminho para importar do index
const errorHandler = require('./src/middlewares/errorHandler');
const { startJobs } = require('./src/jobs');
const mainApiRouter = require('./src/routes');


async function initializeDatabaseAndJobs() {
  try {
    console.log('Tentando autenticar com o banco de dados...');
    await sequelize.authenticate();
    console.log('Conexão com o banco de dados estabelecida com sucesso.');

    const isProduction = process.env.NODE_ENV === 'production';
    const forceResetDev = process.env.FORCE_DB_RESET === 'true';

    // ==========================================================================
    // LÓGICA DE SINCRONIZAÇÃO SEGURA (CORRIGIDA)
    // ==========================================================================
    if (isProduction) {
      // ####################################################################
      // ## CORREÇÃO CRÍTICA APLICADA AQUI                                 ##
      // ## Em produção, NUNCA chamamos sequelize.sync().                  ##
      // ## A estrutura do banco é gerenciada 100% pelas migrations.       ##
      // ####################################################################
      console.log('Ambiente de PRODUÇÃO detectado.');
      console.log('As Migrations via "npm start" são a única fonte de verdade para a estrutura do banco.');
      console.log('Sincronização automática (sequelize.sync) DESATIVADA.');

    } else {
      // --- MODO DESENVOLVIMENTO ---
      if (forceResetDev) {
        // Esta opção só funciona se NODE_ENV NÃO for 'production'.
        console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        console.warn('!! ATENÇÃO: MODO DESENVOLVIMENTO com FORCE_DB_RESET=true.                 !!');
        console.warn('!! O BANCO DE DADOS SERÁ COMPLETAMENTE APAGADO E RECRIADO.                !!');
        console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        // A linha destrutiva, segura apenas para desenvolvimento.
        await sequelize.sync({ force: true });
        console.log('Banco de dados resetado com sucesso (force: true).');
        
        // Após um reset total, é essencial semear os dados básicos.
  

      } else {
        // Comportamento padrão para desenvolvimento: tenta alterar tabelas sem apagar.
        // Usar { alter: true } é uma opção, mas pode ser perigoso.
        // Manter { alter: false } ou sync() vazio é mais seguro.
        // O ideal em dev é também usar migrations.
        console.log('Ambiente de DESENVOLVIMENTO. As migrations gerenciam o banco.');
        // await sequelize.sync({ alter: true }); // Use com cuidado
      }
    }

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
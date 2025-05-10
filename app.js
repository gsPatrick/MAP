// src/app.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas primeiro
const express = require('express');
const cors = require('cors');

// Caminhos para os módulos (assumindo que app.js está na RAIZ do projeto, e 'src' é uma subpasta)
// Se app.js estivesse DENTRO de 'src', os caminhos seriam diferentes (ex: './config/database').
const { sequelize } = require('./src/database'); // << CORRIGIDO: sequelize vem de src/database/index.js
const errorHandler = require('./src/middlewares/errorHandler');
const { startJobs } = require('./src/jobs'); // << CORRIGIDO: Caminho para jobs
const mainApiRouter = require('./src/routes'); // << IMPORTANTE: Importa o router principal de src/routes/index.js

async function initializeDatabaseAndJobs() {
  try {
    await sequelize.authenticate();
    console.log('Conexão com o banco de dados estabelecida com sucesso.');

    if (process.env.NODE_ENV === 'production' && process.env.DB_SYNC === 'true') {
      await sequelize.sync({ force: true }); // Use com cautela!
      console.log('Modelos sincronizados com o banco de dados (alter:true). Use migrations em produção!');
    } else if (process.env.NODE_ENV !== 'deveplopment') {
      console.log('DB_SYNC não está habilitado ou NODE_ENV não é development. Migrations são preferidas.');
    }

    startJobs(); // Inicia os jobs agendados
  } catch (error) {
    console.error('Não foi possível conectar ou sincronizar com o banco de dados:', error);
    throw error; // Re-lança o erro para ser tratado pelo chamador
  }
}

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

  // Rota de health check básica (antes das rotas da API)
  app.get('/health', (req, res) => res.status(200).json({ status: 'OK', timestamp: new Date() }));

  // Configura as rotas da aplicação com prefixo /api
  app.use('/api', mainApiRouter); // << IMPORTANTE: Usa o router principal aqui

  // Tratamento para rotas não encontradas (404) - DEPOIS de todas as suas rotas da API
  app.use((req, res, next) => {
    res.status(404).json({ message: `Rota não encontrada: ${req.originalUrl}` });
  });

  // Middleware de tratamento de erros (deve ser o último middleware)
  app.use(errorHandler);

  return app;
}

// Bloco para iniciar o servidor apenas se este script for executado diretamente
// (Geralmente o app.js é o ponto de entrada, não server.js, ou vice-versa. Ajuste se necessário)
if (require.main === module) { // Isso é mais comum se o app.js for o seu server.js
  const app = createApp();
  const PORT = process.env.PORT || 3000;

  initializeDatabaseAndJobs()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
        console.log(`Rota de health check: http://localhost:${PORT}/health`);
        console.log(`API principal em: http://localhost:${PORT}/api/status (exemplo)`);
      });
    })
    .catch(error => {
      console.error("Falha crítica durante a inicialização. Servidor não iniciado.", error);
      process.exit(1);
    });
}

module.exports = createApp; // Exporta a função para testes ou se você tiver um server.js separado
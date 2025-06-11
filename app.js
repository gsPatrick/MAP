// src/app.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas primeiro
const express = require('express');
const cors = require('cors');
const punycode = require('punycode/');


// Caminhos para os módulos
const { sequelize } = require('./src/database'); // Importa a instância do sequelize (e os modelos se necessário)
const errorHandler = require('./src/middlewares/errorHandler');
const { startJobs } = require('./src/jobs'); // Importa a função startJobs
const mainApiRouter = require('./src/routes');
const { seedPlans } = require('./src/database/seeders/seedPlans'); // <<< IMPORTAÇÃO DA NOVA FUNÇÃO


async function initializeDatabaseAndJobs() {
  try {
    await sequelize.authenticate();
    console.log('Conexão com o banco de dados estabelecida com sucesso.');

    const isDevelopment = process.env.NODE_ENV === 'development';
    const forceReset = process.env.FORCE_DB_RESET === 'true';

    // ======================== PONTO CRÍTICO DE ATENÇÃO ========================
    // A lógica abaixo controla se o banco de dados será apagado ou não.
    // Para reiniciar sem apagar nada, certifique-se de que a variável de ambiente
    // FORCE_DB_RESET NÃO seja 'true'.
    // ==========================================================================

    if (forceReset) {
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.warn('!! ATENÇÃO: FORCE_DB_RESET está habilitado! O banco será apagado.         !!');
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      await sequelize.sync({ force: true }); // <<< ISTO APAGA TUDO
      console.log('Banco de dados resetado (force: true).');
    } else if (isDevelopment) {
      console.log('Ambiente de DESENVOLVIMENTO. Sincronizando modelos com { alter: true }...');
      // 'alter:true' é seguro para desenvolvimento, pois tenta adicionar/modificar colunas sem apagar dados.
      await sequelize.sync({ alter: true }); // <<< ISTO NÃO APAGA DADOS
      console.log('Modelos sincronizados.');
    } else {
      console.log('Ambiente de PRODUÇÃO. Sincronização automática desativada. Use migrations.');
      // Em produção, a sincronização é desativada por segurança.
    }

    // Após a sincronização, executa a semeadura dos dados essenciais
    // Isso garante que os planos sempre existam, especialmente após um reset.
    await seedPlans();

    // Inicia os jobs agendados
    await startJobs();

  } catch (error) {
    console.error('Não foi possível conectar ou inicializar o banco de dados e os serviços:', error);
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
        console.log(`   Ambiente: ${process.env.NODE_ENV}`);
        if (process.env.FORCE_DB_RESET === 'true') {
          console.warn('   AVISO: FORCE_DB_RESET está ATIVO.');
        }
      });
    })
    .catch(error => {
      console.error("❌ Falha crítica durante a inicialização. Servidor não iniciado.", error.message);
      process.exit(1); // Encerrar o processo com código de erro
    });
}

module.exports = createApp;
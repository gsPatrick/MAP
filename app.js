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

async function initializeDatabaseAndJobs() {
  try {
    await sequelize.authenticate();
    console.log('Conexão com o banco de dados estabelecida com sucesso.');

    // 1. Prioridade máxima: Forçar reset do banco de dados se FORCE_DB_RESET=true
    if (process.env.FORCE_DB_RESET === 'true') {
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.warn('!! ATENÇÃO: FORCE_DB_RESET está habilitado!                               !!');
      console.warn('!! O banco de dados será COMPLETAMENTE APAGADO E RECRIADO (force:true).   !!');
      console.warn('!! ISSO AFETARÁ PRODUÇÃO SE NODE_ENV=production. USE COM EXTREMA CAUTELA! !!');
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      await sequelize.sync({ force: false });
      console.log('Modelos sincronizados com o banco de dados (force:true devido a FORCE_DB_RESET).');
    }
    // 2. Lógica para desenvolvimento com DB_SYNC
    else if (process.env.NODE_ENV === 'development' && process.env.DB_SYNC === 'true') {
      console.log('Ambiente de DESENVOLVIMENTO com DB_SYNC habilitado. Sincronizando modelos (force:false)...');
      // Corrigido: force: false para não apagar dados em dev se não for reset global
      // Se você *quer* que DB_SYNC=true em dev apague tudo, mude para { force: false }
      await sequelize.sync({ force: false });
      console.log('Modelos sincronizados com o banco de dados (force:false para desenvolvimento).');
    }
    // 3. Lógica para produção com DB_SYNC (MUITO PERIGOSO com force:true)
    else if (process.env.NODE_ENV === 'production' && process.env.DB_SYNC === 'true') {
      console.error('###################################################################################################');
      console.error('## PERIGO EXTREMO: DB_SYNC está habilitado em PRODUÇÃO com a intenção de usar sequelize.sync()!   ##');
      console.error('## SEU CÓDIGO ORIGINAL INDICAVA force:true PARA ESTA CONDIÇÃO.                                   ##');
      console.error('## ISSO APAGARÁ TODOS OS DADOS DE PRODUÇÃO!                                                      ##');
      console.error('## Esta configuração é altamente desaconselhada. Use migrations dedicadas para produção.         ##');
      console.error('## Se você realmente precisa sincronizar, considere { alter: true } com cautela após backup.     ##');
      console.error('###################################################################################################');
      // Corrigido: force: false é menos perigoso que force:true (que apaga tudo)
      // Se você REALMENTE QUISER force:true aqui, volte, mas saiba o risco.
      // O ideal é usar `{ alter: true }` aqui em produção, mas com MUITA cautela.
      // Ou, melhor ainda, NUNCA use sync em produção, apenas migrations.
      console.log('Ambiente de PRODUÇÃO com DB_SYNC habilitado. Sincronizando modelos (force:false)...');
      await sequelize.sync({ force: false });
      console.log('Modelos sincronizados com o banco de dados em PRODUÇÃO (force:false).');
      console.log('É CRUCIALMENTE RECOMENDADO DESABILITAR DB_SYNC EM PRODUÇÃO E USAR MIGRAÇÕES.');

    }
    // 4. Se nenhuma das condições de sincronização for atendida
    else {
      if (process.env.NODE_ENV === 'production') {
        console.log('DB_SYNC não está habilitado para produção. Migrations são obrigatórias para produção.');
              await sequelize.sync({ force: false });

      } else {
        console.log('DB_SYNC não está habilitado ou NODE_ENV não configura sincronização automática. Migrations são preferidas.');
      }
      // Mesmo sem sync automático, podemos verificar a conexão e modelos se necessário
      // await sequelize.sync({ alter: true }); // Exemplo para tentar alterar sem apagar, mas ainda perigoso em produção
    }


    // Inicia os jobs agendados SOMENTE APÓS a conexão e sincronização
    await startJobs(); // <--- AGORA É ASYNC E PRECISA DE AWAIT

  } catch (error) {
    console.error('Não foi possível conectar ou sincronizar com o banco de dados OU iniciar os Jobs:', error);
    throw error; // Re-lança o erro para ser tratado pelo chamador (bloco .catch abaixo)
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

// Bloco para iniciar o servidor
if (require.main === module) {
  const app = createApp();
  const PORT = process.env.PORT || 3000;

  initializeDatabaseAndJobs() // Chama a função assíncrona
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
        console.log(`Rota de health check: http://localhost:${PORT}/health`);
        console.log(`API principal em: http://localhost:${PORT}/api`);
        if (process.env.NODE_ENV === 'development') {
          console.log('Ambiente de desenvolvimento ativo.');
        } else if (process.env.NODE_ENV === 'production') {
          console.log('Ambiente de PRODUÇÃO ativo.');
        }
        if (process.env.FORCE_DB_RESET === 'true') {
          console.warn('AVISO: FORCE_DB_RESET está ATIVO. O banco foi resetado.');
        }
      });
    })
    .catch(error => {
      console.error("Falha crítica durante a inicialização. Servidor não iniciado.", error);
      process.exit(1); // Encerrar o processo com código de erro
    });
}

module.exports = createApp;
// src/app.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas primeiro
const express = require('express');
const cors = require('cors');

// Caminhos para os módulos
const { sequelize } = require('./src/database');
const errorHandler = require('./src/middlewares/errorHandler');
const { startJobs } = require('./src/jobs');
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
      await sequelize.sync({ force: true });
      console.log('Modelos sincronizados com o banco de dados (force:true devido a FORCE_DB_RESET).');
    }
    // 2. Lógica para desenvolvimento com DB_SYNC
    else if (process.env.NODE_ENV === 'development' && process.env.DB_SYNC === 'true') {
      console.log('Ambiente de DESENVOLVIMENTO com DB_SYNC habilitado. Sincronizando modelos (force:true)...');
      await sequelize.sync({ force: false }); // Em dev, force:true é comum para resetar
      console.log('Modelos sincronizados com o banco de dados (force:true para desenvolvimento).');
    }
    // 3. Lógica para produção com DB_SYNC (MUITO PERIGOSO com force:true)
    else if (process.env.NODE_ENV === 'production' && process.env.DB_SYNC === 'true') {
      console.error('###################################################################################################');
      console.error('## PERIGO EXTREMO: DB_SYNC está habilitado em PRODUÇÃO com a intenção de usar sequelize.sync()!   ##');
      console.error('## SEU CÓDIGO ORIGINAL INDICAVA force:true PARA ESTA CONDIÇÃO.                                   ##');
      console.error('## ISSO APAGARÁ TODOS OS DADOS DE PRODUÇÃO!                                                      ##');
      console.error('## Esta configuração é altamente desaconselhada. Use migrations dedicadas para produção.         ##');
      console.error('## Se você realmente precisa sincronizar, considere { alter: true } com cautela após backup.     ##');
      console.error('## PROCEDENDO COM force:true CONFORME LÓGICA ORIGINAL PARA ESTA CONDIÇÃO ESPECÍFICA.             ##');
      console.error('###################################################################################################');
      await sequelize.sync({ force: fale }); // Mantendo o force:true do seu código original para esta condição
      console.log('Modelos sincronizados com o banco de dados em PRODUÇÃO (force:true). TODOS OS DADOS FORAM APAGADOS!');
      console.log('É CRUCIALMENTE RECOMENDADO DESABILITAR DB_SYNC EM PRODUÇÃO E USAR MIGRAÇÕES.');
    }
    // 4. Se nenhuma das condições de sincronização for atendida
    else {
      if (process.env.NODE_ENV === 'production') {
        console.log('DB_SYNC não está habilitado para produção ou NODE_ENV não é "production" com DB_SYNC. Migrations são obrigatórias para produção.');
      } else {
        console.log('DB_SYNC não está habilitado ou NODE_ENV não configura sincronização automática. Migrations são preferidas.');
      }
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

  initializeDatabaseAndJobs()
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
      process.exit(1);
    });
}

module.exports = createApp;
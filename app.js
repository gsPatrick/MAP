// src/app.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas primeiro
const express = require('express');
const cors = require('cors');

// Caminhos para os módulos (mantidos como no original)
const { sequelize } = require('./src/database');
const errorHandler = require('./src/middlewares/errorHandler');
const { startJobs } = require('./src/jobs');
const mainApiRouter = require('./src/routes');

async function initializeDatabaseAndJobs() {
  try {
    await sequelize.authenticate();
    console.log('Conexão com o banco de dados estabelecida com sucesso.');

    let syncPerformed = false; // Flag para rastrear se sync foi chamado

    // 1. Prioridade máxima: FORCE_DB_RESET=true (modificado para alter:true)
    if (process.env.FORCE_DB_RESET === 'true') {
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.warn('!! ATENÇÃO: FORCE_DB_RESET está habilitado!                                       !!');
      console.warn('!! Originalmente, isso APAGARIA E RECRIARIA o banco (force:true).                 !!');
      console.warn('!! CONFORME SOLICITADO, O BANCO NÃO SERÁ COMPLETAMENTE APAGADO.                   !!');
      console.warn('!! Em vez disso, será usada a opção { alter: true }.                              !!');
      console.warn('!! { alter: true } tentará atualizar o schema para corresponder aos modelos.      !!');
      console.warn('!! ISSO PODE INCLUIR ADICIONAR, MODIFICAR OU REMOVER COLUNAS.                     !!');
      console.warn('!! REMOVER COLUNAS SIGNIFICA PERDA DE DADOS NESSAS COLUNAS.                       !!');
      console.warn('!! Use com extrema cautela, especialmente em produção. Faça backup.               !!');
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      await sequelize.sync({ alter: true });
      console.log('Modelos sincronizados com o banco de dados (alter:true devido a FORCE_DB_RESET e solicitação de não apagar totalmente).');
      syncPerformed = true;
    }
    // 2. Lógica para desenvolvimento com DB_SYNC
    else if (process.env.NODE_ENV === 'development' && process.env.DB_SYNC === 'true') {
      console.log('Ambiente de DESENVOLVIMENTO com DB_SYNC habilitado.');
      console.log('Sincronizando modelos com { alter: true }...');
      console.log('({ alter: true } tentará atualizar o schema para corresponder aos modelos, podendo adicionar, modificar ou remover colunas.)');
      await sequelize.sync({ alter: true });
      console.log('Modelos sincronizados com o banco de dados (alter:true para desenvolvimento).');
      syncPerformed = true;
    }
    // 3. Lógica para produção com DB_SYNC (MUITO PERIGOSO mesmo com alter:true)
    else if (process.env.NODE_ENV === 'production' && process.env.DB_SYNC === 'true') {
      console.error('###################################################################################################');
      console.error('## PERIGO: DB_SYNC está habilitado em PRODUÇÃO!                                                  ##');
      console.error('## O código original usaria force:true, APAGANDO TODOS OS DADOS DE PRODUÇÃO.                     ##');
      console.error('## CONFORME SOLICITADO, force:true FOI REMOVIDO. Será usado { alter: true } em vez disso.        ##');
      console.error('##                                                                                               ##');
      console.error('## ATENÇÃO: { alter: true } em PRODUÇÃO é ARRISCADO:                                             ##');
      console.error('##   - Tenta alterar tabelas e colunas para corresponder aos modelos.                            ##');
      console.error('##   - PODE REMOVER COLUNAS, resultando em PERDA DE DADOS.                                       ##');
      console.error('##   - Alterações complexas de schema podem falhar ou ter resultados inesperados.                ##');
      console.error('##                                                                                               ##');
      console.error('## É FORTEMENTE RECOMENDADO DESABILITAR DB_SYNC EM PRODUÇÃO E USAR MIGRAÇÕES DEDICADAS.           ##');
      console.error('## FAÇA BACKUP COMPLETO DO BANCO DE DADOS ANTES DE CONTINUAR SE ESTA MENSAGEM APARECER.          ##');
      console.error('## PROCEDENDO COM { alter: true }...                                                             ##');
      console.error('###################################################################################################');
      await sequelize.sync({ alter: true });
      console.log('Modelos sincronizados com o banco de dados em PRODUÇÃO usando { alter: true }.');
      console.warn('AVISO IMPORTANTE: O schema do banco de dados pode ter sido alterado.');
      console.warn('Verifique a integridade dos dados e a estrutura das tabelas.');
      console.warn('Considere desabilitar DB_SYNC em produção e usar um sistema de migrações robusto.');
      syncPerformed = true;
    }
    // 4. Se nenhuma das condições de sincronização explícita for atendida (nenhum sync é chamado)
    else {
      // Mantém a lógica original de apenas logar se nenhuma condição de sync foi atendida.
      if (process.env.NODE_ENV === 'production') {
        // Se DB_SYNC não for 'true' em produção
        console.log('DB_SYNC não está habilitado como "true" para o ambiente de PRODUÇÃO.');
        console.log('Este é o comportamento recomendado para produção. Use migrações para gerenciar o schema do banco de dados.');
      } else if (process.env.NODE_ENV === 'development') {
        // Se DB_SYNC não for 'true' em desenvolvimento
        console.log('DB_SYNC não está habilitado como "true" para o ambiente de DESENVOLVIMENTO.');
        console.log('Se você deseja que o Sequelize tente atualizar o schema automaticamente (usando { alter: true }), defina DB_SYNC=true.');
        console.log('Caso contrário, o uso de migrações é recomendado também para desenvolvimento consistente.');
      } else {
        // Outros ambientes (staging, test, etc.) ou NODE_ENV não definido, e DB_SYNC não é 'true'
        const env = process.env.NODE_ENV || 'não definido';
        console.log(`DB_SYNC não está habilitado como "true" para o ambiente NODE_ENV=${env}.`);
        console.log('Para habilitar a sincronização automática do schema (usando { alter: true }), defina DB_SYNC=true.');
        console.log('O uso de migrações é geralmente a abordagem mais segura e controlada para todos os ambientes.');
      }
      console.log('Nenhuma sincronização automática do schema do banco de dados (sequelize.sync) foi realizada pelo app nesta inicialização.');
    }

    if (syncPerformed) {
        console.log('Sincronização do Sequelize (com { alter: true } ou similar) concluída.');
    }

    startJobs(); // Inicia os jobs agendados
  } catch (error) {
    console.error('Falha durante initializeDatabaseAndJobs:', error);
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
          console.warn('AVISO: FORCE_DB_RESET está ATIVO. O banco foi sincronizado com { alter: true } em vez de ser completamente resetado (force:true).');
        }
      });
    })
    .catch(error => {
      console.error("Falha crítica durante a inicialização. Servidor não iniciado.", error);
      process.exit(1);
    });
}

module.exports = createApp;
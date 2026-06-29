// src/app.js
require('dotenv').config(); // Garante que as variáveis de ambiente sejam carregadas primeiro
const express = require('express');
const cors = require('cors');
const path = require('path');
const punycode = require('punycode/');

// Caminhos para os módulos
const { sequelize, User } = require('./src/database');
const { DataTypes } = require('sequelize');
const errorHandler = require('./src/middlewares/errorHandler');
const { startJobs } = require('./src/jobs');
const mainApiRouter = require('./src/routes');
const { initializeBasePlans } = require('./src/scripts/initializePlans'); // <<< ADICIONE ESTA LINHA

/**
 * Garante, de forma idempotente, que colunas críticas existam no banco mesmo que a
 * migration correspondente não tenha sido aplicada em produção. Roda após a conexão.
 * É seguro: só adiciona o que está faltando e nunca derruba o boot (try/catch).
 */
async function ensureCriticalSchema() {
  const qi = sequelize.getQueryInterface();

  // Colunas que o código usa mas cujas migrations podem não ter rodado em produção.
  // É seguro: só adiciona o que falta, por tabela, sem derrubar o boot.
  const plan = {
    user_preferences: {
      areAutomatedJobsEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      cardClosingAlertLeadDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
      cardPaymentAlertLeadDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    },
    clients: {
      lastLoginAt: { type: DataTypes.DATE, allowNull: true },
      lastActiveAt: { type: DataTypes.DATE, allowNull: true },
    },
    financial_transactions: {
      originalPurchaseTotalValue: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    },
    credit_cards: {
      dominantColor: { type: DataTypes.STRING(20), allowNull: true },
      flagIconUrl: { type: DataTypes.STRING(2048), allowNull: true },
    },
  };

  for (const [table, columns] of Object.entries(plan)) {
    try {
      const existing = await qi.describeTable(table);
      for (const [name, def] of Object.entries(columns)) {
        if (!existing[name]) {
          await qi.addColumn(table, name, def);
          console.log(`[SCHEMA] Coluna ${table}.${name} criada (estava faltando).`);
        }
      }
    } catch (err) {
      console.error(`[SCHEMA] Falha ao garantir colunas de "${table}" (não crítico):`, err.message);
    }
  }

  // Garante que exista pelo menos uma linha de preferências com automações ligadas.
  try {
    const [rows] = await sequelize.query('SELECT COUNT(*)::int AS c FROM user_preferences');
    if (rows && rows[0] && rows[0].c === 0) {
      await qi.bulkInsert('user_preferences', [{ areAutomatedJobsEnabled: true, createdAt: new Date(), updatedAt: new Date() }]);
      console.log('[SCHEMA] Linha inicial de user_preferences criada.');
    }
  } catch (err) {
    console.error('[SCHEMA] Falha ao garantir linha de user_preferences (não crítico):', err.message);
  }

  // Garante o valor 'inadimplente' no ENUM de accessLevel (default do model) e
  // migra os 'gratuito' legados — não há mais plano gratuito.
  try {
    const [typeRows] = await sequelize.query(`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_attribute a ON a.atttypid = t.oid
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'clients' AND a.attname = 'accessLevel'
      LIMIT 1`);
    const typname = typeRows && typeRows[0] && typeRows[0].typname;
    if (typname) {
      // ADD VALUE roda em autocommit (fora de transação) — necessário no Postgres.
      await sequelize.query(`ALTER TYPE "${typname}" ADD VALUE IF NOT EXISTS 'inadimplente'`);
      console.log(`[SCHEMA] Valor 'inadimplente' garantido no ENUM ${typname}.`);
      // Migra os legados só depois que o valor existe no tipo.
      await sequelize.query(`UPDATE clients SET "accessLevel" = 'inadimplente' WHERE "accessLevel" = 'gratuito'`);
      console.log('[SCHEMA] Clientes legados "gratuito" migrados para "inadimplente".');
    } else {
      console.warn('[SCHEMA] Tipo ENUM de accessLevel não localizado; pulando migração inadimplente.');
    }
  } catch (err) {
    console.error('[SCHEMA] Falha ao garantir ENUM/migrar inadimplente (não crítico):', err.message);
  }
}

/**
 * [TEMPORÁRIO/DIAGNÓSTICO] Imprime no log as recorrências ativas com a data de
 * vencimento e o plano do cliente, para investigar por que não disparam.
 * REMOVER depois de diagnosticar.
 */
async function debugRecorrencias(label = '') {
  try {
    const [rows] = await sequelize.query(`
      SELECT r.id, r.description, r."isActive", r."autoCreateTransaction",
             r."nextDueDate", r."lastGeneratedDate",
             c.name AS client_name, c."accessLevel", c.status, c.phone
      FROM recurring_transaction_rules r
      JOIN financial_accounts fa ON fa.id = r."financialAccountId"
      JOIN clients c ON c.id = fa."clientId"
      WHERE r."isActive" = true
      ORDER BY r."nextDueDate"
      LIMIT 100`);
    console.log(`================= [DIAG RECORRÊNCIAS ATIVAS ${label}] =================`);
    console.log(`Hoje: ${new Date().toISOString().split('T')[0]} | Total de regras ativas: ${rows.length}`);
    rows.forEach((r) => {
      console.log(`#${r.id} | "${r.description}" | next=${r.nextDueDate} | lastGen=${r.lastGeneratedDate} | autoCreate=${r.autoCreateTransaction} | cliente=${r.client_name} (${r.phone}) | plano=${r.accessLevel} | status=${r.status}`);
    });
    console.log('================= [/DIAG RECORRÊNCIAS] =================');
  } catch (err) {
    console.error('[DIAG RECORRÊNCIAS] Falhou:', err.message);
  }
}

/**
 * Garante a existência de um usuário admin (bootstrap). Idempotente: só cria se
 * ainda não existir um usuário com o e-mail configurado. A senha é hasheada pelo
 * hook beforeCreate do model User.
 * Configurável por env (BOOTSTRAP_ADMIN_EMAIL / _PASSWORD / _NAME).
 * SEGURANÇA: troque a senha após o primeiro login e/ou defina as vars de ambiente.
 */
async function ensureBootstrapAdmin() {
  try {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'patrickadmindev@gmail.com';
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'patrickadmindev';
    const name = process.env.BOOTSTRAP_ADMIN_NAME || 'Patrick Admin';

    const existing = await User.findOne({ where: { email } });
    if (existing) {
      console.log(`[ADMIN] Admin "${email}" já existe (id ${existing.id}). Nada a fazer.`);
      return;
    }
    const created = await User.create({ name, email, passwordHash: password, role: 'admin', isActive: true });
    console.log(`[ADMIN] Admin bootstrap criado: ${email} (id ${created.id}).`);
  } catch (err) {
    console.error('[ADMIN] ensureBootstrapAdmin falhou (não crítico, app continua):', err.message);
  }
}


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

    // Garante colunas críticas (ex.: areAutomatedJobsEnabled) antes de qualquer
    // query a user_preferences, evitando quebra caso a migration não tenha rodado.
    await ensureCriticalSchema();
    await ensureBootstrapAdmin();
    await debugRecorrencias('ANTES'); // TEMPORÁRIO: remover após diagnóstico

    // Realinha recorrências atrasadas (datas no passado por causa do switch que
    // ficou off): ajusta para a próxima ocorrência futura, sem gerar backlog.
    try {
      const recurringJob = require('./src/jobs/recurringTransactionJob');
      await recurringJob.realignOverdueRecurringRules();
    } catch (e) {
      console.error('[BOOT] Falha ao realinhar recorrências (não crítico):', e.message);
    }

    await debugRecorrencias('DEPOIS'); // TEMPORÁRIO: confirma que as datas avançaram

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
    'http://localhost:5173', // Vite dev
    'https://api.z-api.io' // ✅ webhooks da Z-API
  ];

  // Libera o domínio principal e QUALQUER subdomínio dele (www, app, etc.),
  // além de previews da Vercel — evita bloqueio por variação de origem.
  const allowedOriginRegexes = [
    /^https:\/\/([a-z0-9-]+\.)*map-nocontrole\.com\.br$/i,
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i
  ];

  app.use(cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // permite Postman e requests internas
      if (allowedOrigins.includes(origin) || allowedOriginRegexes.some((re) => re.test(origin))) {
        return callback(null, true);
      }
      console.warn(`🚫 CORS bloqueado para origem não autorizada: ${origin}`);
      // Não lança erro (evita 500 sem headers CORS); apenas não autoriza a origem.
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // ==========================================================================
  // MIDDLEWARES ESSENCIAIS
  // ==========================================================================
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use('/reports', express.static(path.join(process.cwd(), 'temp_reports')));


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

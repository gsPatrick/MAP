// src/utils/logger.js
const fs = require('fs');
const path = require('path');

// Define o diretório de logs (pode ser configurável via .env)
const logDirectory = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'); // Ex: raiz_do_projeto/logs
const logFile = path.join(logDirectory, 'app.log');

// Cria o diretório de logs se não existir
if (!fs.existsSync(logDirectory)) {
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
  } catch (error) {
    console.error('Falha ao criar diretório de logs:', error);
    // Se não conseguir criar o diretório, os logs irão apenas para o console
  }
}

// Função para formatar a mensagem de log
function formatLogMessage(level, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  let logEntry = `${timestamp} [${level.toUpperCase()}]`;

  if (typeof message === 'string') {
    logEntry += `: ${message}`;
  } else if (typeof message === 'object' && message !== null) {
    // Se a mensagem principal for um objeto (como no errorHandler), use-a como base
    logEntry += `: ${message.message || 'Log de objeto sem mensagem principal.'}`;
    // Adiciona outros metadados do objeto principal, exceto a 'message' e 'stack' (se já impressos)
    const mainMetadata = { ...message };
    delete mainMetadata.message;
    // delete mainMetadata.stack; // O stack será tratado separadamente
    if (Object.keys(mainMetadata).length > 0) {
        logEntry += ` | Metadata: ${JSON.stringify(mainMetadata, null, process.env.NODE_ENV === 'development' ? 2 : 0)}`;
    }
  }

  // Adiciona metadados adicionais, se houver
  if (Object.keys(metadata).length > 0) {
    logEntry += ` | Adicional: ${JSON.stringify(metadata, null, process.env.NODE_ENV === 'development' ? 2 : 0)}`;
  }
  
  // Adiciona stack trace se presente no objeto principal da mensagem
  if (typeof message === 'object' && message !== null && message.stack) {
    logEntry += `\nStack Trace:\n${message.stack}\n---`;
  }

  return logEntry;
}

// Função para escrever no arquivo de log
function writeToLogFile(logEntry) {
  if (fs.existsSync(logDirectory)) { // Verifica novamente, caso tenha falhado na criação
    fs.appendFile(logFile, logEntry + '\n', (err) => {
      if (err) {
        console.error('Falha ao escrever no arquivo de log:', err);
      }
    });
  }
}

// Níveis de Log (simples)
const logger = {
  log: (message, metadata) => {
    const formatted = formatLogMessage('info', message, metadata);
    console.log(formatted);
    writeToLogFile(formatted);
  },
  info: (message, metadata) => {
    const formatted = formatLogMessage('info', message, metadata);
    console.info(formatted); // console.info geralmente tem a mesma cor de console.log
    writeToLogFile(formatted);
  },
  warn: (message, metadata) => {
    const formatted = formatLogMessage('warn', message, metadata);
    console.warn(formatted);
    writeToLogFile(formatted);
  },
  error: (message, metadata) => { // 'message' aqui pode ser o objeto 'err' do errorHandler
    const formatted = formatLogMessage('error', message, metadata);
    console.error(formatted);
    writeToLogFile(formatted);
  },
  debug: (message, metadata) => {
    // Só loga debug se NODE_ENV for 'development' ou se explicitamente habilitado
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG_LOGGING === 'true') {
      const formatted = formatLogMessage('debug', message, metadata);
      console.debug(formatted); // Em alguns consoles, console.debug pode ser estilizado diferente
      writeToLogFile(formatted);
    }
  },
};

module.exports = logger;
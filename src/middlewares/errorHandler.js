// src/middlewares/errorHandler.js
const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  logger.error({
    message: err.message,
    stack: err.stack,
    statusCode: err.statusCode || 500,
    status: err.status || 'error',
    path: req.originalUrl,
    method: req.method,
  });

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Ocorreu um erro interno no servidor.';
  // <<< GARANTIA DE STATUS NA RESPOSTA >>>
  // Se o erro tiver um 'status' (como 'fail_subscription'), use-o. Senão, use 'fail' para erros de cliente e 'error' para servidor.
  let status = err.status || (statusCode < 500 ? 'fail' : 'error');

  // Lógica de tratamento de erros do Sequelize... (mantida igual)
  if (err.name === 'SequelizeValidationError') {
    statusCode = 400; status = 'fail'; message = 'Erro de validação nos dados enviados.';
  } else if (err.name === 'SequelizeUniqueConstraintError') {
    statusCode = 409; status = 'fail'; message = 'Já existe um registro com os dados fornecidos.';
  } else if (err.name === 'SequelizeForeignKeyConstraintError') {
    statusCode = 400; status = 'fail'; message = 'Erro de chave estrangeira: um dos registros referenciados não existe.';
  }

  if (process.env.NODE_ENV === 'production' && statusCode >= 500) {
    message = 'Ocorreu um erro inesperado. Nossa equipe foi notificada.';
  }

  res.status(statusCode).json({
    status: status, // <<< AGORA SEMPRE TERÁ UM VALOR SIGNIFICATIVO
    message: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = errorHandler;
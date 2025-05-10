// src/middlewares/errorHandler.js
const logger = require('../utils/logger'); // Nosso logger customizado

function errorHandler(err, req, res, next) {
  // Se o erro já foi tratado e a resposta enviada, não faz mais nada
  if (res.headersSent) {
    return next(err);
  }

  // Loga o erro com mais detalhes usando nosso logger
  // Inclui informações da requisição para melhor rastreabilidade
  logger.error({
    message: err.message,
    stack: err.stack,
    statusCode: err.statusCode || 500,
    status: err.status || 'error', // 'error' ou 'fail' (para erros operacionais esperados)
    path: req.originalUrl,
    method: req.method,
    ip: req.ip,
    // body: req.body, // CUIDADO: Não logar dados sensíveis do corpo da requisição
    // params: req.params,
    // query: req.query,
  });

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Ocorreu um erro interno no servidor.';
  let status = err.status || 'error';

  // Tratamento específico para erros do Sequelize (Validação, Constraints, etc.)
  if (err.name === 'SequelizeValidationError') {
    statusCode = 400; // Bad Request
    status = 'fail';
    message = 'Erro de validação nos dados enviados.';
    // Você pode extrair mais detalhes dos erros de validação:
    // err.errors é um array de objetos de erro de validação
    // const validationErrors = err.errors.map(e => ({ field: e.path, message: e.message }));
    // return res.status(statusCode).json({ status, message, errors: validationErrors });
  } else if (err.name === 'SequelizeUniqueConstraintError') {
    statusCode = 409; // Conflict
    status = 'fail';
    message = 'Já existe um registro com os dados fornecidos (conflito de unicidade).';
    // const fields = err.fields; // Campos que causaram o conflito
    // message = `O valor fornecido para '${Object.keys(fields).join(', ')}' já está em uso.`;
  } else if (err.name === 'SequelizeForeignKeyConstraintError') {
    statusCode = 400; // Bad Request ou 409 Conflict
    status = 'fail';
    message = 'Erro de chave estrangeira: um dos registros referenciados não existe ou não pode ser modificado/deletado.';
  } else if (err.name === 'SequelizeDatabaseError') {
    // Erros genéricos de banco de dados, podem indicar problemas no SQL, conexão, etc.
    // Em produção, não exponha detalhes do erro de DB ao cliente
    message = process.env.NODE_ENV === 'production' ? 'Erro ao processar a requisição.' : `Erro de banco de dados: ${err.message}`;
    // statusCode permanece 500 a menos que seja um erro conhecido que possa ser mapeado
  }

  // Em ambiente de produção, não exponha detalhes de erros internos ou stack traces
  if (process.env.NODE_ENV === 'production' && statusCode === 500 && status === 'error') {
    message = 'Ocorreu um erro inesperado. Nossa equipe foi notificada.';
  }

  res.status(statusCode).json({
    status: status, // 'error' para erros inesperados, 'fail' para erros operacionais (ex: validação)
    message: message,
    // Apenas em desenvolvimento, pode-se enviar o stack trace para facilitar a depuração
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack, error: err }),
  });
}

module.exports = errorHandler;
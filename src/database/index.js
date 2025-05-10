// src/database/index.js
const sequelize = require('../config/database'); // Importa a instância já configurada

// Importe TODOS os seus modelos aqui
const Client = require('../models/Client');
const FinancialAccount = require('../models/FinancialAccount'); // << IMPORTAR FinancialAccount
const FinancialTransaction = require('../models/FinancialTransaction');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Appointment = require('../models/Appointment');
const UserPreference = require('../models/UserPreference');
const User = require('../models/User');
const MotivationalPhrase = require('../models/MotivationalPhrase');
const FinancialCategory = require('../models/FinancialCategory');
const ClientInteractionLog = require('../models/ClientInteractionLog');
const RecurringTransactionRule = require('../models/RecurringTransactionRule'); // << IMPORTAR RecurringTransactionRule
const CreditCard = require('../models/CreditCard'); // << IMPORTAR CreditCard
// Adicione aqui o ProductCategory se você o criou

const models = {
  User,
  Client,
  FinancialAccount,         // << ADICIONAR AO OBJETO MODELS
  FinancialCategory,
  FinancialTransaction,
  Product,
  // ProductCategory,       // Se você criou
  StockMovement,
  Appointment,
  UserPreference,
  MotivationalPhrase,
  ClientInteractionLog,
  RecurringTransactionRule, // << ADICIONAR AO OBJETO MODELS
  CreditCard,               // << ADICIONAR AO OBJETO MODELS
};

// Inicializar associações
// É crucial que os modelos sejam definidos ANTES de tentar associá-los.
// A ordem de chamada de 'associate' não importa tanto, desde que todos os modelos
// estejam no objeto 'models' quando 'associate' é chamado.

console.log("Inicializando associações dos modelos...");
Object.values(models).forEach(model => {
  if (model && model.associate) { // Adicionada verificação se model existe
    console.log(`Associando modelo: ${model.name}`);
    model.associate(models); // Passa todos os outros modelos para a função associate
  } else {
    // console.log(`Modelo ${model.name} não possui método associate ou é undefined.`); // Opcional: para debug
  }
});
console.log("Associações dos modelos finalizadas.");

module.exports = {
  sequelize, // Exporta a instância do Sequelize
  ...models, // Exporta todos os modelos individualmente para fácil acesso
};
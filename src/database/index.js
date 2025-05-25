// src/database/index.js
const sequelize = require('../config/database'); // Importa a instância já configurada

// Importe TODOS os seus modelos aqui
const Client = require('../models/Client');
const FinancialAccount = require('../models/FinancialAccount');
const FinancialTransaction = require('../models/FinancialTransaction');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Appointment = require('../models/Appointment');
const UserPreference = require('../models/UserPreference');
const User = require('../models/User'); // Admin users
const MotivationalPhrase = require('../models/MotivationalPhrase');
const FinancialCategory = require('../models/FinancialCategory');
const ClientInteractionLog = require('../models/ClientInteractionLog');
const RecurringTransactionRule = require('../models/RecurringTransactionRule');
const CreditCard = require('../models/CreditCard');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const KanbanTask = require('../models/KanbanTask'); // <<< ADICIONAR IMPORTAÇÃO DO NOVO MODELO

// Adicione aqui o ProductCategory se você o criou

const models = {
  User,                       // Admin users
  Client,                     // Usuários finais (contatos WhatsApp / usuários dashboard)
  Plan,
  Subscription,
  FinancialAccount,
  FinancialCategory,
  FinancialTransaction,
  Product,
  // ProductCategory,       // Se você criou
  StockMovement,
  Appointment,
  UserPreference,           // Configurações do sistema
  MotivationalPhrase,
  ClientInteractionLog,
  RecurringTransactionRule,
  CreditCard,
  KanbanTask,                 // <<< ADICIONADO AO OBJETO MODELS
};

// Inicializar associações
console.log("Inicializando associações dos modelos...");
Object.values(models).forEach(model => {
  if (model && model.associate) {
    console.log(`Associando modelo: ${model.name}`);
    model.associate(models);
  } else if (model) {
    // console.log(`Modelo ${model.name} não possui método associate.`); // Opcional para debug
  } else {
    // console.warn(`Um modelo no objeto 'models' é undefined.`); // Alerta se um modelo não foi carregado corretamente
  }
});
console.log("Associações dos modelos finalizadas.");

module.exports = {
  sequelize,
  ...models, // Exporta todos os modelos individualmente
};
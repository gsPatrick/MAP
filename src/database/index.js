// src/database/index.js
const sequelize = require('../config/database');

const Client = require('../models/Client');
const FinancialAccount = require('../models/FinancialAccount');
const FinancialTransaction = require('../models/FinancialTransaction');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Appointment = require('../models/Appointment');
const UserPreference = require('../models/UserPreference');
const User = require('../models/User');
const MotivationalPhrase = require('../models/MotivationalPhrase');
const FinancialCategory = require('../models/FinancialCategory');
const ClientInteractionLog = require('../models/ClientInteractionLog');
const RecurringTransactionRule = require('../models/RecurringTransactionRule');
const CreditCard = require('../models/CreditCard');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const KanbanTask = require('../models/KanbanTask');
const KanbanColumn = require('../models/KanbanColumn'); // <<< ADICIONAR IMPORTAÇÃO

const models = {
  User,
  Client,
  Plan,
  Subscription,
  FinancialAccount,
  FinancialCategory,
  FinancialTransaction,
  Product,
  StockMovement,
  Appointment,
  UserPreference,
  MotivationalPhrase,
  ClientInteractionLog,
  RecurringTransactionRule,
  CreditCard,
  KanbanColumn, // <<< ADICIONADO AO OBJETO
  KanbanTask,
};

console.log("Inicializando associações dos modelos...");
Object.values(models).forEach(model => {
  if (model && model.associate) {
    console.log(`Associando modelo: ${model.name}`);
    model.associate(models);
  }
});
console.log("Associações dos modelos finalizadas.");

module.exports = {
  sequelize,
  ...models,
};
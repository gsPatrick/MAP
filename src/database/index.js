// src/database/index.js
const { Sequelize } = require('sequelize');
const config = require('../config/database');
const logger = require('../utils/logger');

// Importar modelos
const User = require('../models/User');
const Client = require('../models/Client');
const FinancialAccount = require('../models/FinancialAccount');
const FinancialTransaction = require('../models/FinancialTransaction');
const CreditCard = require('../models/CreditCard');
const RecurringTransactionRule = require('../models/RecurringTransactionRule');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Appointment = require('../models/Appointment');
const ClientInteractionLog = require('../models/ClientInteractionLog');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const FinancialCategory = require('../models/FinancialCategory');
const MotivationalPhrase = require('../models/MotivationalPhrase');
const UserPreference = require('../models/UserPreference');
// NOVOS MODELOS
const BusinessClient = require('../models/BusinessClient');
const AppointmentBusinessClient = require('../models/AppointmentBusinessClient');


const env = process.env.NODE_ENV || 'development';
const dbConfig = config[env];

const sequelize = new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
  host: dbConfig.host,
  dialect: dbConfig.dialect,
  logging: dbConfig.logging === 'true' ? (msg => logger.debug(msg)) : false,
  timezone: dbConfig.timezone, // Use a timezone do seu servidor ou 'Z' para UTC
  dialectOptions: dbConfig.dialectOptions, // Configurações específicas do dialeto
});

const models = {
  User: User(sequelize, DataTypes),
  Client: Client(sequelize, DataTypes),
  FinancialAccount: FinancialAccount(sequelize, DataTypes),
  FinancialTransaction: FinancialTransaction(sequelize, DataTypes),
  CreditCard: CreditCard(sequelize, DataTypes),
  RecurringTransactionRule: RecurringTransactionRule(sequelize, DataTypes),
  Product: Product(sequelize, DataTypes),
  StockMovement: StockMovement(sequelize, DataTypes),
  Appointment: Appointment(sequelize, DataTypes),
  ClientInteractionLog: ClientInteractionLog(sequelize, DataTypes),
  Plan: Plan(sequelize, DataTypes),
  Subscription: Subscription(sequelize, DataTypes),
  FinancialCategory: FinancialCategory(sequelize, DataTypes),
  MotivationalPhrase: MotivationalPhrase(sequelize, DataTypes),
  UserPreference: UserPreference(sequelize, DataTypes),
  // NOVOS MODELOS
  BusinessClient: BusinessClient(sequelize, DataTypes),
  AppointmentBusinessClient: AppointmentBusinessClient(sequelize, DataTypes), // Não precisa passar DataTypes para models de junção simples, mas não faz mal
};

// Associar Modelos
Object.values(models)
  .filter(model => typeof model.associate === 'function')
  .forEach(model => model.associate(models));

// Log de associações (Opcional para debug)
// logger.debug("Associações configuradas:", Object.keys(models).map(name => ({ model: name, associations: Object.keys(models[name].associations) })));


module.exports = {
  ...models,
  sequelize,
};
// src/database/index.js

// Importar a instância do Sequelize já criada e configurada
const sequelize = require('../config/database');

// Importar DataTypes (pode ser útil exportar)
const { DataTypes } = require('sequelize');

// --- Importar TODOS os arquivos de modelo e armazenar as classes diretamente ---
// Requerer os arquivos executa o sequelize.define dentro deles.
// Armazenamos as referências às classes exportadas.
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
// NOVOS MODELOS: Importar as classes
const BusinessClient = require('../models/BusinessClient');
const AppointmentBusinessClient = require('../models/AppointmentBusinessClient');


// --- Criar o objeto 'models' com as classes importadas ---
// Esta abordagem difere de usar sequelize.models diretamente,
// mas garante que estamos usando as *referências* exatas que importamos.
const models = {
  User: User,
  Client: Client,
  FinancialAccount: FinancialAccount,
  FinancialTransaction: FinancialTransaction,
  CreditCard: CreditCard,
  RecurringTransactionRule: RecurringTransactionRule,
  Product: Product,
  StockMovement: StockMovement,
  Appointment: Appointment,
  ClientInteractionLog: ClientInteractionLog,
  Plan: Plan,
  Subscription: Subscription,
  FinancialCategory: FinancialCategory,
  MotivationalPhrase: MotivationalPhrase,
  UserPreference: UserPreference,
  // NOVOS MODELOS
  BusinessClient: BusinessClient,
  AppointmentBusinessClient: AppointmentBusinessClient,
};


// --- ADICIONAR LOGGING DE DEBUG AQUI NOVAMENTE ---
// Agora inspecionando o objeto 'models' que acabamos de construir
console.log("--- DEBUG (Post-Import Object): Modelos disponíveis para associação ---");
let allModelsValid = true;
const SequelizeModel = require('sequelize').Model; // Para verificar se é subclasse de Model

for (const modelName in models) {
    if (Object.hasOwnProperty.call(models, modelName)) {
        const model = models[modelName];
        const isValid = model && typeof model === 'function' && model.prototype instanceof SequelizeModel;
        console.log(`Modelo: ${modelName}, Tipo: ${typeof model}, É subclasse de Model: ${isValid}`);

         if (modelName === 'FinancialAccount' || modelName === 'BusinessClient' || modelName === 'AppointmentBusinessClient') {
             console.log(`  DEBUG: Detalhes para ${modelName}:`, {
                 name: model?.name,
                 hasAssociate: typeof model?.associate === 'function',
                 // keysInModelsObject: Object.keys(models) // Já listado no loop
             });
        }

        if (!isValid) {
            allModelsValid = false;
            console.error(`  ERRO: Modelo "${modelName}" não é uma subclasse válida de Sequelize.Model.`);
        }
    }
}

if (!allModelsValid) {
    console.error("--- FIM DEBUG (Post-Import Object): Alguns modelos não são válidos. Verifique os arquivos de modelo e a inicialização. ---");
    // Não lance um erro aqui, deixe o loop de associação abaixo capturá-lo
} else {
    console.log("--- FIM DEBUG (Post-Import Object): Todos os modelos importados parecem válidos. ---");
}
console.log("------------------------------------------------------------------");
// --- FIM DO LOGGING DE DEBUG ---


// --- Chamar o método associate em cada modelo que tiver um ---
// Passamos o objeto 'models' (o que acabamos de construir)
Object.values(models)
  .filter(model => typeof model.associate === 'function')
  .forEach(model => {
      try {
          model.associate(models);
           console.log(`Associações configuradas para o modelo: ${model.name}`);
      } catch(error) {
          console.error(`Erro ao configurar associações para o modelo ${model.name}:`, error);
           const specificError = new Error(`Falha ao configurar associações para o modelo ${model.name}: ${error.message}`);
          specificError.stack = error.stack;
          throw specificError; // Re-lançar o erro
      }
  });

// --- Exportar a instância do sequelize e os modelos ---
module.exports = {
  sequelize, // Exporta a instância configurada do Sequelize
  ...models, // Exporta todas as classes de modelo importadas
  DataTypes // Exporta DataTypes (útil para migrations, por exemplo)
};
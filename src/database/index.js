// src/database/index.js
const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

// --- Requerer TODOS os arquivos de modelo ---
require('../models/Client');
require('../models/FinancialAccount');
require('../models/BusinessClient');
require('../models/KanbanColumn');
require('../models/KanbanTask');
require('../models/Appointment');
require('../models/AppointmentBusinessClient');
require('../models/User');
require('../models/FinancialCategory');
require('../models/FinancialTransaction');
require('../models/CreditCard');
require('../models/RecurringTransactionRule');
require('../models/Product');
require('../models/StockMovement');
require('../models/ClientInteractionLog');
require('../models/Plan');
require('../models/Subscription');
require('../models/MotivationalPhrase');
require('../models/UserPreference');
require('../models/SharedAccess');
require ('../models/WaterIntakeLog') // <<< SharedAccess está aqui
require('../models/AppointmentService')
require('../models/Service');
require('../models/AvailabilityRule')

const models = sequelize.models;

// --- DEBUG ---
console.log("--- DEBUG: Modelos registrados ANTES de associações (database/index.js) ---");
const SequelizeModel = require('sequelize').Model;
let allModelsValidBeforeAssociate = true;
for (const modelName in models) {
    if (Object.hasOwnProperty.call(models, modelName)) {
        const model = models[modelName];
        const isValid = model && typeof model === 'function' && model.prototype instanceof SequelizeModel;
        console.log(`Modelo: ${modelName}, Tipo: ${typeof model}, Válido: ${isValid}`);
        if (!isValid) {
            allModelsValidBeforeAssociate = false;
            console.error(`  ERRO DEBUG (database/index.js): Modelo "${modelName}" NÃO é Sequelize Model válido ANTES de associate.`);
        }
    }
}
if (!allModelsValidBeforeAssociate) {
    console.error("--- FIM DEBUG (database/index.js): ALGUNS MODELOS INVÁLIDOS ANTES DE ASSOCIATE! VERIFIQUE AS DEFINIÇÕES. ---");
} else {
     console.log("--- FIM DEBUG (database/index.js): Todos os modelos parecem VÁLIDOS antes de associate. ---");
}
console.log("------------------------------------------------------");
// --- FIM DEBUG ---


Object.values(models)
  .filter(model => typeof model.associate === 'function')
  .forEach(model => {
      try {
          // --- DEBUG ESPECÍFICO PARA Client e SharedAccess ---
          if (model.name === 'Client') {
              console.log("--- DEBUG (database/index.js): Preparando para Client.associate ---");
              console.log("models.SharedAccess existe?", !!models.SharedAccess);
              console.log("typeof models.SharedAccess:", typeof models.SharedAccess);
              if (models.SharedAccess) {
                console.log("models.SharedAccess.prototype instanceof SequelizeModel:", models.SharedAccess.prototype instanceof SequelizeModel);
              } else {
                console.log("models.SharedAccess é UNDEFINED ou NULL ao tentar associar com Client.");
              }
              console.log("------------------------------------------------------------");
          }
          // --- FIM DEBUG ESPECÍFICO ---

          model.associate(models);
          console.log(`Associações configuradas para o modelo: ${model.name}`);
      } catch(error) {
          console.error(`Erro CRÍTICO ao configurar associações para o modelo ${model.name}:`, error);
          const specificError = new Error(`Falha crítica ao configurar associações para ${model.name}: ${error.message}. Verifique a definição do modelo e suas associações.`);
          specificError.stack = error.stack;
          throw specificError;
      }
  });

module.exports = {
  sequelize,
  ...models,
  DataTypes
};
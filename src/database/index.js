// src/database/index.js

// Importar a instância do Sequelize já criada e configurada
const sequelize = require('../config/database');

// Importar DataTypes apenas se necessário diretamente neste arquivo
// Os modelos geralmente importam DataTypes por si, mas manter aqui não prejudica.
const { DataTypes } = require('sequelize');

// --- Importar TODOS os arquivos de modelo ---
// Este passo executa o código em cada arquivo, incluindo o sequelize.define,
// que registra o modelo com a instância 'sequelize'.
// É crucial que todos os arquivos de modelo estejam listados aqui.
require('../models/User');
require('../models/Client');
require('../models/FinancialAccount');
require('../models/FinancialTransaction');
require('../models/CreditCard');
require('../models/RecurringTransactionRule');
require('../models/Product');
require('../models/StockMovement');
require('../models/Appointment');
require('../models/ClientInteractionLog');
require('../models/Plan');
require('../models/Subscription');
require('../models/FinancialCategory');
require('../models/MotivationalPhrase');
require('../models/UserPreference');
// NOVOS MODELOS: Certifique-se que os requires para eles estão presentes
require('../models/BusinessClient'); // <--- Verifique se este require está correto
require('../models/AppointmentBusinessClient'); // <--- Verifique se este require está correto


// --- Obter os modelos diretamente da instância do Sequelize ---
// Isso garante que estamos trabalhando com os modelos que foram
// definidos e registrados corretamente pelo sequelize.define.
// 'sequelize.models' contém todos os modelos definidos por sequelize.define na instância 'sequelize'.
const models = sequelize.models;

// --- ADICIONAR LOGGING DE DEBUG AQUI ---
console.log("--- DEBUG: Modelos registrados e disponíveis para associação ---");
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
                 keysInModelsObject: Object.keys(models) // Lista todas as chaves presentes no objeto models
             });
        }

        if (!isValid) {
            allModelsValid = false;
            console.error(`  ERRO: Modelo "${modelName}" não é uma subclasse válida de Sequelize.Model.`);
        }
    }
}

if (!allModelsValid) {
    console.error("--- FIM DEBUG: Alguns modelos não são válidos. Verifique os arquivos de modelo e a inicialização. ---");
    // Não lance um erro aqui ainda, deixe o loop de associação abaixo capturá-lo
} else {
    console.log("--- FIM DEBUG: Todos os modelos registrados parecem válidos. ---");
}
console.log("------------------------------------------------------------------");
// --- FIM DO LOGGING DE DEBUG ---


// --- Chamar o método associate em cada modelo que tiver um ---
// Passamos o objeto 'models' (que agora é sequelize.models)
// para que cada modelo possa configurar suas associações.
Object.values(models)
  .filter(model => typeof model.associate === 'function')
  .forEach(model => {
      try {
          model.associate(models);
           console.log(`Associações configuradas para o modelo: ${model.name}`); // Log de sucesso
      } catch(error) {
          console.error(`Erro ao configurar associações para o modelo ${model.name}:`, error);
          // Capture o erro específico aqui para dar mais contexto antes de relançar
          const specificError = new Error(`Falha ao configurar associações para o modelo ${model.name}: ${error.message}`);
          specificError.stack = error.stack; // Mantém o stack original
          throw specificError; // Re-lançar o erro para parar a aplicação
      }
  });

// --- Exportar a instância do sequelize e os modelos ---
module.exports = {
  sequelize, // Exporta a instância configurada do Sequelize
  ...models, // Exporta todas as classes de modelo registradas
  DataTypes // Exporta DataTypes (útil para migrations, por exemplo)
};
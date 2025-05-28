// src/database/index.js

// Importar a instância do Sequelize já criada e configurada
const sequelize = require('../config/database');

// Importar DataTypes (pode ser útil exportar para migrations, etc.)
const { DataTypes } = require('sequelize');


// --- Requerer TODOS os arquivos de modelo ---
// Este passo é CRUCIAL. Ao "requerer" cada arquivo, o código dentro dele é executado.
// Assumindo que cada arquivo de modelo contém uma chamada `sequelize.define(...)`
// usando a instância `sequelize` importada de `../config/database`,
// esta chamada registra o modelo recém-definido *automaticamente* na instância `sequelize`.
// É essencial que TODOS os seus arquivos de modelo estejam listados aqui.
// Adicione um `require` para cada novo arquivo de modelo que você criar.

// REORDENADO: Mover modelos que foram adicionados recentemente
// ou modelos que são fortemente associados entre si para serem requeridos mais cedo.
// Isso pode ajudar a garantir que o Sequelize tenha processado completamente suas definições
// antes que as associações sejam configuradas.

// Modelos centrais e os novos modelos que podem ter causado o problema
require('../models/Client'); // Central, muitos outros dependem dele
require('../models/FinancialAccount'); // Central, associa a muitos, incluindo os novos
require('../models/BusinessClient'); // Novo modelo
require('../models/KanbanColumn'); // Novo modelo (associado a FinancialAccount)
require('../models/KanbanTask'); // Novo modelo (associado a KanbanColumn e FinancialAccount)
require('../models/Appointment'); // Associado a BusinessClient (e FinancialAccount)
require('../models/AppointmentBusinessClient'); // Tabela de junção para Appointment-BusinessClient

// Outros modelos
require('../models/User'); // Modelo de usuário admin
require('../models/FinancialCategory'); // Associado a FinancialTransaction
require('../models/FinancialTransaction'); // Associado a FinancialAccount, CreditCard, Category, RecurringRule
require('../models/CreditCard'); // Associado a FinancialAccount e FinancialTransaction
require('../models/RecurringTransactionRule'); // Associado a FinancialAccount e FinancialTransaction
require('../models/Product'); // Associado a FinancialAccount
require('../models/StockMovement'); // Associado a Product
require('../models/ClientInteractionLog'); // Associado a Client
require('../models/Plan'); // Associado a Subscription
require('../models/Subscription'); // Associado a Client e Plan
require('../models/MotivationalPhrase'); // Modelo independente (para funcionalidade de frases)
require('../models/UserPreference'); // Configurações globais (pode ser singleton)


// --- Obter os modelos definidos a partir da instância do Sequelize ---
// Após requerir todos os arquivos de modelo acima, a instância `sequelize`
// agora tem todos os modelos definidos e registrados acessíveis em `sequelize.models`.
// Este objeto `sequelize.models` contém as classes de modelo prontas para uso.
const models = sequelize.models;


// --- DEBUG: Validar modelos antes de configurar associações ---
// Este logging ajuda a confirmar quais modelos foram carregados e se o Sequelize
// os reconhece como subclasses válidas de Sequelize.Model antes de tentar associá-los.
console.log("--- DEBUG: Modelos registrados com a instância Sequelize ---");
const SequelizeModel = require('sequelize').Model; // Importar a classe base Model para a verificação
let allModelsSeemValid = true; // Flag para verificar se todos parecem válidos

for (const modelName in models) {
    // Verifica se a propriedade pertence ao objeto diretamente (não herança)
    if (Object.hasOwnProperty.call(models, modelName)) {
        const model = models[modelName];
        // Verifica se é uma função (constructor) e se é uma instância (ou protótipo) da classe base do Sequelize Model
        const isValid = model && typeof model === 'function' && model.prototype instanceof SequelizeModel;
        console.log(`Modelo: ${modelName}, Tipo: ${typeof model}, É subclasse de Sequelize.Model: ${isValid}`);

        if (!isValid) {
            allModelsSeemValid = false;
             console.error(`  ERRO DEBUG: Modelo "${modelName}" não é uma subclasse válida de Sequelize.Model.`);
        }
    }
}

if (!allModelsSeemValid) {
    console.error("--- FIM DEBUG: Alguns modelos registrados NÃO parecem ser Sequelize Models. Verifique as definições nos arquivos de modelo. ---");
} else {
     console.log("--- FIM DEBUG: Todos os modelos registrados parecem ser válidos Sequelize Models. ---");
}
console.log("------------------------------------------------------");
// --- FIM DO DEBUG ---


// --- Configurar Associações ---
// Iterar sobre os modelos que foram registrados na instância `sequelize`
// (acessíveis via `sequelize.models`).
// Para cada modelo que tiver um método estático `associate`, chamá-lo.
// Passamos o objeto `models` (que é `sequelize.models`) para que cada modelo
// possa referenciar outros modelos (ex: `models.User`, `models.FinancialAccount`).
Object.values(models)
  .filter(model => typeof model.associate === 'function') // Filtra apenas modelos com o método associate
  .forEach(model => {
      try {
          // Chama o método associate, passando o objeto completo de modelos
          // O DEBUG dentro de FinancialAccount.associate mostrou que models.BusinessClient existe AQUI.
          // O erro deve ser algum estado interno do Sequelize relacionado à ordem de definição vs. associação.
          model.associate(models);
           console.log(`Associações configuradas para o modelo: ${model.name}`); // Log de sucesso
      } catch(error) {
          console.error(`Erro ao configurar associações para o modelo ${model.name}:`, error);
          // Envolve o erro original em um novo erro mais informativo e o re-lança.
          // Isso ajuda a rastrear qual modelo específico causou o problema durante a configuração.
          const specificError = new Error(`Falha ao configurar associações para o modelo ${model.name}: ${error.message}`);
          specificError.stack = error.stack; // Mantém o stack trace original para debug
          throw specificError; // Re-lançar o erro para parar a aplicação, pois o DB não está configurado corretamente
      }
  });


// --- Exportar a instância do sequelize e todos os modelos definidos ---
// Exportamos a instância `sequelize` (que agora contém a conexão e todos os modelos definidos)
// e também exportamos os modelos individualmente para que possam ser importados em outros lugares
// usando `require('../database')`.
module.exports = {
  sequelize, // Exporta a instância configurada e inicializada do Sequelize
  ...models, // Usa o spread operator para exportar todas as classes de modelo registradas individualmente (ex: User, Client, etc.)
  DataTypes // Exporta DataTypes (útil para usar em migrations, por exemplo, sem importar sequelize globalmente)
};
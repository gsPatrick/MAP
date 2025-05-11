// src/models/Client.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs'); // <<< ADICIONADO

const Client = sequelize.define('Client', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Nome do contato do WhatsApp (pessoa física)',
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    comment: 'Número de telefone do WhatsApp do cliente (com DDI+DDD)',
  },
  email: { // <<< TORNANDO MAIS ROBUSTO PARA LOGIN WEB
    type: DataTypes.STRING,
    allowNull: true, // Inicialmente pode ser nulo, mas obrigatório para registro no dashboard
    unique: true,
    validate: {
      isEmailOrNull(value) { // Permite nulo ou um email válido
        if (value !== null && value !== '' && !validator.isEmail(value)) { // Usar 'validator' se disponível ou uma regex
          throw new Error('Forneça um email válido ou deixe o campo vazio.');
        }
      }
    },
    comment: 'Email do cliente, usado para login no dashboard web',
  },
  passwordHash: { // <<< NOVO CAMPO
    type: DataTypes.STRING,
    allowNull: true, // Nulo até que o cliente defina uma senha (para o dashboard)
    comment: 'Hash da senha do cliente para acesso ao dashboard web',
  },
  status: {
    type: DataTypes.ENUM('Ativo', 'Inativo', 'Bloqueado', 'Aguardando Pagamento', 'Pagamento Falhou'), // <<< ADICIONADO STATUS DE PAGAMENTO
    defaultValue: 'Ativo', // Pode mudar para 'Aguardando Pagamento' após primeiro contato
    allowNull: false,
    comment: 'Status do cliente no sistema',
  },
  // Outros campos
}, {
  tableName: 'clients',
  timestamps: true,
  comment: 'Representa o contato do WhatsApp e usuário do dashboard',
  defaultScope: { // <<< ADICIONADO DEFAULT SCOPE
    attributes: { exclude: ['passwordHash'] },
  },
  scopes: { // <<< ADICIONADO SCOPE
    withPassword: {
      attributes: { include: ['passwordHash'] },
    }
  },
  hooks: { // <<< ADICIONADO HOOKS
    beforeCreate: async (client) => {
      if (client.email) { // Normalizar email para minúsculas
          client.email = client.email.toLowerCase();
      }
      if (client.passwordHash) { // Hashear senha se fornecida na criação
        client.passwordHash = await bcrypt.hash(client.passwordHash, 10);
      }
    },
    beforeUpdate: async (client) => {
      if (client.changed('email') && client.email) {
        client.email = client.email.toLowerCase();
      }
      // Hashear a senha apenas se ela foi modificada e não é já um hash longo
      if (client.changed('passwordHash') && client.passwordHash && client.passwordHash.length < 60) {
        client.passwordHash = await bcrypt.hash(client.passwordHash, 10);
      }
    }
  },
  indexes: [
    { unique: true, fields: ['phone'] },
    // Adicionado para garantir que o email (se não nulo) seja único
    { unique: true, fields: ['email'], where: { email: { [DataTypes.Op.ne]: null } } } // Correção: Op do DataTypes
  ]
});

// Método de instância para verificar a senha (para Client) <<< ADICIONADO
Client.prototype.isValidPassword = async function(password) {
  if (!this.passwordHash) return false; // Se não há hash, não há como validar
  return bcrypt.compare(password, this.passwordHash);
};

Client.associate = (models) => {
  Client.hasMany(models.FinancialAccount, {
    foreignKey: 'clientId',
    as: 'financialAccounts',
    onDelete: 'CASCADE',
  });
  Client.hasMany(models.ClientInteractionLog, {
    foreignKey: 'clientId',
    as: 'interactionLogs',
    onDelete: 'CASCADE',
  });
  Client.hasMany(models.Subscription, { // <<< NOVA ASSOCIAÇÃO
    foreignKey: 'clientId',
    as: 'subscriptions',
    onDelete: 'CASCADE',
  });
};

// Para usar validator.isEmail, você precisaria instalar 'validator': npm install validator
// Por simplicidade, aqui a validação de email é básica. Para produção, use uma biblioteca.
// Mock do validator para o exemplo:
const validator = { isEmail: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) }; // Regex simples

module.exports = Client;
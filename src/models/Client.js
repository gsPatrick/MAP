// src/models/Client.js
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');

// Mock do validator para o exemplo (ou use `npm install validator`)
const validator = {
  isEmail: (value) => {
    if (typeof value !== 'string') {
      return false;
    }
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
};

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
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    validate: {
      isEmailOrNull(value) {
        if (value === null || value === '') {
          return;
        }
        if (!validator.isEmail(value)) {
          throw new Error('Forneça um email válido ou deixe o campo vazio.');
        }
      }
    },
    comment: 'Email do cliente, usado para login no dashboard web',
  },
  passwordHash: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Hash da senha do cliente para acesso ao dashboard web',
  },
  status: {
    type: DataTypes.ENUM('Ativo', 'Inativo', 'Bloqueado', 'Aguardando Pagamento', 'Pagamento Falhou'),
    defaultValue: 'Ativo',
    allowNull: false,
    comment: 'Status do cliente no sistema',
  },
  accessLevel: {
    type: DataTypes.ENUM(
        'gratuito',
        'basico_mensal',
        'basico_anual',
        'avancado_mensal',
        'avancado_anual',
        'vitalicio_basico',
        'vitalicio_avancado'
    ),
    allowNull: false,
    defaultValue: 'gratuito',
    comment: 'Nível de acesso/plano do cliente',
  },
  accessExpiresAt: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      comment: 'Data em que o nível de acesso pago expira (para planos temporários)',
  }
}, {
  tableName: 'clients',
  timestamps: true,
  comment: 'Representa o contato do WhatsApp e usuário do dashboard',
  defaultScope: {
    attributes: { exclude: ['passwordHash'] },
  },
  scopes: {
    withPassword: {
      attributes: { include: ['passwordHash'] },
    }
  },
  hooks: {
    beforeCreate: async (client) => {
      if (client.email) {
        client.email = client.email.toLowerCase();
      }
      if (client.passwordHash) {
        client.passwordHash = await bcrypt.hash(client.passwordHash, 10);
      }
      if (client.accessLevel && !client.accessExpiresAt) {
        const now = new Date();
        if (client.accessLevel.includes('_mensal')) {
          now.setMonth(now.getMonth() + 1);
          client.accessExpiresAt = now.toISOString().split('T')[0];
        } else if (client.accessLevel.includes('_anual')) {
          now.setFullYear(now.getFullYear() + 1);
          client.accessExpiresAt = now.toISOString().split('T')[0];
        } else if (client.accessLevel.startsWith('vitalicio_') || client.accessLevel === 'gratuito') {
            client.accessExpiresAt = null;
        }
      }
    },
    beforeUpdate: async (client) => {
      if (client.changed('email') && client.email) {
        client.email = client.email.toLowerCase();
      }
      if (client.changed('passwordHash') && client.passwordHash && client.passwordHash.length < 60) {
        client.passwordHash = await bcrypt.hash(client.passwordHash, 10);
      }
      if (client.changed('accessLevel')) {
        const now = new Date();
        if (client.accessLevel.includes('_mensal')) {
          now.setMonth(now.getMonth() + 1);
          client.accessExpiresAt = now.toISOString().split('T')[0];
        } else if (client.accessLevel.includes('_anual')) {
          now.setFullYear(now.getFullYear() + 1);
          client.accessExpiresAt = now.toISOString().split('T')[0];
        } else if (client.accessLevel.startsWith('vitalicio_') || client.accessLevel === 'gratuito') {
          client.accessExpiresAt = null;
        }
      }
    }
  },
  indexes: [
    { unique: true, fields: ['phone'] },
    { unique: true, fields: ['email'], where: { email: { [Op.ne]: null } } },
    { fields: ['accessLevel'] },
    { fields: ['accessExpiresAt'] },
  ]
});

Client.prototype.isValidPassword = async function(password) {
  if (!this.passwordHash) return false;
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
  Client.hasMany(models.Subscription, {
    foreignKey: 'clientId',
    as: 'subscriptions',
    onDelete: 'CASCADE',
  });

  // Associações para SharedAccess
  // Um cliente pode SER O DONO de vários compartilhamentos
  Client.hasMany(models.SharedAccess, {
    foreignKey: 'ownerClientId',
    as: 'ownedSharedAccesses', // Acessos que este cliente concedeu
    onDelete: 'CASCADE',
  });
  // Um cliente pode RECEBER acesso de vários compartilhamentos
  Client.hasMany(models.SharedAccess, {
    foreignKey: 'sharedWithClientId',
    as: 'receivedSharedAccesses', // Acessos que este cliente recebeu
    onDelete: 'CASCADE',
  });
};

module.exports = Client;
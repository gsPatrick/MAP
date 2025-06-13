// src/models/Client.js
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto'); // Correção para usar o módulo nativo do Node.js

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
    debugPassword: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'SENHA EM TEXTO PURO APENAS PARA DEBUG. NUNCA USE EM PRODUÇÃO!',
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
  },
  // --- Campos para Integração Google Calendar ---
  googleAccessToken: {
    type: DataTypes.STRING(1024),
    allowNull: true,
    comment: 'Token de acesso do Google (criptografado)',
  },
  googleRefreshToken: {
    type: DataTypes.STRING(1024),
    allowNull: true,
    comment: 'Token de refresh do Google (criptografado)',
  },
  googleTokenExpiryDate: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Data de expiração do token de acesso do Google',
  },
  googleCalendarIdPrincipal: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'ID do calendário principal do Google do usuário (geralmente "primary")',
  },
  isGoogleCalendarSynced: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
    comment: 'Indica se a sincronização com o Google Calendar está ativa para este cliente',
  },
  googleCalendarColorIdPF: {
    type: DataTypes.STRING(2),
    allowNull: true,
    defaultValue: '1',
    comment: 'ID da cor padrão para eventos de Pessoa Física no Google Calendar',
  },
  googleCalendarColorIdPJ: {
    type: DataTypes.STRING(2),
    allowNull: true,
    defaultValue: '2',
    comment: 'ID da cor padrão para eventos de Pessoa Jurídica no Google Calendar',
  },
  // --- Campos para Webhook (Push Notifications) do Google Calendar ---
  googleChannelId: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'ID do canal de notificação do Google Calendar',
  },
  googleChannelResourceId: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'ID do recurso (calendário) que está sendo observado pelo Google',
  },
  googleChannelExpiryDate: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Data de expiração do canal de notificação do Google Calendar',
  },
  googleLastSyncToken: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Último syncToken do Google Calendar para este cliente',
  },
   wantsMotivationMessage: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: 'Indica se o cliente deseja receber a mensagem motivacional diária.',
  },
    motivationMessageTime: {
    type: DataTypes.TIME,
    allowNull: false,
    defaultValue: '13:00:00',
    comment: 'Horário preferencial do cliente para receber a mensagem motivacional.',
  },
   lastMotivationSentDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    comment: 'Registra a data do último envio de mensagem motivacional para este cliente.',
  },
    asaasCustomerId: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    comment: 'ID do cliente correspondente na plataforma ASAAS',
  },
  // --- Fim dos Campos Google Calendar ---

  // ===============================================
  // === INÍCIO DOS NOVOS CAMPOS PARA AFILIADOS ===
  // ===============================================
  affiliateCode: {
    type: DataTypes.STRING(12),
    allowNull: true,
    unique: true,
    comment: 'Código único de afiliado deste cliente.',
  },
  referredByClientId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'clients', // Auto-referência
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
    comment: 'ID do cliente afiliado que indicou este cliente.',
  },
  balance: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0.00,
    comment: 'Saldo de comissões disponível para saque.',
  },
  asaasPayoutPixKey: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Chave PIX do cliente para receber pagamentos de comissão.',
  },
  // ===============================================
  // === FIM DOS NOVOS CAMPOS PARA AFILIADOS ===
  // ===============================================

}, {
  tableName: 'clients',
  timestamps: true,
  comment: 'Representa o contato do WhatsApp e usuário do dashboard',
  defaultScope: {
    attributes: { exclude: ['passwordHash', 'googleAccessToken', 'googleRefreshToken'] },
  },
  scopes: {
    withPassword: {
      attributes: { include: ['passwordHash'] },
    },
    withGoogleTokens: {
        attributes: { include: ['googleAccessToken', 'googleRefreshToken'] },
    }
  },
  hooks: {
    beforeCreate: async (client) => {
      // Gera o código de afiliado para o novo cliente
      if (!client.affiliateCode) {
        client.affiliateCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      }
      
      if (client.email) client.email = client.email.toLowerCase();
      if (client.passwordHash) client.passwordHash = await bcrypt.hash(client.passwordHash, 10);
      
      if (client.accessLevel && !client.accessExpiresAt) {
        const now = new Date();
        if (client.accessLevel.includes('_mensal')) now.setMonth(now.getMonth() + 1);
        else if (client.accessLevel.includes('_anual')) now.setFullYear(now.getFullYear() + 1);
        else if (client.accessLevel.startsWith('vitalicio_') || client.accessLevel === 'gratuito') {
            client.accessExpiresAt = null;
            return;
        }
        client.accessExpiresAt = now.toISOString().split('T')[0];
      }
    },
    beforeUpdate: async (client) => {
      if (client.changed('email') && client.email) client.email = client.email.toLowerCase();
      if (client.changed('passwordHash') && client.passwordHash && client.passwordHash.length < 60) {
        client.passwordHash = await bcrypt.hash(client.passwordHash, 10);
      }
      if (client.changed('accessLevel')) {
        const now = new Date();
        if (client.accessLevel.includes('_mensal')) now.setMonth(now.getMonth() + 1);
        else if (client.accessLevel.includes('_anual')) now.setFullYear(now.getFullYear() + 1);
        else if (client.accessLevel.startsWith('vitalicio_') || client.accessLevel === 'gratuito') {
             client.accessExpiresAt = null;
             return;
        }
        client.accessExpiresAt = now.toISOString().split('T')[0];
      }
    }
  },
  indexes: [
    { unique: true, fields: ['phone'] },
    { unique: true, fields: ['email'], where: { email: { [Op.ne]: null } } },
    { fields: ['accessLevel'] },
    { fields: ['accessExpiresAt'] },
    { fields: ['isGoogleCalendarSynced'] },
    { fields: ['googleChannelId'] },
    { fields: ['googleChannelExpiryDate'] },
    { fields: ['wantsMotivationMessage'] },
    { fields: ['asaasCustomerId'], unique: true, where: { asaasCustomerId: { [Op.ne]: null } } },
    { fields: ['affiliateCode'], unique: true, where: { affiliateCode: { [Op.ne]: null } } },
    { fields: ['referredByClientId'] },
  ]
});

Client.prototype.isValidPassword = async function(password) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(password, this.passwordHash);
};

Client.associate = (models) => {
  Client.hasMany(models.FinancialAccount, { foreignKey: 'clientId', as: 'financialAccounts', onDelete: 'CASCADE' });
  Client.hasMany(models.ClientInteractionLog, { foreignKey: 'clientId', as: 'interactionLogs', onDelete: 'CASCADE' });
  Client.hasMany(models.Subscription, { foreignKey: 'clientId', as: 'subscriptions', onDelete: 'CASCADE' });
  Client.hasMany(models.SharedAccess, { foreignKey: 'ownerClientId', as: 'ownedSharedAccesses', onDelete: 'CASCADE' });
  Client.hasMany(models.SharedAccess, { foreignKey: 'sharedWithClientId', as: 'receivedSharedAccesses', onDelete: 'CASCADE' });
  Client.belongsTo(models.Client, { as: 'referrer', foreignKey: 'referredByClientId' });
};

module.exports = Client;
// src/models/Client.js
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const validator = {
  isEmail: (value) => {
    if (typeof value !== 'string') return false;
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
        if (value === null || value === '') return;
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
  },
  accessLevel: {
    type: DataTypes.ENUM('gratuito', 'basico_mensal', 'basico_anual', 'avancado_mensal', 'avancado_anual', 'vitalicio_basico', 'vitalicio_avancado'),
    allowNull: false,
    defaultValue: 'gratuito',
  },
  accessExpiresAt: {
      type: DataTypes.DATEONLY,
      allowNull: true,
  },
  // ===================================================
  // === INÍCIO DA MUDANÇA PARA CONVERSA PERSISTENTE ===
  // ===================================================
  openai_thread_id: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    comment: 'ID do Thread da OpenAI para manter o histórico da conversa persistente.',
  },
  // =================================================
  // === FIM DA MUDANÇA PARA CONVERSA PERSISTENTE ===
  // =================================================
  googleAccessToken: {
    type: DataTypes.STRING(1024),
    allowNull: true,
  },
  googleRefreshToken: {
    type: DataTypes.STRING(1024),
    allowNull: true,
  },
  googleTokenExpiryDate: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  googleCalendarIdPrincipal: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  isGoogleCalendarSynced: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  googleCalendarColorIdPF: {
    type: DataTypes.STRING(2),
    allowNull: true,
    defaultValue: '1',
  },
  googleCalendarColorIdPJ: {
    type: DataTypes.STRING(2),
    allowNull: true,
    defaultValue: '2',
  },
  googleChannelId: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  googleChannelResourceId: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  googleChannelExpiryDate: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  googleLastSyncToken: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  wantsMotivationMessage: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  motivationMessageTime: {
    type: DataTypes.TIME,
    allowNull: false,
    defaultValue: '13:00:00',
  },
  lastMotivationSentDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  asaasCustomerId: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
  },
  affiliateCode: {
    type: DataTypes.STRING(12),
    allowNull: true,
    unique: true,
  },
  referredByClientId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'clients', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  balance: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0.00,
  },
  asaasPayoutPixKey: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  tableName: 'clients',
  timestamps: true,
  defaultScope: {
    attributes: { exclude: ['passwordHash', 'googleAccessToken', 'googleRefreshToken'] },
  },
  scopes: {
    withPassword: { attributes: { include: ['passwordHash'] } },
    withGoogleTokens: { attributes: { include: ['googleAccessToken', 'googleRefreshToken'] } }
  },
  hooks: {
    beforeCreate: async (client) => {
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
    // Adicionando índice para o novo campo
    { fields: ['openai_thread_id'], unique: true, where: { openai_thread_id: { [Op.ne]: null } } },
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
  Client.hasMany(models.Client, { as: 'referrals', foreignKey: 'referredByClientId' });
};

module.exports = Client;
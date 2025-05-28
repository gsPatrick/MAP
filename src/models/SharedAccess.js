// src/models/SharedAccess.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database'); // Caminho corrigido anteriormente
const bcrypt = require('bcryptjs');
const validator = require('validator'); // Importar explicitamente

const SharedAccess = sequelize.define('SharedAccess', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  ownerClientId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'clients', key: 'id', },
    onUpdate: 'CASCADE', onDelete: 'CASCADE',
  },
  sharedWithClientId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'clients', key: 'id', },
    onUpdate: 'CASCADE', onDelete: 'CASCADE',
  },
  canAccessPersonalProfile: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  canAccessBusinessProfileId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'financial_accounts', key: 'id', },
    onUpdate: 'CASCADE', onDelete: 'SET NULL',
  },
  sharedAccessEmail: { // Email OPCIONAL e ESPECÍFICO para ESTE acesso compartilhado
    type: DataTypes.STRING,
    allowNull: true, // Permite ser nulo
    unique: true,
    validate: {
      isEmailOrNullOrEmpty(value) { // Renomeado para clareza e lógica ajustada
        if (value === null || typeof value === 'undefined' || String(value).trim() === '') {
          return; // Válido se for null, undefined ou string vazia
        }
        // Se não for nulo/vazio, DEVE ser um email válido
        if (!validator.isEmail(String(value))) {
          throw new Error('O Email de Acesso Compartilhado deve ser um endereço de email válido ou ficar em branco.');
        }
      }
    },
    comment: 'Email opcional que o usuário convidado usará para logar NESTA conta compartilhada.',
  },
  sharedAccessPasswordHash: {
    type: DataTypes.STRING,
    allowNull: true, // Se não houver login por email/senha para este acesso específico
    comment: 'Hash da senha para login NESTE acesso compartilhado.',
  },
  sharedAccessPhone: { // Telefone OPCIONAL e ESPECÍFICO para ESTE acesso compartilhado (WhatsApp)
    type: DataTypes.STRING,
    allowNull: true, // Permite ser nulo
    unique: true,
    comment: 'Número de telefone opcional que o usuário convidado pode usar no WhatsApp para interagir com esta conta compartilhada.',
  },
  status: {
    type: DataTypes.ENUM('Ativo', 'Inativo', 'Pendente'),
    defaultValue: 'Pendente',
    allowNull: false,
  }
}, {
  tableName: 'shared_accesses',
  timestamps: true,
  comment: 'Registros de compartilhamento de acesso entre clientes',
  indexes: [
    { unique: true, fields: ['ownerClientId', 'sharedWithClientId', 'canAccessBusinessProfileId'], name: 'unique_shared_access_target' },
    // Índices únicos condicionais para campos que permitem null
    { fields: ['sharedAccessEmail'], where: { sharedAccessEmail: { [require('sequelize').Op.ne]: null } }, unique: true, name: 'unique_sa_email_if_not_null' },
    { fields: ['sharedAccessPhone'], where: { sharedAccessPhone: { [require('sequelize').Op.ne]: null } }, unique: true, name: 'unique_sa_phone_if_not_null' },
  ],
  hooks: {
    beforeCreate: async (sharedAccess) => {
      if (sharedAccess.sharedAccessEmail) {
        sharedAccess.sharedAccessEmail = sharedAccess.sharedAccessEmail.toLowerCase().trim();
        if (sharedAccess.sharedAccessEmail === '') sharedAccess.sharedAccessEmail = null; // Garante null se for string vazia
      } else {
        sharedAccess.sharedAccessEmail = null; // Garante null se undefined
      }
      if (sharedAccess.sharedAccessPasswordHash) {
        sharedAccess.sharedAccessPasswordHash = await bcrypt.hash(sharedAccess.sharedAccessPasswordHash, 10);
      }
      if (sharedAccess.sharedAccessPhone) {
        sharedAccess.sharedAccessPhone = sharedAccess.sharedAccessPhone.replace(/\D/g, '');
        if (sharedAccess.sharedAccessPhone === '') sharedAccess.sharedAccessPhone = null; // Garante null se for string vazia
      } else {
        sharedAccess.sharedAccessPhone = null; // Garante null se undefined
      }
    },
    beforeUpdate: async (sharedAccess) => {
      if (sharedAccess.changed('sharedAccessEmail')) {
        if (sharedAccess.sharedAccessEmail) {
            sharedAccess.sharedAccessEmail = sharedAccess.sharedAccessEmail.toLowerCase().trim();
            if (sharedAccess.sharedAccessEmail === '') sharedAccess.sharedAccessEmail = null;
        } else {
            sharedAccess.sharedAccessEmail = null;
        }
      }
      if (sharedAccess.changed('sharedAccessPasswordHash') && sharedAccess.sharedAccessPasswordHash && sharedAccess.sharedAccessPasswordHash.length < 60) {
        sharedAccess.sharedAccessPasswordHash = await bcrypt.hash(sharedAccess.sharedAccessPasswordHash, 10);
      } else if (sharedAccess.changed('sharedAccessPasswordHash') && !sharedAccess.sharedAccessPasswordHash) {
        sharedAccess.sharedAccessPasswordHash = null; // Permite remover senha
      }
      if (sharedAccess.changed('sharedAccessPhone')) {
        if (sharedAccess.sharedAccessPhone) {
            sharedAccess.sharedAccessPhone = sharedAccess.sharedAccessPhone.replace(/\D/g, '');
            if (sharedAccess.sharedAccessPhone === '') sharedAccess.sharedAccessPhone = null;
        } else {
            sharedAccess.sharedAccessPhone = null;
        }
      }
    }
  }
});

SharedAccess.prototype.isValidPassword = async function(password) {
  if (!this.sharedAccessPasswordHash) return false;
  return bcrypt.compare(password, this.sharedAccessPasswordHash);
};

SharedAccess.associate = (models) => {
  SharedAccess.belongsTo(models.Client, {
    foreignKey: 'ownerClientId',
    as: 'ownerClient',
  });
  SharedAccess.belongsTo(models.Client, {
    foreignKey: 'sharedWithClientId',
    as: 'sharedWithClient',
  });
  SharedAccess.belongsTo(models.FinancialAccount, {
    foreignKey: 'canAccessBusinessProfileId',
    as: 'accessibleBusinessProfile',
    constraints: false,
  });
};

module.exports = SharedAccess;
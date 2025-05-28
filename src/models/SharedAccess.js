// src/models/SharedAccess.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database'); // <<< CORREÇÃO AQUI
const bcrypt = require('bcryptjs');

const SharedAccess = sequelize.define('SharedAccess', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  ownerClientId: { // Quem está concedendo o acesso
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'clients', // Tabela de Clients
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se o dono for excluído, os compartilhamentos são revogados
  },
  sharedWithClientId: { // Quem está recebendo o acesso (deve ser um Client existente)
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'clients', // Tabela de Clients
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Se o usuário compartilhado for excluído, o acesso é revogado
  },
  canAccessPersonalProfile: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Permissão para acessar o perfil PF principal do ownerClient',
  },
  canAccessBusinessProfileId: { // A qual perfil PJ/MEI específico o acesso é concedido
    type: DataTypes.INTEGER,
    allowNull: true, // Pode não ter acesso a nenhum perfil PJ/MEI
    references: {
      model: 'financial_accounts', // Tabela de FinancialAccounts
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', // Se a FinancialAccount for deletada, o acesso a ela é revogado (fica null)
    comment: 'ID da FinancialAccount (PJ/MEI) do ownerClient que pode ser acessada',
  },
  sharedAccessEmail: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    validate: {
      isEmailOrNull(value) {
        if (value === null || value === '') return;
        const validator = require('validator');
        if (!validator.isEmail(value)) {
          throw new Error('Forneça um email válido para o acesso compartilhado ou deixe o campo vazio.');
        }
      }
    },
    comment: 'Email que o usuário convidado usará para logar NESTA conta compartilhada.',
  },
  sharedAccessPasswordHash: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Hash da senha para login NESTE acesso compartilhado.',
  },
  sharedAccessPhone: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    comment: 'Número de telefone que o usuário convidado pode usar no WhatsApp para interagir com esta conta compartilhada.',
  },
  status: {
    type: DataTypes.ENUM('Ativo', 'Inativo', 'Pendente'),
    defaultValue: 'Pendente',
    allowNull: false,
  },
}, {
  tableName: 'shared_accesses',
  timestamps: true,
  comment: 'Registros de compartilhamento de acesso entre clientes',
  indexes: [
    { unique: true, fields: ['ownerClientId', 'sharedWithClientId', 'canAccessBusinessProfileId'], name: 'unique_shared_access_target' },
    { fields: ['sharedAccessEmail'], where: { sharedAccessEmail: { [require('sequelize').Op.ne]: null } } },
    { fields: ['sharedAccessPhone'], where: { sharedAccessPhone: { [require('sequelize').Op.ne]: null } } },
  ],
  hooks: {
    beforeCreate: async (sharedAccess) => {
      if (sharedAccess.sharedAccessEmail) {
        sharedAccess.sharedAccessEmail = sharedAccess.sharedAccessEmail.toLowerCase();
      }
      if (sharedAccess.sharedAccessPasswordHash) {
        sharedAccess.sharedAccessPasswordHash = await bcrypt.hash(sharedAccess.sharedAccessPasswordHash, 10);
      }
      if (sharedAccess.sharedAccessPhone) {
        sharedAccess.sharedAccessPhone = sharedAccess.sharedAccessPhone.replace(/\D/g, '');
      }
    },
    beforeUpdate: async (sharedAccess) => {
      if (sharedAccess.changed('sharedAccessEmail') && sharedAccess.sharedAccessEmail) {
        sharedAccess.sharedAccessEmail = sharedAccess.sharedAccessEmail.toLowerCase();
      }
      if (sharedAccess.changed('sharedAccessPasswordHash') && sharedAccess.sharedAccessPasswordHash && sharedAccess.sharedAccessPasswordHash.length < 60) {
        sharedAccess.sharedAccessPasswordHash = await bcrypt.hash(sharedAccess.sharedAccessPasswordHash, 10);
      }
      if (sharedAccess.changed('sharedAccessPhone') && sharedAccess.sharedAccessPhone) {
        sharedAccess.sharedAccessPhone = sharedAccess.sharedAccessPhone.replace(/\D/g, '');
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
// src/models/User.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true,
    },
  },
  passwordHash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  role: { // Ex: 'admin', 'manager', 'viewer'
    type: DataTypes.ENUM('admin', 'support', 'viewer'), // Defina os roles que fazem sentido
    defaultValue: 'viewer', // Ou o role mais restrito
    allowNull: false,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
  }
}, {
  tableName: 'users',
  timestamps: true,
  comment: 'Usuários administradores do sistema',
  defaultScope: { // Por padrão, nunca retorna o passwordHash
    attributes: { exclude: ['passwordHash'] },
  },
  scopes: {
    withPassword: { // Escopo para buscar o usuário COM o passwordHash (usado no login)
      attributes: { include: ['passwordHash'] },
    }
  },
  hooks: {
    beforeCreate: async (user) => {
      if (user.passwordHash) {
        user.passwordHash = await bcrypt.hash(user.passwordHash, 10); // 10 é o saltRounds
      }
    },
    beforeUpdate: async (user) => {
      // Hashear a senha apenas se ela foi modificada e não é já um hash longo
      if (user.changed('passwordHash') && user.passwordHash && user.passwordHash.length < 60) {
        user.passwordHash = await bcrypt.hash(user.passwordHash, 10);
      }
    }
  }
});

// Método de instância para verificar a senha
User.prototype.isValidPassword = async function(password) {
  return bcrypt.compare(password, this.passwordHash);
};

// User.associate = (models) => {
//   // User pode ter uma UserPreference
//   User.hasOne(models.UserPreference, { foreignKey: 'userId', as: 'preferences' });
//   // Se um admin agenda compromissos para financialAccounts:
//   // User.hasMany(models.Appointment, { foreignKey: 'userId', as: 'scheduledAppointments' });
// };

module.exports = User;
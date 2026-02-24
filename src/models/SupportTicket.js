// d:/daniatualagrvai/MAP/src/models/SupportTicket.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SupportTicket = sequelize.define('SupportTicket', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    clientId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'clients',
            key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
    },
    type: {
        type: DataTypes.ENUM('Tecnico', 'Financeiro', 'Duvida', 'Sugestao'),
        allowNull: false,
        comment: 'Tipo de problema ou solicitação',
    },
    subject: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    status: {
        type: DataTypes.ENUM('Aberto', 'Em andamento', 'Resolvido'),
        allowNull: false,
        defaultValue: 'Aberto',
    },
    priority: {
        type: DataTypes.ENUM('Baixa', 'Media', 'Alta'),
        allowNull: false,
        defaultValue: 'Media',
    },
    lastResponseAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    resolvedAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
}, {
    tableName: 'support_tickets',
    timestamps: true,
    indexes: [
        { fields: ['clientId'] },
        { fields: ['status'] },
        { fields: ['type'] },
    ]
});

SupportTicket.associate = (models) => {
    SupportTicket.belongsTo(models.Client, { foreignKey: 'clientId', as: 'client' });
};

module.exports = SupportTicket;

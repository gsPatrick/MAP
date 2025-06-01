// src/models/KanbanTask.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const KanbanTask = sequelize.define('KanbanTask', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  kanbanColumnId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'kanban_columns',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE', // Tarefas são deletadas se a coluna for
    comment: 'ID da Coluna Kanban à qual esta tarefa pertence',
  },
  financialAccountId: { // Mantido para facilitar queries diretas e validação de propriedade
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    comment: 'ID da Conta Financeira à qual esta tarefa está indiretamente ligada (via coluna)',
  },
  title: { // Frontend usa 'content' para o input principal, mas 'title' é mais comum para o nome da tarefa
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Título ou conteúdo principal da tarefa',
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Descrição detalhada da tarefa (opcional)',
  },
  priority: {
    type: DataTypes.ENUM('low', 'medium', 'high', 'baixa', 'media', 'alta'), // Inclui os IDs do frontend e os labels
    allowNull: true,
    comment: 'Prioridade da tarefa (ex: low, medium, high)',
  },
  dueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    comment: 'Data de vencimento da tarefa (opcional)',
  },
  order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: 'Ordem de exibição da tarefa dentro da coluna',
  },
  cardColor: { // NOVO CAMPO
    type: DataTypes.STRING(50), // Para armazenar o ID da cor (ex: 'laranja', 'dourado', 'nenhuma')
    allowNull: true,
    comment: 'ID da cor selecionada para o card da tarefa',
  },
  isCompleted: { // NOVO CAMPO
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Indica se a tarefa foi concluída',
  },
  labels: { // NOVO CAMPO - Para armazenar as etiquetas da tarefa
    type: DataTypes.JSONB, // Armazena um array de objetos [{id: string, text: string, color: string}] ou [{id: string}]
    allowNull: true,
    defaultValue: [],
    comment: 'Etiquetas associadas à tarefa (ex: [{id: "dev", text: "Desenvolvimento", color: "blue"}])',
  },
  // Outros campos que podem ser úteis no futuro:
  // assignedToUserId: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'users', key: 'id' } },
  // attachments: { type: DataTypes.JSONB, allowNull: true },
}, {
  sequelize,
  modelName: 'KanbanTask',
  tableName: 'kanban_tasks',
  timestamps: true,
  comment: 'Tarefas do quadro Kanban',
  indexes: [
    { fields: ['kanbanColumnId'] },
    { fields: ['financialAccountId'] }, // Para buscar todas as tasks de uma FA se necessário
    { fields: ['kanbanColumnId', 'order'] },
    { fields: ['dueDate'] },
    { fields: ['isCompleted'] },
  ]
});

KanbanTask.associate = (models) => {
  KanbanTask.belongsTo(models.KanbanColumn, {
    foreignKey: 'kanbanColumnId',
    as: 'column'
  });
  KanbanTask.belongsTo(models.FinancialAccount, {
    foreignKey: 'financialAccountId',
    as: 'financialAccount'
  });
};

module.exports = KanbanTask;
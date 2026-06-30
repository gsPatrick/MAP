// src/models/FinancialTransaction.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const FinancialTransaction = sequelize.define('FinancialTransaction', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  financialAccountId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'financial_accounts',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
  },
  description: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM('Entrada', 'Saída'),
    allowNull: false,
  },
  value: { // Para compras à vista, este é o valor total. Para parcelas, este é o valor da parcela individual.
    type: DataTypes.DECIMAL(12, 2),
    allowNull: false,
    validate: {
      isDecimal: true,
      min: 0.01
    },
  },
  financialCategoryId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_categories',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  transactionDate: { // Data da transação (compra à vista, data da parcela no cartão, data da compra original para contas a pagar)
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  isPayableOrReceivable: { // Indica se é uma conta a pagar/receber (não se aplica a gastos diretos no cartão)
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  dueDate: { // Data de vencimento para contas a pagar/receber
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  isPaidOrReceived: { // Status de liquidação para contas a pagar/receber
    type: DataTypes.BOOLEAN,
    defaultValue: false, // Para isPayableOrReceivable=true, começa como não pago/recebido
    allowNull: false,
  },
  lastPaymentReminderAt: { // Última vez que enviamos o lembrete "pagou?" desta conta (cadência da cobrança)
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  paymentDate: { // Data em que a conta foi efetivamente paga/recebida
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  isParcel: { // Indica se esta transação é parte de um parcelamento
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  parcelNumber: { // Número da parcela atual (ex: 1, 2, 3...)
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
  },
  totalParcels: { // Número total de parcelas da compra original
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 1 },
  },
  originalAccountId: { // ID da transação "mãe" que representa a compra parcelada original
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'financial_transactions', // Auto-referência
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', // Se a transação mãe for deletada, as parcelas filhas perdem a referência (ou CASCADE se preferir deletá-las juntas)
    comment: 'ID da transação original se esta for uma parcela (aponta para a primeira parcela do grupo)',
  },
  originalPurchaseTotalValue: { // Valor total da compra original, quando isParcel = true
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true, // Será preenchido para transações de parcelamento
    comment: 'Valor total da compra original, se esta transação for uma parcela ou a "mãe" de um parcelamento.',
  },
  paymentMethod: { // Método de pagamento (ex: "Cartão de Crédito XPTO", "Débito", "Pix")
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'Pix',
    validate: {
      isIn: [['Pix', 'Dinheiro', 'Cartão de Crédito', 'Cartão de Débito', 'Transferência']]
    }
  }, // ATENÇÃO: Mudanças de schema em produção DEVEM ser via Migrations!
  creditCardId: { // Se a transação foi feita com um cartão de crédito específico
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'credit_cards',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL', // Se o cartão for deletado, a transação perde a referência, mas não é deletada
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  recurringTransactionRuleId: { // Se esta transação foi gerada por uma regra de recorrência
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'recurring_transaction_rules',
      key: 'id',
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
    comment: 'ID da regra de recorrência que originou esta transação (se aplicável)',
  },
  // Campo para vincular pagamentos de fatura ao cartão pago (MELHORIA SUGERIDA)
  // paidForCreditCardId: {
  //   type: DataTypes.INTEGER,
  //   allowNull: true,
  //   references: {
  //     model: 'credit_cards',
  //     key: 'id',
  //   },
  //   onUpdate: 'CASCADE',
  //   onDelete: 'SET NULL',
  //   comment: 'Se esta transação for um pagamento de fatura, indica o ID do cartão que foi pago.',
  // }
}, {
  tableName: 'financial_transactions',
  timestamps: true,
  comment: 'Registros de transações financeiras, vinculadas a uma FinancialAccount',
  indexes: [
    { fields: ['financialAccountId'] },
    { fields: ['transactionDate'] },
    { fields: ['dueDate'] },
    { fields: ['financialCategoryId'] },
    { fields: ['creditCardId'] },
    { fields: ['originalAccountId'] },
    { fields: ['recurringTransactionRuleId'] },
    // { fields: ['paidForCreditCardId'] }, // Se adicionar o campo sugerido
  ],
  hooks: {
    beforeValidate: (transaction, options) => {
      // Se é uma parcela e originalAccountId não está definido, mas parcelNumber é 1 (ou >1),
      // e se é uma compra parcelada (tem totalParcels > 1),
      // então originalAccountId deveria ser ela mesma se for a "mãe".
      // Esta lógica é melhor tratada no service durante a criação.
      if (transaction.isParcel && transaction.parcelNumber && transaction.totalParcels && !transaction.originalAccountId) {
        if (transaction.parcelNumber === 1) {
          // Se for a primeira parcela de um novo grupo, o service deve lidar com a atribuição do ID após a criação.
          // Não setar aqui, pois o ID ainda não existe no beforeCreate.
        }
      }

      // Garante que se isParcel for false, os campos de parcela sejam nulos
      if (!transaction.isParcel) {
        transaction.parcelNumber = null;
        transaction.totalParcels = null;
        transaction.originalAccountId = null;
        transaction.originalPurchaseTotalValue = null;
      }

      // Se é uma transação de cartão, não deve ser marcada como payable/receivable com dueDate
      if (transaction.creditCardId) {
        transaction.isPayableOrReceivable = false;
        transaction.dueDate = null;
        // Transações de cartão são "pagas" na origem (lançadas na fatura),
        // o pagamento real é o da fatura.
        transaction.isPaidOrReceived = true;
        transaction.paymentDate = transaction.transactionDate;
      } else if (transaction.isPayableOrReceivable === false) {
        // Se não é de cartão e não é a pagar/receber (à vista), então é paga/recebida na data da transação
        transaction.isPaidOrReceived = true;
        transaction.paymentDate = transaction.transactionDate;
        transaction.dueDate = null;
      }

    },
    beforeUpdate: (transaction, options) => {
      if (transaction.changed('isPaidOrReceived') && transaction.isPaidOrReceived && !transaction.paymentDate) {
        const today = new Date();
        transaction.paymentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      }
      if (transaction.changed('isPaidOrReceived') && !transaction.isPaidOrReceived) {
        transaction.paymentDate = null;
      }
    },
  }
});

FinancialTransaction.associate = (models) => {
  FinancialTransaction.belongsTo(models.FinancialAccount, { foreignKey: 'financialAccountId', as: 'financialAccount' });
  FinancialTransaction.belongsTo(models.FinancialCategory, { foreignKey: 'financialCategoryId', as: 'category' });
  FinancialTransaction.belongsTo(models.CreditCard, { foreignKey: 'creditCardId', as: 'creditCard' });

  // Para uma transação que é a "mãe" de um parcelamento (ex: originalAccountId === id)
  FinancialTransaction.hasMany(models.FinancialTransaction, {
    as: 'parcels',
    foreignKey: 'originalAccountId', // As parcelas filhas terão este FK apontando para a mãe
    useJunctionTable: false,
    // onDelete: 'CASCADE' // Se a mãe for deletada, todas as parcelas filhas também são. CUIDADO.
    // SET NULL já está no campo originalAccountId, o que é mais seguro.
  });
  // Para uma transação que é uma parcela "filha"
  FinancialTransaction.belongsTo(models.FinancialTransaction, {
    as: 'originalAccount',
    foreignKey: 'originalAccountId',
    targetKey: 'id'
  });

  FinancialTransaction.belongsTo(models.RecurringTransactionRule, {
    foreignKey: 'recurringTransactionRuleId',
    as: 'recurringRuleOrigin',
  });

  // Se adicionar o campo paidForCreditCardId:
  // FinancialTransaction.belongsTo(models.CreditCard, {
  //   foreignKey: 'paidForCreditCardId',
  //   as: 'paidInvoiceForCard'
  // });
};

module.exports = FinancialTransaction;
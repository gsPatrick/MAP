// src/models/UserPreference.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UserPreference = sequelize.define('UserPreference', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  // userId: { // Descomente se as preferências forem por usuário individual
  //   type: DataTypes.INTEGER,
  //   allowNull: false,
  //   unique: true, // Se for 1:1 com User
  //   references: {
  //     model: 'users', // Nome da tabela de usuários
  //     key: 'id',
  //   },
  //   onUpdate: 'CASCADE',
  //   onDelete: 'CASCADE',
  // },

  // Lembrete de Beber Água
  enableWaterReminder: {
    type: DataTypes.BOOLEAN,
    defaultValue: false, // Padrão: desabilitado
    allowNull: false,
  },
  waterReminderFrequencyType: {
    type: DataTypes.ENUM('disabled', '2h', '3h', 'custom'),
    defaultValue: 'disabled', // Padrão: desabilitado
    allowNull: false,
  },
  waterReminderCustomIntervalMinutes: {
    type: DataTypes.INTEGER,
    allowNull: true, // Só é relevante se frequencyType for 'custom'
    validate: { min: 15 }, // Mínimo de 15 minutos para intervalo customizado
  },
  waterReminderStartTime: {
    type: DataTypes.TIME, // Formato 'HH:MM:SS'
    defaultValue: '09:00:00',
    allowNull: false,
  },
  waterReminderEndTime: {
    type: DataTypes.TIME,
    defaultValue: '18:00:00',
    allowNull: false,
  },
  dailyGoalMl: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 0 }
  },
  lastWaterReminderSentTimestamp: {
    type: DataTypes.DATE, // Guarda data e hora do último envio
    allowNull: true,
  },

  // Mensagem Diária de Motivação
  enableMotivationMessage: {
    type: DataTypes.BOOLEAN,
    defaultValue: false, // Padrão: desabilitado (para o usuário ativar se quiser)
    allowNull: false,
  },
  motivationMessageTime: {
    type: DataTypes.TIME,
    defaultValue: '08:00:00',
    allowNull: false,
  },
  lastMotivationalMessageSentDate: {
    type: DataTypes.DATEONLY, // Apenas a data YYYY-MM-DD
    allowNull: true,
  },

  // Configurações de Relatórios e Resumos Automáticos (via Job)
  dailySummaryTime: {
    type: DataTypes.TIME,
    defaultValue: '19:00:00',
    allowNull: false,
  },
  weeklySummaryDayOfWeek: {
    type: DataTypes.INTEGER,
    defaultValue: 5, // Sexta-feira
    allowNull: false,
    validate: { min: 0, max: 6 }, // 0 (Dom) a 6 (Sab)
  },
  weeklySummaryTime: {
    type: DataTypes.TIME,
    defaultValue: '10:00:00',
    allowNull: false,
  },
  monthlyReportDayOfMonth: {
    type: DataTypes.INTEGER,
    defaultValue: 1, // Dia 1 do mês
    allowNull: false,
    validate: { min: 1, max: 28 }, // Simplificado para evitar problemas com meses curtos
  },
  monthlyReportTime: {
    type: DataTypes.TIME,
    defaultValue: '10:00:00',
    allowNull: false,
  },

  // Configurações de Lembretes de Compromisso (Padrões para novos compromissos)
  defaultAppointmentReminderLeadTimeMinutes: {
    type: DataTypes.INTEGER,
    defaultValue: 60, // 1 hora antes como padrão
    allowNull: false,
    validate: { min: 1 },
    comment: 'Tempo padrão de antecedência para lembretes de compromissos (em minutos)',
  },

  // --- Campos para agendamento dos Jobs (schedules cron) ---
  // Estes definem QUANDO os jobs de verificação rodam.
  // A lógica interna do job decide se algo precisa ser ENVIADO.
 recurringJobSchedule: {
    type: DataTypes.STRING,
    defaultValue: '0 1 * * *',
    allowNull: false,
    comment: 'Schedule cron para o job de transações recorrentes (baixa frequência).',
  },
  highFrequencyRecurringJobSchedule: {
    type: DataTypes.STRING,
    defaultValue: '*/1 * * * *', // A cada 1 minuto
    allowNull: false,
    comment: 'Schedule cron para o job de transações recorrentes (alta frequência: min/hora).',
  },
  appointmentReminderJobSchedule: {
    type: DataTypes.STRING,
    defaultValue: '*/2 * * * *', // A cada 2 minutos (para verificar lembretes de compromissos)
    allowNull: false,
    comment: 'Schedule cron para o job de lembretes de compromisso.',
  },
  alertsJobSchedule: {
    type: DataTypes.STRING,
    defaultValue: '0 8 * * *', // Todo dia às 08:00 da manhã (para verificar alertas)
    allowNull: false,
    comment: 'Schedule cron para o job de alertas (vencimentos, estoque).',
  },
  motivationalMessageJobSchedule: { // Novo schedule para o job de motivação
    type: DataTypes.STRING,
    defaultValue: '*/1 * * * *', // A cada 1 minuto (para verificar se precisa enviar a msg do dia)
    allowNull: false,
    comment: 'Schedule cron para o job de mensagem motivacional (verificação).',
  },
  waterReminderJobSchedule: { // Novo schedule para o job de água
    type: DataTypes.STRING,
    defaultValue: '*/2 * * * *', // A cada 2 minutos (para verificar se precisa enviar lembrete de água)
    allowNull: false,
    comment: 'Schedule cron para o job de lembrete de água (verificação).',
  },
   invoiceGenerationJobSchedule: {
    type: DataTypes.STRING,
    defaultValue: '0 3 * * *', // Todo dia às 3 da manhã
    allowNull: false,
    comment: 'Schedule cron para o job de geração automática de faturas de cartão.',
  },
  
  // --- Campos para controle de comportamento dos Alertas ---
  dueAlertLeadDays: {
    type: DataTypes.INTEGER,
    defaultValue: 3, // 3 dias de antecedência
    allowNull: false,
    validate: { min: 0 },
    comment: 'Dias de antecedência para alerta de contas a vencer.',
  },
  fiscalAlertLeadDaysMEI: {
    type: DataTypes.INTEGER,
    defaultValue: 5, // 5 dias de antecedência
    allowNull: false,
    validate: { min: 0 },
    comment: 'Dias de antecedência para alerta fiscal MEI (ex: DAS).',
  },

}, {
  tableName: 'user_preferences',
  timestamps: true, // createdAt e updatedAt
  comment: 'Configurações gerais do sistema e preferências globais (geralmente uma única linha)',
  hooks: {
    async afterSync(options) {
      // Garante que existe pelo menos um registro de preferências após a sincronização
      // Isso é útil para desenvolvimento e para garantir que os defaults sejam aplicados
      // se a tabela for criada vazia.
      const count = await this.count();
      if (count === 0) {
        await this.create({}) // Cria com os defaultValues definidos no modelo
          .then(() => console.log('[UserPreference Hook] Registro de preferências padrão criado.'))
          .catch(err => console.error('[UserPreference Hook] Erro ao criar registro de preferências padrão:', err));
      }
    }
  }
});

// UserPreference.associate = (models) => {
//   // Se você tiver um modelo User e quiser associar preferências a usuários específicos:
//   // UserPreference.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
// };

module.exports = UserPreference;
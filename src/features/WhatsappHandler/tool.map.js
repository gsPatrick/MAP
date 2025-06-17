// src/features/WhatsappHandler/tool.map.js
// DESCRIÇÃO:
// Este arquivo funciona como um "dispatcher" ou um "mapa de rotas".
// Ele mapeia o nome da função (string) que a API de Assistants da OpenAI retorna
// para a função JavaScript real que deve ser executada, que está definida
// no arquivo action.handler.js.
// Isso mantém o código de orquestração limpo e desacoplado da lógica de negócio.

const actions = require('./action.handler.js');

const toolFunctionMap = {
    // Ações de Criação (CREATE)
    'CREATE_FINANCIAL_TRANSACTION': actions.createFinancialTransaction,
    'SCHEDULE_APPOINTMENT': actions.scheduleAppointment,
    'CREATE_PARCELLED_ACCOUNT': actions.createParcelledAccount,
    'CREATE_RECURRING_RULE': actions.createRecurringRule,
    'CREATE_PRODUCT': actions.createProduct,
    'CREATE_CREDIT_CARD': actions.createCreditCard,
    'CREATE_FINANCIAL_ACCOUNT': actions.createFinancialAccount,
    'CREATE_BUSINESS_CLIENT': actions.createBusinessClient,
    'GRANT_ACCESS': actions.grantAccess,
    'RECORD_STOCK_MOVEMENT': actions.recordStockMovement,
    'PAY_CREDIT_CARD_INVOICE': actions.payCreditCardInvoice,
    'CREATE_FINANCIAL_CATEGORY': actions.createFinancialCategory,
    'CREATE_MOTIVATIONAL_PHRASE': actions.createMotivationalPhrase,

    // Ações de Leitura (GET / LIST)
    'GET_FINANCIAL_SUMMARY': actions.getFinancialSummary,
    'LIST_FINANCIAL_TRANSACTIONS': actions.listFinancialTransactions,
    'LIST_APPOINTMENTS': actions.listAppointments,
    'LIST_CREDIT_CARDS': actions.listCreditCards,
    'LIST_RECURRING_RULES': actions.listRecurringRules,
    'GET_STOCK_INFO': actions.getStockInfo,
    'GET_CREDIT_CARD_INVOICE': actions.getCreditCardInvoice,
    'GET_CREDIT_CARD_AVAILABLE_LIMIT': actions.getCreditCardAvailableLimit,
    'LIST_BUSINESS_CLIENTS': actions.listBusinessClients,
    'LIST_GRANTED_ACCESS': actions.listGrantedAccess,
    'LIST_RECEIVED_ACCESS': actions.listReceivedAccess,
    'GET_MONTHLY_TREND': actions.getMonthlyTrend,
    'GET_EXPENSE_CATEGORY_SUMMARY': actions.getExpenseCategorySummary,
    'GET_INCOME_CATEGORY_SUMMARY': actions.getIncomeCategorySummary,
    'LIST_FINANCIAL_CATEGORIES': actions.listFinancialCategories,
    'LIST_PRODUCTS': actions.listProducts,
    'GET_PRODUCT_DETAILS': actions.getProductDetails,
    'GET_HYDRATION_LOG': actions.getHydrationLog,
    'GET_AFFILIATE_DASHBOARD': actions.getAffiliateDashboard,
    'GET_ACTIVE_SUBSCRIPTION': actions.getActiveSubscription,

    // Ações de Atualização (UPDATE)
    'UPDATE_FINANCIAL_TRANSACTION': actions.updateFinancialTransaction,
    'UPDATE_APPOINTMENT': actions.updateAppointment,
    'MARK_TRANSACTION_AS_PAID_RECEIVED': actions.markTransactionAsPaidReceived,
    'UPDATE_RECURRING_RULE': actions.updateRecurringRule,
    'UPDATE_PRODUCT': actions.updateProduct,
    'UPDATE_PARCELLED_ACCOUNT_DESCRIPTION': actions.updateParcelledAccountDescription,
    'RECREATE_PARCELLED_ACCOUNT': actions.recreateParcelledAccount,
    'UPDATE_CREDIT_CARD': actions.updateCreditCard,
    'UPDATE_BUSINESS_CLIENT': actions.updateBusinessClient,
    'UPDATE_FINANCIAL_ACCOUNT': actions.updateFinancialAccount,
    'UPDATE_GRANTED_ACCESS': actions.updateGrantedAccess,
    'UPDATE_FINANCIAL_CATEGORY': actions.updateFinancialCategory,
    'UPDATE_MOTIVATIONAL_PHRASE': actions.updateMotivationalPhrase,
    'LOG_WATER_INTAKE': actions.logWaterIntake,

    // Ações de Exclusão (DELETE)
    'DELETE_FINANCIAL_ACCOUNT': actions.deleteFinancialAccount,
    'REVOKE_ACCESS': actions.revokeAccess,
    'DELETE_FINANCIAL_TRANSACTION': actions.deleteFinancialTransaction,
    'DELETE_PRODUCT': actions.deleteProduct,
    'DELETE_RECURRING_RULE': actions.deleteRecurringRule,
    'DELETE_BUSINESS_CLIENT': actions.deleteBusinessClient,
    'DELETE_FINANCIAL_CATEGORY': actions.deleteFinancialCategory,
    'DELETE_MOTIVATIONAL_PHRASE': actions.deleteMotivationalPhrase,

    // Ações de Sistema e Estado
    'SWITCH_FINANCIAL_ACCOUNT': actions.switchFinancialAccount,
    'SET_MOTIVATIONAL_MESSAGE_PREFERENCE': actions.setMotivationalMessagePreference,
    'SET_WATER_REMINDER_PREFERENCE': actions.setWaterReminderPreference,
    'RESPOND_TO_INVITE': actions.respondToInvite,
};

module.exports = toolFunctionMap;
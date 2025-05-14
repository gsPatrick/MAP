// src/features/DevTools/devTools.controller.js
const whatsappService = require('../../services/whatsappService');
const devToolsService = require('./devTools.service');
const logger = require('../../utils/logger');

async function testSendButtonList(req, res, next) {
  try {
    const targetPhone = req.body.phone || "71983141335"; // Seu número de teste
    const messageIdToEdit = req.body.messageIdToEdit || "exemploID123"; // ID da transação/item para os botões
    const messageIdToDelete = req.body.messageIdToDelete || "exemploID456";

    const messageText = "Este é um resumo de uma transação de exemplo:\n\n" +
                        "💡 Descrição: Compra Teste\n" +
                        "💰 Valor: R$ 100,00\n" +
                        "📅 Data: 10/05/2024\n" +
                        "✅ Status: Pago\n\n" +
                        "O que você gostaria de fazer?";

    const buttons = [
      { id: `edit_transaction_${messageIdToEdit}`, label: "Editar Transação" },
      { id: `delete_transaction_${messageIdToDelete}`, label: "Excluir Transação" }
    ];

    // Como a Z-API trata os IDs dos botões:
    // Quando o usuário clica em um botão de uma "Button List", o webhook que você recebe da Z-API
    // geralmente inclui o `message` (texto do botão clicado) e um `selectedButtonId` (o ID que você definiu).
    // No seu `whatsapp.service.js` (processIncomingMessage), você precisaria verificar se o payload
    // contém `selectedButtonId` e, se sim, processar a ação baseada nesse ID.

    const result = await whatsappService.sendButtonListMessage(targetPhone, messageText, buttons);

    if (result) {
      res.status(200).json({ status: 'success', message: `Mensagem com lista de botões enviada para ${targetPhone}.`, zapiResponse: result });
    } else {
      const error = new Error('Falha ao enviar mensagem com lista de botões via Z-API.');
      error.statusCode = 500; // Erro interno do servidor se a chamada à Z-API falhou
      next(error);
    }
  } catch (error) {
    next(error);
  }
}

async function activateTestSubscription(req, res, next) {
  try {
      const clientId = parseInt(req.params.clientId, 10);
      // O planId agora é opcional na rota, então pode ser undefined.
      // Se presente, deve ser um número.
      let planId = req.params.planId ? parseInt(req.params.planId, 10) : null;
      const days = req.query.days ? parseInt(req.query.days, 10) : null;

      if (isNaN(clientId)) {
          const error = new Error('ID do Cliente inválido na rota.');
          error.statusCode = 400; error.status = 'fail'; return next(error);
      }
      if (req.params.planId && isNaN(planId)) { // Valida planId apenas se foi fornecido e não é um número
           const error = new Error('ID do Plano inválido na rota.');
          error.statusCode = 400; error.status = 'fail'; return next(error);
      }
      if (req.query.days && (isNaN(days) || days <= 0) ) {
           const error = new Error('Parâmetro "days" (duração em dias) inválido.');
          error.statusCode = 400; error.status = 'fail'; return next(error);
      }

      const result = await devToolsService.activateClientSubscriptionForTesting(clientId, planId, days);
      res.status(200).json({
          status: 'success',
          message: `Assinatura de teste ativada para cliente ID ${clientId} com plano ID ${result.plan.id} ("${result.plan.name}"). Válida por ${days || result.plan.durationDays} dias.`,
          data: {
              client: result.client,
              subscription: result.subscription,
              plan: result.plan
          }
      });
  } catch (error) {
      next(error);
  }
}

module.exports = {
  testSendButtonList,
  activateTestSubscription
};  
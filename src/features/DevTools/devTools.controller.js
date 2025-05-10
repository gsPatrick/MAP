// src/features/DevTools/devTools.controller.js
const whatsappService = require('../../services/whatsappService');
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

module.exports = {
  testSendButtonList,
};  
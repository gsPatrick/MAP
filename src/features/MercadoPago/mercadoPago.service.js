// src/features/MercadoPago/mercadoPago.service.js

const { preference: mpPreference, payment: mpPayment } = require('../../config/mercadoPago'); 
const { Subscription, Plan, Client } = require('../../database');
const subscriptionService = require('../Subscription/subscription.service');
const logger = require('../../utils/logger');

function getExpirationDate() {
    const date = new Date();
    date.setDate(date.getDate() + 3); 
    return date.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

const mercadoPagoService = {
  async criarPreferenciaAssinatura(clientId, planId) {
    try {
      const client = await Client.findByPk(clientId);
      const plan = await Plan.findByPk(planId);

      if (!client || !plan) {
        throw { statusCode: 404, message: 'Cliente ou Plano não encontrado.' };
      }
      if (!plan.isActive) {
        throw { statusCode: 400, message: 'Este plano não está mais disponível para assinatura.' };
      }
      if (!plan.price || Number(plan.price) < 1.00) {
        logger.error(`[CRÍTICO] Tentativa de checkout com preço inválido para o Plano ID ${planId}. Preço: ${plan.price}`);
        throw { statusCode: 500, message: 'O plano selecionado está com uma configuração de preço inválida. Por favor, contate o suporte.' };
      }

      const subscription = await Subscription.create({
        clientId,
        planId,
        status: 'Pendente',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(new Date().setDate(new Date().getDate() + plan.durationDays)).toISOString().split('T')[0],
      });

      const [firstName, ...lastNameParts] = (client.name || 'Cliente').split(' ');
      const lastName = lastNameParts.join(' ') || firstName;
      
      // <<< INÍCIO DA CORREÇÃO FINAL >>>
      // Adiciona a lógica para extrair o DDD e o número do telefone do cliente.
      let payerPhone = {};
      if (client.phone && client.phone.length === 12) { // Formato 55XXYYYYYYYY
        payerPhone = {
          area_code: client.phone.substring(2, 4),
          number: client.phone.substring(4)
        };
      }
      // <<< FIM DA CORREÇÃO FINAL >>>

      const preferencePayload = {
        purpose: 'wallet_purchase',
        items: [{
          id: plan.id.toString(),
          title: plan.name,
          description: `Assinatura do plano ${plan.name} para o MAP no Controle.`,
          unit_price: Math.round(plan.price * 100) / 100,
          quantity: 1,
          currency_id: 'BRL',
        }],
        payer: {
          name: firstName,
          surname: lastName,
          email: client.email,
          // <<< CORREÇÃO FINAL APLICADA AQUI >>>
          // Inclui o objeto 'phone' no 'payer', espelhando a implementação funcional.
          phone: payerPhone,
        },
        payment_methods: {
            excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
            installments: 1
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL}/assinatura/sucesso`,
          failure: `${process.env.FRONTEND_URL}/assinatura/erro`,
          pending: `${process.env.FRONTEND_URL}/assinatura/pendente`,
        },
        auto_return: "approved",
        external_reference: subscription.id.toString(),
        notification_url: `${process.env.BASE_URL}/api/mercado-pago/webhook`,
        statement_descriptor: "MAP NO CONTROLE",
        binary_mode: true,
        expiration_date_of: getExpirationDate(),
      };

      const response = await mpPreference.create({ body: preferencePayload });

      await subscription.update({
        externalSubscriptionId: response.id
      });

      logger.info(`Preferência de pagamento MP criada (ID: ${response.id}) para Assinatura ID ${subscription.id}`);
      
      return {
        checkoutUrl: response.init_point,
        preferenceId: response.id,
      };

    } catch (error) {
      logger.error("Erro ao criar preferência de pagamento no Mercado Pago:", error.cause || error);
      throw error;
    }
  },

  async processarWebhook(dados) {
    try {
      if (dados.type !== 'payment') {
        return;
      }
      
      const paymentId = dados.data.id;
      const paymentData = await mpPayment.get({ id: paymentId });
      const subscriptionId = parseInt(paymentData.external_reference, 10);

      if (!subscriptionId) {
        logger.warn("[MP Webhook] Webhook sem 'external_reference'.");
        return;
      }
      
      const subscription = await Subscription.findByPk(subscriptionId, { include: ['plan'] });
      if (!subscription) {
        logger.error(`[MP Webhook] CRÍTICO: Assinatura com ID ${subscriptionId} não encontrada!`);
        return;
      }
      
      if (paymentData.status === "approved" && subscription.status !== 'Ativa') {
        const newEndDate = new Date();
        newEndDate.setDate(newEndDate.getDate() + subscription.plan.durationDays);
        
        await subscriptionService.updateSubscriptionStatusByExternalId(
          subscription.externalSubscriptionId, 
          'Ativa', 
          newEndDate.toISOString().split('T')[0]
        );
      } else if (['rejected', 'cancelled', 'refunded'].includes(paymentData.status) && subscription.status !== 'Cancelada') {
        await subscription.update({ status: 'Cancelada' });
      }

    } catch (error) {
      logger.error("Erro fatal ao processar webhook do Mercado Pago:", error.cause || error);
    }
  },
};

module.exports = mercadoPagoService;
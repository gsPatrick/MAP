require('dotenv').config();
const { FinancialTransaction, FinancialAccount } = require('./src/database');
const financialService = require('./src/features/Financial/financial.service');

async function verify() {
    try {
        console.log('--- Verificando obrigatoriedade do paymentMethod ---');
        try {
            await FinancialTransaction.create({
                description: 'Teste sem paymentMethod',
                type: 'Saída',
                value: 10,
                transactionDate: new Date(),
                financialAccountId: 1 // Assumindo que existe
            });
            console.log('ERRO: Transação criada sem paymentMethod (esperado erro)');
        } catch (e) {
            console.log('OK: Erro esperado capturado:', e.message);
        }

        console.log('\n--- Verificando geração de PDF ---');
        const accounts = await FinancialAccount.findAll({ limit: 1 });
        if (accounts.length > 0) {
            const result = await financialService.generateMonthlyReportPdf(accounts[0].id, 2, 2026);
            console.log('OK: PDF gerado com sucesso:', result.filePath);
        } else {
            console.log('AVISO: Nenhuma conta encontrada para testar PDF');
        }

    } catch (error) {
        console.error('Falha na verificação:', error);
    } finally {
        process.exit();
    }
}

verify();

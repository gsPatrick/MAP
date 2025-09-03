// scripts/cleanupDuplicates.js

const { Client, FinancialAccount, Subscription, SharedAccess, ClientInteractionLog, WaterIntakeLog, sequelize } = require('./src/database');
const logger = require('./src/utils/logger');

/**
 * Normaliza um número de telefone para o formato canônico do sistema (sem o 9º dígito).
 * @param {string} phoneNumber - O número de telefone.
 * @returns {string|null} - O número normalizado.
 */
function normalizePhoneNumberToCanonical(phoneNumber) {
    if (!phoneNumber || typeof phoneNumber !== 'string') return null;
    let cleanNumber = phoneNumber.replace(/\D/g, '');
    if (cleanNumber.length === 10 || cleanNumber.length === 11) {
        cleanNumber = '55' + cleanNumber;
    }
    if (cleanNumber.length === 13 && cleanNumber.startsWith('55') && cleanNumber.charAt(4) === '9') {
        return cleanNumber.substring(0, 4) + cleanNumber.substring(5);
    }
    return cleanNumber;
}

/**
 * Script principal para encontrar, mesclar e remover clientes duplicados.
 */
async function runCleanup() {
    logger.info('--- INICIANDO SCRIPT DE LIMPEZA DE CLIENTES DUPLICADOS ---');

    try {
        await sequelize.authenticate();
        logger.info('Conexão com o banco de dados estabelecida com sucesso.');

        const allClients = await Client.findAll();
        const clientsByBasePhone = new Map();

        // 1. Agrupar clientes pelo número de telefone base (normalizado)
        for (const client of allClients) {
            const basePhone = normalizePhoneNumberToCanonical(client.phone);
            if (!basePhone) {
                logger.warn(`Cliente ID ${client.id} com telefone inválido ou nulo: ${client.phone}. Ignorando.`);
                continue;
            }
            if (!clientsByBasePhone.has(basePhone)) {
                clientsByBasePhone.set(basePhone, []);
            }
            clientsByBasePhone.get(basePhone).push(client);
        }

        // 2. Filtrar apenas os grupos que têm duplicados
        const duplicateGroups = Array.from(clientsByBasePhone.values()).filter(group => group.length > 1);

        if (duplicateGroups.length === 0) {
            logger.info('Nenhum cliente duplicado encontrado. O banco de dados está limpo! ✅');
            return;
        }

        logger.warn(`Encontrados ${duplicateGroups.length} grupos de clientes duplicados. Iniciando processo de mesclagem...`);

        for (const group of duplicateGroups) {
            // 3. Para cada grupo, identificar o perfil correto e os perfis a serem removidos
            const correctProfile = group.find(c => c.phone === normalizePhoneNumberToCanonical(c.phone));
            const profilesToRemove = group.filter(c => c.id !== correctProfile?.id);

            if (!correctProfile) {
                logger.error(`GRUPO DE DUPLICADOS SEM PERFIL CANÔNICO: ${group.map(c => c.phone).join(', ')}. Ação manual necessária.`);
                continue;
            }

            logger.info(`Processando grupo do telefone base ${normalizePhoneNumberToCanonical(correctProfile.phone)}:`);
            logger.info(`  - Perfil CORRETO: ID ${correctProfile.id} (${correctProfile.phone})`);

            for (const profileToRemove of profilesToRemove) {
                logger.warn(`  - Mesclando dados do perfil ERRADO: ID ${profileToRemove.id} (${profileToRemove.phone}) para o perfil correto...`);

                const transaction = await sequelize.transaction();
                try {
                    // 4. Transferir todos os dados associados para o perfil correto
                    const modelsToUpdate = [
                        FinancialAccount, 
                        Subscription, 
                        ClientInteractionLog,
                        WaterIntakeLog
                    ];

                    for (const Model of modelsToUpdate) {
                        const updatedRows = await Model.update(
                            { clientId: correctProfile.id },
                            { where: { clientId: profileToRemove.id }, transaction }
                        );
                        if (updatedRows[0] > 0) {
                            logger.info(`    - Transferidos ${updatedRows[0]} registros de ${Model.name}.`);
                        }
                    }

                    // Tratar SharedAccess (pode estar em duas colunas)
                    const updatedOwner = await SharedAccess.update({ ownerClientId: correctProfile.id }, { where: { ownerClientId: profileToRemove.id }, transaction });
                    if (updatedOwner[0] > 0) logger.info(`    - Transferidos ${updatedOwner[0]} registros de SharedAccess (como dono).`);
                    
                    const updatedSharedWith = await SharedAccess.update({ sharedWithClientId: correctProfile.id }, { where: { sharedWithClientId: profileToRemove.id }, transaction });
                    if (updatedSharedWith[0] > 0) logger.info(`    - Transferidos ${updatedSharedWith[0]} registros de SharedAccess (como convidado).`);

                    // 5. Excluir o perfil duplicado (agora vazio)
                    await profileToRemove.destroy({ transaction });
                    logger.info(`    - Perfil duplicado ID ${profileToRemove.id} excluído com sucesso.`);

                    await transaction.commit();
                    logger.info(`  - MESCLAGEM COMPLETA para ID ${profileToRemove.id}.`);

                } catch (error) {
                    await transaction.rollback();
                    logger.error(`  - ERRO ao mesclar perfil ID ${profileToRemove.id}. A transação foi revertida.`, error);
                }
            }
        }

        logger.info('--- SCRIPT DE LIMPEZA FINALIZADO ---');

    } catch (error) {
        logger.error('Erro fatal durante a execução do script de limpeza:', error);
    } finally {
        await sequelize.close();
        logger.info('Conexão com o banco de dados fechada.');
    }
}

// Executa a função principal
runCleanup();
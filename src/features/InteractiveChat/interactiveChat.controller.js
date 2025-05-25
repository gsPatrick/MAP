// src/routes/index.js
// ... (outros imports)
const interactiveChatRoutes = require('../features/InteractiveChat/interactiveChat.routes'); // <<< NOVO IMPORT

const mainApiRouter = Router();

// ... (outras rotas)

// --- ROTAS PARA CLIENTS LOGADOS (protegidas para Clients com token válido e assinatura ativa) ---
// ...
mainApiRouter.use('/chat', interactiveChatRoutes); // <<< ADICIONAR ESTA LINHA (CLIENTES LOGADOS USAM ESTA)

// ... (resto do arquivo)
module.exports = mainApiRouter;